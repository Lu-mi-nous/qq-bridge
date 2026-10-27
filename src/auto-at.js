/**
 * 回复时按概率 @ 对方 —— **桥接侧决定，模型不用操心**。
 *
 * ## 为什么要桥接做（而不是让模型自己传 atUserId）
 *
 * `qq_send_message` / `qq_reply` 早就支持 `atUserId` 参数，但实测模型几乎不主动传：
 * 30 天会话里 `qq_send_message` 调用 4174 次，带 `atUserId` 的屈指可数。
 * 原因很实在——群里绝大多数对话不需要 @（对着谁说话本来就清楚），
 * 而模型要判断"这次该不该 @"得额外想一步，收益又不明显，于是默认省略。
 *
 * 用户要的是「回复时有概率 @ 发出消息的人」：像真人一样偶尔点一下名，
 * 让对话有指向感，但不是每条都 @（每条都 @ 反而像客服机器人）。
 * 这属于**发送行为的外观**，不是语义判断，交给桥接掷骰更稳定。
 *
 * ## 关键设计：@ 谁必须准确
 *
 * @ 错人比不 @ 糟糕得多（群里会立刻尴尬）。所以目标只有两个来源，都要求"确实是这个人"：
 *
 *   1. **显式引用**（replyToMessageId 解析出的那条消息）→ @ 它的作者。
 *      这是最强的信号：模型主动引用了某人，说明在回他。
 *   2. **没有引用时**→ 在未读消息里挑**"这条回复最可能在回谁"**（见 pickUnreadTarget）。
 *
 * 排除：私聊（不需要 @）、@ 自己、@ 系统/匿名、目标 QQ 号非法。
 *
 * ## 为什么第 2 条不能只取"未读里最后一条"（2026-10-20 真实事故）
 *
 * 群里的实际时间线：
 *   17:36:08  记者：「明天开会的东西还没看完」
 *   17:36:09  记者：「他妈的」
 *   17:36:58  编辑：「我是153」（插话，跟前面无关）
 *   17:36:59  机器人：「这个点还没看完就别硬看了，明天顶着困去开会更亏」→ **@ 了编辑**
 *
 * 那句回复显然是回记者的（"还没看完""去开会"都是记者说的），但旧逻辑取"未读里
 * 最后一条他人消息"的作者，正好被中间插话的编辑顶掉。群里立刻有人指出"@错人了吧"。
 *
 * 现在改为**按内容相关性选人**：把要发的回复文本与每个人说过的话做字面重合度比较，
 * 取最相关的那个人。上例中「还没看完」「开会」全部命中记者的两条消息，
 * 编辑的「我是153」完全不沾，于是正确 @ 记者。
 *
 * ## 什么情况**不该** @（即使掷中）
 *
 *   - 已经显式 @ 了（模型自己传了 atUserId）——不叠加。
 *   - 句子本身像"自言自语/收尾"（"睡觉了""哈哈哈"）——@ 上去显得莫名其妙。
 *     这里只挡最明显的几种，宁漏不误。
 *   - 本会话刚 @ 过（默认 5 分钟内）——避免连续点名像催债。
 *   - **回复与所有未读都对不上**（谁都不沾）——宁可不 @，也别乱指一个人。
 */

