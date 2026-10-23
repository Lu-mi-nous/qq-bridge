/**
 * 从群友的话里识别「要用哪个图站」。
 *
 * 为什么桥接侧还要自己识别（明明工具已有 sources 参数）：
 * 群主的说法是自然中文——「pixiv上找几张安洁丽娜的图」「用 safebooru 的」——
 * 而**实测模型经常不传 sources 参数**（日志里能直接看到：只说
 * `tags:["angelina_(arknights)","arknights"]`，于是又发了 safebooru 的图）。
 * 把这件事只押在模型「记得填参数」上不可靠，所以桥接在收到消息时就记下
 * 群主要的是哪个站，之后该会话的取图默认用它——模型传了就以模型的为准。
 *
 * 设计取向：**宁可不识别也不要认错站**。误判会导致「明明没指定却只从一个站找」，
 * 比漏判更糟。因此要求站点名与「找图/图片」语境同时出现。
 */

/** 站点别名 → 规范源名。全是实测的常见写法。 */
const SOURCE_ALIASES = [
  ['pixiv', ['pixiv', 'p 站', 'p站', 'ピクシブ', 'pixiv上', 'p站上']],
  ['safebooru', ['safebooru', 'safe booru', 'safebooru上', 'donmai']],
  ['yandere', ['yandere', 'yande.re', 'yande', 'y站', 'yandere上']],
];

/** 「在图站找图」的语境词——必须和站点名同时出现，才认定是"指定图源"。 */
const IMAGE_CONTEXT = /找|来(?:几|一|张|点)|搜|查|要|发|图|画|壁纸|存货|库存|来张|几张/;

/** 否定/无关语境：出现这些时不要认（避免"pixiv上不去了"被当成指定图源）。 */
const NEGATIVE_CONTEXT = /打不开|上不去|登不|连不|封了|挂了|没图|找不到|崩了|慢|卡/;

/**
 * 从一条消息里识别指定的图源。
 *
 * @param {string} text 消息文本（含 @ 等）
 * @returns {{sources:string[], matched:string[], reason:string}}
 *   sources 为规范源名数组（空数组表示没指定）
 */
export function detectSourceRequest(text) {
  const s = String(text ?? '').toLowerCase();
  if (!s.trim()) return { sources: [], matched: [], reason: '空消息' };
  // 先排除"站点故障"这类无关说法
  if (NEGATIVE_CONTEXT.test(s)) return { sources: [], matched: [], reason: '疑似在说站点故障而非指定图源' };

  const matched = [];
  const sources = [];
  for (const [canonical, aliases] of SOURCE_ALIASES) {
    const hit = aliases.find((a) => s.includes(a.toLowerCase()));
    if (hit) { matched.push(hit); sources.push(canonical); }
  }
  if (!sources.length) return { sources: [], matched: [], reason: '未提及任何图站' };
  if (!IMAGE_CONTEXT.test(s)) return { sources: [], matched, reason: '提到图站但没有找图语境' };
  return { sources: [...new Set(sources)], matched, reason: '指定图源' };
}

/**
 * 会话级的「指定图源」记忆（带时效）。
 *
 * 为什么需要记忆而不是只看当前这条消息：群主说「pixiv上找几张…」之后，
 * 紧接着可能说「再来一张」——这时不该退回默认全站。
 *
 * @param {{ttlMs?:number, now?:()=>number}} opts
 */
export function createSourceHintStore({ ttlMs = 10 * 60 * 1000, now = () => Date.now() } = {}) {
  const hints = new Map(); // key -> {sources, at, text}
  return {
    /** 记下本次指定的源（没有指定时不动已有记忆）。 */
    remember(key, sources, text = '') {
      if (!Array.isArray(sources) || !sources.length) return false;
      hints.set(key, { sources: [...new Set(sources.map(String))], at: now(), text: String(text).slice(0, 60) });
      return true;
    },
    /** 取当前有效的源提示（过期自动失效）。 */
    get(key) {
      const h = hints.get(key);
      if (!h) return null;
      if (now() - h.at > ttlMs) { hints.delete(key); return null; }
      return { sources: h.sources, ageMs: now() - h.at, text: h.text };
    },
    /** 清掉（群主改口说「随便哪个站都行」时可用）。 */
    clear(key) {
      if (key === undefined) hints.clear(); else hints.delete(key);
    },
    /** 诊断用。 */
    size: () => hints.size
  };
}

export { SOURCE_ALIASES, IMAGE_CONTEXT, NEGATIVE_CONTEXT };
