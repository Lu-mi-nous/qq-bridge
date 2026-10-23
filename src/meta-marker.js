// 剥离模型误写进正文的"内部标记"前缀。
//
// 背景（2026-10-09 实测）：模型在回复正文开头加了 `[[这是玩笑]]`，以为方括号包起来的内容
// 会被系统当成元信息处理掉，结果原样发给群友。它的推理里自己承认：
//   "I used `[[` markers. That was a mistake — those brackets would show up in the QQ message."
// 误会的来源是唤醒提示里大量 `【】` 包裹的内部小节（【当前角色】【此刻状态】…），
// 模型把"方括号=内部标注"从 `【】` 推广到了 `[[]]`。
//
// 设计原则：**极窄，宁可漏也不误伤**。真人群友也会打方括号（`[doge]`、`[笑]`、
// `[图片]` 这些甚至是 QQ 自己的段格式），所以只在「消息最开头」且「成对的方括号」
// 才剥，且内容不含换行、长度有限。
//
// 三个必须放行的反例（都有回归测试）：
//   `[图片]`        —— 桥接自己生成的段标记，剥了会让模型读不懂上下文
//   `[doge]这个梗`  —— 群友/模型爱用的表情文字
//   `[[链接]]`      —— Markdown 双链写法，是正常内容
// 判据是「里面那句话像元信息」（含"内部/玩笑/注意/备注"等词，或明显是给自己的说明），
// 所以下面用白名单式词表，而不是"只要是 [[...]] 就剥"。

/** 像"给自己的元信息标注"的词。命中才剥，避免误伤 `[doge]` 这类正常用法。 */
const META_MARKER_WORDS = [
  '这是玩笑', '这是梗', '玩笑', '内部', '备注', '注意', '提示', '说明',
  '语气', '情绪', '动作', '心理', '内心', '旁白', 'self', 'note', 'inner',
  'meta', 'aside', 'tone', 'mood', 'action'
];

/**
 * 判断一个方括号片段是否是"模型给自己的元信息标注"。
 * @param {string} inner 括号内的文本
 */
function looksLikeMetaMarker(inner) {
  const s = String(inner ?? '').trim();
  if (!s) return false;
  if (s.length > 20) return false;          // 元标注都很短，长的一般是正常内容
  if (/[，。！？；：、\n]/.test(s)) return false; // 有标点=像正常句子，不剥
  const low = s.toLowerCase();
  return META_MARKER_WORDS.some((w) => low.includes(w.toLowerCase()));
}

/**
 * 剥掉消息**开头**的元信息标记。只处理最开头，只处理成对方括号，最多连剥两层。
 *
 * @param {string} text
 * @returns {string} 处理后的文本（没命中就原样返回）
 */
export function stripLeadingMetaMarker(text) {
  let s = String(text ?? '');
  for (let round = 0; round < 2; round++) {
    // 形如 [[这是玩笑]] 或 [这是玩笑]；后面紧跟正文（允许一个空格）
    const m = /^\s*\[\[?([^\[\]\n]{1,20})\]\]?\s*/.exec(s);
    if (!m) break;
    if (!looksLikeMetaMarker(m[1])) break;
    s = s.slice(m[0].length);
  }
  return s;
}

/** 对一组消息逐条剥离（返回新数组，不改原数组）。空结果回退原值，避免把消息变空。 */
export function stripLeadingMetaMarkers(messages) {
  if (!Array.isArray(messages)) return messages;
  return messages.map((m) => {
    const cleaned = stripLeadingMetaMarker(m);
    return cleaned.trim() === '' ? m : cleaned;
  });
}
