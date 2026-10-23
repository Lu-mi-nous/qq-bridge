/**
 * 负面评价识别：判断群友是否在说「刚发的那张图不行」。
 *
 * 为什么要单独一层而不是让模型自己判断：模型在 reserved2 模式下是「挑时机说话」，
 * 它没有「把某张图从图库删掉」的直觉，也未必知道反馈是针对哪张图；
 * 而「不好看就换一张」是**即时反馈**，等模型回合结束再处理往往已经冷了。
 *
 * 设计取向：**宁可漏判也不要误判**。误判会把好图删掉、还多发一张图刷屏；
 * 漏判只是维持现状（用户再骂一次就会被判到）。因此：
 *   - 负面词必须**和"图"相关**（有"图/这张/这个"或处于刚发图的窗口内）才算
 *   - 排除「回答式否定」（"不好看吗？我觉得还行" 这种反问/维护）
 */

/** 明确的差评词（针对图）。 */
const NEGATIVE_PATTERNS = [
  /不好看/, /难看/, /好丑/, /太丑/, /丑死/,
  /不是(?:我|俺)(?:要|想)的/, /不是想要的/, /不(?:是|对)(?:这个|这张|这张图)/,
  /换一张/, /换一个/, /重发/, /重来/,
  /不喜欢/, /不合(?:我)?(?:口味|意)/, /看腻/,
  /发错/, /不是这(?:个|张)/, /有没有别的/, /其他(?:的)?图/, /别的图/,
  /什么鬼/, /这啥啊?/, /离谱/, /敷衍/,
  /一般般/, /就这/, /不行(?:啊|吧)?/
];

/**
 * 正面/反问语气——命中即**不**当差评。
 *
 * 必须用否定环视（`(?<!不)好看`）而不是裸 `/好看/`：裸的会匹配「不**好看**」
 * 里的子串，把差评判成夸奖（实测踩过）。同理 `/喜欢/` 会命中「不**喜欢**」。
 */
const NEGATED_OR_POSITIVE = [
  /不好看吗/, /不(?:好|错)看吧/, /难看吗/,   // 反问
  /怎么会不好看/, /哪里难看/,               // 维护
  /(?<![不难難])好看/,                       // 夸好看（排除「不好看」「难看」）
  /(?<!不)喜欢/,                             // 喜欢（排除「不喜欢」）
  /谢谢/, /感谢/, /辛苦了/,
];

/**
 * 指向「图」的词——差评必须落在图上，而不是别的话题。
 *
 * 注意不要把 `这个` / `一个` 这类泛指示词算进来：`我不喜欢这个游戏的设定`
 * 会被误判成对图不满（实测踩过）。必须有真正的"图"字或明确的"这/哪张图"。
 */
const IMAGE_WORDS = /图|画|照片|壁纸|这(?:张|幅)|那(?:张|幅)|这啥|什么鬼/;

/**
 * **自带指向性**的说法：这些短语天然是在说「刚才那张图」，不需要再出现"图"字，
 * 也不依赖发图时间窗口。
 *
 * 与 `再来一张` 的区别很重要：`换一张`（换掉这张）隐含对当前图不满；
 * `再来一张`（还要一张）只是想要更多，**不是差评**——所以后者不在差评词表里。
 */
const SELF_TARGETED = /换一张|换一幅|换(?:个|一)(?:别的|其他)|不要这(?:张|个)|重发|发错|不是这(?:张|个)(?:图|画)?$/;

/**
 * 判断一条消息是否是对图的负面评价。
 *
 * @param {string} text 消息文本（已去掉 @ 等）
 * @param {{recentImageMs?:number}} [opts] recentImageMs：距上次发图的毫秒数。
 *   **传了就等于声明「刚刚发过图」**——此时群友的「换一张」「不好看」默认是在说那张图，
 *   即使没提"图"字也判为差评（实测群里最常见的正是这类省略说法）。
 *   不传则要求句子里有明确的图片指代，避免把「这电影不好看」这类闲聊误判。
 * @returns {{negative:boolean, matched:string[], reason:string}}
 */
export function classifyImageFeedback(text, opts = {}) {
  const s = String(text ?? '').trim();
  if (!s) return { negative: false, matched: [], reason: '空消息' };

  const neg = NEGATIVE_PATTERNS.filter((re) => re.test(s));
  if (!neg.length) return { negative: false, matched: [], reason: '无差评词' };

  // 正面/反问优先：命中即不当差评
  const pos = NEGATED_OR_POSITIVE.filter((re) => re.test(s));
  if (pos.length) return { negative: false, matched: neg.concat(pos).map((r) => r.source), reason: '命中正面/反问语气' };

  // 必须落在「图」上：要么句子里有图片指代，要么是自带指向性的说法（换一张…），
  // 要么处于刚发图的窗口内。
  const windowMs = Number(opts.recentImageMs);
  const inWindow = Number.isFinite(windowMs) && windowMs >= 0;
  const targeted = IMAGE_WORDS.test(s) || SELF_TARGETED.test(s);
  if (!targeted && !inWindow) {
    return { negative: false, matched: neg.map((r) => r.source), reason: '差评词未指向图片' };
  }

  return {
    negative: true,
    matched: neg.map((r) => r.source),
    reason: IMAGE_WORDS.test(s) ? '差评且指向图'
      : SELF_TARGETED.test(s) ? '差评且自带指向（换一张类）'
      : '差评且在刚发图窗口内'
  };
}

/**
 * 该不该因为差评而自动换图。
 *
 * 限流是必要的：群友连骂三句"丑"不该触发送三张图。
 *
 * @returns {{allow:boolean, retryAfterMs:number}}
 */
export function createFeedbackGate({ cooldownMs = 90 * 1000, now = () => Date.now() } = {}) {
  const lastAt = new Map(); // key -> 上次因差评换图时间
  return {
    /** 判断并记账（同一步完成，避免并发回合都拿到 true）。 */
    shouldSwap(key) {
      const t = now();
      if (lastAt.has(key) && t - lastAt.get(key) < cooldownMs) {
        return { allow: false, retryAfterMs: cooldownMs - (t - lastAt.get(key)) };
      }
      lastAt.set(key, t);
      return { allow: true, retryAfterMs: 0 };
    },
    peek(key) {
      if (!lastAt.has(key)) return { last: null, remainingMs: 0 };
      const last = lastAt.get(key);
      return { last, remainingMs: Math.max(0, cooldownMs - (now() - last)) };
    },
    reset(key) {
      if (key === undefined) lastAt.clear(); else lastAt.delete(key);
    }
  };
}

export { NEGATIVE_PATTERNS, NEGATED_OR_POSITIVE, IMAGE_WORDS };
