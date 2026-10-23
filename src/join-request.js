// 加好友 / 入群邀请的**人工裁决**：队列 + 指令解析。
//
// 需求（2026-10-20 用户）：「当 bot 账号被请求加好友或者拉进群的时候通知管理员并且询问同意或拒绝」。
//
// ── 设计取舍 ────────────────────────────────────────────────────────────
//
// 1. **默认不自动同意**。加好友/入群是**扩张攻击面**的动作：好友能私聊它、
//    群能让它出现在陌生人面前。所以默认 **fail-closed**：没人处理就拒绝。
//    真想要自动同意可以配 `autoApprove`，但默认关。
//
// 2. **要不要等管理员？** 等。OneBot 的请求有有效期（QQ 侧约几分钟），
//    所以超时（默认 5 分钟）后自动拒绝——不能让请求一直挂着，那样发请求的人
//    看到的是"永远在等待"，比明确拒绝更糟。
//
// 3. **裁决指令走管理员私聊**，不走群。理由：群里的"同意"可能是别人说的，
//    而这是账号级权限变更；只认 `private:${ownerQQ}`。
//
// 4. **指令要能指代具体某一条**。同时来了两个请求时，"同意"到底同意哪个？
//    所以每条待决请求有短编号（1、2、3…），`/yes 2` 指定；只说 `/yes`
//    则在**只有一条待决**时才生效（多条时要求编号，避免误批）。
//
// 5. **队列要落盘**。桥接重启时若把待决请求丢了，管理员已经看到通知却点不动。
//
// 本模块是纯逻辑（不碰网络/QQ），便于离线测试。
import fs from 'node:fs';
import path from 'node:path';

/** 待决请求的最长存活时间。超过就自动拒绝。 */
export const DEFAULT_TTL_MS = 5 * 60 * 1000;

/**
 * 解析管理员的裁决指令。
 *
 * 支持：/yes 1、/no 2、/pending、同意、拒绝、批准、不予理会 等。
 * **中文只认短句**（整句等于这些词），避免"我同意了但是……"这类长句被误判成指令。
 *
 * @returns {{action:'approve'|'reject'|'list', index?:number}|null}
 */
export function parseJoinCommand(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;

  // /pending / /list / /待决
  if (/^\/(?:pending|list|待决)$/i.test(raw)) return { action: 'list' };

  // /yes 2 / /no 1 / /approve 3 / /reject
  const m = /^\/(yes|approve|ok|accept|no|reject|deny|refuse)(?:\s+(\d{1,2}))?$/i.exec(raw);
  if (m) {
    const approve = /^(yes|approve|ok|accept)$/i.test(m[1]);
    const index = m[2] ? Number(m[2]) : undefined;
    return index && index > 0
      ? { action: approve ? 'approve' : 'reject', index }
      : { action: approve ? 'approve' : 'reject' };
  }

  // 中文短指令：整句必须就是这些词之一（长句不认，避免误判）
  if (/^(同意|通过|批准|允许|加吧|拉吧|可以)$/.test(raw)) return { action: 'approve' };
  if (/^(拒绝|不同意|不行|不要|驳回|算了|不加|不拉)$/.test(raw)) return { action: 'reject' };
  // 中文 + 编号：「同意 2」「拒绝 1」
  const cn = /^(同意|通过|批准|允许|拒绝|不同意|不行|驳回)\s*(\d{1,2})$/.exec(raw);
  if (cn) {
    const approve = /^(同意|通过|批准|允许)$/.test(cn[1]);
    return { action: approve ? 'approve' : 'reject', index: Number(cn[2]) };
  }
  return null;
}

/** 一条待决请求的人话描述（发通知用）。 */
export function describeJoinRequest(req) {
  const who = req.userId ? `${req.nickname || '未知'}（${req.userId}）` : '未知用户';
  if (req.requestType === 'friend') {
    return `加好友请求：${who}${req.comment ? `\n验证消息：${req.comment}` : ''}`;
  }
  const gid = req.groupId || '';
  const invite = req.subType === 'invite' || !req.subType;
  return `${invite ? '群邀请' : '入群申请'}：${who}`
    + `${gid ? `\n群号：${gid}${req.groupName ? `（${req.groupName}）` : ''}` : ''}`
    + `${req.comment ? `\n附言：${req.comment}` : ''}`;
}

/**
 * 待决请求队列。
 *
 * 为什么自己实现而不用 Set：需要**稳定编号**（管理员要 `/yes 2`）、
 * 需要 TTL、需要落盘。编号用自增序号，删除后不重排——重排会让管理员
 * "看到的是 2、点的时候变成 1"。
 */
