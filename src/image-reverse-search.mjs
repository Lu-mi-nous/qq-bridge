// image-reverse-search.mjs — 反向搜图（以图搜图）：拿一张图去图源站反查它的出处
//
// 与 image-sources.js 的区别（别混）：
//   image-sources.js      = **正向**搜索（按标签/画师名从 safebooru/pixiv/yande.re 找图）
//   image-reverse-search  = **反向**搜索（给你一张图，问「这是谁画的、出处在哪」）
//
// 用途：群友发一张图问「这图哪来的 / 画师是谁 / 求出处」时用。
//
// ── SauceNAO ─────────────────────────────────────────────────────────────
// 端点 `https://saucenao.com/search.php`，参数：
//   api_key=<40位密钥>  output_type=2(JSON)  db=<索引号>
//   图源二选一：url=<图片直链> 或 file=<文件上传（multipart）>
// 实测（2026-10-11）：**必须有 API key**——不带 key 或被 Cloudflare 挡（403 HTML 挑战页），
//   带无效 key 返回 `{"header":{"status":-1,"message":"The anonymous account type does not
//   permit API usage."}}`。免费账号可在 saucenao.com 注册后获取 key。
//
// 免费 key 的限频（官方文档口径）：**每 30 秒 4 次请求、每天 100 次搜索**（付费更高）。
// 所以这里内置节流 + 每天上限，并把「配额用尽」和「key 无效」区分开报错。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { proxyGet, openTunnel } from './proxy-tunnel.js';

const SEARCH_URL = 'https://saucenao.com/search.php';

/** 常用 db 索引号 → 站点名（SauceNAO 的索引编号）。0 = 全部启用的索引。 */
export const DB_INDEX = {
  all: 0,
  pixiv: 5,
  pixivHistory: 6,
  seiga: 8,
  danbooru: 9,
  drawr: 10,
  nijie: 11,
  yandere: 12,
  fakku: 14,
  sankaku: 15,
  anidb: 2,
  imdb: 999,
  twitter: 41,
  deviantart: 34,
  ehentai: 38,
  artstation: 39,
  gelbooru: 25,
  konachan: 26,
  'anime-pictures': 27
};

/** 索引号 → 可读站点名（结果里带上，便于模型直接说「来自 pixiv」）。 */
const INDEX_NAME = Object.fromEntries(Object.entries(DB_INDEX).map(([k, v]) => [v, k]));

const DEFAULT_DB = 999;          // 999 = 全部站点（SauceNAO 用它表示「不限定索引」）
const FREE_WINDOW_MS = 30 * 1000;
const FREE_WINDOW_MAX = 4;       // 免费 key：30 秒 4 次
const FREE_DAILY_MAX = 100;      // 免费 key：每天 100 次

/**
 * 创建反向搜图器（带节流 + 每日配额 + 磁盘缓存）。
 *
 * @param {object} o
 *   - root      项目根（读 config.json / 写缓存）
 *   - log       日志函数
 *   - proxy     代理（SauceNAO 在国内需代理）
 *   - apiKey    SauceNAO API key（空则不可用，调用方应回退到"没配 key 就说明原因"）
 */