/** 默认配置（可被 config.json 的 socialV2.send.autoAt 覆盖） */
export const DEFAULT_AUTO_AT = {
  enabled: true,
  probability: 0.3,          // 掷中概率
  // 无引用时，只 @ 这个时间窗内的最近一条他人消息。
  // 10 分钟而非 3 分钟：实测群聊正常节奏下"上一条他人消息"距今 2~6 分钟很常见
  // （三个活跃群抽样：2 秒 / 194 秒 / 374 秒）。窗口太窄会让大多数回复都选不到人，
  // 功能等于没开。窗口只用来挡"回一句无关的话却 @ 三小时前的人"，不需要很紧。
  windowMs: 10 * 60 * 1000,
  cooldownMs: 5 * 60 * 1000, // 同会话两次自动 @ 的最小间隔
  maxPerHour: 10,            // 每小时最多自动 @ 次数（防刷）
  // 「回最后一条且时间相近就不 @」的门槛（2026-10-20 用户要求）。
  // 超过它就认为"隔了太久"，需要点名接上话头。默认 1 小时。
  staleAfterMs: 60 * 60 * 1000,
  // 内容匹配的最低门槛：回复与某人说的话重合度低于它就不 @（宁可不 @ 也不乱指人）。
  // 0.12 是实测值：真实事故里记者的匹配度约 0.45、插话编辑约 0，
  // 无关闲聊通常 < 0.1。门槛太低会让"完全不沾"的人也混进来。
  minOverlap: 0.12,
  // 反向覆盖率（"对方说的有多少被回复覆盖"）只对足够长的文本启用。
  //
  // 为什么（2026-10-22 group:1000000007 事故）：群友A只说了 6 个 2-gram
  // 「@…大肥鱼可爱」，其中 2 个（大肥/肥鱼）与回复里的「给大肥鱼买鱼食」重合，
  // 反向覆盖率 2/6=33%，打 0.6 折仍有 0.20——压过了真正点单的群友B（4/24=0.1667）。
  // 短句里"顺口提了个共同词"太容易发生，不能按比例放大。
  backwardMinGrams: 8,
  // 「未读里明确 @ 它 / 引用它」这条信号的时效。
  // 超过这个时长的 @ 不再作为"正在跟它说话"的理由——群里话题早就换了。
  // 2 分钟够覆盖「@它 → 它读完 → 回复」的正常链路（实测一次回合约 20~40 秒）。
  addressedTtlMs: 2 * 60 * 1000
};

// 自言自语/收尾类：这类话 @ 人很奇怪。
// 保守清单——只挡最明显的，避免把正常的点名回复也挡掉。
const SELF_TALK_PATTERNS = [
  /^(哈哈|嘿嘿|呵|嗯+|哦+|噢|诶+|哎|唉|草|卧槽|好耶|睡了|晚安|溜了|走了|下了|吃饭去)/,
  /(睡了|晚安|下了|溜了|先忙|不聊了)[。！!~～]*$/,
];

/**
 * 从消息对象里取出可用于 @ 的 QQ 号。
 * 群里 sender 是昵称、userId 才是号；两者都可能缺失（系统消息）。
 */
export function atTargetOf(message) {
  if (!message || typeof message !== 'object') return null;
  if (message.isSelf) return null;
  const raw = message.userId ?? message.user_id ?? message.senderId ?? null;
  const s = raw == null ? '' : String(raw).trim();
  // QQ 号是正整数；排除 0、all、空、非数字
  if (!/^[1-9]\d{4,11}$/.test(s)) return null;
  return s;
}

/** 这句话是否"像自言自语"，不适合 @ 人 */
export function looksLikeSelfTalk(text) {
  const t = String(text ?? '').trim();
  if (!t) return false;
  return SELF_TALK_PATTERNS.some((re) => re.test(t));
}

/**
 * 这条消息是不是「拍一拍」事件。
 *
 * 拍一拍虽然是"冲你来的"，但它**没有说话**，不能作为「在回谁」的线索：
 * 没人会通过拍一下来表达一个可回复的观点。把它排除在 @ 目标之外是必要的——
 * 实测事故（2026-10-21 group:1000000005）：某人刚戳过机器人，几秒后别人问「那你怎么漏的」，
 * 机器人却 @ 了那个只戳过它的人。
 *
 * 判据同时看文本前缀和结构化字段（`kind: 'poke'` / `poke` 对象），
 * 因为 appendSocialV2Poke 写的是结构化字段，文本前缀只是可读呈现。
 */
export function isPokeMessage(m) {
  if (!m || typeof m !== 'object') return false;
  if (m.kind === 'poke') return true;
  if (m.poke && typeof m.poke === 'object') return true;
  return /^\[拍一拍\]/.test(String(m.text ?? m.plain ?? ''));
}

// ── 文本重合度（用于判断"这条回复在回谁"）──────────────────────────────────

/**
 * 这个消息是不是**明确在叫机器人**（@ 它 / 引用它 / 直接对它的提问）。
 *
 * 为什么需要这一层：字面重合度对"短回应"天然失效。
 * 真实事故（2026-10-21）：Lu-mi-nous 问「@大肥鱼 你用了多少token」，
 * 机器人回「喏，图来了」——零重合，匹配不出人；但这条**明明就是在回答 Lu-mi-nous**。
 * 「@ 了我」本身就是最强的指向信号，不需要再看用词。
 *
 * 判据与 bridge.js 的 findCallersV2 保持一致（那边判断"谁在叫我"用的是同一套）：
 *   - 引用机器人的消息（quoteTargetIsSelf）
 *   - 文本里出现 @<任一别名>（别名 = 角色名 / 群昵称 / 唤醒关键词）
 *
 * @param {object} m 消息对象
 * @param {string[]} aliasNames 机器人别名
 */
