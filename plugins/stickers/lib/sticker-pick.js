// 表情包选择：按"这句话的语气"挑出合适的候选表情。
//
// 需求（2026-10-22 用户）：「现在依旧极少调用表情包，给出一个解决方案，
// 能够有更多机会并且根据回答语气选择合适表情包」。
//
// ── 为什么之前几乎不用（实测数据）────────────────────────────────────
//
//   `state/tool-calls.jsonl` 里 1999 次工具调用，`qq_send_sticker` 只出现 **1 次**。
//   原因不是没提示，而是三条叠在一起：
//     ① 提示是**软建议**（"大约每 3~5 轮来一张就够"）——模型可以永远不选；
//     ② 发表情必须**单独一条气泡**（OneBot 的 sticker 段不能带文字），
//        模型要多做一次工具调用，收益却是"可有可无"，自然被跳过；
//     ③ 全靠模型自觉，没有外部触发。
//
// ── 解法：桥接掷骰 + 只给 2~3 个候选 ────────────────────────────────
//
//   与自动 @ 同一思路：**由桥接决定"这一轮该不该发"**，模型只负责"从候选里挑一个
//   最贴语气的"。这比让模型自由判断有效得多——它的注意力在回话上，
//   不该再分一份去想要不要发表情。
//
//   选候选时按语气标签匹配：把表情的备注（desc/localNote/tags）归到几个大语气类，
//   再按本轮回复的文本判断语气，取同类候选。这样"被吐槽 → 无语脸"、
//   "夸人 → 害羞/得意"才对得上，而不是随机丢一张。
//
// ── 为什么每个情绪只留一张代表 ─────────────────────────────────────
//
//   候选多了模型反而挑不动（实测它在长列表里倾向"不用"）。
//   所以每类最多给 2 张，总量控制在 3 张以内，并在提示里明确"选一个或不发"。
import { normalizeStickerEntry } from './sticker-lib.js';

/**
 * 语气分类表。
 *
 * key 是内部标签，value 是**匹配备注文本的关键词**。
 * 这些词来自现有表情库的真实备注（实测 40 个里 34 个有备注，
 * 形如"蓝发女仆小鲸鱼无语脸，被吐槽时用"），所以直接用中文子串匹配就够准，
 * 不需要分词或模型判断。
 */
export const MOOD_RULES = [
  { mood: 'speechless', label: '无语/被吐槽', words: ['无语', '翻白眼', '白眼', '沉默', '汗', '尴尬', '敷衍', '哦鲸鲸', '撇嘴', '冷笑', '鄙视'] },
  { mood: 'laugh', label: '搞笑/整活', words: ['搞笑', '笑', '哈', '乐', '草', '打滚', '滑稽', '整活', '绷'] },
  { mood: 'shy', label: '害羞/脸红', words: ['害羞', '脸红', '羞', '捂脸', '不好意思', '♥', '心'] },
  { mood: 'angry', label: '生气/不满', words: ['生气', '怒', '气', '凶', '瞪', '炸', '恼'] },
  { mood: 'sad', label: '难过/委屈', words: ['难过', '哭', '委屈', '伤心', '泪', '叹气', '失落'] },
  { mood: 'cute', label: '撒娇/卖萌', words: ['撒娇', '萌', '可爱', '亲亲', '抱', '贴贴', '猫', '捏'] },
  { mood: 'agree', label: '赞同/点头', words: ['赞同', '同意', '点头', 'ok', '好', '对', '赞', '握手'] },
  { mood: 'confused', label: '疑惑/问号', words: ['疑惑', '问号', '？', '?', '不懂', '沉思', '歪头', '迷惑'] },
  { mood: 'greet', label: '打招呼/告别', words: ['你好', '嗨', '挥手', '拜拜', '晚安', '再见', '早安', '打招呼'] },
  { mood: 'proud', label: '得意/炫耀', words: ['得意', '自信', '炫', '胜利', '耶', '酷', '棒'] }
];