export function createReverseSearcher({ root, log = () => {}, proxy = '', apiKey = '' } = {}) {
  // 可变：控制台改 key 后要能立即生效，不必重启桥接。
  // 用 let 而不是 const —— 原来 const 时只能重启，与"立即生效"的预期不符。
  let currentApiKey = String(apiKey ?? '');
  // 节流状态：**按日期持久化**（2026-10-23 修）。
  // 以前是纯内存，桥接一重启 usedToday 就归零，控制台「取图额度」看起来永远
  // 100/100、像没更新；更危险的是本地 100 次/天的限制被绕过。
  // 持久化时只保留当天计数和 30 秒窗口内的 hits，跨天/过期自动清空。
  const hits = [];
  let dailyCount = 0;
  let dailyAt = new Date().toDateString();
  const quotaFile = path.join(root, 'state', 'reverse-search-quota.json');

  function saveQuota() {
    try {
      fs.mkdirSync(path.dirname(quotaFile), { recursive: true });
      const now = Date.now();
      const recentHits = hits.filter((t) => Number.isFinite(Number(t)) && now - Number(t) <= FREE_WINDOW_MS);
      const tmp = quotaFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({
        date: dailyAt,
        dailyCount,
        hits: recentHits,
        savedAt: now
      }, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, quotaFile);
    } catch (e) {
      log(`[反查] 额度状态写入失败：${e?.message ?? e}`);
    }
  }

  try {
    const raw = JSON.parse(fs.readFileSync(quotaFile, 'utf8'));
    if (raw && raw.date === dailyAt) {
      dailyCount = Math.max(0, Math.min(FREE_DAILY_MAX, Number(raw.dailyCount) || 0));
      const now = Date.now();
      if (Array.isArray(raw.hits)) {
        hits.push(...raw.hits.map(Number)
          .filter((t) => Number.isFinite(t) && now - t <= FREE_WINDOW_MS)
          .sort((a, b) => a - b));
      }
    }
  } catch { /* 没有历史额度状态或格式损坏：从 0 开始 */ }

  // 磁盘缓存：同一张图别反复搜（按图片内容 sha1 分桶）
  const cacheFile = path.join(root, 'state', 'reverse-search-cache.json');
  let cache = {};
  try {
    if (fs.existsSync(cacheFile)) cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) || {};
  } catch { cache = {}; }
  const CACHE_MAX = 300;

  function saveCache() {
    try {
      const keys = Object.keys(cache);
      if (keys.length > CACHE_MAX) {
        // 保留最近使用的：按 at 排序截断
        const keep = keys.map((k) => ({ k, at: cache[k]?.at || 0 }))
          .sort((a, b) => b.at - a.at).slice(0, CACHE_MAX);
        const next = {};
        for (const { k } of keep) next[k] = cache[k];
        cache = next;
      }
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      fs.writeFileSync(cacheFile, JSON.stringify(cache));
    } catch (e) { log(`[反查] 缓存写入失败：${e?.message ?? e}`); }
  }

  /** 只检查额度，不记账（判定与记账分离，见 search 里的说明）。 */
  function checkQuota() {
    const today = new Date().toDateString();
    if (today !== dailyAt) { dailyAt = today; dailyCount = 0; hits.length = 0; saveQuota(); }
    if (dailyCount >= FREE_DAILY_MAX) {
      return { ok: false, reason: `今天的反查次数已用完（${FREE_DAILY_MAX} 次/天，免费额度），明天再试` };
    }
    const now = Date.now();
    while (hits.length && now - hits[0] > FREE_WINDOW_MS) hits.shift();
    if (hits.length >= FREE_WINDOW_MAX) {
      const wait = Math.ceil((FREE_WINDOW_MS - (now - hits[0])) / 1000);
      return { ok: false, reason: `反查太频繁了（免费额度 30 秒 ${FREE_WINDOW_MAX} 次），等 ${wait} 秒再试` };
    }
    return { ok: true };
  }

  /** 记账（**只在确实拿到 SauceNAO 响应后**调用）。 */
  function commitQuota() {
    const today = new Date().toDateString();
    if (today !== dailyAt) { dailyAt = today; dailyCount = 0; hits.length = 0; }
    hits.push(Date.now());
    dailyCount += 1;
    saveQuota();
  }

  /** 退回最近一次记账（SauceNAO 侧拒绝时用，见 search 里的说明）。 */
  function refundQuota() {
    if (hits.length) hits.pop();
    if (dailyCount > 0) dailyCount -= 1;
    saveQuota();
  }

  /** 可用性：没配 key 就别装作能用 */
  function available() {
    return { ok: !!currentApiKey, reason: currentApiKey ? '' : '未配置 SauceNAO API key（config.json 的 imageReverseSearch.apiKey）' };
  }

  /**
   * 反查一张图。
   *
   * @param {Buffer} buffer    图片字节
   * @param {object} opts
   *   - db        索引号（默认 999 = 全部）
   *   - minsim    相似度下限（0~100，默认 50；低于它的结果 SauceNAO 会直接过滤）
   *   - numres    最多几条（默认 5，上限 10）
   *   - mimeType  图片类型（用于日志）
   * @returns {Promise<{ok, results?, error?, cached?, quota?}>}
   */
  async function search(buffer, opts = {}) {
    const { db = DEFAULT_DB, minsim = 50, numres = 5 } = opts;
    const avail = available();
    if (!avail.ok) return { ok: false, error: avail.reason };
    if (!buffer?.length) return { ok: false, error: '图片内容为空' };

    const key = `sha1:${sha1of(buffer)}:db${db}:ms${minsim}`;
    const hit = cache[key];
    if (hit && Date.now() - (hit.at || 0) < 24 * 3600 * 1000) {
      return { ok: true, cached: true, ...hit.value };
    }

    // 先只**检查**额度，不记账：网络失败（代理抖动/超时）不该吃掉额度，
    // 否则连续几次连接失败就把当天 100 次配额耗尽（实测踩过：ECONNRESET ×4 直接顶满）。
    const pre = checkQuota();
    if (!pre.ok) return { ok: false, error: pre.reason, quota: true };

    // 用上传方式（base64 data URL 不可靠；SauceNAO 支持 multipart 上传，但要自己拼 body）。
    // 这里走 **url 参数**的反面——SauceNAO 也支持把图作为 POST body 的 multipart 上传，
    // 但项目现有 proxyGet 只支持 GET，所以改用「公开可访问的图片直链」不现实
    // （群友发的图在 QQ 图床，短链会过期）。因此这里自己拼一个 multipart POST。
    try {
      const body = buildMultipart(buffer, opts.mimeType || 'image/jpeg');
      const r = await proxyPost(SEARCH_URL + `?api_key=${encodeURIComponent(currentApiKey)}&output_type=2&db=${db}&minsim=${minsim}&numres=${Math.min(10, Math.max(1, numres))}`,
        body.buffer, body.contentType, { proxy, timeoutMs: 45000 });
      // 记账策略（2026-10-21 修）：**只有真正完成了一次搜索才扣额度**。
      //
      // 原先的写法是「拿到任何响应就先 commit，再按错误文案正则决定要不要 refund」，
      // 实测暴露两个问题：
      //   ① Cloudflare 挑战页（`Just a moment`）的文案不在那条正则里 → 白扣一次额度，
      //      而群友看到的是"没搜到"，额度却少了一格；
      //   ② 靠"错误文案正则"判断太脆，上游改一个字就漏。
      // 现在改成显式区分：只有 `parsed.ok === true`（真拿到 results）才 commit；
      // 其余一切（风控页/非 JSON/格式异常/上游报错/连接失败）都不扣。
      //
      // 代价：极少数情况下 SauceNAO 真的计了费但我们没扣（例如它返回了 status=0 但
      // results 为空——那种仍算 ok，会正常扣）。宁可本地少扣一格，也不要在被风控挡住时
      // 把免费额度白白耗光（免费 key 每天只有 100 次）。
      const text = String(r.body ?? '');
      // 403 + HTML：即使特征串没命中，也基本可以确定是风控（正常 API 响应是 200 JSON）
      if (Number(r.status) === 403 && !/^\s*\{/.test(text)) {
        return {
          ok: false,
          error: 'SauceNAO 返回 HTTP 403（疑似 Cloudflare 风控）。'
            + '不是 key 或额度问题，请求没到搜索接口。换个代理出口再试，别连续重试。'
        };
      }
      const parsed = parseSauceResponse(text);
      if (!parsed.ok) {
        // **不扣额度**：风控页 / 非 JSON / 上游报错都不算"完成了一次搜索"
        return parsed;
      }
      commitQuota();

      cache[key] = { at: Date.now(), value: { results: parsed.results, raw: parsed.raw } };
      saveCache();
      return { ok: true, results: parsed.results, raw: parsed.raw, cached: false };
    } catch (e) {
      return { ok: false, error: `反查请求失败：${e?.message ?? e}` };
    }
  }

  /** 统计（供控制台/日志展示） */
  function stats() {
    const today = new Date().toDateString();
    const usedToday = (today === dailyAt ? dailyCount : 0);
    // 窗口内用量要按**当前时刻**重新数：hits 里的旧时间戳要等下次 checkQuota 才被清掉，
    // 直接用 hits.length 会把过期的也算进去，控制台就显示一个虚高的数字。
    const now = Date.now();
    const windowUsed = hits.filter((t) => now - t <= FREE_WINDOW_MS).length;
    return {
      hasKey: !!currentApiKey,
      usedToday,
      dailyMax: FREE_DAILY_MAX,
      remainingToday: Math.max(0, FREE_DAILY_MAX - usedToday),
      windowMax: FREE_WINDOW_MAX,
      windowUsed,
      // 窗口满了之后要等多久才腾出名额（0 = 现在就能用）
      windowResetMs: windowUsed >= FREE_WINDOW_MAX && hits.length
        ? Math.max(0, FREE_WINDOW_MS - (now - hits[0]))
        : 0,
      cached: Object.keys(cache).length
    };
  }

  /** 运行时更新 API key（控制台保存后立即生效，无需重启）。 */
  function setApiKey(next) {
    currentApiKey = String(next ?? '').trim();
    return { hasKey: !!currentApiKey };
  }

  return { available, search, stats, setApiKey, DB_INDEX };
}

