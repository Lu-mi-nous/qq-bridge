/**
 * 上游报错拦截与"拟人化"告知。
 *
 * 背景：模型上游（网关 :7863 → 各账号池）会返回 503 no_healthy_account / 429 rate_limit
 * 这类「额度或限流」错误。桥接原先的处理是把原始错误串直接发到群里：
 *
 *     ⚠️ agent 处理出错：503: {"code":"no_healthy_account","gateway_hint":"no healthy
 *     account available in pool; check /status or retry later","message":"all accounts
 *     are temporarily unavailable...
 *
 * 这有两个问题：① 群里看到一坨英文 JSON，出戏且暴露内部实现；
 * ② 同一波限流会让多个群同时刷屏。
 *
 * 本模块做三件事：
 *   1. 识别「额度/限流」类上游错误（只有这类才替换文案，其他错误照旧）。
 *   2. 群里发一句符合当前人设的话，且**同一会话 3 分钟内只发一次**（节流）。
 *   3. 把含群号、错误码、原始 JSON 的详情**私聊**发给管理员。
 *
 * 设计要点：
 *   - 纯逻辑与副作用分离：识别/节流/组装详情都是纯函数或只依赖注入的 now()，
 *     便于离线回归测试（见 scripts/test-error-notifier.mjs）。
 *   - 节流按**会话 key** 记，不是全局：A 群限流不该把 B 群的提示也吞掉。
 *   - 消息文案从配置读，默认内置一套贴合「大肥鱼」人设的短句；随机取一条。
 */

/** 上游「额度/限流」类错误的识别特征。
 *
 * 为什么要按多个特征判而不是只看 HTTP 状态码：错误经过 DSH 转述后，
 * 数字状态码不一定还在（实测有 `turn/end` 只带 code:"RATE_LIMIT"、
 * message 里才是原始 JSON 的情况），所以文本特征必须一起判。
 */
const QUOTA_PATTERNS = [
  /no_healthy_account/i,          // 网关：池内无健康账号（额度耗尽/全被限流）
  /rate_limit_exceeded/i,         // 网关：触达频率限制
  /usage exceeds frequency limit/i, // 上游原文（6004）
  /"code"\s*:\s*6004/,            // 上游额度码
  /insufficient|余额不足|额度不足/i,
  /quota|credit/i,
  /429\b/,                        // Too Many Requests
  /503\b.*(unavailable|account)/i,
  /all accounts are temporarily unavailable/i,
  /RATE_LIMIT\b/,                 // DSH 侧归一化的 code
  // 上游 WAF 拦截网关出口 IP（2026-10-13 首次遇到，群 100002004 凌晨 01:37）。
  // 网关回 `"code":"waf_ip_blocked"` + 一大坨 WAF 的英文 HTML 403 页。
  // 性质与限流同类：上游不可用、**临时**（报错自带 "retry after the block window"）、
  // 非桥接可控（网关直连上游，桥接的抓图走代理，互不影响）。
  // 不识别的话会把整页 HTML 当详情丢进管理员私聊，既难看又刷屏。
  /waf_ip_blocked/i,
  /WAF Block Page/i
];

/** 内置默认文案（贴合「大肥鱼」：短、软、带点无奈，不暴露技术细节）。 */
const DEFAULT_MESSAGES = [
  '诶，我这边好像没额度了……让管理员看看？',
  '呀，卡住了，好像是没额度了呢',
  '呜，我这会儿转不动了，管理员救一下',
  '诶诶，我掉线了…应该又没额度了吧',
  '本鱼没电了，管理员你在吗'
];

/**
 * 判断一个错误是否属于「上游额度/限流」类。
 * @param {unknown} errText 错误文本（Error.message 或拼接后的字符串）
 * @returns {{matched:boolean, code:string, patterns:string[]}}
 */
export function classifyUpstreamError(errText) {
  const s = String(errText ?? '');
  const hit = QUOTA_PATTERNS.filter((re) => re.test(s));
  if (!hit.length) return { matched: false, code: '', patterns: [] };
  // 归一化成给人看的短代号（管理员私聊里用）
  const code = /waf_ip_blocked|WAF Block Page/i.test(s) ? 'waf_ip_blocked'
    : /no_healthy_account/i.test(s) ? 'no_healthy_account'
    : /rate_limit_exceeded|usage exceeds frequency limit|6004|RATE_LIMIT/i.test(s) ? 'rate_limit'
    : 'quota';
  return { matched: true, code, patterns: hit.map((re) => re.source) };
}