export function isAddressedToBot(m, aliasNames = []) {
  if (!m || m.isSelf) return false;
  // 入站时直接从 OneBot 的 at 段判定的结果，最可靠：
  // 不依赖机器人当前群名片/昵称是否在别名表里（2026-10-22 事故就是别名表缺群名片，
  // 导致所有 `@?！哦鲸鲸  ? !` 都不算在叫它）。老消息没有这个字段时走下面的别名匹配。
  if (m.atSelf) return true;
  if (m.quoteTargetIsSelf) return true;
  const t = String(m.plain ?? m.text ?? '');
  if (!t) return false;
  const lower = t.toLowerCase();
  return (Array.isArray(aliasNames) ? aliasNames : [])
    .map((x) => String(x ?? '').trim())
    .filter(Boolean)
    .some((nm) => lower.includes(`@${nm}`.toLowerCase()));
}

/**
 * 停用词：这些词在任何一句话里都常见，拿它们算重合会误判。
 * 中文没空格，所以这里只挡单字虚词与常见功能词。
 */
const STOP_WORDS = new Set([
  '的', '了', '是', '在', '我', '你', '他', '她', '它', '们', '这', '那',
  '不', '也', '就', '都', '和', '与', '还', '有', '没', '要', '会', '能',
  '啊', '吧', '呢', '吗', '呀', '哦', '嗯', '哈', '个', '把', '被', '给',
  'the', 'a', 'an', 'is', 'are', 'to', 'of', 'and', 'or', 'in', 'on', 'it'
]);

/**
 * 把文本切成用于比较的片段。
 *
 * 为什么用**中文 2-gram + 英文单词**：中文没有空格，不做分词的话整句只能整体比较；
 * 而项目里没有分词库，也**不值得为这个功能引一个**（体积、启动耗时都不划算）。
 * 2-gram（相邻两字）是中文近似匹配的常用做法，实测能稳定区分
 * 「还没看完/开会」与「我是153」这种完全无关的短句。
 *
 * 单字不参与（除了保留英文单词）：单字重合太容易，会把无关句子也算成相关。
 *
 * @param {string} text
 * @returns {Set<string>}
 */
export function textGrams(text) {
  const s = String(text ?? '')
    // 全角转半角没必要，但要统一大小写、去掉零宽与多余空白
    .replace(/[\u200b-\u200f\ufeff]/g, '')
    .toLowerCase();
  const out = new Set();
  // 英文/数字单词（>=2 字符）
  for (const w of s.match(/[a-z0-9]{2,}/g) || []) {
    if (!STOP_WORDS.has(w)) out.add(`w:${w}`);
  }
  // 中文：按连续中文字符分段，每段取相邻 2 字
  for (const seg of s.match(/[\u4e00-\u9fa5]+/g) || []) {
    if (seg.length === 1) continue; // 单字不成 gram
    for (let i = 0; i < seg.length - 1; i++) {
      const g = seg.slice(i, i + 2);
      // 两个都是虚词时跳过（"的是""了也"这类没有信息量）
      if (STOP_WORDS.has(g[0]) && STOP_WORDS.has(g[1])) continue;
      out.add(g);
    }
  }
  return out;
}

/**
 * 把"机器人自己的名字"从待比文本里去掉。
 *
 * 为什么需要（2026-10-22 group:1000000007）：回复里写了「给大肥鱼买鱼食」，
 * 群友A的短句「@…大肥鱼可爱」也含「大肥鱼」。两者共享的只是**机器人的名字**，
 * 并不表示在聊同一件事——名字本身不能当作"在回谁"的证据。
 *
 * ignoreNames：按普通子串去掉（角色名/群名片这类真正的名字）。
 * ignoreAtNames：只去掉 `@名字` 形式。关键词（DS/R1 等）可能很短，
 * 裸子串替换会把正常词汇切碎，所以只认带 @ 的写法。
 */