/** 从一条表情的文本里推断它属于哪个语气（取第一个命中的规则）。 */
export function moodOfSticker(entry) {
  const e = normalizeStickerEntry(entry) || entry || {};
  const hay = [
    e.desc, e.localNote, e.usage,
    ...(Array.isArray(e.tags) ? e.tags : [])
  ].filter(Boolean).join(' ').toLowerCase();
  if (!hay) return '';
  for (const r of MOOD_RULES) {
    if (r.words.some((w) => hay.includes(String(w).toLowerCase()))) return r.mood;
  }
  return '';
}

/**
 * 从一段回复文本判断语气。
 *
 * 只用**轻量规则**，不调模型：这里要的是"这句话像什么情绪"，
 * 用关键词 + 标点已经够（"哈哈" → 搞笑、"……" → 无语、"？" → 疑惑）。
 * 判断错了的代价很小——只是挑的表情不太贴，而不是发错东西。
 */
export function moodOfText(text) {
  const s = String(text ?? '');
  // 顺序很重要：**具体的语气要排在泛匹配前面**。
  // 实测踩到：「哇你好厉害啊」先命中了"你好"（greet）被分到打招呼，
  // 而它显然是"夸人/得意"。所以把 proud/agree 这类明确词放前面，
  // greet 的"你好/嗨"这种弱词放最后。
  const rules = [
    ['laugh', /哈哈|嘿嘿|笑死|绷不住|乐死|😂|🤣|草/],
    ['speechless', /无语|算了|行吧|就这|随你|……|\.\.\.|服了|醉了|醉了/],
    ['proud', /厉害|牛|强|棒|优秀|佩服|高手|居然|竟然/],
    ['shy', /害羞|脸红|不好意思|别夸|哪有|捂脸|谦虚/],
    ['angry', /生气|气死|烦死|滚|别闹|过分|讨厌/],
    ['sad', /难过|想哭|委屈|唉|伤心|失落/],
    ['confused', /[?？]{1,}|不懂|啥意思|啊这|迷惑|什么鬼/],
    ['cute', /贴贴|抱抱|亲亲|喵|人家嘛|啾/],
    ['agree', /好的|可以|没问题|确实|同意|嗯嗯|^ok$/i],
    ['greet', /晚安|拜拜|再见|早安|^(你好|嗨)/]
  ];
  for (const [mood, re] of rules) if (re.test(s)) return mood;
  return '';
}

/**
 * 挑选候选表情。
 *
 * @param {Array} entries 表情库
 * @param {object} opts
 *   - replyText  本轮要发的回复（用来判断语气）
 *   - recentIds  最近发过的表情 id/md5（避免连续同一张）
 *   - max        最多给几个（默认 3）
 *   - excludeIds 明确排除
 * @returns {{mood:string, moodLabel:string, picks:Array<{id:string,label:string,useCount:number}>}}
 */