/**
 * 压缩上游错误详情，避免把整页 HTML 塞给管理员。
 *
 * 为什么需要：网关在 WAF 拦截时会把**整个 403 HTML 页**（含内联 CSS/JS、腾讯云
 * CDN 链接）当 message 回传，实测有几 KB。原样转发到管理员私聊就是满屏英文标签，
 * 反而看不见真正有用的部分（错误码、网关提示）。
 *
 * 策略：识别到 HTML 就丢弃标签只留可读文本，并截断；
 * 非 HTML 原样返回（截断兜底）。**不丢错误码与 gateway_hint** —— 那才是排查依据。
 */
export function condenseUpstreamDetail(errText, maxLen = 600) {
  let s = String(errText ?? '');
  // 抽 code / gateway_hint（这两个字段是排查关键，必须在）
  const code = (s.match(/"code"\s*:\s*"([^"]+)"/) || [])[1] || '';
  const hint = (s.match(/"gateway_hint"\s*:\s*"([^"]+)"/) || [])[1] || '';
  const status = (s.match(/^(\d{3})\s*:/) || [])[1] || '';

  // 去掉 HTML 标签与内联脚本/样式，压缩空白
  const looksHtml = /<!DOCTYPE html>|<html[\s>]|WAF Block Page/i.test(s);
  if (looksHtml) {
    const text = s
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const parts = [
      status ? `HTTP ${status}` : '',
      code ? `code=${code}` : '',
      hint || '',
      text ? `页面文本：${text}` : '（上游返回了一个 HTML 拦截页）'
    ].filter(Boolean);
    s = parts.join('；');
  } else if (code || hint || status) {
    const parts = [
      status ? `HTTP ${status}` : '',
      code ? `code=${code}` : '',
      hint || '',
      s.length > 200 ? s.slice(0, 200) + '…' : s
    ].filter(Boolean);
    s = parts.join('；');
  }
  return s.length > maxLen ? s.slice(0, maxLen) + '…' : s;
}

/**
 * 创建一个带节流的状态机（纯内存，随进程重启清空——这是有意的：
 * 重启后第一次遇到限流应当照常提示，而不是被上一轮的计时压住）。
 *
 * @param {{windowMs?:number, now?:()=>number}} opts
 */
export function createErrorNotifier({ windowMs = 3 * 60 * 1000, now = () => Date.now() } = {}) {
  /** key -> 上次群内提示时间戳 */
  const lastSentAt = new Map();

  /**
   * 是否该在本轮向群里发提示（同会话 windowMs 内只发一次）。
   * 注意：**判定与记账在同一步**，避免「先问后记」之间插入并发回合导致重复发。
   */
  function shouldNotify(key) {
    const t = now();
    // 用 has() 判「有没有记过」，不能用 `?? 0`：时间戳 0 是合法值（测试与
    // 某些单调时钟都从 0 起），当成「从未发过」的哨兵会让首次调用被自己的默认值挡住。
    if (lastSentAt.has(key) && t - lastSentAt.get(key) < windowMs) {
      return { allowed: false, retryAfterMs: windowMs - (t - lastSentAt.get(key)) };
    }
    lastSentAt.set(key, t);
    return { allowed: true, retryAfterMs: 0 };
  }

  /** 只读查询（不改记账），供测试与诊断用。 */
  function peek(key) {
    const t = now();
    if (!lastSentAt.has(key)) return { last: null, remainingMs: 0 };
    const last = lastSentAt.get(key);
    return { last, remainingMs: Math.max(0, windowMs - (t - last)) };
  }

  function reset(key) {
    if (key === undefined) lastSentAt.clear();
    else lastSentAt.delete(key);
  }

  return { shouldNotify, peek, reset, windowMs };
}

/** 从会话 key 抽出可读的群号/QQ 号，供私聊详情使用。 */
export function parseKey(key) {
  const m = /^(group|private):(\d+)$/.exec(String(key ?? '').trim());
  return m ? { kind: m[1], id: m[2] } : { kind: '', id: '' };
}

/**
 * 组装发给管理员的私聊详情（纯函数，便于单测断言字段）。
 *
 * @param {{key:string, code:string, rawError:string, at?:number, messages?:string[], sessionId?:string}} p
 * @returns {string} 私聊文本
 */
