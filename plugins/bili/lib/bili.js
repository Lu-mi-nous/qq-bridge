// B 站视频「自己刷」：视频信息获取 + 抽帧看图 + 本地全局记忆。
//
// 需求（2026-10-19 用户要求）：
//   「让它自己刷B站，并非有目的地根据命令进行，而是仅像人类一样，遇到自己喜欢的视频就多看一会，
//     不喜欢的就划走，然后放在本地形成记忆；群友发B站卡片链接时也可以直接自主观看」
//   补充约束（用户选定）：
//   - 记忆**跨群全局共用**（现有 activeTopic 等是每会话独立的，不适合："我喜欢什么"与群无关）
//   - 潜水时随机刷，**每天总时长不超过 30 分钟**；群友发链接让他看**不占用**这 30 分钟
//   - 刷到喜欢的**偶尔主动分享**
//
// 设计取舍：
//   - 「多看一会 / 划走」不是真的等时间，而是**投入多少帧**：喜欢的多抽几帧（看得清细节和节奏），
//     不喜欢的只看首帧 + 标题就够判断。这既省带宽也贴近真实的"扫一眼就划走"。
//     （真的按秒等待没有意义——模型不在时间维度上感知视频。）
//   - 每轮只看**前 N 秒**（默认 8 秒），不是整段。理由同上：判断"喜不喜欢"用开头足够，
//     整段下载几十上百 MB 纯属浪费。
//   - 抽帧拼图复用 gif-frames 的思路（网格布局），但这里是视频，单独实现。
//   - 记忆存 state/bili-memory.json（全局，不挂会话）。按 bvid 去重，
//     记录标题/UP主/分区/我给的标签/喜欢程度/看过的帧数/时间。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { findFfmpeg, findFfprobe } from '../../../src/plugin-api/process.js';
import { createJsonStore } from '../../../src/plugin-api/storage.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const REFERER = 'https://www.bilibili.com/';

// ── B 站 API ────────────────────────────────────────────────────────────────

/**
 * B 站 API 的请求头。
 *
 * 为什么这组头是必需的（2026-10-19 实测）：
 *   只带 user-agent + referer 时，`/x/web-interface/view` 返回的是 **HTML 风控页**
 *   （解析 JSON 直接炸）。补上 `accept: application/json` 和 `origin` 才稳定返回 JSON。
 *   这不是"绕过验证"，而是让请求看起来像正常的前端调用。
 */
const API_HEADERS = {
  'user-agent': UA,
  referer: REFERER,
  accept: 'application/json, text/plain, */*',
  'accept-language': 'zh-CN,zh;q=0.9',
  origin: REFERER.replace(/\/$/, '')
};

// 登录态 Cookie（由桥接在启动时从 state/bili-auth.json 注入）。
// 字幕接口 `/x/player/v2` 是**必须登录**的：实测不带 SESSDATA 时 subtitles 恒为空数组
// （code 仍是 0，不会报错，所以很容易误判成"这个视频没字幕"）。
// 这跟搜索接口不一样——搜索带任意 buvid3 就够。
let AUTH_COOKIE = '';

/** 注入登录态 Cookie。传空串退回匿名。只用于请求头，绝不进日志。 */
export function setBiliCookie(cookie) {
  AUTH_COOKIE = String(cookie || '').trim();
}

function apiHeaders() {
  return AUTH_COOKIE ? { ...API_HEADERS, cookie: AUTH_COOKIE } : API_HEADERS;
}

