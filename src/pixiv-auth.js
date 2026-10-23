// pixiv 登录态（Cookie）读取与请求头注入。
//
// 需求（2026-10-21 用户）：「pixiv有办法通过账号凭据绕开限制吗」→「先把凭据配置接口做出来」。
//
// ── 先说清楚：凭据能解决什么、不能解决什么 ─────────────────────────────
//
// 实测（2026-10-21）：pixiv 全站返回 503，页面原文是
//   "pixiv is currently under maintenance. The maintenance is scheduled to end in
//    the early hours of October 22, 2026 (JST). ... apply an update patch for a
//    vulnerability discovered in the software we use."
// 也就是说当时**是官方维护**，与风控、与有没有 Cookie 都无关——任何凭据都无效。
//
// 凭据真正有用的场景是另外三类：
//   ① 匿名访问被限流（同一出口 IP 拉日榜太频繁）
//   ② 需要「关注画师」「收藏」这类个性化内容（匿名接口给不了）
//   ③ 部分接口对未登录者返回 `error: true` 的空壳（搜索某些词时）
//
// ── 安全约定（与 bili-auth.js 一致）────────────────────────────────────
//
// - 凭据只从 `state/pixiv-auth.json` 读（`state/` 已在 .gitignore 里），
//   绝不写进 config.json、日志、错误信息或 API 返回值。
// - 日志只出现「已加载 / 未配置」，**不打印 cookie 任何字符**。
// - 文件格式：`{ "PHPSESSID": "...", "device_token": "..." }`
//   只需要 PHPSESSID；device_token 可选但建议一起填（pixiv 会用它做设备校验，
//   只带 PHPSESSID 有时会被要求重新验证）。
//   也支持 `{ "cookie": "PHPSESSID=xxx; device_token=yyy" }` 直接粘整串。
// - **默认不发送**：文件不存在 / 字段为空时，请求头里连 cookie 键都不出现，
//   行为与改造前完全一致（匿名访问）。
import fs from 'node:fs';

/** 当前登录态 Cookie 头。空串表示匿名访问。 */
let PIXIV_COOKIE = '';

/**
 * 读取 pixiv 凭据。
 *
 * @param {string} file 凭据文件绝对路径
 * @returns {{cookie:string, hasSession:boolean, loaded:boolean, reason?:string, userId?:string}}
 *   cookie 是拼好的 Cookie 头；**不要把它打进日志或返回值**。
 */
export function loadPixivAuth(file) {
  const fail = (reason) => ({ cookie: '', hasSession: false, loaded: false, reason });
  if (!file) return fail('未配置凭据文件路径');
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return fail('凭据文件不存在');
  }
  let obj;
  try {
    obj = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
  } catch {
    return fail('凭据文件不是合法 JSON');
  }
  if (!obj || typeof obj !== 'object') return fail('凭据格式错误');

  const pick = (k) => String(obj[k] ?? '').replace(/[\r\n]+/g, '').trim();

  // 直接粘整串 Cookie 的写法（用户从 DevTools 里一键复制的就是这种）
  const rawCookie = pick('cookie');
  if (rawCookie) {
    // 至少得像个 Cookie 头：`name=value`，否则八成是粘错了（比如粘了 URL）
    if (!/=/.test(rawCookie)) return fail('cookie 字段不像 Cookie 头（应为 name=value; ...）');
    return {
      cookie: rawCookie,
      hasSession: /(?:^|;\s*)PHPSESSID=/i.test(rawCookie) || /(?:^|;\s*)device_token=/i.test(rawCookie),
      loaded: true,
      userId: pick('user_id') || undefined,
      source: 'cookie'
    };
  }

  const phpsessid = pick('PHPSESSID') || pick('phpsessid');
  const deviceToken = pick('device_token') || pick('deviceToken');
  const userId = pick('user_id') || pick('userId');

  if (!phpsessid && !deviceToken) return fail('凭据里既没有 PHPSESSID 也没有 device_token');

  const parts = [];
  if (phpsessid) parts.push(`PHPSESSID=${phpsessid}`);
  if (deviceToken) parts.push(`device_token=${deviceToken}`);

  return {
    cookie: parts.join('; '),
    hasSession: !!phpsessid,
    loaded: true,
    userId: userId || undefined,
    // 只有 device_token 没有 PHPSESSID：等于"装了设备但没登录"，
    // 能过一部分设备校验，但拿不到个性化内容——要说清楚，别让人以为登录了。
    reason: phpsessid ? undefined : '只有 device_token，没有登录态 PHPSESSID'
  };
}

/**
 * 注入/清除当前登录态。
 * 传空串表示回到匿名访问（本次运行内不再带 Cookie）。
 */
export function setPixivCookie(cookie) {
  PIXIV_COOKIE = String(cookie || '').replace(/[\r\n]+/g, '').trim();
}

/** 当前是否带登录态（只回布尔，不回值）。 */
export function hasPixivCookie() {
  return !!PIXIV_COOKIE;
}

/**
 * 给请求头补上 Cookie（无凭据时**不添加任何键**）。
 *
 * 为什么返回新对象而不是原地改：调用方常把同一个对象复用给多次请求，
 * 原地改会让「一次带凭据」变成「之后都带」，排查起来很费劲。
 */
export function withPixivAuth(headers) {
  const h = headers && typeof headers === 'object' ? headers : {};
  return PIXIV_COOKIE ? { ...h, cookie: PIXIV_COOKIE } : h;
}