function stripBotNames(text, opts = {}) {
  let s = String(text ?? '');
  const byLengthDesc = (arr) => (Array.isArray(arr) ? arr : [])
    .map((x) => String(x ?? '').trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  // 长的先替换，避免「大肥鱼」先被「肥鱼」截成「大」+ 残留
  for (const nm of byLengthDesc(opts.ignoreAtNames)) {
    s = s.split(`@${nm}`).join(' ');
  }
  for (const nm of byLengthDesc(opts.ignoreNames)) {
    if (nm.length < 2) continue; // 单字名字替换会误伤正文
    s = s.split(nm).join(' ');
  }
  return s;
}

/**
 * 两段文本的重合度（0~1）。
 *
 * 用**双向覆盖率的最大值**而不是 Jaccard：
 * 回复通常比对方原话短很多（"别硬看了" vs "明天开会的东西还没看完"），
 * Jaccard 会被长度差稀释到接近 0，而"回复里的词有多少出现在对方话里"
 * 才是我们要的信号。反向也取一次，避免某人说了一句话而回复很长时被漏掉。
 *
 * opts.ignoreNames / opts.ignoreAtNames：见 stripBotNames。
 * opts.backwardMinGrams：反向覆盖率只在对方文本够长时启用（见 DEFAULT_AUTO_AT 说明）。
 */
export function textOverlap(replyText, otherText, opts = {}) {
  const a = textGrams(stripBotNames(replyText, opts));
  const b = textGrams(stripBotNames(otherText, opts));
  if (!a.size || !b.size) return 0;
  let hit = 0;
  for (const g of a) if (b.has(g)) hit += 1;
  const forward = hit / a.size;
  // 反向：对方说的有多少被回复覆盖（短回复场景下通常更低，取 max 是为了
  // 不让"对方话很长、回复很短但完全对口"的情况被压掉）
  const backwardMinGrams = Math.max(0, Number(opts.backwardMinGrams ?? DEFAULT_AUTO_AT.backwardMinGrams));
  if (b.size < backwardMinGrams) return forward;
  let hit2 = 0;
  for (const g of b) if (a.has(g)) hit2 += 1;
  const backward = hit2 / b.size;
  return Math.max(forward, backward * 0.6); // 反向打折：长消息天然容易覆盖短回复
}

/**
 * 从**未读消息**里挑"这条回复最可能在回谁"。
 *
 * 取代原来"取最后一条他人消息"的做法（见文件头的事故说明）。
 *
 * 规则：
 *   1. 按人聚合，但**逐条算重合度取最大值**，不把多句话拼成一段再算比例。
 *      拼接会稀释：话多的人说了一堆无关内容，真正对口的那句被平均掉。
 *      （2026-10-22 事故：群友B的「给我发张百亿鲸元券」精确命中 4 个 gram，
 *      但同窗口里他还说了 3 句无关的话，4/24=0.1667，输给了短句 2/6×0.6=0.20。）
 *   2. 取重合度最高的人；**同分时**取"最近说过话"的那个（更像在接当前话题）。
 *   3. 最高重合度低于 `minOverlap` → 返回 null（谁都不沾就不 @，别乱指人）。
 *   4. 完全没有文本（纯图片/表情）时 → 退回"最近一条他人消息"的旧行为，
 *      因为这时候没有内容可比，位置信息是唯一线索。
 *
 * 返回里带 `candidates`（前 3 名与分数），供 `[自动@]` 日志定位误判。
 *
 * @param {Array} unread 未读消息（含 isSelf / userId / sender / text|plain / time）
 * @param {string} replyText 本次要发的第一条文本
 * @param {{minOverlap?:number, ignoreNames?:string[], ignoreAtNames?:string[], backwardMinGrams?:number}} opts
 * @returns {{userId:string, overlap:number, sender:string, reason:string, candidates:Array}|null}
 */
export function pickUnreadTarget(unread, replyText, opts = {}) {
  const minOverlap = Number(opts.minOverlap ?? DEFAULT_AUTO_AT.minOverlap) || 0;
  const list = (Array.isArray(unread) ? unread : []).filter((m) => {
    if (!m || m.isSelf) return false;
    // 拍一拍没有说话，不能作为"在回谁"的线索（见 isPokeMessage 注释里的事故）
    if (isPokeMessage(m)) return false;
    return !!atTargetOf(m);
  });
  if (!list.length) return null;

  // 按人聚合：userId → { texts:[], lastAt, sender }
  const byUser = new Map();
  for (const m of list) {
    const uid = atTargetOf(m);
    if (!uid) continue;
    const entry = byUser.get(uid) || { userId: uid, texts: [], lastAt: 0, sender: '' };
    const t = String(m.plain ?? m.text ?? '').trim();
    if (t) entry.texts.push(t);
    const at = Number(m.time) || 0;
    if (at >= entry.lastAt) {
      entry.lastAt = at;
      entry.sender = String(m.sender ?? '').trim();
    }
    byUser.set(uid, entry);
  }
  if (!byUser.size) return null;

  const hasAnyText = [...byUser.values()].some((e) => e.texts.length);
  if (!hasAnyText) {
    // 全是图片/表情：没有内容可比，用"最近说话的人"作唯一线索
    const arr = [...byUser.values()].sort((a, b) => b.lastAt - a.lastAt);
    const pick = arr[0];
    return { userId: pick.userId, overlap: 0, sender: pick.sender, lastAt: pick.lastAt, reason: 'hit:unread-recent', candidates: [] };
  }

  const scored = [...byUser.values()].map((e) => {
    // 逐条比较取最大：多句闲话不该把一句精确命中平均掉
    let overlap = 0;
    let matchedText = '';
    for (const t of e.texts) {
      const o = textOverlap(replyText, t, opts);
      if (o > overlap) {
        overlap = o;
        matchedText = t;
      }
    }
    return { ...e, overlap, matchedText };
  });
  scored.sort((a, b) => (b.overlap - a.overlap) || (b.lastAt - a.lastAt));
  const best = scored[0];
  const candidates = scored.slice(0, 3).map((e) => ({
    userId: e.userId,
    sender: e.sender,
    overlap: Number(e.overlap.toFixed(3)),
    lastAt: e.lastAt,
    matchedText: String(e.matchedText).slice(0, 40)
  }));
  if (!(best.overlap >= minOverlap)) {
    // 谁都不沾 → 不 @。这比随便指一个人安全（真实事故就是这么来的）
    return null;
  }
  return {
    userId: best.userId,
    overlap: best.overlap,
    sender: best.sender,
    // 这个人最后说话的时间：调用方用它判断"是不是就是当前最后一条、且刚说过"
    // （那种情况直接发就行，再 @ 反而多余，见 pickAutoAt 里的说明）。
    lastAt: best.lastAt,
    reason: 'hit:unread-match',
    matchedText: String(best.matchedText).slice(0, 80),
    candidates
  };
}

/**
 * 判断"这次是否真的需要 @"。
 *
 * 需求（2026-10-20 用户）：「只在回复的消息不在当前会话中的最后一条消息时，
 * 或者要回复的是最后一条但是和当前时间差距超过 1h 时才 @ 人；
 * 如果是最后一条且时间相近，直接发送即可」。
 *
 * 道理：@ 的唯一作用是**指明在跟谁说话**。回刚才最后一条、就在几十秒内，
 * 谁都知道在回谁，@ 是噪音。只有"回更早的某条"（中间插了别人的话）或
 * "最后一条已经过去很久"（怕对方以为你在自言自语）时才需要点名。
 *
 * 判据：
 *   1. 若目标不是**最后一条他人消息**（后面还有人说过话）→ 需要 @。
 *   2. 若它就是最后一条 → 时间差超过 `staleAfterMs`（默认 1 小时）才 @。
 *   3. 拿不到位置/时间信息时**倾向需要 @**（信息不足时点名更安全——
 *      误解对象的代价比多一个 @ 大）。
 *
 * @returns {{needed:boolean, reason:string}}
 */
export function shouldAutoAt(opts = {}) {
  const now = Number(opts.now ?? Date.now());
  const staleAfterMs = Math.max(0, Number(opts.cfg?.staleAfterMs ?? DEFAULT_AUTO_AT.staleAfterMs));
  const recent = Array.isArray(opts.recentMessages) ? opts.recentMessages : [];
  const target = String(opts.target ?? '');
  const targetAt = Number(opts.targetAt) || 0;
  if (!target) return { needed: false, reason: 'no-target' };

  // 找"最后一条他人消息"（跳过机器人自己的）
  let lastOther = null;
  for (let i = recent.length - 1; i >= 0; i--) {
    const m = recent[i];
    if (!m || m.isSelf) continue;
    if (!atTargetOf(m)) continue;
    lastOther = m;
    break;
  }

  if (!lastOther) {
    // 没有任何他人消息可参照 → 需要点名（信息不足时偏向 @）
    return { needed: true, reason: 'need:no-last-other' };
  }

  const lastUid = atTargetOf(lastOther);
  const lastTime = Number(lastOther.time) || 0;
  // 目标是不是"最后一条他人消息"：同一人，且时间不早于它
  const isLast = lastUid === target && (targetAt === 0 || lastTime === 0 || targetAt >= lastTime);

  if (!isLast) {
    // 后面还有人说过话 → 必须点名，否则群友会以为在回最后那个人
    return { needed: true, reason: 'need:not-last' };
  }

  // 就是最后一条：时间差够大才 @
  const at = lastTime || targetAt;
  if (!at) {
    // 完全拿不到时间 → 无法判断"是否相近"，偏向 @
    return { needed: true, reason: 'need:no-time' };
  }
  // staleAfterMs === 0 表示**关闭这条规则**（总是允许 @），用于测试/调试；
  // 线上默认 1 小时。
  if (staleAfterMs === 0) return { needed: true, reason: 'need:rule-off' };
  const gap = now - at;
  if (gap > staleAfterMs) {
    return { needed: true, reason: `need:stale(${Math.round(gap / 60000)}m)` };
  }
  return { needed: false, reason: 'skip:last-and-fresh' };
}

/**
 * 选出这次回复该 @ 谁。
 *
 * 目标优先级（越靠前越准）：
 *   1. **引用对象**：模型主动引用了某人 → 就是在回他，最准。
 *   2. **未读消息的作者**：这次是被这些消息唤醒的，他们才是"叫它的人"。
 *      比 recentMessages 准——recentMessages 里混着它自己刚发的消息和早已聊完的旧话。
 *   3. **最近一条他人消息**：兜底（受时间窗限制）。
 *
 * 选定之后还要过一遍 shouldAutoAt：**回最后一条且时间相近时不 @**。
 *
 * @param {object} opts
 * @param {'group'|'private'} opts.kind        会话类型（私聊直接返回 null）
 * @param {string|number} opts.atUserId        模型已显式指定的 @ 目标（有就不再自动加）
 * @param {object|null} opts.quoted            引用解析结果 { userId, sender, ... }
 * @param {Array} opts.unreadMessages          会话未读（本次唤醒的直接原因）
 * @param {Array} opts.recentMessages          会话最近消息（含 isSelf / userId / time）
 * @param {string} opts.replyText              本次要发的第一条文本（判断是否自言自语）
 * @param {number} opts.lastAutoAt             上次自动 @ 的时间戳
 * @param {Array<number>} opts.autoAtTimes      最近自动 @ 的时间戳列表（算每小时上限）
 * @param {object} opts.config                 覆盖 DEFAULT_AUTO_AT
 * @param {() => number} opts.random           随机数（测试注入）
 * @param {number} opts.now                    当前时间（测试注入）
 * @returns {{ userId: string|null, reason: string }}
 */
export function pickAutoAt(opts = {}) {
  const cfg = { ...DEFAULT_AUTO_AT, ...(opts.config || {}) };
  const now = Number(opts.now ?? Date.now());
  const random = typeof opts.random === 'function' ? opts.random : Math.random;
  const none = (reason) => ({ userId: null, reason });

  if (!cfg.enabled) return none('disabled');
  if (opts.kind !== 'group') return none('private');
  // 模型自己 @ 了：尊重它，不叠加
  if (opts.atUserId != null && String(opts.atUserId).trim() !== '') return none('already-at');

  // 冷却 + 每小时上限
  const lastAutoAt = Number(opts.lastAutoAt) || 0;
  if (cfg.cooldownMs > 0 && lastAutoAt > 0 && now - lastAutoAt < cfg.cooldownMs) {
    return none('cooldown');
  }
  const hourly = (Array.isArray(opts.autoAtTimes) ? opts.autoAtTimes : [])
    .map(Number).filter((t) => Number.isFinite(t) && t > 0 && now - t < 3600000);
  if (cfg.maxPerHour > 0 && hourly.length >= cfg.maxPerHour) return none('hourly-cap');

  if (looksLikeSelfTalk(opts.replyText)) return none('self-talk');

  // ── 目标优先级：引用 → 未读里明确叫它的 → 内容匹配 → （仅在无未读可定位时）最近说话的人 ──
  let target = null;
  let source = '';
  // 命中依据（只用于日志定位：@错人时能一眼看出分数与候选）
  let overlap = 0;
  let matchedText = '';
  let candidates = [];

  const quotedId = atTargetOf({ userId: opts.quoted?.userId, isSelf: false });
  if (quotedId) {
    target = quotedId;
    source = 'quoted';
  }

  // @ 目标的最后说话时间（用于下面的"是否需要点名"判断）
  let targetAt = 0;

  const unreadList = Array.isArray(opts.unreadMessages) ? opts.unreadMessages : [];
  const unreadHasTargets = unreadList.some((m) => m && !m.isSelf && atTargetOf(m));

  if (!target && unreadHasTargets) {
    // ① 未读里**明确在叫它**的人（@它 / 引用它）——最强信号，优先于字面匹配。
    //    短回应（"喏，图来了"）与问题零重合，靠字面永远选不到人，但它显然是在回提问者。
    //
    // 三条约束缺一不可，每一条都对应一次实测事故：
    //
    //   a) **排除拍一拍**：`[拍一拍] 群友E 戳了戳 你` 从"是不是在叫它"看也算命中，
    //      但拍一拍没有说话，不可能是回复对象。
    //      （2026-10-21 group:1000000005：群友E 刚戳过它，几秒后别人提问，它 @ 了群友E）
    //
    //   b) **每个人只看最近一条有实质内容的消息**，而不是他所有历史消息的并集。
    //      否则一条几分钟前的 @ 会让人无限期地"正在叫它"。
    //      （同群事故：不会忘本 13:08 叫过它，之后只发图片/拍一拍，13:12 仍被选中）
    //
    //   c) **时效**：这条 @ 必须够新。群里 @ 完聊别的话题了，就不该再拿那次 @ 当理由。
    //      默认 2 分钟——足够覆盖"@它 → 它读完 → 回复"的正常链路。
    const aliasNames = Array.isArray(opts.aliasNames) ? opts.aliasNames : [];
    const addressedTtl = Math.max(0, Number(cfg.addressedTtlMs ?? DEFAULT_AUTO_AT.addressedTtlMs));
    const latestPerUser = new Map(); // userId -> 该用户最近一条有实质内容的消息
    for (const m of unreadList) {
      const uid = atTargetOf(m);
      if (!uid) continue;
      // 图片/表情/拍一拍都不算"有实质内容"——它们不能表达 @ 之外的意图
      if (isPokeMessage(m)) continue;
      const txt = String(m.plain ?? m.text ?? '').trim();
      if (!txt || /^\[(图片|表情|动画表情|语音|视频|文件|卡片消息)/.test(txt)) continue;
      const prev = latestPerUser.get(uid);
      if (!prev || (Number(m.time) || 0) >= (Number(prev.time) || 0)) latestPerUser.set(uid, m);
    }
    let bestAddressed = null;
    const addressedCandidates = [];
    for (const m of latestPerUser.values()) {
      if (!isAddressedToBot(m, aliasNames)) continue;
      const t = Number(m.time) || 0;
      if (addressedTtl > 0 && t > 0 && now - t > addressedTtl) continue;  // 太旧的 @ 不算
      addressedCandidates.push(m);
      if (!bestAddressed || t >= (Number(bestAddressed.time) || 0)) bestAddressed = m;
    }
    // 多个"在叫它"的候选时，**不能只取最新的那个**。
    //
    // 实测事故（2026-10-22 group:1000000005）：
    //   04:13:13 不会忘本：「@大肥鱼装AI 能给我一些比较雷霆的奶龙图片吗？」   ← 提问
    //   04:13:29 群友F：「[引用 图片] @大肥鱼装AI 那存这张，遇到不喜欢的就发出来」← 陈述
    //   04:14:32 机器人：「雷霆的奶龙没有，鱼这儿只有鲸鱼」→ 却 @ 了群友F
    // 两条都 @ 了机器人，按"最新"选就选到了后说的那位；但回复内容明明在回答前者的提问。
    // 现在：候选多于一个时，用**回复内容与候选话语的重合度**挑；都沾不上才按最新。
    if (addressedCandidates.length > 1) {
      const scored = addressedCandidates.map((m) => ({
        m,
        overlap: textOverlap(opts.replyText, String(m.plain ?? m.text ?? ''), opts)
      })).sort((a, b) => (b.overlap - a.overlap) || ((Number(b.m.time) || 0) - (Number(a.m.time) || 0)));
      // 只有确实存在"更像在回谁"的信号（>0）时才覆盖最新；
      // 全是 0 说明内容上分不出，保持"取最新"的老行为（短回应场景常如此）。
      if (scored[0].overlap > 0) bestAddressed = scored[0].m;
    }
    if (bestAddressed) {
      target = atTargetOf(bestAddressed);
      source = 'hit:unread-addressed';
      targetAt = Number(bestAddressed.time) || 0;
      matchedText = String(bestAddressed.plain ?? bestAddressed.text ?? '');
      overlap = textOverlap(opts.replyText, matchedText, opts);
    }
  }

  if (!target && unreadHasTargets) {
    // ② 没有明确的 @，退回按内容相关性选人；谁都不沾就这次不 @。
    const matched = pickUnreadTarget(unreadList, opts.replyText, {
      minOverlap: cfg.minOverlap,
      ignoreNames: opts.ignoreNames,
      ignoreAtNames: opts.ignoreAtNames,
      backwardMinGrams: cfg.backwardMinGrams
    });
    if (matched) {
      target = matched.userId;
      source = matched.reason;
      targetAt = Number(matched.lastAt) || 0;
      overlap = Number(matched.overlap) || 0;
      matchedText = matched.matchedText || '';
      candidates = Array.isArray(matched.candidates) ? matched.candidates : [];
    }
  }

  // ③ 只有「未读里根本没有可定位的人」时才退回最近一条他人消息。
  //
  // ⚠️ 这里**不能在"有未读但内容都不沾"时兜底**。历史事故（2026-10-21，group:1000000004）：
  //   Lu-mi-nous 问「@大肥鱼 你用了多少token」，机器人回「喏，图来了」——
  //   当时字面匹配返回 null（谁都不沾），兜底逻辑就按"谁最后说话"挑了 **翩翩老公**，
  //   于是在群里公开 @ 错了人。两种失败必须分开：
  //     ① 没有未读可定位 → 信息不足，recent 兜底合理；
  //     ② 有未读但都不沾 → 已有足够信息判断"这次不该点名"，兜底只会制造错误。
  if (!target && !unreadHasTargets) {
    const recent = Array.isArray(opts.recentMessages) ? opts.recentMessages : [];
    for (let i = recent.length - 1; i >= 0; i--) {
      const m = recent[i];
      if (!m || m.isSelf) continue;
      const uid = atTargetOf(m);
      if (!uid) continue;
      const t = Number(m.time) || 0;
      // 时间窗只管"太旧"，无时间戳（0）时不拦——有些历史消息没写 time
      if (cfg.windowMs > 0 && t > 0 && now - t > cfg.windowMs) break;
      target = uid;
      source = 'recent';
      targetAt = t;
      break;
    }
  }
  if (!target) return none(unreadHasTargets ? 'no-match' : 'no-target');

  // ── 该不该点名：只有在"指代不明确"时才需要 @ ──────────────────────────
  //
  // 用户要求（2026-10-20）：「可能只在回复的消息不在当前会话中的最后一条消息时，
  // 或者要回复的是最后一条但是和当前时间差距超过 1h 时才 @ 人，因为如果是最后一条
  // 且时间相近时直接发送即可」。
  //
  // 这个规则比"按概率瞎点"合理得多：@ 的唯一作用是**指明在跟谁说话**。
  //   - 如果就是回刚才最后一条、而且就在几十秒内 → 谁都知道在回谁，@ 是噪音。
  //   - 如果回的是更早的某条（中间插了别人的话）→ 确实需要点名，否则会误解。
  //   - 如果最后一条是一小时前 → 时间跨度大，点一下名更像"接上话头"。
  //
  // 唯一例外是**引用**（quoted）：模型主动引用了某条消息时，说明它明确指向那条，
  // 引用本身已经指明了对象；但模型显式引用往往意味着"这不是在接最近的话"，
  // 所以仍然按上面的规则判（引用对象若不是最后一条 → 会 @，合理）。
  const needAt = shouldAutoAt({
    target, targetAt, quoted: opts.quoted,
    recentMessages: opts.recentMessages,
    now, cfg
  });
  if (!needAt.needed) return none(needAt.reason);

  // 掷骰放在最后：先确认"真的有可 @ 的人"再随机，
  // 否则日志里会大量出现"掷中了但没人可 @"的噪声。
  if (random() >= Number(cfg.probability ?? 0)) return none('roll-miss');

  // source 已经在 pickUnreadTarget 里带了 `hit:` 前缀（便于日志区分来源），
  // 这里不要再拼一次，否则会得到 `hit:hit:unread-match`。
  return {
    userId: target,
    reason: source.startsWith('hit:') ? source : `hit:${source}`,
    // 以下只用于日志排查：@错人时能直接看到"凭什么选了他"
    overlap: Number(overlap.toFixed ? overlap.toFixed(3) : overlap) || 0,
    matchedText: String(matchedText || '').slice(0, 80),
    candidates
  };
}