async function biliApi(pathname, opts = {}) {
  const url = pathname.startsWith('http') ? pathname : `https://api.bilibili.com${pathname}`;
  const res = await fetch(url, {
    headers: apiHeaders(),
    signal: AbortSignal.timeout(opts.timeoutMs || 15000)
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    // 风控页是 HTML：给出可读原因，别让调用方去猜 JSON 为什么会炸
    throw new Error(`B 站接口返回非 JSON（可能触发风控）：${(text || '').slice(0, 80).replace(/\s+/g, ' ')}`);
  }
  if (json.code !== 0) {
    throw new Error(`B 站接口错误 code=${json.code} ${json.message || ''}`.trim());
  }
  return json.data;
}

/** 从各种 B 站链接里抠出 bvid（BVxxx）或 aid。群友发的卡片/普通链接都走这里。 */
export function parseBiliId(input) {
  const s = String(input ?? '').trim();
  if (!s) return null;
  // 已经是裸 bvid
  const bare = /^(BV[0-9A-Za-z]{10})$/.exec(s);
  if (bare) return { bvid: bare[1] };
  // 短链 b23.tv 无法离线解析，需要网络（见 resolveBiliId）
  const bv = /(BV[0-9A-Za-z]{10})/.exec(s);
  if (bv) return { bvid: bv[1] };
  const av = /[?&]aid=(\d+)|\/av(\d+)/i.exec(s);
  if (av) return { aid: Number(av[1] || av[2]) };
  return null;
}

/** 是否为 b23.tv 短链（需要一次网络跳转才能拿到真实 bvid）。 */
export function isBiliShortUrl(input) {
  return /https?:\/\/b23\.tv\/\S+/i.test(String(input ?? ''));
}

/**
 * 把任意 B 站输入（裸 bvid / 完整链接 / b23.tv 短链 / av 号）解析成可查询的 id。
 *
 * b23.tv 必须走网络：它是 302 跳转，真实 bvid 只出现在跳转后的 URL 里。
 * 实测群友分享卡片经常给的是短链，所以这条路径不能省。
 *
 * @returns {Promise<{bvid?:string, aid?:number}|null>}
 */
export async function resolveBiliId(input, opts = {}) {
  const direct = parseBiliId(input);
  if (direct) return direct;
  if (!isBiliShortUrl(input)) return null;
  const finalUrl = await resolveBiliShortUrl(String(input).match(/https?:\/\/b23\.tv\/\S+/i)[0], opts.timeoutMs);
  return parseBiliId(finalUrl);
}

/** 解析 b23.tv 短链（需要一次网络跳转）。返回最终 URL。 */
export async function resolveBiliShortUrl(shortUrl, timeoutMs = 10000) {
  const res = await fetch(shortUrl, {
    method: 'GET',
    redirect: 'follow',
    headers: { 'user-agent': UA, referer: REFERER },
    signal: AbortSignal.timeout(timeoutMs)
  });
  // fetch 会跟随重定向，最终 URL 在 res.url
  return res.url || shortUrl;
}

// 分区 tid → 名称。详情接口的 tname 有时是空串（实测 BV1Jonu6mEwN 就是），
// 热门列表里却有值；用常见 tid 兜底，让"我喜欢什么分区"的统计不至于缺项。
const TID_NAMES = {
  1: '动画', 3: '音乐', 4: '游戏', 5: '娱乐', 11: '电视剧', 13: '番剧',
  17: '单机游戏', 19: '鬼畜', 20: '舞蹈', 21: '生活', 22: '鬼畜',
  // 游戏区二级分区：这些 tid 的 tname 经常是空串（2026-10-20 实测
  // BV1NxnJ6SE4G 的 tid=121、tname/tname_v2 全空），不补就会归到"未知分区"，
  // 选片权重与"我喜欢什么分区"的统计都会缺项。
  // 只补真正缺的：65/122/171/172 下面那张表里已有，不要重复写
  18: '单机游戏', 121: 'GMV', 124: '科技', 125: '技术', 126: '手工',
  127: '音MAD', 130: '音乐', 136: '音游', 173: '漫画', 174: '综合', 175: '电竞',
  23: '电影', 24: 'MAD·AMV', 25: 'MMD·3D', 26: '音MAD', 27: '综合',
  28: '原创音乐', 29: '三次元音乐', 30: 'VOCALOID', 31: '翻唱',
  36: '科技', 37: '人文·历史', 47: '短片', 51: '赛事', 59: '音乐现场',
  65: '网络游戏', 71: '综艺', 75: '动物圈', 76: '美食', 95: '数码',
  122: '野生技术协会', 138: '搞笑', 160: '生活', 165: '广告', 167: '国创',
  171: '资讯', 172: '纪录片', 179: '美食', 181: '影视', 183: '影视杂谈',
  188: '数码', 198: '机械', 201: '科学科普', 207: '财经商业', 209: '健身',
  211: '美食制作', 217: '动物', 218: '手工', 227: '运动', 228: '汽车',
  229: '家居房产', 230: '出行', 231: '穿搭', 232: '三农'
};

function categoryOf(d) {
  const t = String(d?.tname_v2 ?? d?.tname ?? '').trim();
  if (t) return t;
  // 优先用 tid（旧分区编号，映射表较全）；tid_v2 是新体系（如 2050/2071），表里没有。
  // 实测 BV1Jonu6mEwN：tid=138(搞笑)、tid_v2=2156、tname 为空 —— 用 tid 才能拿到名字。
  const tid = Number(d?.tid);
  const named = TID_NAMES[tid];
  if (named) return named;
  // 兜底：按 tid_v2 的千位区间推大类。
  //
  // 为什么需要（2026-10-20 实测）：B 站新视频常常 tname / tname_v2 **全为空**，
  // 而 tid 又是新编号（121 / 162 …）不在表里 —— 于是整个分区为空，
  // 选片权重、"我喜欢什么分区"的统计都缺项。逐个补 tid 追不上平台改版，
  // 用区间推断至少能保证有值（大类粒度够选片用了）。
  // 实测样本：2071→游戏、2050→科技、2156→搞笑，与下面区间对得上。
  const v2 = Number(d?.tid_v2);
  if (Number.isFinite(v2) && v2 > 0) {
    const band = Math.floor(v2 / 100);
    if (band === 20) return '科技';     // 2000~2099：知识/科技/数码
    if (band === 21) return '生活';     // 2100~2199：生活/美食/动物
    if (band === 22) return '游戏';     // 2200~2299：游戏
    if (band === 23) return '鬼畜';     // 2300~2399：鬼畜/音乐
    if (band === 24) return '资讯';     // 2400~2499：资讯/热点
  }
  return '';
}

/** 取视频元信息（标题/UP主/时长/分区/cid/封面/简介）。 */
export async function fetchVideoInfo(idOrBvid) {
  const q = typeof idOrBvid === 'string' ? `bvid=${encodeURIComponent(idOrBvid)}` : `aid=${encodeURIComponent(idOrBvid.aid)}`;
  const d = await biliApi(`/x/web-interface/view?${q}`);
  const desc = String(d.desc ?? '').slice(0, 600);
  // 简介经常不可用：实测热门榜 10 条里有 3 条是 0 字、2 条只有一个 "-"。
  // 这时靠**标签**补信息（`/x/tag/archive/tags` 能拿到 UP 主填的 tag 名，
  // 实测一条简介为 "-" 的视频拿到了「AI/搬运/搞笑/deepseek/吃饭/大肥鱼」六个标签，
  // 足够说明"这是什么类型的内容"）。
  // 只在简介过短时才多打一次接口，避免每条视频都多一个请求。
  let tags = [];
  if (desc.trim().length < 12) {
    try {
      const td = await biliApi(`/x/tag/archive/tags?bvid=${encodeURIComponent(d.bvid)}`);
      tags = (Array.isArray(td) ? td : [])
        .map((t) => String(t?.tag_name ?? '').trim())
        .filter(Boolean)
        .slice(0, 10);
    } catch {
      // 标签拿不到不影响主流程
    }
  }
  // 分P标题也是线索（合集类视频常有"第 N 集：xxx"）
  const pageTitles = (Array.isArray(d.pages) ? d.pages : [])
    .map((p) => String(p?.part ?? '').trim())
    .filter(Boolean)
    .slice(0, 5);
  return {
    bvid: d.bvid,
    aid: d.aid,
    cid: d.cid,
    title: String(d.title ?? ''),
    desc,
    tags,
    pageTitles,
    durationSec: Number(d.duration) || 0,
    owner: String(d.owner?.name ?? ''),
    cover: String(d.pic ?? ''),
    category: categoryOf(d),
    view: Number(d.stat?.view) || 0,
    like: Number(d.stat?.like) || 0,
    danmaku: Number(d.stat?.danmaku) || 0,
    pubdate: Number(d.pubdate) || 0,
    pages: Array.isArray(d.pages) ? d.pages.length : 1
  };
}

/**
 * 取视频字幕（B 站自动生成的 `ai-zh` 或 UP 主上传的 `zh-Hans` 等）。
 *
 * ── 为什么做这个（2026-10-19 用户问「不能直接给模型视频和音频流吗」）──
 *
 * 不能：DSH 的 prompt 协议只接受 `text` / `image` 两种内容块
 * （`dsh-host-apiproxy` 的 `promptContentPartSchema` 是 text|image 的 discriminated union），
 * 网关 42 个模型也只声明了 `supports_images`，没有 audio/video 输入位。
 * 但**声音本身可以变成文字**：B 站给绝大多数视频配了 AI 字幕，
 * 实测热门榜 12 条里 11 条有 `ai-zh`。字幕对"这视频在讲什么"的贡献
 * 比再多抽 100 帧都大——画面只能看出场景，字幕能直接给出内容。
 *
 * ── 必须登录（实测）──
 *   不带 SESSDATA 时 `/x/player/v2` 的 `subtitles` 恒为空数组，**且 code 仍是 0**，
 *   不会报错。所以"没字幕"和"没登录"从返回值上分不开，这里只能用状态码区分
 *   `noAuth`（没配凭据）与 `none`（配了但这条确实没字幕）。
 *   字幕文件本身（aisubtitle.hdslb.com）**不需要 cookie**，带 url 里的 auth_key 就能下。
 *
 * @returns {Promise<{ok:boolean, tracks?:Array, lines?:Array<{from:number,to:number,text:string}>,
 *   reason?:string}>} 失败时 ok=false + reason（'noAuth'|'none'|'http'|'parse'）
 */
export async function fetchSubtitles(bvid, cid, opts = {}) {
  const id = String(bvid ?? '').trim();
  const c = Number(cid) || 0;
  if (!id || !c) return { ok: false, reason: 'http' };
  if (!AUTH_COOKIE) return { ok: false, reason: 'noAuth' };

  const timeoutMs = Number(opts.timeoutMs) || 12000;
  let data;
  try {
    data = await biliApi(`/x/player/v2?bvid=${encodeURIComponent(id)}&cid=${c}`, { timeoutMs });
  } catch {
    return { ok: false, reason: 'http' };
  }
  const tracks = Array.isArray(data?.subtitle?.subtitles) ? data.subtitle.subtitles : [];
  if (!tracks.length) return { ok: false, reason: 'none' };

  // 优先中文：UP 主上传的人工字幕（zh-Hans/zh-CN）> AI 生成（ai-zh）> 其他
  const rank = (t) => {
    const lan = String(t?.lan ?? '').toLowerCase();
    if (lan === 'zh-hans' || lan === 'zh-cn' || lan === 'zh') return 0;
    if (lan === 'ai-zh') return 1;
    if (lan.startsWith('zh')) return 2;
    if (lan === 'ai-en') return 3;
    return 4;
  };
  const sorted = [...tracks].sort((a, b) => rank(a) - rank(b));
  const pick = sorted[0];
  const rawUrl = String(pick?.subtitle_url || pick?.url || '').trim();
  if (!rawUrl) return { ok: false, reason: 'none' };
  const url = rawUrl.startsWith('//') ? `https:${rawUrl}` : rawUrl;

  let body;
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': UA, referer: REFERER },
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) return { ok: false, reason: 'http' };
    body = await res.json();
  } catch {
    return { ok: false, reason: 'http' };
  }
  const lines = (Array.isArray(body?.body) ? body.body : [])
    .map((l) => ({
      from: Number(l?.from) || 0,
      to: Number(l?.to) || 0,
      text: String(l?.content ?? '').trim()
    }))
    .filter((l) => l.text);
  if (!lines.length) return { ok: false, reason: 'none' };
  return { ok: true, tracks: tracks.map((t) => String(t?.lan ?? '')), lines, lan: String(pick.lan ?? '') };
}