export function buildOwnerReport({ key, code, rawError, at = Date.now(), messages = [], sessionId = '' }) {
  const { kind, id } = parseKey(key);
  const time = new Date(at).toLocaleString('sv-SE', { hour12: false });
  const lines = [
    '【上游报错通知】',
    `时间：${time}`,
    `会话：${key}`,
    // 群号/QQ 号单列一行，方便直接复制
    kind === 'group' ? `群号：${id}` : `QQ号：${id}`,
    kind ? `类型：${kind === 'group' ? '群聊' : '私聊'}` : '',
    `错误码：${code || '未知'}`,
    sessionId ? `sessionId：${sessionId}` : '',
    messages.length ? `群内已回复：${messages.join(' / ')}` : '',
    '',
    '原始报错：',
    String(rawError ?? '').slice(0, 1200)
  ];
  return lines.filter((l) => l !== '').join('\n');
}

/**
 * 判断一条**入站消息**是否是「桥接自己发出的报错」被 QQ 回显回来的。
 *
 * 为什么要拦：桥接发给群的报错，QQ 会把它作为一条普通群消息再投递回来，
 * 于是被记进 recentMessages 当成群友发言。模型读到就以为「群里在讨论系统报错」，
 * 既污染上下文、又把内部实现带进群。实测一条「消息未被接受」在群里躺了两天，
 * 每次重启补投又被模型读一遍。
 *
 * 判据分两类，避免误伤群友正常聊天：
 *  ① 带 emoji 前缀（⚠️/❌/⏳/⏰）**且**后接桥接特有的短语——群友不会这么说话；
 *  ② 不带前缀也绝不会有群友自己打的独特长句。
 * 刻意**不**把「消息未被接受」单独列为②：群友可能真在问「消息未被接受是什么意思？」。
 *
 * @param {string} text
 * @returns {boolean}
 */
export function looksLikeBridgeErrorEcho(text) {
  const s = String(text ?? '');
  // ⚠ 常跟变体选择符 U+FE0F（⚠️），必须显式允许，否则匹配不到。
  const withEmojiPrefix = new RegExp(
    '^\\s*[\\u26A0\\u274C\\u23F3\\u23F0]\\uFE0F?\\s*'
    + '(?:消息未被接受|agent 处理出错|本条回复因疑似包含敏感信息|回答提交失败|审批回执提交失败)'
  );
  if (withEmojiPrefix.test(s)) return true;
  const UNIQUE_PHRASES = [
    '本条回复因疑似包含敏感信息',
    '系统服务重启中，消息已排队',
    '等待回答超时，已取消该请求',
    '回答提交失败，请再回复一次',
    '审批回执提交失败，请再回复'
  ];
  return UNIQUE_PHRASES.some((p) => s.includes(p));
}

/** 随机取一条文案（可注入 rng 便于测试确定性）。 */
export function pickMessage(messages, rng = Math.random) {
  const list = Array.isArray(messages) && messages.length ? messages : DEFAULT_MESSAGES;
  const i = Math.min(list.length - 1, Math.floor(rng() * list.length));
  return String(list[i]);
}

/**
 * 组装「任意桥接报错」发给管理员的私聊（纯函数）。
 *
 * 与 buildOwnerReport 的区别：那个专用于上游额度/限流（会用「群内已回复」字段）；
 * 这个是**通用出口**——安全拦截、消息未被接受、DSH 掉线、审批回执失败等等都走它。
 * 用户要求：报错信息一律不再出现在群里，全部私聊管理员。
 *
 * @param {{key:string, title:string, detail?:string, at?:number, extra?:Record<string,unknown>, suppressed?:number}} p
 * @returns {string}
 */
export function buildOwnerNotice({ key = '', title, detail = '', at = Date.now(), extra = {}, suppressed = 0 }) {
  const { kind, id } = parseKey(key);
  const time = new Date(at).toLocaleString('sv-SE', { hour12: false });
  const lines = [
    '【桥接报错】',
    `时间：${time}`,
    title ? `类型：${title}` : '',
    key ? `会话：${key}` : '',
    // 群号/QQ 号单列，方便直接复制排查
    kind === 'group' ? `群号：${id}` : kind === 'private' ? `QQ号：${id}` : '',
    // 节流窗口内被压掉的同类报错数量：不静默丢弃，让管理员知道「不止一次」
    suppressed > 0 ? `（此前 ${suppressed} 次同类报错因节流未单独发送）` : '',
    ...Object.entries(extra || {})
      .filter(([, v]) => v !== undefined && v !== null && String(v) !== '')
      .map(([k, v]) => `${k}：${String(v)}`)
  ];
  if (detail) lines.push('', '详情：', String(detail).slice(0, 2000));
  return lines.filter((l) => l !== '').join('\n');
}

export { DEFAULT_MESSAGES, QUOTA_PATTERNS };
