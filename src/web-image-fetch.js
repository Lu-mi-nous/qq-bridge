// 按 URL 取图给模型看：共享常量与纯逻辑。
//
// 为什么需要（2026-10-12，用户要求"做"）：
// 微信公众号的图片帖（appmsg_type=10002）正文容器是空的，内容全在配图里。
// web_fetch 能拿到图片直链，但机器人**看不到图内容**：
//   - qq_get_message_images 只认 QQ 消息里的图（不接受外链）
//   - qq_send_image 只支持标签检索（不接受任意 URL）
// 于是「群友发来一篇图片帖」时机器人只能复述摘要，答不出图里是什么。
//
// 本模块只提供纯逻辑（无网络），取图本身复用 safe-fetch.js 的 safeFetchBuffer：
// 它已带 SSRF 防护（内网/环回/DNS rebinding 逐跳校验）、重定向逐跳复检、
// magic number 图片校验、字节上限。**不要在这里另写一套抓取**，否则安全防线会分叉。
//
// 安全与健壮性约束：
//   1. 单图字节上限 2.5MB —— 模型侧对单张 base64 图片有上限，超了会被 API 拒收；
//      而 base64 会膨胀约 33%，所以原始字节必须比上限更早拦下，给出可读的报错。
//   2. 单次调用最多 3 张 —— 一次塞十几张图会爆上下文，且对"看懂这张图"没有帮助。
//   3. 拒绝非图片内容：抓到的若是 HTML 错误页，报错而不是把垃圾当图发模型。

/** 单张图片的原始字节上限（base64 后约 3.3MB）。 */
export const IMAGE_MAX_BYTES = 2.5 * 1024 * 1024;

/** 单次调用最多返回几张图。 */
export const IMAGE_MAX_PER_CALL = 3;

/**
 * 按 host 给防盗链 Referer。
 * 依据（image-archive.js 实测）：pixiv 的 i.pximg.net 不带 Referer 一律 403。
 * 微信 mmbiz 实测无需 Referer，但带上无副作用（值取文章页即可）。
 */
export const REFERER_BY_HOST = [
  { host: 'i.pximg.net', referer: 'https://www.pixiv.net/' },
  { host: 'mmbiz.qpic.cn', referer: 'https://mp.weixin.qq.com/' },
  { host: 'mmbiz.qlogo.cn', referer: 'https://mp.weixin.qq.com/' },
  { host: 'sinaimg.cn', referer: 'https://weibo.com/' },
];

/** 取该 host 需要的 Referer（无匹配则空串）。 */
export function refererForHost(hostname) {
  const h = String(hostname ?? '').toLowerCase();
  const hit = REFERER_BY_HOST.find((r) => h === r.host || h.endsWith('.' + r.host));
  return hit ? hit.referer : '';
}

/** 由 magic number 判图片类型；不认识返回 ''（调用方据此报错，而不是猜）。 */
export function sniffImageMime(buf) {
  if (!buf || buf.length < 12) return '';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  const ascii6 = buf.toString('ascii', 0, 6);
  if (ascii6 === 'GIF87a' || ascii6 === 'GIF89a') return 'image/gif';
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
    && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp';
  // BMP：模型侧未必支持，但先识别出来给出准确提示
  if (buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp';
  return '';
}

/** 人可读的大小。 */
export function humanBytes(n) {
  const b = Number(n) || 0;
  if (b < 1024) return `${b}B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)}KB`;
  return `${(b / 1024 / 1024).toFixed(1)}MB`;
}

/**
 * 校验并规范化要抓的 URL 列表。
 * 只做形状检查（http/https 个数），内网拦截交给 safeFetchBuffer 的 SSRF 防护
 * ——那里才是权威，不在这里重复实现以免两套规则不一致。
 * @returns {{ok:true, urls:string[]} | {ok:false, error:string}}
 */
export function normalizeImageUrls(input) {
  const raw = Array.isArray(input) ? input : (input == null ? [] : [input]);
  const urls = [];
  for (const item of raw) {
    const s = String(item ?? '').trim();
    if (!s) continue;
    let u;
    try { u = new URL(s); } catch { return { ok: false, error: `不是合法 URL：${s.slice(0, 80)}` }; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return { ok: false, error: `只支持 http/https：${s.slice(0, 80)}` };
    }
    if (!urls.includes(u.toString())) urls.push(u.toString());
  }
  if (!urls.length) return { ok: false, error: '没有可抓取的图片 URL' };
  if (urls.length > IMAGE_MAX_PER_CALL) {
    return { ok: false, error: `一次最多看 ${IMAGE_MAX_PER_CALL} 张图（收到 ${urls.length} 张）。请挑最关键的几张，或分批调用。` };
  }
  return { ok: true, urls };
}
