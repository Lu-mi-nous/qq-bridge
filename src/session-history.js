// 会话映射历史：sessionId → QQ 会话 key。
//
// 为什么需要它：`state/sessions.json` 只保存**当前**映射。DSH 的 token 用量
// 按会话目录天然分组，但一旦发生轮换（上下文超限 / 模式代际 / reset / 删除），
// 旧 sessionId 就变成"无主"，它的消耗无法归属到任何群或私聊。
//
// 本模块只做三件事：
//   1. 在会话创建、轮换、重置、删除时记一条映射（同一 sessionId 只保留一条，后写覆盖归档信息）；
//   2. 首次启用时从 `state/context/<key>/compactions.jsonl` 回填历史 sessionId；
//   3. 有界（默认 2000 条），原子写盘。
//
// 注意：这里存的是**归属索引**，不含聊天内容、不含 token 数；真正的用量仍由
// token-usage.js 从 DSH 转录里解析。文件损坏时按空历史启动（不能因此让桥接起不来），
// 下一次写入会重建；旧文件不会被追加成无限增长。
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_MAX_ITEMS = 2000;

function readJson(file) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const data = JSON.parse(text);
    return data && typeof data === 'object' ? data : null;
  } catch {
    return null;
  }
}

function atomicWrite(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** 把 state/context 的目录名还原成 QQ 会话 key（group_123 → group:123）。 */
export function keyFromContextDirName(name) {
  const m = /^(group|private)_(.+)$/.exec(String(name || ''));
  return m ? `${m[1]}:${m[2]}` : '';
}

export function createSessionHistory({
  file,
  log = () => {},
  maxItems = DEFAULT_MAX_ITEMS
} = {}) {
  if (!file) throw new Error('createSessionHistory 需要 file');
  /** @type {Map<string, {sessionId:string,key:string,reason:string,createdAt:number,archivedAt:number}>} */
  const items = new Map();
  let loaded = false;

  function load() {
    if (loaded) return;
    loaded = true;
    const data = readJson(file);
    const list = Array.isArray(data?.items) ? data.items : [];
    for (const raw of list) {
      const sessionId = String(raw?.sessionId || '').trim();
      if (!sessionId) continue;
      items.set(sessionId, {
        sessionId,
        key: String(raw?.key || ''),
        reason: String(raw?.reason || ''),
        createdAt: Number(raw?.createdAt) || 0,
        archivedAt: Number(raw?.archivedAt) || 0
      });
    }
    if (list.length) log(`[会话历史] 已加载 ${items.size} 条 sessionId 映射`);
  }

  function prune() {
    if (items.size <= maxItems) return 0;
    const sorted = [...items.values()].sort((a, b) =>
      (Number(a.archivedAt) || Number(a.createdAt) || 0) - (Number(b.archivedAt) || Number(b.createdAt) || 0));
    const drop = items.size - maxItems;
    for (let i = 0; i < drop; i++) items.delete(sorted[i].sessionId);
    return drop;
  }

  function save() {
    prune();
    atomicWrite(file, { version: 1, items: [...items.values()] });
  }

  /**
   * 记一条映射。同一 sessionId 重复调用时合并：key 以新值为准（非空时），
   * archivedAt 一旦写入不会被后续 0 覆盖。
   */
  function record(sessionId, key, reason = '', { at = Date.now() } = {}) {
    const sid = String(sessionId || '').trim();
    if (!sid) return false;
    load();
    const old = items.get(sid);
    const next = {
      sessionId: sid,
      key: String(key || old?.key || ''),
      reason: String(reason || old?.reason || ''),
      createdAt: Number(old?.createdAt) || Number(at) || Date.now(),
      archivedAt: Number(old?.archivedAt) || 0
    };
    // 'create'/'adopt' 表示仍在使用；归档类 reason 才写 archivedAt。
    if (reason && reason !== 'create' && reason !== 'adopt') next.archivedAt = Number(at) || Date.now();
    items.set(sid, next);
    save();
    return true;
  }

  function get(sessionId) {
    load();
    return items.get(String(sessionId || ''))?.key || '';
  }

  function mapping() {
    load();
    const out = {};
    for (const [sid, item] of items) if (item.key) out[sid] = item.key;
    return out;
  }

  function list() {
    load();
    return [...items.values()];
  }

  /**
   * 从 state/context/<key>/compactions.jsonl 回填历史 sessionId。
   * 只读文件、不做网络；解析失败的行跳过。
   * @returns {number} 新写入的条目数
   */
  function backfillFromContext(contextRoot) {
    load();
    let added = 0;
    let dirs = [];
    try {
      dirs = fs.readdirSync(contextRoot, { withFileTypes: true })
        .filter((ent) => ent.isDirectory());
    } catch { return 0; }
    for (const ent of dirs) {
      const key = keyFromContextDirName(ent.name);
      if (!key) continue;
      const filePath = path.join(contextRoot, ent.name, 'compactions.jsonl');
      let text = '';
      try { text = fs.readFileSync(filePath, 'utf8'); } catch { continue; }
      for (const line of text.split('\n')) {
        if (!line.includes('sessionId')) continue;
        let row;
        try { row = JSON.parse(line); } catch { continue; }
        const sid = String(row?.sessionId || '').trim();
        if (!sid) continue;
        if (items.has(sid)) continue;
        const at = Number(row?.at) || Date.now();
        items.set(sid, { sessionId: sid, key, reason: 'backfill', createdAt: at, archivedAt: at });
        added += 1;
      }
    }
    if (added) {
      save();
      log(`[会话历史] 从上下文压缩记录回填 ${added} 条历史 sessionId`);
    }
    return added;
  }

  /** 把当前 state.sessions 里的映射登记为 adopt（幂等，供首次启用时补历史）。 */
  function adoptCurrent(sessions) {
    load();
    let added = 0;
    for (const [key, sessionId] of Object.entries(sessions || {})) {
      const sid = String(sessionId || '').trim();
      if (!sid || items.has(sid)) continue;
      items.set(sid, { sessionId: sid, key, reason: 'adopt', createdAt: Date.now(), archivedAt: 0 });
      added += 1;
    }
    if (added) save();
    return added;
  }

  return { record, get, mapping, list, backfillFromContext, adoptCurrent, save, prune };
}