/**
 * 把字幕裁到"实际看过的那段时间"并压成一段文字。
 *
 * 为什么要裁：看 120 秒就只该给这 120 秒的字幕。整条视频 590 行字幕
 * 全塞进 prompt 会占掉几千 token，而模型只看到了开头——多出来的部分
 * 反而会让它以为"视频后面讲了 X"。
 *
 * @param {Array<{from:number,to:number,text:string}>} lines
 * @param {{from?:number, to?:number, maxChars?:number}} opts
 * @returns {string} 形如 "0:03 那相信这几天大家看完评测 0:07 可以跟我得出相同的结论"
 */
export function subtitleSnippet(lines, opts = {}) {
  const from = Math.max(0, Number(opts.from) || 0);
  const to = Number(opts.to) || Infinity;
  const maxChars = Math.max(80, Number(opts.maxChars) || 1200);
  const picked = (Array.isArray(lines) ? lines : [])
    .filter((l) => l.to >= from && l.from <= to)
    .map((l) => l.text);
  if (!picked.length) return '';
  // 逐行拼，超长就截断（宁可少给，也别把 prompt 撑爆）
  let out = '';
  for (const t of picked) {
    const next = out ? `${out} ${t}` : t;
    if (next.length > maxChars) break;
    out = next;
  }
  return out.trim();
}

/** 取热门视频列表（"自己刷"的候选池）。 */
export async function fetchPopularVideos(opts = {}) {
  const ps = Math.min(50, Math.max(1, Number(opts.count) || 20));
  const pn = Math.max(1, Number(opts.page) || 1);
  const d = await biliApi(`/x/web-interface/popular?ps=${ps}&pn=${pn}`);
  const list = Array.isArray(d?.list) ? d.list : [];
  return list.map(mapRankItem);
}

/**
 * 取某分区排行榜（游戏区 rid=4 等）。
 *
 * 为什么要这个（2026-10-19 用户要求「多看鸣潮/明日方舟/终末地/原神/星铁/绝区零/英雄联盟」）：
 *   实测综合热门榜 150 条里只有 **5 条（3.3%）** 是这些游戏相关，靠加成也刷不到几次。
 *   而**游戏区排行榜前几名正好全是这些游戏**（星穹铁道、绝区零、鸣潮……）。
 *   所以把分区榜并进候选池，让"群友常玩的游戏"真的有内容可刷。
 *
 * 注：B 站的搜索接口（search/type）限流严重（实测连续请求返回 -412），
 * 分区榜稳定得多，用它替代。
 */
export async function fetchRankingByRegion(rid = 4, opts = {}) {
  const n = Math.min(100, Math.max(1, Number(opts.count) || 30));
  const d = await biliApi(`/x/web-interface/ranking/v2?rid=${encodeURIComponent(rid)}&type=all`);
  const list = Array.isArray(d?.list) ? d.list : [];
  return list.slice(0, n).map(mapRankItem);
}

/**
 * 下载视频的一小段音轨并转写成文字（让模型"听见"视频）。
 *
 * 需求（2026-10-21 用户）：「设计新的可以让模型同时接收视觉和听觉信息的方案」。
 *
 * ── 为什么只能转成文字（全部实测）────────────────────────────────────
 *
 * 网关的内容类型白名单只接受 `text` 与 `image_url`：`input_audio` / `audio` /
 * `file` / `image`（DSH 原生写法）一律返回 `code 11101 unsupported content type`；
 * `video_url` 能过网关，但模型侧明确回答「无法查看该视频」；
 * DSH 的 prompt 协议（promptContentPartSchema）也只有 text/image。
 * **所以"听觉"必须以文字进入模型**——这不是退而求其次，
 * 转写之后模型确实拿到了"说了什么"这个信息。
 *
 * ── 与字幕的关系：互补，不是替代 ─────────────────────────────────────
 *
 * B 站 AI 字幕（fetchSubtitles）覆盖大多数热门视频，**零成本、瞬时**。
 * 但字幕有三个缺口：① 没登录就完全没有（`subtitles` 恒为空且 code 仍为 0，
 * 很容易误判成"这条没字幕"）；② 冷门视频 / 纯音乐 / 外语内容常常没有字幕；
 * ③ 字幕是别人整理过的文本，会省略语气词。
 * ASR 直接听原始音轨，三类都能补。所以策略是：
 * **有字幕优先用字幕（快）；没有字幕才走 ASR（慢但总能听到）**。
 *
 * ── 性能实测（本机）──────────────────────────────────────────────────
 *
 * large-v3（3.1GB，int8/CPU，16 线程）：加载 ~8.5 秒（常驻只付一次）；
 * 识别 12 秒音频 ~10.7 秒、22 秒 ~12.3 秒、30 秒真实 B 站视频 ~14.4 秒——
 * **耗时以固定开销为主，几乎不随时长线性增长**，所以给 30 秒窗口是划算的。
 *
 * @param {{bvid:string, cid:number}} target
 * @param {object} opts
 *   - fromSec    起始秒（与画面窗口对齐，默认 0）
 *   - seconds    取多长（默认 30）
 *   - asr        外部注入的 ASR 引擎（未注入则不转写）
 *   - timeoutMs  总超时
 * @returns {Promise<{ok:boolean, text?:string, lang?:string, fromSec?:number, seconds?:number, asrSec?:number, error?:string}>}
 */
