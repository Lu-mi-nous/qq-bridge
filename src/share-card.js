// QQ 分享卡片（json 段）解析：把 B 站视频/小程序/音乐等分享卡片变成可读文本 + 封面图。
//
// 背景（2026-10-12 用户要求「群里发送 bilibili 视频链接或者分享的小程序时，能不能让机器人
// 能看到标题和封面图片」）：
// 原先 `segmentsToText` 对 json 段只输出 `[卡片消息]` 四个字，标题、描述、封面、真实链接
// 全部丢弃。实测机器人自己在群里抱怨过：「卡片只显示成[卡片消息]，里面什么内容我看不到」。
//
// 关键发现（从 SnowLuma 的 messages.db 里提取真实卡片，共 4 种形态）：
//   com.tencent.miniapp_01  (200+ 次，最常见) meta.detail_1 → title/desc/preview/qqdocurl
//     —— B 站视频分享走这个：title="哔哩哔哩"、desc=视频标题、
//        preview=封面直链、qqdocurl="https://b23.tv/xxx"（真实可打开的链接）
//   com.tencent.tuwen.lua    meta.news    → title/desc/tag/preview/jumpUrl（小红书等）
//   com.tencent.feed.lua     meta.feed    → title/cover/jumpUrl（QQ空间相册）
//   com.tencent.map          meta['Location.Search'] → 位置分享
//
// **重要**：标题和封面都在卡片里，不需要去抓网页。这比联网抓 B 站页面可靠得多
// （B 站有风控、且小程序链接 m.q.qq.com/a/s/... 在浏览器里打不开，只有 qqdocurl 是真实链接）。
//
// 纯函数模块（无网络、无 IO），便于离线回归测试。封面图的抓取复用 safe-fetch 的 safeFetchBuffer。
import { looksLikeImageBuffer } from './safe-fetch.js';

/** 卡片 data 字段可能是「已解析对象」或「转义过的 JSON 字符串」，两种都要吃。 */
export function parseCardData(data) {
  if (!data) return null;
  if (typeof data === 'object') return Array.isArray(data) ? null : data;
  const s = String(data).trim();
  if (!s) return null;
  try {
    const o = JSON.parse(s);
    // 只接受普通对象：数组/数字/字符串/布尔都不是卡片，当成解析失败更安全
    return o && typeof o === 'object' && !Array.isArray(o) ? o : null;
  } catch {
    return null;
  }
}

const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();

/** 已知的分享来源标签（用于把 title 当"平台名"时补一句人话）。 */
const PLATFORM_BY_APP = [
  { re: /bilibili|哔哩/i, label: '哔哩哔哩' },
  { re: /xiaohongshu|小红书/i, label: '小红书' },
  { re: /kugou|酷狗/i, label: '酷狗音乐' },
  { re: /qqmusic|QQ音乐/i, label: 'QQ音乐' },
  { re: /netease|网易云/i, label: '网易云音乐' },
  { re: /douyin|抖音/i, label: '抖音' },
  { re: /weibo|微博/i, label: '微博' },
];

/** meta 里可能出现的子对象键（不同 app 用不同键，按优先级取第一个存在的）。 */
const META_KEYS = ['detail_1', 'news', 'feed', 'detail', 'Location.Search', 'music'];

/**
 * 位置分享卡片（com.tencent.map）单独处理：meta 结构是
 * `{"Location.Search":{"name":..., "address":..., "lat":..., "lng":...}}`，
 * 没有 title/desc/preview，通用取值会全部落空而返回 null（实测如此）。
 */
function parseMapCard(card) {
  const body = card.meta?.['Location.Search'] || card.meta?.Location?.Search;
  if (!body || typeof body !== 'object') return null;
  const name = clean(body.name || body.title);
  const address = clean(body.address || body.addr || '');
  const lat = clean(body.lat ?? body.latitude ?? '');
  const lng = clean(body.lng ?? body.longitude ?? '');
  if (!name && !address) return null;
  const where = [name, address].filter(Boolean).join(' · ');
  return {
    app: clean(card.app),
    platform: '位置',
    title: '',
    desc: where,
    // 腾讯地图检索链接（无需 key，点了能在地图上看到位置）
    url: lat && lng ? `https://apis.map.qq.com/uri/v1/marker?marker=coord:${lat},${lng}` : '',
    cover: '',
    source: '',
    extra: { lat, lng },
  };
}