export function createJoinQueue({ file = '', ttlMs = DEFAULT_TTL_MS, now = () => Date.now(), maxItems = 50 } = {}) {
  const nowMs = typeof now === 'function' ? now : () => Date.now();
  const ttl = Math.max(30 * 1000, Number(ttlMs) || DEFAULT_TTL_MS);
  let seq = 0;
  /** @type {Map<number, object>} 编号 → 请求（保持插入顺序） */
  let items = new Map();

  function load() {
    if (!file) return;
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
      if (Array.isArray(raw?.items)) {
        seq = Number(raw.seq) || 0;
        for (const it of raw.items) {
          const n = Number(it?.n);
          if (n > 0) items.set(n, it);
        }
      }
    } catch { /* 文件不存在/损坏：从空队列开始 */ }
  }

  function save() {
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ seq, items: [...items.values()] }, null, 2) + '\n',
        { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch { /* 落盘失败不影响内存队列 */ }
  }

  load();

  /**
   * 启动时已过期的项。
   *
   * 为什么要单独收集（2026-10-20 实测踩到）：`load()` 之后如果直接等第一次
   * `list()/pruneExpired()`，那些"重启时就已经超时"的请求会被**静默删除**——
   * 从队列里消失，但从来没有向 QQ 提交过拒绝。表现是：申请人一直挂着等待，
   * 而桥接日志里什么都没有。所以启动时先把它们捞出来，交给调用方补发拒绝。
   */
  const expiredAtStartup = (() => {
    const t = nowMs();
    const out = [];
    for (const [n, it] of items) {
      if (t - Number(it.at || 0) >= ttl) {
        items.delete(n);
        out.push(it);
      }
    }
    if (out.length) save();
    return out;
  })();

  /** 取出启动时发现已过期的项（只能取一次，取完清空）。 */
  function takeExpiredAtStartup() {
    const out = expiredAtStartup.slice();
    expiredAtStartup.length = 0;
    return out;
  }

  /** 清掉过期项，返回被清掉的（调用方负责真正发拒绝）。 */
  function pruneExpired() {
    const t = nowMs();
    const expired = [];
    for (const [n, it] of items) {
      if (t - Number(it.at || 0) >= ttl) {
        items.delete(n);
        expired.push(it);
      }
    }
    if (expired.length) save();
    return expired;
  }

  /**
   * 入队。
   * @returns {{n:number, item:object}}
   */
  function push(item) {
    pruneExpired();
    seq += 1;
    const entry = { ...item, n: seq, at: nowMs() };
    items.set(seq, entry);
    // 有界：超过上限时丢掉最旧的（它们本来也会超时）
    while (items.size > maxItems) {
      const oldest = items.keys().next().value;
      if (oldest === undefined) break;
      items.delete(oldest);
    }
    save();
    return { n: seq, item: entry };
  }

  /** 列出未过期的（按编号升序）。 */
  function list() {
    pruneExpired();
    return [...items.values()].sort((a, b) => a.n - b.n);
  }

  /**
   * 取出并删除一条（用于裁决）。
   * @param {number} [n] 指定编号；省略时仅在**恰好一条**待决时生效
   * @returns {{ok:true, item:object} | {ok:false, error:string, candidates?:object[]}}
   */
  function take(n) {
    pruneExpired();
    const all = list();
    if (!all.length) return { ok: false, error: '现在没有待处理的请求' };
    if (n != null) {
      const it = items.get(Number(n));
      if (!it) return { ok: false, error: `没有编号 ${n} 的待处理请求`, candidates: all };
      items.delete(Number(n));
      save();
      return { ok: true, item: it };
    }
    if (all.length > 1) {
      return {
        ok: false,
        error: `现在有 ${all.length} 条待处理，请用编号指定（例如 /yes 1）`,
        candidates: all
      };
    }
    items.delete(all[0].n);
    save();
    return { ok: true, item: all[0] };
  }

  function size() { return list().length; }
  function clear() { items.clear(); save(); }

  /**
   * 按条件取出并删除（可能一次删多条），返回被删的项（按编号升序）。
   *
   * 用途：外部状态已经让请求作废——最典型的是**机器人已经进群了**
   * （QQ 自动同意了邀请），此时再让管理员 /yes 只会得到一个
   * "matching group request not found"。2026-10-22 实测：
   * 入群通知与邀请事件同一秒到达，43 秒后管理员裁决时请求已不存在。
   */
  function takeWhere(pred) {
    pruneExpired();
    const out = [];
    for (const [n, it] of items) {
      if (pred(it)) {
        items.delete(n);
        out.push(it);
      }
    }
    if (out.length) save();
    return out.sort((a, b) => a.n - b.n);
  }

  return { push, list, take, takeWhere, size, clear, pruneExpired, takeExpiredAtStartup, ttlMs: ttl };
}