export async function grabAudioTranscript(target, opts = {}) {
  const asr = opts.asr;
  if (!asr || typeof asr.transcribe !== 'function') return { ok: false, error: '未配置 ASR' };
  if (typeof asr.available === 'function' && !asr.available()) return { ok: false, error: 'ASR 未就绪' };
  const bvid = String(target?.bvid ?? '').trim();
  const cid = Number(target?.cid) || 0;
  if (!bvid || !cid) return { ok: false, error: '缺少 bvid/cid' };

  const ffmpeg = findFfmpeg();
  if (!ffmpeg) return { ok: false, error: '未找到 ffmpeg' };

  const fromSec = Math.max(0, Number(opts.fromSec) || 0);
  const seconds = Math.min(180, Math.max(3, Number(opts.seconds) || 30));
  const timeoutMs = Number(opts.timeoutMs) || 120000;
  const tag = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const dir = path.join(os.tmpdir(), `biliasr-${tag}`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const audio = await fetchAudioUrl(bvid, cid);
    const raw = path.join(dir, 'audio.m4s');
    const wav = path.join(dir, 'audio16k.wav');

    const res = await fetch(audio.url, {
      headers: { 'user-agent': UA, referer: REFERER },
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) return { ok: false, error: `下载音频失败 HTTP ${res.status}` };
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) return { ok: false, error: '音频为空' };
    fs.writeFileSync(raw, buf);

    // 切窗口 + 转 16k 单声道 wav（whisper 的输入规格；显式转码比直接喂 m4s 稳）
    const seekArgs = fromSec > 0 ? ['-ss', String(fromSec)] : [];
    const tr = await run(ffmpeg, [
      '-y', '-v', 'error',
      ...seekArgs,
      '-i', raw, '-t', String(seconds),
      '-ar', '16000', '-ac', '1', '-vn', wav
    ], timeoutMs);
    if (!tr.ok || !fs.existsSync(wav) || fs.statSync(wav).size === 0) {
      return { ok: false, error: `音频转码失败：${tr.error || '空文件'}` };
    }

    const r = await asr.transcribe(wav);
    const text = String(r?.text ?? '').trim();
    if (!text) return { ok: false, error: '转写结果为空（可能是纯音乐/静音）' };
    return { ok: true, text, lang: r.lang || '', fromSec, seconds, asrSec: r.asrSec };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

/** 热门榜/分区榜共用的字段映射。 */
function mapRankItem(v) {
  return {
    bvid: v.bvid,
    cid: v.cid,
    title: String(v.title ?? ''),
    desc: String(v.desc ?? '').slice(0, 200),
    durationSec: Number(v.duration) || 0,
    owner: String(v.owner?.name ?? ''),
    cover: String(v.pic ?? ''),
    category: categoryOf(v) || String(v.tname ?? ''),
    view: Number(v.stat?.view) || 0,
    like: Number(v.stat?.like) || 0,
    danmaku: Number(v.stat?.danmaku) || 0,
    pubdate: Number(v.pubdate) || 0
  };
}

/**
 * 取视频播放地址（免登录，给最低清晰度即可——抽帧看内容不需要高清）。
 *
 * 为什么要 qn=32（360P）：清晰度越高文件越大、下载越慢；判断"这是什么、在讲什么"
 * 360P 完全够（实测字幕都能看清）。真要看清细节另有超分工具。
 */
export async function fetchPlayUrl(bvid, cid, opts = {}) {
  const qn = Number(opts.qn) || 32;
  const d = await biliApi(`/x/player/playurl?bvid=${encodeURIComponent(bvid)}&cid=${encodeURIComponent(cid)}&qn=${qn}&fnval=1`);
  const url = d?.durl?.[0]?.url;
  if (!url) throw new Error('取不到播放地址（可能需要登录或视频受限）');
  return {
    url,
    size: Number(d.durl[0].size) || 0,
    quality: Number(d.quality) || qn
  };
}

/**
 * 取**独立音频流**地址（dash 的 audio 轨道）。
 *
 * 需求（2026-10-21 用户）：「设计新的可以让模型同时接收视觉和听觉信息的方案」。
 *
 * 为什么要单独取音频轨（实测）：
 *   - 上面 `fetchPlayUrl` 用的 `fnval=1` 只给 `durl`——那是**音视频合一**的流，
 *     为了转写去下几 MB 视频纯属浪费；
 *   - `fnval=16` 走 dash，返回 `dash.audio[]`，**只有音频**。实测某热门视频
 *     最低档（id=30216，约 64kbps）30 秒不到 1MB，转写质量与合一流完全一致
 *     （本来就是同一路音轨）；
 *   - 额外好处：音频流不受视频关键帧限制，比"切视频片段再抽音轨"更稳。
 *
 * 为什么取**最低码率**：转写只需"听清说什么"，语音主要能量在 300~3400Hz，
 * 64kbps 足够；更高码率只会下载更慢，**并不会让转写更准**。
 *
 * @returns {Promise<{url:string, bandwidth:number, id:number, mimeType:string}>}
 */
export async function fetchAudioUrl(bvid, cid, opts = {}) {
  const d = await biliApi(
    `/x/player/playurl?bvid=${encodeURIComponent(bvid)}&cid=${encodeURIComponent(cid)}&qn=16&fnval=16`,
    { timeoutMs: Number(opts.timeoutMs) || 15000 }
  );
  const list = Array.isArray(d?.dash?.audio) ? d.dash.audio : [];
  if (!list.length) throw new Error('取不到音频流（视频可能无音轨或受限）');
  const pick = [...list].sort((a, b) => (Number(a.bandwidth) || 0) - (Number(b.bandwidth) || 0))[0];
  const url = String(pick?.baseUrl || pick?.base_url || '').trim();
  if (!url) throw new Error('音频流地址为空');
  return {
    url,
    bandwidth: Number(pick.bandwidth) || 0,
    id: Number(pick.id) || 0,
    mimeType: String(pick.mimeType || pick.mime_type || 'audio/mp4')
  };
}

// ── 视频抽帧 ────────────────────────────────────────────────────────────────

function run(bin, args, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { windowsHide: true });
    } catch (error) {
      resolve({ ok: false, error: String(error?.message ?? error) });
      return;
    }
    const err = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch {}
      resolve({ ok: false, error: 'timeout' });
    }, timeoutMs);
    child.stderr?.on('data', (d) => err.push(d));
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, error: String(error?.message ?? error) });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stderrText = Buffer.concat(err).toString('utf8');
      resolve({
        ok: code === 0,
        code,
        // 成功时也把 stderr 带出来：signalstats 的 YAVG 输出在 stderr 里，
        // 只保留失败时的尾部会拿不到亮度。
        stderr: stderrText.slice(-4000),
        error: code === 0 ? '' : stderrText.slice(-500)
      });
    });
  });
}