/**
 * 解析 QQ 分享卡片。
 * @param {object|string} raw 卡片对象，或 json 段的 data.data 字符串
 * @returns {null | {app:string, platform:string, title:string, desc:string, url:string,
 *                   cover:string, source:string, extra:object}}
 *   解析不出任何有用内容时返回 null（调用方退回 [卡片消息]，不要编内容）。
 */
export function parseShareCard(raw) {
  const card = parseCardData(raw);
  if (!card) return null;

  if (/com\.tencent\.map/i.test(clean(card.app))) {
    const mapped = parseMapCard(card);
    if (mapped) return mapped;
  }

  const app = clean(card.app);
  const meta = card.meta && typeof card.meta === 'object' ? card.meta : {};
  // 按已知键顺序取第一个非空子对象；都空则取 meta 里第一个对象（兼容未知 app）
  let body = null;
  for (const k of META_KEYS) {
    const v = meta[k];
    if (v && typeof v === 'object' && Object.keys(v).length) { body = v; break; }
  }
  if (!body) {
    for (const v of Object.values(meta)) {
      if (v && typeof v === 'object' && Object.keys(v).length) { body = v; break; }
    }
  }
  if (!body) return null;

  const rawTitle = clean(body.title);
  const desc = clean(body.desc || body.description || body.summary || '');
  const tag = clean(body.tag || body.tagName || body.source || '');
  // 真实链接优先级：qqdocurl（B站等小程序里是可打开的原始链接）> jumpUrl > url > pcJumpUrl
  // 实测 B 站卡片：url 是 m.q.qq.com/a/s/... （浏览器打不开的中间页），
  // qqdocurl 才是 https://b23.tv/xxx 真实链接 —— 顺序不能反。
  // 只保留 http(s)：mqzone:// / mqqapi:// 这类 scheme 模型无法访问，给了反而误导。
  const rawUrl = clean(body.qqdocurl || body.jumpUrl || body.url || body.pcJumpUrl || '');
  const url = /^https?:\/\//i.test(rawUrl) ? rawUrl : '';
  const cover = clean(body.preview || body.cover || body.imageUrl || '');

  // 平台名：title 常常就是平台名（"哔哩哔哩"），此时 desc 才是真正的内容标题。
  // 例如 B 站视频：title="哔哩哔哩"、desc="根本就没有这样的唱歌小妹"。
  // 直接拿 title 当标题会让模型以为视频叫"哔哩哔哩"。
  let platform = '';
  for (const p of PLATFORM_BY_APP) {
    if (p.re.test(rawTitle) || p.re.test(app) || p.re.test(tag)) { platform = p.label; break; }
  }
  const isPlatformName = platform && (rawTitle === platform || rawTitle.length <= 6 && platform.includes(rawTitle));
  const title = isPlatformName ? '' : rawTitle;

  if (!title && !desc && !url && !cover) return null;

  return {
    app,
    platform: platform || (isPlatformName ? rawTitle : ''),
    title,
    desc,
    url,
    cover,
    source: tag || '',
    extra: {
      ...(isPlatformName ? { cardTitle: rawTitle } : {}),
      ...(body.uin || card.extra?.uin ? { sharerUin: String(body.uin || card.extra?.uin) } : {}),
    },
  };
}

/**
 * 把卡片渲染成给模型看的一行文本。
 * 措辞目标：让模型知道"这是群友分享的一个链接，标题是 X，能看封面"，
 * 并附上真实链接，便于它需要时用 web_fetch 深入。
 */
