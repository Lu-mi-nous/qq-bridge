/**
 * 给群消息贴表情回应（QQ 群消息表情回应）——**由上游模型自主决定**。
 *
 * ## 为什么改成模型自主（而不是桥接按概率自动贴）
 *
 * 初版是桥接侧自动贴：按消息语气分类 + 概率决定。用户指出这样不对——
 * 「改成由上游模型自主控制，否则只是纯随机的无意义行为，容易引起误解」。
 * 确实如此：桥接只看单条消息的字面，不知道上下文里刚发生过什么（是不是在吵架、
 * 是不是刚被点名、这个话题已经聊完了），所以它的"判断"本质上仍是概率行为，
 * 贴错的时候（别人正经说事时贴个笑脸）比不贴更糟。
 *
 * 现在桥接**只提供能力**（`set_msg_emoji_like` 的封装 + 限流 + 参数校验），
 * 由模型在它掌握的完整上下文里决定贴不贴、贴哪条、贴哪个。
 *
 * ## 桥接保留的三件事（模型不该操心的）
 *
 *   1. **只允许群聊**：QQ 的私聊不支持表情回应（实测报错），提前拦掉给清晰提示。
 *   2. **限流**：模型可能一时兴起连贴一串。按会话限速（默认 60 秒内最多 1 次、
 *      每小时最多 15 次），被拦时返回剩余等待，让它知道为什么没成功。
 *   3. **表情 id 校验**：模型可能凭印象编一个不存在的 id。能读到 SnowLuma 的
 *      表情目录时就按目录校验，并给出"最接近的可用名字"，让它自己纠正。
 */

/**
 * 推荐给模型的表情（按用途分组）。id 是 QQ 内置表情的 qSid。
 *
 * 为什么给"推荐"而不是"全部 404 个"：工具描述里塞太多选项反而让模型乱选。
 * 这 16 个覆盖了群聊回应的主要语义，且都是**中性或正面**的——
 * 负面情绪表情（发怒/咒骂/大哭）不列，避免被误用成阴阳怪气；
 * 模型真需要时仍可传别的合法 id（校验只看"id 是否存在"，不限于此表）。
 *
 * 名称都**照 SnowLuma 的 data/sys-face-catalog.json 核对过**——
 * 写错名字不影响可用性，但会让日志与错误提示说谎（曾把 124 写成"强"，实为 /OK）。
 */
export const REACTION_EMOJIS = [
  // 赞同类
  { id: '76', name: '赞', use: '同意、支持' },
  { id: '124', name: 'OK', use: '收到、没问题、认可' },
  { id: '201', name: '点赞', use: '比"赞"更活泼的赞同' },
  { id: '364', name: '超级赞', use: '非常赞同' },
  // 好笑类
  { id: '20', name: '偷笑', use: '好笑但不想打字' },
  { id: '13', name: '呲牙', use: '开心、乐' },
  { id: '5', name: '流泪', use: '笑到流泪 / 也被用来说"感动"' },
  { id: '12', name: '调皮', use: '开玩笑、逗' },
  // 夸人类
  { id: '16', name: '酷', use: '帅气、厉害' },
  { id: '21', name: '可爱', use: '萌、可爱' },
  { id: '66', name: '爱心', use: '喜欢、比心' },
  { id: '63', name: '玫瑰', use: '送花、感谢' },
  { id: '99', name: '鼓掌', use: '叫好、祝贺' },
  { id: '79', name: '胜利', use: '成功、赢了' },
  // 情绪反应类
  { id: '0', name: '惊讶', use: '没想到' },
  { id: '3', name: '发呆', use: '懵、无语但不冒犯' },
];

/** 给工具描述用的紧凑清单：`id=名字(用途)`。 */
export function emojiMenuText(list = REACTION_EMOJIS) {
  return list.map((e) => `${e.id}=${e.name}（${e.use}）`).join('；');
}

/**
 * 校验表情 id 是否合法。
 *
 * @param {string} id
 * @param {Set<string>|null} validIds 已知合法 id 集合（来自 SnowLuma 目录）；
 *   为 null 表示拿不到目录，只做格式校验（位数/纯数字）。
 * @returns {{ok:boolean, reason:string, hint:string}}
 */
export function validateEmojiId(id, validIds = null) {
  const s = String(id ?? '').trim();
  if (!s) return { ok: false, reason: 'emoji_id 不能为空', hint: '' };
  // QQ 内置表情 id 是 1~5 位数字
  if (/^\d{1,5}$/.test(s)) {
    if (validIds && validIds.size && !validIds.has(s)) {
      return {
        ok: false,
        reason: `QQ 表情里没有 id=${s}（可能记错了）`,
        hint: `可用示例：${REACTION_EMOJIS.slice(0, 6).map((e) => `${e.id}=${e.name}`).join('、')}`
      };
    }
    return { ok: true, reason: '', hint: '' };
  }
  // 也允许直接传 unicode 表情符号（SnowLuma 用 `emojiId.length > 3` 判定为 unicode；
  // 注意必须按**码点**数判断，`👍` 的 JS length 是 2——按 length 判会被误拒）
  const codePoints = [...s].length;
  if (codePoints >= 1 && codePoints <= 4 && !/[\p{L}\p{N}]/u.test(s)) {
    return { ok: true, reason: '', hint: '' };
  }
  return { ok: false, reason: `emoji_id「${s}」格式不对（应为 QQ 内置表情的数字 id，如 76）`, hint: '' };
}

/**
 * 贴表情的限流（防模型一时兴起连贴一串）。
 *
 * 为什么限流放在桥接而不是靠提示词：模型并不知道自己刚才贴过几次
 * （那不在它的上下文里），所以"别贴太频繁"这条靠它自律不可靠。
 *
 * @param {{cooldownMs?:number, maxPerHour?:number, now?:()=>number}} opts
 */
export function createReactionGate({ cooldownMs = 60 * 1000, maxPerHour = 15, now = () => Date.now() } = {}) {
  const history = new Map(); // key -> number[]

  /**
   * 判断并记账（同步完成，避免并发回合都拿到允许）。
   * @returns {{allow:boolean, reason:string}}
   */
  function check(key) {
    const t = now();
    const times = (history.get(key) ?? []).filter((x) => t - x < 3600000);
    history.set(key, times);
    const gap = Number(cooldownMs) || 0;
    if (gap && times.length) {
      const last = times[times.length - 1];
      if (t - last < gap) {
        return { allow: false, reason: `刚贴过表情，${Math.ceil((gap - (t - last)) / 1000)} 秒后才能再贴（同会话限流，避免刷屏）` };
      }
    }
    const cap = Number(maxPerHour) || 0;
    if (cap && times.length >= cap) {
      return { allow: false, reason: `本会话每小时最多贴 ${cap} 次表情，已达上限` };
    }
    times.push(t);
    history.set(key, times);
    return { allow: true, reason: '' };
  }

  function reset(key) {
    if (key === undefined) history.clear(); else history.delete(key);
  }

  return { check, reset };
}