// ── 内部工具 ────────────────────────────────────────────────────────────────

function sha1of(buf) {
  return crypto.createHash('sha1').update(buf).digest('hex').slice(0, 20);
}

/** 拼 multipart/form-data 请求体（file 字段）。 */
function buildMultipart(buffer, mimeType) {
  const boundary = '----qqbridge' + Math.random().toString(36).slice(2, 14);
  const head = Buffer.from(
    `--${boundary}\r\n`
    + `Content-Disposition: form-data; name="file"; filename="image.jpg"\r\n`
    + `Content-Type: ${mimeType}\r\n\r\n`
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { buffer: Buffer.concat([head, buffer, tail]), contentType: `multipart/form-data; boundary=${boundary}` };
}

/**
 * 解析 SauceNAO 的 JSON 响应，归一成好用的结构。
 *
 * 响应形态（output_type=2）：
 *   { header: {status: 0, ...}, results: [ { header: {similarity, thumbnail, index_id, index_name},
 *     data: {source, creator, title, pixiv_id, member_name, ext_urls, ...} } ] }
 * status<0 表示错误（如 key 无效 / 配额用尽），message 里有原因。
 */
export function parseSauceResponse(text) {
  let j;
  try { j = JSON.parse(text); } catch {
    // Cloudflare 挑战页是 HTML
    // Cloudflare 挑战页是 HTML。
    // 判据要**同时看特征串与状态**（2026-10-21 修）：
    //   早先只测 /cloudflare/i，而 SauceNAO 正常首页里也有 "Cloudflare Web Analytics"
    //   的脚本注释 → 会误判成"被拦"。真正的挑战页至少带 `Just a moment` 或 `cf-chl`，
    //   且响应是 403 + `Cf-Mitigated: challenge`（见下面 status 判断）。
    if (/Just a moment|cf-chl|challenge-platform|cf-mitigated/i.test(text)) {
      return {
        ok: false,
        error: '被 SauceNAO 的 Cloudflare 挑战页拦住了（HTTP 403）。'
          + '这不是 key 或额度问题——请求没能到达 SauceNAO 的搜索接口。'
          + '常见原因：当前代理出口 IP 被 Cloudflare 标记、或请求缺少浏览器特征。'
          + '可以换一个代理节点/出口地区再试；不要反复重试（会加重风控）。'
      };
    }
    return { ok: false, error: `SauceNAO 返回了非 JSON 内容：${String(text).slice(0, 120)}` };
  }
  // JSON.parse 对 `null` / 纯数字 / 字符串字面量都不抛，但它们显然不是有效响应。
  // 必须显式拒绝：否则会被当成「成功但 0 条结果」，让模型对群友说「没搜到出处」——
  // 而真实情况是接口返回了异常内容（实测踩过）。
  if (!j || typeof j !== 'object' || Array.isArray(j)) {
    return { ok: false, error: `SauceNAO 响应格式异常（不是 JSON 对象）：${String(text).slice(0, 80)}` };
  }
  const status = Number(j?.header?.status);
  if (Number.isFinite(status) && status < 0) {
    const msg = String(j?.header?.message || '').trim();
    if (/anonymous account/i.test(msg)) {
      return { ok: false, error: 'SauceNAO 拒绝了请求：API key 无效或未生效（匿名账号不允许调用 API）' };
    }
    if (/limit|exceed|quota|rate/i.test(msg)) {
      return { ok: false, error: `SauceNAO 配额/限频：${msg || '已超出免费额度'}` };
    }
    return { ok: false, error: `SauceNAO 报错：${msg || `status=${status}`}` };
  }
  const list = Array.isArray(j?.results) ? j.results : [];
  const results = list.map((r) => {
    const h = r?.header || {};
    const d = r?.data || {};
    const indexId = Number(h.index_id);
    return {
      similarity: Number(h.similarity) || 0,
      site: prettySiteName(h.index_name, indexId),
      indexId: Number.isFinite(indexId) ? indexId : 0,
      title: clean(d.title) || clean(d.jp_name) || '',
      creator: prettyCreator(clean(d.creator) || clean(d.author_name) || clean(d.member_name) || clean(d.username)),
      // ext_urls 是「这张图在那个站点的页面」，通常第一条最有用
      urls: (Array.isArray(d.ext_urls) ? d.ext_urls : []).filter((u) => typeof u === 'string' && /^https?:/.test(u)).slice(0, 3),
      // pixiv 专有：插画 id 与画师 id（可直接拼 https://www.pixiv.net/artworks/<id>）
      pixivId: d.pixiv_id ? String(d.pixiv_id) : '',
      memberId: d.member_id ? String(d.member_id) : '',
      thumbnail: String(h.thumbnail || '')
    };
  // 相似度降序（SauceNAO 本来就有序，但显式排一下更稳）
  }).sort((a, b) => b.similarity - a.similarity);
  return { ok: true, results, raw: { status, count: results.length } };
}

function clean(v) {
  const s = String(v ?? '').trim();
  return s === 'null' ? '' : s;
}

/**
 * 规整画师字段。
 *
 * SauceNAO 对读不出作者的条目会填字面量 `Unknown` / `N/A` / `-`——照原样返回的话，
 * 模型会很自然地对群友说「作者是 Unknown」，非常出戏。统一清成空串，
 * 让上层按「没有画师信息」处理（工具描述里已要求这种情况别提作者）。
 */
function prettyCreator(v) {
  const s = clean(v);
  if (/^(unknown|n\/?a|none|null|无|未知|-+)$/i.test(s)) return '';
  return s;
}

/**
 * 把 SauceNAO 给的站点名洗成人话。
 *
 * 它原始返回形如（实测）：
 *   `Index #12: Yande.re - 1313e6d8f63540d90440c24d385baa87_1.jpg`
 *   `Index #5: Pixiv Images - 99729014_p0_master1200.jpg`
 *   `Index #38: H-Misc (E-Hentai) - 014793cb...jpg`
 * 即「Index #N: 站名 - 匹配到的那个文件名」。两段噪音都要去掉（文件名尤其没用，
 * 念给群友是纯干扰）。再规整几个常见站名的通行写法。
 */
export function prettySiteName(indexName, indexId) {
  let s = String(indexName || '').replace(/^Index\s*#\d+\s*:\s*/i, '').trim();
  // 去掉「 - <文件名>」后缀：文件名特征是含扩展名，或很长的一串 hex（无扩展名时）
  s = s.replace(/\s+-\s+[^\s]*\.(jpe?g|png|gif|webp|mp4|bmp|tiff?)\s*$/i, '')
       .replace(/\s+-\s+[0-9a-f]{16,}(\.\w+)?\s*$/i, '')
       .trim();
  if (!s) s = INDEX_NAME[Number(indexId)] || (Number.isFinite(Number(indexId)) && indexId ? `索引${indexId}` : '');
  const ALIAS = {
    'pixiv images': 'Pixiv',
    'h-misc (e-hentai)': 'E-Hentai',
    'h-misc (nhentai)': 'nhentai',
    deviantart2: 'deviantArt',
    'anime-pictures.net': 'Anime-Pictures',
    'sankaku complex': 'Sankaku'
  };
  return ALIAS[s.toLowerCase()] || s;
}

/**
 * 带自定义 body 的 POST（proxyGet 只支持 GET，这里补一个）。
 *
 * 走与 proxyGet 同一套隧道逻辑：直连失败或有 proxy 时走代理。
 * 这里实现得比较朴素（一次性写 body、读完整响应），够用于一个 JSON 响应。
 */
async function proxyPost(urlString, body, contentType, { proxy = '', timeoutMs = 45000 } = {}) {
  const url = new URL(urlString);
  const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
  const sock = await openTunnel({ proxy, host: url.hostname, port, timeoutMs });
  return await new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let done = false;
    const finish = (fn, v) => { if (done) return; done = true; try { sock.destroy(); } catch {} fn(v); };
    const t = setTimeout(() => finish(reject, new Error('读取超时')), timeoutMs);
    sock.on('data', (c) => { chunks.push(c); total += c.length; if (total > 4 * 1024 * 1024) finish(reject, new Error('响应过大')); });
    sock.on('end', () => {
      clearTimeout(t);
      const raw = Buffer.concat(chunks);
      const parsed = parseHttp(raw);
      if (!parsed) return finish(reject, new Error('响应解析失败'));
      finish(resolve, parsed);
    });
    sock.on('error', (e) => { clearTimeout(t); finish(reject, e); });
    sock.on('timeout', () => finish(reject, new Error('连接超时')));
    const head = [
      `POST ${url.pathname}${url.search} HTTP/1.1`,
      `Host: ${url.host}`,
      'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      `Content-Type: ${contentType}`,
      `Content-Length: ${body.length}`,
      'Accept: application/json, */*',
      'Connection: close',
      '',
      ''
    ].join('\r\n');
    sock.write(Buffer.from(head, 'utf8'));
    sock.write(body);
  });
}