export function formatShareCard(card) {
  if (!card) return '';
  const label = card.platform || '分享';
  const headline = card.title || card.desc;
  // 内容部分最多给两段：标题 + 描述（不与标题重复时）。
  // 早期实现无条件追加 desc，导致小红书卡片出现「标题：标签串」这种重复噪声。
  const parts = [];
  if (headline) parts.push(headline);
  if (card.title && card.desc && card.title !== card.desc) parts.push(card.desc);
  const body = parts.join(' | ');
  const tail = [card.source ? `来自${card.source}` : '', trimShareUrl(card.url)].filter(Boolean).join(' ');
  return `[${label}卡片]${body ? ' ' + body : ''}${tail ? '：' + tail : ''}`;
}

/**
 * 分享链接清洗：只去掉**确定纯统计用**的几个追踪参数，让提示词短一点。
 *
 * 保守原则：宁可留着长链接，也不要删掉影响打开的鉴权参数。
 * 明确保留 xsec_token / token / sign / auth 这类——小红书等站点的分享链接
 * **没有 xsec_token 会直接打不开**（实测），删了就等于给了个坏链接。
 * 所以这里用白名单式的精确参数名，不用前缀通配。
 */
const TRACKING_PARAMS = new Set([
  'share_source', 'share_medium', 'share_channel', 'share_id', 'share_from_user_hidden',
  'xhsshare', 'bbid', 'ts', 'apptime', 'app_platform', 'app_version', 'author_share',
  'ignoreEngage', 'shareRedId', 'from_source', 'vd_source', 'spm_id_from', 'share_token',
]);

export function trimShareUrl(u) {
  const s = String(u ?? '').trim();
  if (!/^https?:\/\//i.test(s)) return s;
  try {
    const url = new URL(s);
    for (const k of [...url.searchParams.keys()]) {
      if (TRACKING_PARAMS.has(k)) url.searchParams.delete(k);
    }
    const out = url.toString().replace(/\?$/, '');
    // 清洗后仍异常长就别冒险（可能删漏了关键参数），原样返回
    return out.length > 300 ? s : out;
  } catch {
    return s;
  }
}

/** 封面常见协议：http 一律升级为 https（图床都支持，且避免明文请求被中间人篡改）。 */
function upgradeToHttps(u) {
  const s = String(u ?? '').trim();
  if (/^http:\/\//i.test(s)) return 'https://' + s.slice(7);
  return s;
}

/**
 * 从卡片里取封面图 URL（供媒体管线内联/按需取图）。
 * 只接受 http(s)，且必须像图片直链（避免把 m.q.qq.com 这类中间页当图去抓）。
 */
export function coverUrlOf(card) {
  const u = upgradeToHttps(card?.cover);
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) return '';
  // 封面常见 jpg/png/webp，或带 wx_fmt/wxfrom/format 等参数
  if (/\.(jpe?g|png|gif|webp)(\?|$)/i.test(u)) return u;
  if (/[?&](wx_fmt|format|fmt)=/i.test(u)) return u;
  // ugcimg/qpic/qlogo/gtimg 等图床路径可能无扩展名，按域名放行；
  // photo.store.qq.com 是 QQ 空间相册封面（实测 feed.lua 卡片用它）。
  if (/(^|\.)(ugcimg\.cn|qpic\.cn|qlogo\.cn|gtimg\.cn|photo\.store\.qq\.com)$/i.test(safeHost(u))) return u;
  return '';
}

function safeHost(u) {
  try { return new URL(u).hostname.toLowerCase(); } catch { return ''; }
}

/** 卡片段判定：OneBot 的 json 段。 */
export function isShareCardSegment(seg) {
  return !!seg && seg.type === 'json' && !!seg.data;
}

/**
 * 从消息段列表里抽出所有分享卡片（供媒体管线把封面当图片处理）。
 * @returns {Array<{card:object, cover:string, segmentIndex:number}>}
 */
export function extractShareCards(segments) {
  const out = [];
  const list = Array.isArray(segments) ? segments : [];
  list.forEach((seg, i) => {
    if (!isShareCardSegment(seg)) return;
    const card = parseShareCard(seg.data?.data);
    if (!card) return;
    out.push({ card, cover: coverUrlOf(card), segmentIndex: i });
  });
  return out;
}

/** 封面字节是否确实是图片（复用 safe-fetch 的 magic 判定，避免两套规则）。 */
export function isImageBytes(buf) {
  return looksLikeImageBuffer(buf);
}