export function pickStickerCandidates(entries, opts = {}) {
  const max = Math.max(1, Math.min(6, Number(opts.max) || 3));
  const list = (Array.isArray(entries) ? entries : []).map(normalizeStickerEntry).filter(Boolean);
  const recent = new Set((Array.isArray(opts.recentIds) ? opts.recentIds : []).map(String));
  const excluded = new Set((Array.isArray(opts.excludeIds) ? opts.excludeIds : []).map(String));

  // 先用回复文本判语气；判不出来就用"通用"（按使用次数取常用的）
  const mood = moodOfText(opts.replyText) || '';
  const rule = MOOD_RULES.find((r) => r.mood === mood);
  const label = rule ? rule.label : '通用';

  // 分组：同语气的排前面，其次按用过次数（越常用越可能是好用的）
  const scored = list.map((e) => {
    const eMood = moodOfSticker(e);
    const idKey = String(e.md5 || e.id || '');
    let score = Number(e.useCount) || 0;
    if (mood && eMood === mood) score += 1000;      // 语气匹配，压倒性优先
    if (!mood && eMood) score += 100;               // 没判出语气时，有明确场景的优先
    // **加一点随机扰动**：否则 useCount 最高的那张永远排第 1，
    // 而模型总选"第 1 个"（实测连续三次都是同一张 9FE3D97B）。
    // 扰动 0~400：仍小于"语气匹配"的 1000（不破坏语气准确性），
    // 但足以让同一语气里的多张轮换（useCount 差值通常只有个位数）。
    score += Math.random() * 400;
    if (recent.has(idKey)) score -= 5000;           // 刚发过，基本排除
    if (excluded.has(idKey)) score -= 100000;       // 明确排除
    return { e, idKey, score, eMood };
  }).filter((x) => x.idKey && x.score > -10000)
    .sort((a, b) => b.score - a.score);

  // 候选要**多样**：第 1 张严格取最贴语气的，后面两张换别的语气，
  // 免得三张都是"无语脸"（实测原有排序里 2/3 位永远是同一类——
  // 因为无语类表情用得最多，按 useCount 排就会霸榜）。
  // 模型拿到"无语/搞笑/疑惑"三选一，比"三张无语"更容易挑出贴切的。
  const picks = [];
  const usedMoods = new Set();
  const take = (pred) => {
    for (const x of scored) {
      if (picks.length >= max) return;
      if (picks.some((p) => p.id === x.idKey)) continue;
      if (!pred(x)) continue;
      picks.push({
        id: x.idKey,
        label: String(x.e.desc || x.e.localNote || '(无备注)').slice(0, 40),
        mood: x.eMood,
        useCount: Number(x.e.useCount) || 0
      });
      usedMoods.add(x.eMood || '_');
      return;
    }
  };
  // ① 先取语气完全匹配的
  if (mood) take((x) => x.eMood === mood);
  // ② 再取**其它语气**（各一个），保证候选之间不重样
  take((x) => x.eMood && !usedMoods.has(x.eMood));
  take((x) => x.eMood && !usedMoods.has(x.eMood));
  // ③ 还不够就用"无明确场景"的补位（按使用次数）
  while (picks.length < max) {
    const before = picks.length;
    take(() => true);
    if (picks.length === before) break;
  }

  return { mood, moodLabel: label, picks: picks.slice(0, max) };
}

/**
 * 生成"该发一张表情"的提示行。
 *
 * 关键措辞考量（都来自实测教训）：
 *   - **必须明确要求"这一轮发一张"**，而不是"可以考虑"——软措辞等于不发；
 *   - 给出**具体候选 md5**，省掉一次 qq_list_stickers 调用（模型很懒，
 *     多一步调用就会放弃）；
 *   - 允许"真的不贴就别发"，避免硬塞一张不合语境的表情；
 *   - 强调**单独一条气泡**，否则模型会试图和文字混在一起（OneBot 不支持）。
 */
export function buildStickerNudge(candidates, opts = {}) {
  const { moodLabel, picks } = candidates ?? {};
  if (!Array.isArray(picks) || !picks.length) return '';
  const lines = picks.map((p, i) => `  ${i + 1}. ${p.label}${p.mood ? `（${p.mood}）` : ''}  md5=${p.id}`);
  // hint 优先取 opts，其次取 candidates 里带的。
  // 为什么两处都认：planStickerV2 把语境塞在 plan 对象里，
  // 而单独调用时更自然的是第二参数。实测踩到过只认一处导致语境丢失。
  const hint = String(opts.hint ?? candidates?.hint ?? '').trim();
  return `【这一轮请附一张表情】
${hint ? hint + '\n' : ''}你刚才这句的调子是「${moodLabel || '通用'}」，从下面选一张最贴的，用 qq_send_sticker 单独发一条气泡（不能和文字混在同一个气泡里）：
${lines.join('\n')}

要求：
- **必须发一张**：先把你的文字回复发了，再单独发这张表情（两步，两个气泡）。
- 选**最贴刚才语气**的那张；拿不准就选第 1 个。
- 如果确实一句都贴不上（比如在谈正事/严肃话题），可以只回「跳过」两个字，不发。
- 不要在文字里描述你发了什么表情。`}