/** 解析 HTTP 原始响应（状态行 + headers + body）。 */
function parseHttp(raw) {
  const sep = raw.indexOf('\r\n\r\n');
  if (sep < 0) return null;
  const head = raw.slice(0, sep).toString('utf8');
  const lines = head.split('\r\n');
  const m = /^HTTP\/1\.[01]\s+(\d{3})/.exec(lines[0] || '');
  if (!m) return null;
  const headers = {};
  for (const l of lines.slice(1)) {
    const i = l.indexOf(':');
    if (i > 0) headers[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim();
  }
  let body = raw.slice(sep + 4);
  // chunked 解码（SauceNAO 常用 chunked）
  if (/chunked/i.test(headers['transfer-encoding'] || '')) {
    const out = [];
    let pos = 0;
    while (pos < body.length) {
      const nl = body.indexOf('\r\n', pos);
      if (nl < 0) break;
      const size = parseInt(body.slice(pos, nl).toString('utf8').trim(), 16);
      if (!Number.isFinite(size) || size <= 0) break;
      out.push(body.slice(nl + 2, nl + 2 + size));
      pos = nl + 2 + size + 2;
    }
    body = Buffer.concat(out);
  }
  return { status: Number(m[1]), headers, body: body.toString('utf8'), rawBody: body };
}

export { SEARCH_URL };