/**
 * 下载视频一段并抽帧拼成网格图。
 *
 * @param {string} videoUrl 播放地址（带签名，有时效）
 * @param {object} opts
 *   - seconds: 从这一段的起点往后取多少秒（默认 8）
 *   - frames: 抽几帧（默认 9 = 3×3；"喜欢就多看一会"会传得更多）
 *   - cols: 每行几帧（默认按 frames 算成接近方形）
 *   - skipSeconds: 跳过片头多少秒（默认 0；MV/PV 常有黑场淡入）
 *   - autoSkipDark: 拼图太暗时自动往后挪一段重抽（默认 true，最多 2 次）
 *   - tilesPerSheet: 每张拼图最多几格（默认 30；超过则按时间顺序切成多张）
 *   - timeoutMs
 * @returns {Promise<{buffer:Buffer, mimeType:string, frames:number, seconds:number,
 *   cols:number, rows:number, skipSeconds:number, brightness:number,
 *   sheets:Array<{buffer:Buffer, mimeType:string, cols:number, rows:number,
 *     frames:number, fromSec:number, toSec:number}>}|null>}
 *   `buffer/mimeType` 是第一张（兼容旧调用方），`sheets` 是按时间顺序的全部分页。
 */
export async function grabVideoFrames(videoUrl, opts = {}) {
  // 先用给定参数抽一次；太暗就往后挪（最多 2 次）。
  // 为什么需要（2026-10-19 用户反馈「刷了半天只刷到几个黑屏」）：
  //   K/DA 官方 MV 开头 2~4 秒是黑场淡入，浅看正好 4 秒 → 抽到的 6 帧几乎全黑
  //   （实测拼图平均亮度 5.0，正常画面约 31~78）。人看视频会跳过片头黑屏，
  //   所以这里也照做：检出暗场就把采样窗口往后移，而不是把黑屏交给模型。
  const autoSkipDark = opts.autoSkipDark !== false;
  const baseSkip = Math.max(0, Number(opts.skipSeconds) || 0);
  // 每次重试往后挪 max(2s, 半个窗口)，避免挪太短又落回同一片黑场
  const step = Math.max(2, Math.floor((Number(opts.seconds) || 8) / 2));

  let attempt = 0;
  let last = null;
  while (attempt <= 2) {
    const skip = baseSkip + attempt * step;
    const got = await grabVideoFramesOnce(videoUrl, { ...opts, skipSeconds: skip });
    if (!got) return last || null;
    last = got;
    // 亮度够就收工。阈值取 18：实测黑场淡入 5~12、正常画面 31~78，
    // 中间地带（18~25）多是"很暗但有内容"的夜景/舞台，不该继续往后跳
    // （否则会把正常的暗调视频也跳过，反而错过真实内容）。
    if (!autoSkipDark || got.brightness >= 18) return got;
    attempt += 1;
  }
  // 都偏暗：返回最亮的那次（通常是最后一次，画面已往后挪）
  return last;
}

