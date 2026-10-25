/**
 * 拍一拍的目标解析：把「符号引用 / 昵称」换算成 QQ 号。
 *
 * ## 为什么需要
 *
 * 事故（2026-10-22，group:100002005）：机器人反复拍同一个人（群友A），群里被问「怎么一直戳我」。
 * 查下来是一条很典型的「信息不足 + 模型复用旧值」链路：
 *
 *   1. `qq_send_poke` 必须传 `targetUserId`（纯数字 QQ 号）；
 *   2. 唤醒提示只告诉它「有人戳了你（群友F）」——**只有名字，没有号**；
 *   3. 上下文里唯一的 QQ 号来自很早以前某次 `qq_get_recent_messages` 的结果
 *      （恰好是 群友A 的 100002009）以及它自己拍完之后返回的 `targetUserId`；
 *   4. 于是它拿这个旧号顶上，一拍就是十几次。
 *
 * 修法是给模型一条**不需要记数字**的路：像 `replyToMessageId: latest` 那样，
 * 支持 `latest` / `戳我的人` / 对方昵称，由桥接在本会话的消息里换算。
 *
 * ## 安全边界
 *
 * **只在调用方给定的消息集合里解析**（本会话的 recentMessages / unread）——
 * 不查群成员全表，也不接受跨会话的号。昵称命中多人时**拒绝并列出候选**，
 * 绝不猜（猜错就是当众 @ 错人/拍错人，代价比拒绝大）。
 */

// 符号引用：明确表达「最近戳我的那个人」。
// 覆盖模型可能写出的几种自然说法，避免它因为不认识某个词而回去瞎填数字。
const SYMBOLIC_LATEST_RE = /^(latest|last|latest_poke|poke_me|最近戳我的?人?|戳我的?人|上一条|最后一个戳我的?|最新)$/i;

/** 这个 ref 是不是「最近戳我的人」的符号写法。 */
export function isSymbolicPokeRef(ref) {
  return SYMBOLIC_LATEST_RE.test(String(ref ?? '').trim());
}

/**
 * 收集「谁戳过我」的记录。
 *
 * 判据与 bridge 的 `pokeSelfs` 保持一致：非自己、`poke.targetIsSelf === true`、
 * 有合法 QQ 号（`userId`）。拍别人的事件（targetIsSelf=false）不算——那不是"戳你"。
 */
function collectPokeSenders(unread, recentMessages) {
  const all = [];
  const push = (m) => {
    if (!m || m.isSelf) return;
    if (!m.poke || m.poke.targetIsSelf !== true) return;
    const uid = m.userId != null ? String(m.userId).trim() : '';
    if (!/^[1-9]\d{4,11}$/.test(uid)) return;
    all.push({ userId: uid, sender: String(m.sender ?? '').trim(), time: Number(m.time) || 0 });
  };
  for (const m of Array.isArray(unread) ? unread : []) push(m);
  for (const m of Array.isArray(recentMessages) ? recentMessages : []) push(m);
  // 去重（unread 与 recentMessages 常常是同一批消息）
  const seen = new Set();
  const out = [];
  for (const r of all) {
    const k = `${r.userId}|${r.time}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

/**
 * 解析拍一拍目标。
 *
 * @param {object} opts
 * @param {string} opts.ref                 模型传入的 targetUserId 原值
 * @param {Array}  opts.unread              本会话未读
 * @param {Array}  opts.recentMessages      本会话最近消息
 * @returns {{ok:true, userId:string, reason:'numeric'|'latest'|'name', sender?:string}
 *          |{ok:false, reason:'empty'|'not-found'|'ambiguous', candidates?:Array<{userId:string,sender:string}>}}
 */
export function resolvePokeTarget({ ref, unread, recentMessages } = {}) {
  const raw = String(ref ?? '').trim();
  if (!raw) return { ok: false, reason: 'empty' };

  // 纯数字：原样放行（合法性由调用方继续校验，保持原有行为）
  if (/^[1-9]\d*$/.test(raw)) return { ok: true, userId: raw, reason: 'numeric' };

  // 符号引用：最近戳它的那个人
  if (isSymbolicPokeRef(raw)) {
    const pokes = collectPokeSenders(unread, recentMessages)
      .sort((a, b) => b.time - a.time);
    if (!pokes.length) return { ok: false, reason: 'not-found' };
    const top = pokes[0];
    return { ok: true, userId: top.userId, reason: 'latest', sender: top.sender };
  }

  // 昵称：在本会话消息里找发送者同名的人
  // 大小写不敏感（英文昵称常见大小写差异），中文不受影响。
  const want = raw.toLowerCase();
  const byUser = new Map(); // userId -> sender
  const scan = (list) => {
    for (const m of Array.isArray(list) ? list : []) {
      if (!m || m.isSelf) continue;
      const sender = String(m.sender ?? '').trim();
      if (!sender || sender.toLowerCase() !== want) continue;
      const uid = m.userId != null ? String(m.userId).trim() : '';
      if (!/^[1-9]\d{4,11}$/.test(uid)) continue;
      if (!byUser.has(uid)) byUser.set(uid, sender);
    }
  };
  scan(recentMessages);
  scan(unread);

  if (!byUser.size) return { ok: false, reason: 'not-found' };
  if (byUser.size > 1) {
    // 同名多人：拒绝并给候选，让模型/人决定，绝不猜。
    return {
      ok: false,
      reason: 'ambiguous',
      candidates: [...byUser.entries()].map(([userId, sender]) => ({ userId, sender }))
    };
  }
  const [userId, sender] = [...byUser.entries()][0];
  return { ok: true, userId, reason: 'name', sender };
}