/** 只抽一次（内部用）。 */
async function grabVideoFramesOnce(videoUrl, opts = {}) {
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) return null;

  const seconds = Math.min(180, Math.max(1, Number(opts.seconds) || 8));
  // 帧数上限：放宽到 120（支持"1 秒 1 帧"看 2 分钟）。
  // 但帧数越多单格越小——实测 120 帧时单格只剩 142×80，字幕就看不清了。
  // 所以具体取多少由调用方按"想要的采样精度 vs 可读性"决定（见 bili-browse watchDepth）。
  const frames = Math.min(120, Math.max(1, Number(opts.frames) || 9));
  const cols = Math.min(frames, Math.max(1, Number(opts.cols) || Math.ceil(Math.sqrt(frames))));
  const rows = Math.ceil(frames / cols);
  const pad = cols * rows - frames;
  const timeoutMs = Number(opts.timeoutMs) || 90000;

  const tag = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const dir = path.join(os.tmpdir(), `bili-${tag}`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const clip = path.join(dir, 'clip.mp4');
    const out = path.join(dir, 'grid.png');

    // 下载片段。用 -c copy 避免转码（快），但有些源的关键帧不规整时
    // 会切不出可解码片段——失败则退回转码重试一次。
    // 注意：B 站 CDN 校验 Referer，缺了会 403。
    //
    // skipSeconds：跳过片头（默认 0）。为什么要这个（2026-10-19 用户反馈
    // 「刷了半天只刷到几个黑屏」）：很多 MV/PV 开头是 2~5 秒的黑场淡入，
    // 浅看只看 4 秒时正好整段落在黑场里，模型只能回答"黑屏，看不出内容"。
    // 这不是抽帧 bug，是**采样窗口选错了位置**——人看视频也会跳过片头黑屏。
    const skip = Math.max(0, Number(opts.skipSeconds) || 0);
    // `-headers` 是 **HTTP 协议专用**选项，对本地文件会直接报
    // `Option headers not found` 并打不开输入（2026-10-19 用本地合成视频
    // 验证跳过逻辑时踩到，导致 grabVideoFrames 对本地文件恒返回 null）。
    // 所以只在远程 URL 时才带。
    const isRemote = /^https?:\/\//i.test(String(videoUrl));
    const headerArgs = isRemote ? ['-headers', `referer: ${REFERER}\r\nuser-agent: ${UA}\r\n`] : [];
    const seekArgs = skip > 0 ? ['-ss', String(skip)] : [];
    let dl = await run(ffmpeg, [
      '-y', '-v', 'error',
      ...headerArgs,
      ...seekArgs,
      '-i', videoUrl, '-t', String(seconds), '-c', 'copy', clip
    ], timeoutMs);

    if (!dl.ok || !fs.existsSync(clip) || fs.statSync(clip).size === 0) {
      // 副本切不动（关键帧间隔大）→ 转码重试
      dl = await run(ffmpeg, [
        '-y', '-v', 'error',
        ...headerArgs,
        ...seekArgs,
        '-i', videoUrl, '-t', String(seconds),
        '-c:v', 'libx264', '-preset', 'ultrafast', '-an', clip
      ], timeoutMs);
    }
    if (!dl.ok || !fs.existsSync(clip) || fs.statSync(clip).size === 0) {
      return null;
    }

    // ── 分页拼图（2026-10-19 用户问「一定要把所有帧序列放在一张图上吗」）──
    //
    // 不分页的问题：120 帧全塞进一张 1568px 的图 → 每格只剩 142×80，字幕读不清。
    // 模型一次能接收**多张图**，所以按时间顺序切成若干张、每张最多 MAX_TILES_PER_SHEET 格，
    // 单格面积能大好几倍，而"连续性"靠图注里的"第 N 张 / 共 M 张"维持。
    // 实测 120 帧：1 张 → 142×80/格；4 张（每张 30 格）→ 每格约 280×158。
    const MAX_TILES_PER_SHEET = Math.max(4, Math.min(36, Number(opts.tilesPerSheet) || 30));
    const sheetCount = Math.max(1, Math.ceil(frames / MAX_TILES_PER_SHEET));
    const perSheet = Math.ceil(frames / sheetCount);

    const BUDGET = 1568;
    const aspect = await probeAspect(ffmpeg, clip, timeoutMs); // w/h，失败默认 16/9
    const sheets = [];
    let brightness = NaN;

    for (let s = 0; s < sheetCount; s++) {
      const startFrame = s * perSheet;
      const count = Math.min(perSheet, frames - startFrame);
      if (count <= 0) break;
      const cols = Math.min(count, Math.max(1, Number(opts.cols) || Math.ceil(Math.sqrt(count))));
      const rows = Math.ceil(count / cols);
      const pad = cols * rows - count;
      // 宽高比贴合视频（横屏视频塞正方形格子会上下留大片黑）
      const canvasW = Math.round(BUDGET);
      const canvasH = Math.max(1, Math.round(BUDGET * (rows / cols) / aspect));
      const tileW = Math.max(120, Math.floor(canvasW / cols));
      const tileH = Math.max(68, Math.floor(canvasH / rows));

      // 只取本页对应的那段时间片（避免先整段抽帧再切，浪费解码）
      const sheetSec = seconds / sheetCount;
      const sheetStart = sheetSec * s;
      const sheetPng = path.join(dir, `sheet-${s}.png`);
      const padFilter = pad > 0 ? `,tpad=stop_mode=clone:stop=${pad}` : '';
      const vf = `fps=${(count / sheetSec).toFixed(4)},`
        + `scale=${tileW}:${tileH}:force_original_aspect_ratio=decrease,`
        + `pad=${tileW}:${tileH}:(ow-iw)/2:(oh-ih)/2:color=black`
        + `${padFilter},tile=${cols}x${rows}`;
      const r = await run(ffmpeg, [
        '-y', '-v', 'error',
        '-ss', String(sheetStart.toFixed(3)),
        '-i', clip,
        '-vf', vf,
        '-frames:v', '1',
        sheetPng
      ], timeoutMs);
      if (!r.ok || !fs.existsSync(sheetPng)) continue;
      const buf = fs.readFileSync(sheetPng);
      if (!buf.length) continue;
      sheets.push({ buffer: buf, cols, rows, frames: count, fromSec: sheetStart, toSec: sheetStart + sheetSec });
      if (Number.isNaN(brightness)) {
        brightness = await measureBrightness(ffmpeg, sheetPng, timeoutMs);
      }
    }

    if (!sheets.length) return null;

    // 每张分页各自转 JPEG（PNG 无损，1568px 一张约 3MB，会让移交模型的 base64 过大）。
    // 失败则退回 PNG（宁可大一点也别没有）。
    for (const sheet of sheets) {
      const pngPath = path.join(dir, `jpg-${sheet.fromSec}.png`);
      fs.writeFileSync(pngPath, sheet.buffer);
      const jpgPath = path.join(dir, `jpg-${sheet.fromSec}.jpg`);
      try {
        const cj = await run(ffmpeg, [
          '-y', '-v', 'error', '-i', pngPath, '-q:v', '3', '-frames:v', '1', jpgPath
        ], 20000);
        if (cj.ok && fs.existsSync(jpgPath)) {
          const j = fs.readFileSync(jpgPath);
          if (j.length && j.length < sheet.buffer.length) {
            sheet.buffer = j;
            sheet.mimeType = 'image/jpeg';
          }
        }
      } catch {}
      if (!sheet.mimeType) sheet.mimeType = 'image/png';
    }

    return {
      // 兼容旧调用方：buffer/mimeType/cols/rows 取第一张
      buffer: sheets[0].buffer,
      mimeType: sheets[0].mimeType,
      cols: sheets[0].cols,
      rows: sheets[0].rows,
      // 分页：按时间顺序的多张图（模型一次可接收多张）
      sheets: sheets.map((s) => ({
        buffer: s.buffer,
        mimeType: s.mimeType,
        cols: s.cols,
        rows: s.rows,
        frames: s.frames,
        fromSec: Number(s.fromSec.toFixed(1)),
        toSec: Number(s.toSec.toFixed(1))
      })),
      frames, seconds,
      skipSeconds: Math.max(0, Number(opts.skipSeconds) || 0),
      brightness: Number.isFinite(brightness) ? brightness : null
    };
  } catch {
    return null;
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

/**
 * 探测视频宽高比（w/h）。失败返回 16/9。
 *
 * 用 ffprobe 读第一路视频流的分辨率；没有 ffprobe 就用 ffmpeg 的 stderr 兜底，
 * 都不行就按 16:9 处理（绝大多数 B 站视频是横屏）。
 */
async function probeAspect(ffmpeg, file, timeoutMs) {
  const ffprobe = findFfprobe();
  if (ffprobe) {
    const r = await run(ffprobe, [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height',
      '-of', 'csv=p=0', file
    ], Math.min(timeoutMs, 15000));
    if (r.ok) {
      const m = /^(\d+),(\d+)/.exec(String(r.stdout || '').trim());
      if (m) {
        const w = Number(m[1]);
        const h = Number(m[2]);
        if (w > 0 && h > 0) return w / h;
      }
    }
  }
  return 16 / 9;
}

/**
 * 量一张图/一段视频的平均亮度（0~255）。
 *
 * 用 ffmpeg 的 signalstats 滤镜：它把 `YAVG=xx` 打到 stderr，解析文本即可，
 * 比读像素便宜得多。失败返回 NaN（调用方按"不知道"处理，不做跳跃）。
 */
async function measureBrightness(ffmpeg, file, timeoutMs) {
  const r = await run(ffmpeg, [
    '-hide_banner', '-v', 'info',
    '-i', file,
    '-vf', 'signalstats,metadata=print',
    '-f', 'null', '-'
  ], Math.min(timeoutMs, 20000));
  // stderr 才能拿到 metadata=print 的输出
  const text = String(r.stderr || r.error || '');
  const vals = [...text.matchAll(/YAVG=([\d.]+)/g)].map((m) => Number(m[1]));
  if (!vals.length) return NaN;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

/** 抽帧拼图的注入文案（说明"这是视频的连续画面"）。 */
export function videoFramesHint(info, grid) {
  const cols = grid?.cols || 0;
  const rows = grid?.rows || 0;
  const secs = grid?.seconds || 0;
  const frames = grid?.frames || 0;
  const sheetCount = Array.isArray(grid?.sheets) ? grid.sheets.length : 1;
  const layout = cols > 1 && rows > 1
    ? `排成 ${rows} 行、每行 ${cols} 个画面：先从左到右读第一行，再读下一行`
    : '从左到右排开';
  const title = info ? `《${info.title}》` : '';
  const durSec = Number(info?.durationSec) || 0;
  const up = info?.owner ? `UP主：${info.owner}｜` : '';
  const dur = durSec ? `全长 ${Math.floor(durSec / 60)}分${durSec % 60}秒｜` : '';
  const cat = info?.category ? `分区：${info.category}｜` : '';
  // 明确"只看了开头多少、占全长几分之几"——否则模型容易误以为已经看完整个视频，
  // 评价时把"开头 30 秒"当成"整条视频"（实测它会说"整个 MV"但其实只看了前 14%）。
  const ratio = durSec > 0 && secs > 0 ? Math.min(100, Math.round((secs / durSec) * 100)) : 0;
  const scope = durSec > 0
    ? `只截取了**开头 ${secs} 秒**（约占全长 ${ratio}%），共 ${frames} 个画面`
    : `截取了**开头 ${secs} 秒**的连续画面，共 ${frames} 个画面`;
  const padded = cols * rows > frames ? `；末尾空缺是补帧，不代表内容重复` : '';
  // 简介：必须给，而且不能截太短（2026-10-19 用户反馈「问他相关信息回答不出来」：
  // 群里追问"啥视频啊"，它只能答"那种动漫解说"——因为除了标题它手里没有任何背景信息）。
  // 但实测很多视频的简介是空的或只有一个 "-"（热门榜 10 条里占一半），
  // 所以简介缺失/过短时**补上 UP 主填的标签和分P标题**。
  const desc = String(info?.desc ?? '').trim();
  const meaningful = desc.length >= 12;
  const descLine = meaningful ? `\n简介：${desc.slice(0, 600)}${desc.length > 600 ? '…' : ''}` : '';
  const tags = (Array.isArray(info?.tags) ? info.tags : []).filter(Boolean);
  const tagLine = (!meaningful && tags.length) ? `\n标签：${tags.join('、')}` : '';
  const pages = (Array.isArray(info?.pageTitles) ? info.pageTitles : []).filter(Boolean);
  const pageLine = (!meaningful && pages.length > 1) ? `\n分P：${pages.slice(0, 5).join(' / ')}` : '';
  const fallback = (!meaningful && !tags.length && !pages.length)
    ? '\n（这个视频没有简介和标签，只能靠画面判断内容）'
    : '';
  // 多张分页时说明阅读顺序（否则模型会把每张图当成互不相关的内容）
  const sheetLine = sheetCount > 1
    ? `\n**这一共是 ${sheetCount} 张图**，按时间先后排列（第 1 张最早）：`
      + `请按顺序把它们连起来看，就像一段连续播放的视频。`
    : '';
  // 字幕（有就胜过一切：画面只能看出场景，字幕直接给出"在说什么"）
  const sub = String(grid?.subtitleText ?? '').trim();
  const subLine = sub
    ? `\n这一段听到的话（B站${grid?.subtitleLan === 'ai-zh' ? 'AI' : ''}字幕）：${sub}`
    : '';
  // ASR 转写（字幕拿不到时的兜底，见 grabAudioTranscript 顶部说明）：
  // 与字幕**不同时出现**——有字幕就不再转写（字幕更快更准，ASR 是慢速兜底）。
  const heard = String(grid?.asrText ?? '').trim();
  // 语种标注：模型知道"这段是英文/日文"有助于它理解口音与用词，
  // 比笼统写"听到的话"更有用。未知语种时明说"未知"，不要瞎猜。
  const LANG_NAMES = { zh: '中文', en: '英文', ja: '日文', ko: '韩文', ru: '俄文', yue: '粤语' };
  const langName = LANG_NAMES[String(grid?.asrLang || '').toLowerCase()] || '未知语种';
  const heardLine = heard
    ? `\n这一段听到的话（本地语音识别，${langName}）：${heard}`
    : '';
  // 明确告诉模型"这次没能听到声音"，避免它把"没有台词"当成"视频里没人说话"
  const noAudioLine = (!sub && !heard && grid?.asrReason)
    ? `\n（这一段没能获取声音内容：${grid.asrReason}。只有画面信息，请只根据画面判断，不要臆测台词。）`
    : '';
  return `[B站视频${title ? ' ' + title : ''}：${up}${cat}${dur}${scope}，${layout}${padded}。${descLine}${tagLine}${pageLine}${fallback}${sheetLine}${subLine}${heardLine}${noAudioLine}\n`
    + `请把它当作在播放这段视频来理解：画面里发生什么、字幕/文字说了什么、整体是什么类型和调性。`
    + `注意：这是**片段**，不是整条视频；评价时别把开头当成全部内容。]`;
}

// ── 全局视频记忆 ────────────────────────────────────────────────────────────

/**
 * 视频记忆（全局，跨群共用）。
 *
 * 为什么单独一份而不是塞进 socialV2.conversations：
 *   现有记忆（activeTopics / memberImpressions）是每会话独立的——那是**群聊上下文**，
 *   本来就该按群隔离。但"我喜欢看什么视频"是**机器人自己的偏好**，与群无关，
 *   在 A 群看过的视频，B 群聊到时也该记得。
 *
 * 结构：
 *   {
 *     updatedAt,
 *     videos: {
 *       [bvid]: { bvid, title, owner, category, durationSec, tags[], liked, interest(0~100),
 *                 watchedFrames, watchedSeconds, source: 'self'|'shared', at, lastSeenAt, notes }
 *     },
 *     dailyUsage: { 'YYYY-MM-DD': { seconds: 1, videos: 2 } }   // 只统计"自己刷"的时长
 *   }
 */
export function createVideoMemory(file, opts = {}) {
  const maxItems = Math.max(50, Math.min(5000, Number(opts.maxItems) || 800));
  const keepDailyDays = Math.max(1, Math.min(60, Number(opts.keepDailyDays) || 14));

  // 桥接与 MCP 是两个进程、各有一个实例。store 用 reloadOnMtime 保留原来的
  // "文件变了就重读"语义，避免后写的一方用旧内存副本覆盖先写的数据。
  const store = createJsonStore({
    file,
    version: 1,
    reloadOnMtime: true,
    defaults: () => ({ updatedAt: 0, videos: {}, dailyUsage: {} })
  });
  let data = null;
  let source = null;

  function normalize(parsed) {
    return {
      updatedAt: Number(parsed?.updatedAt) || 0,
      videos: parsed?.videos && typeof parsed.videos === 'object' ? parsed.videos : {},
      dailyUsage: parsed?.dailyUsage && typeof parsed.dailyUsage === 'object' ? parsed.dailyUsage : {}
    };
  }

  /**
   * 读记忆。store 会按 mtime 热重载；这里只在底层对象变化时重新归一化，
   * 保证同一次读改写拿到的是同一个 `data` 引用。
   */
  function load() {
    const raw = store.read();
    if (raw !== source || !data) {
      source = raw;
      data = normalize(raw);
    }
    return data;
  }

  function save() {
    const d = load();
    d.updatedAt = Date.now();
    try {
      store.write(d);
      return true;
    } catch {
      return false;
    }
  }

  /** 记录一次观看。同一 bvid 重复看会更新"最近看过"与偏好，不产生重复条目。 */
  function record(video) {
    const d = load();
    const bvid = String(video?.bvid ?? '').trim();
    if (!bvid) return null;
    const prev = d.videos[bvid] || {};
    const now = Date.now();
    const merged = {
      bvid,
      title: String(video.title ?? prev.title ?? '').slice(0, 200),
      owner: String(video.owner ?? prev.owner ?? '').slice(0, 80),
      category: String(video.category ?? prev.category ?? '').slice(0, 40),
      durationSec: Number(video.durationSec ?? prev.durationSec ?? 0),
      // 模型给的标签（2~5 个短词），用于之后"我喜欢什么"的归纳
      tags: Array.isArray(video.tags) && video.tags.length
        ? video.tags.map((t) => String(t).slice(0, 24)).slice(0, 8)
        : (Array.isArray(prev.tags) ? prev.tags : []),
      // liked: true/false/null（null = 没判断出来，比如只看了一眼）
      liked: video.liked === true ? true : (video.liked === false ? false : (prev.liked ?? null)),
      interest: clamp(Number(video.interest ?? prev.interest ?? 50), 0, 100),
      watchedFrames: Number(video.watchedFrames ?? prev.watchedFrames ?? 0),
      watchedSeconds: Number(video.watchedSeconds ?? prev.watchedSeconds ?? 0),
      source: video.source === 'shared' ? 'shared' : (prev.source || 'self'),
      at: Number(prev.at) || now,
      lastSeenAt: now,
      // 简介：必须存进记忆（2026-10-19 用户反馈「问他相关信息回答不出来」）。
      // 群友事后追问"啥视频啊/讲什么的"时，模型只能靠记忆回答——
      // 原来只存了模型自己写的一句 notes，标题之外没有任何原始信息，
      // 于是它只能答"那种专门讲离谱剧情的动漫解说"这种笼统描述。
      desc: String(video.desc ?? prev.desc ?? '').slice(0, 600),
      // UP 主标签：简介为空时的主要线索（实测很多视频简介只有 "-"）
      biliTags: Array.isArray(video.biliTags) && video.biliTags.length
        ? video.biliTags.map((t) => String(t).slice(0, 24)).slice(0, 10)
        : (Array.isArray(prev.biliTags) ? prev.biliTags : []),
      // 字幕片段：看完就存一小段（用户要求"读取简介信息"的延伸——
      // 简介说的是"UP 主想表达什么"，字幕才是"视频里真的讲了什么"）。
      // 只留 1200 字，避免记忆文件膨胀。
      subtitle: String(video.subtitle ?? prev.subtitle ?? '').slice(0, 1200),
      notes: String(video.notes ?? prev.notes ?? '').slice(0, 300)
    };
    d.videos[bvid] = merged;
    pruneVideos(d, maxItems);
    save();
    return merged;
  }

  function pruneVideos(d, max) {
    const entries = Object.values(d.videos);
    if (entries.length <= max) return;
    // 按"最近看过"从新到旧，保留前 max 条；喜欢程度高的额外加权，避免把真心喜欢的删掉
    entries.sort((a, b) => (b.lastSeenAt || 0) - (a.lastSeenAt || 0));
    const keep = new Map();
    for (const [i, v] of entries.entries()) {
      if (i < max || (v.liked === true && i < max + 50)) keep.set(v.bvid, v);
    }
    d.videos = Object.fromEntries(keep);
  }

  /** 查一条（用于"群友发了个我看过的视频"时回忆）。 */
  function get(bvid) {
    const d = load();
    return d.videos[String(bvid ?? '').trim()] || null;
  }

  /** 列出最近看过的（按时间倒序），可过滤 liked。 */
  function recent(limit = 10, filter = {}) {
    const d = load();
    let list = Object.values(d.videos);
    if (filter.likedOnly) list = list.filter((v) => v.liked === true);
    if (filter.category) list = list.filter((v) => v.category === filter.category);
    return list.sort((a, b) => (b.lastSeenAt || 0) - (a.lastSeenAt || 0)).slice(0, Math.max(1, limit));
  }

  /**
   * 归纳"我喜欢什么"：按标签/分区/UP主统计，给出高频偏好。
   * 这是让机器人能说出"我最近爱看 XX 类"的依据（不是模型凭空编）。
   */
  function taste(limit = 8) {
    const d = load();
    const tagCount = new Map();
    const catCount = new Map();
    const ownerCount = new Map();
    let liked = 0;
    let total = 0;
    for (const v of Object.values(d.videos)) {
      total += 1;
      if (v.liked === true) liked += 1;
      // 只有"喜欢"的视频才计入偏好——不喜欢的不代表口味
      if (v.liked !== true) continue;
      if (v.category) catCount.set(v.category, (catCount.get(v.category) || 0) + 1);
      // UP 主也是口味信号：喜欢过两次以上的人，出新视频大概率还对味
      // （选片时由 ownerBoost 消费，见 bili-browse.js）
      if (v.owner) ownerCount.set(v.owner, (ownerCount.get(v.owner) || 0) + 1);
      for (const t of v.tags || []) tagCount.set(t, (tagCount.get(t) || 0) + 1);
    }
    const top = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([k, n]) => ({ name: k, count: n }));
    return {
      total,
      liked,
      totalTags: top(tagCount),
      categories: top(catCount),
      // 不截断：ownerBoost 要按"喜欢过几次"算倍率，截断会把只出现 2 次的人漏掉
      owners: [...ownerCount.entries()].map(([name, count]) => ({ name, count }))
    };
  }

  /** 今天的"自己刷"用量（秒）。 */
  function todayUsage(now = Date.now()) {
    const d = load();
    const key = dateKey(now);
    const u = d.dailyUsage[key] || { seconds: 0, videos: 0 };
    return { seconds: Number(u.seconds) || 0, videos: Number(u.videos) || 0, date: key };
  }

  /** 记一次"自己刷"消耗的时长（群友发链接不计入——那是应要求观看）。 */
  function addUsage(seconds, now = Date.now()) {
    const d = load();
    const key = dateKey(now);
    const u = d.dailyUsage[key] || { seconds: 0, videos: 0 };
    u.seconds = (Number(u.seconds) || 0) + Math.max(0, Number(seconds) || 0);
    u.videos = (Number(u.videos) || 0) + 1;
    d.dailyUsage[key] = u;
    // 只保留最近 N 天，避免无限增长
    const keys = Object.keys(d.dailyUsage).sort();
    while (keys.length > keepDailyDays) {
      delete d.dailyUsage[keys.shift()];
    }
    save();
    return u;
  }

  function stats() {
    const d = load();
    const list = Object.values(d.videos);
    return {
      total: list.length,
      liked: list.filter((v) => v.liked === true).length,
      disliked: list.filter((v) => v.liked === false).length,
      updatedAt: d.updatedAt,
      today: todayUsage()
    };
  }

  return { load, save, record, get, recent, taste, todayUsage, addUsage, stats };
}

function clamp(n, min, max) {
  const v = Number.isFinite(n) ? n : min;
  return Math.min(max, Math.max(min, v));
}

function dateKey(now) {
  const d = new Date(now);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
