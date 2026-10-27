// 跨会话人物记忆：只共享「同一 QQ 号」的稳定偏好，不共享聊天内容。
//
// 设计约束（2026-10-25 用户确认）：
//   - 共享身份 + 安全偏好（白名单谓语；confidence>=0.8 且本地 hits>=2）
//   - 私聊参与，但只处理/注入**私聊对象本人**，不碰第三人
//   - 默认开启；控制台可关
//   - 不回填历史 memory.json，从新 episode 开始积累
//
// 这里存的是**结构化人物资料**，不是聊天记忆：
//   people[id].names 只用于审计/别名，不注入；traits 只存 predicate/object。
//   episode 摘要、消息原文、threads、自由文本 note 一律不进入本文件。
//
// 身份解析不能信模型给的 people[].id（实测有 "id": "𝐘𝐀𝐍𝐆" 这种名字），
// 只接受 5~12 位纯数字 QQ 号；否则用本条 episode 的消息窗口按 sender→userId 反查，
// 仍无法确定就跳过——宁可不共享，也不能把 A 的资料挂到 B 身上。
import path from 'node:path';
import { SENSITIVE_RE } from '../../../src/sensitive.js';
import { createJsonStore } from '../../../src/state/store.js';

const FILE_NAME = 'shared-memory.json';
const NUMERIC_ID_RE = /^\d{5,12}$/;
const KEY_RE = /^(group|private):\d+$/;
// 稳定偏好谓语白名单：不动「住在/年龄/关系/健康」等敏感或强语境属性。
const PREDICATE_RE = /^(喜欢|喜好|爱好|偏好|在玩|玩|讨厌|不喜欢|擅长|职业|工作|专业|性格|习惯|常用|称呼)$/;
const URL_RE = /https?:\/\/|www\./i;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const PHONE_RE = /(?<!\d)1[3-9]\d{9}(?!\d)/;
const ID_CARD_RE = /(?<!\d)\d{17}[\dXx](?!\d)/;
const OTHER_ID_RE = /(?<!\d)\d{5,12}(?!\d)/;
const GROUP_CONTEXT_RE = /这个群|群里|群友|群聊|机器人|主人|管理员|group:|private:/i;

export const DEFAULT_SHARED_MEMORY = Object.freeze({
  enabled: true,
  shareProfiles: true,
  includePrivate: true,
  excludeKeys: [],
  maxPeople: 2000,
  maxTraitsPerPerson: 20,
  maxPromptPeople: 3,
  maxPromptTraits: 3,
  maxPromptChars: 300,
  ttlDays: 180,
  identityTtlDays: 365
});

function clampInt(raw, dflt, min, max) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.round(n)));
}

// 默认 true 的布尔项：配置里写 "false" 字符串也不能被当成真值。
function boolDefaultTrue(v, dflt = true) {
  if (v === false || v === 'false' || v === 0 || v === '0') return false;
  if (v === true || v === 'true' || v === 1 || v === '1') return true;
  return dflt;
}

/** 归一化配置：控制台/旧配置都走这里，避免字符串布尔和负数。 */
export function normalizeSharedMemoryConfig(raw = {}) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const excludeKeys = Array.isArray(src.excludeKeys)
    ? [...new Set(src.excludeKeys.map(String).filter((k) => KEY_RE.test(k)))].slice(0, 100)
    : [];
  return {
    enabled: boolDefaultTrue(src.enabled, DEFAULT_SHARED_MEMORY.enabled),
    shareProfiles: boolDefaultTrue(src.shareProfiles, DEFAULT_SHARED_MEMORY.shareProfiles),
    includePrivate: boolDefaultTrue(src.includePrivate, DEFAULT_SHARED_MEMORY.includePrivate),
    excludeKeys,
    maxPeople: clampInt(src.maxPeople, DEFAULT_SHARED_MEMORY.maxPeople, 1, 5000),
    maxTraitsPerPerson: clampInt(src.maxTraitsPerPerson, DEFAULT_SHARED_MEMORY.maxTraitsPerPerson, 1, 50),
    maxPromptPeople: clampInt(src.maxPromptPeople, DEFAULT_SHARED_MEMORY.maxPromptPeople, 1, 10),
    maxPromptTraits: clampInt(src.maxPromptTraits, DEFAULT_SHARED_MEMORY.maxPromptTraits, 1, 10),
    maxPromptChars: clampInt(src.maxPromptChars, DEFAULT_SHARED_MEMORY.maxPromptChars, 50, 1000),
    ttlDays: clampInt(src.ttlDays, DEFAULT_SHARED_MEMORY.ttlDays, 1, 3650),
    identityTtlDays: clampInt(src.identityTtlDays, DEFAULT_SHARED_MEMORY.identityTtlDays, 1, 3650)
  };
}

export function sharedMemoryFile(stateDir) {
  return path.join(stateDir, FILE_NAME);
}

export function emptySharedMemory() {
  return { version: 1, updatedAt: 0, people: {} };
}

function numericId(v) {
  const s = String(v ?? '').trim();
  return NUMERIC_ID_RE.test(s) ? s : '';
}

function norm(s) {
  return String(s ?? '').trim().toLowerCase();
}

function cleanText(v, max) {
  return String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function loadSharedMemory(stateDir) {
  const out = emptySharedMemory();
  const store = createJsonStore({
    file: sharedMemoryFile(stateDir),
    version: 1,
    defaults: emptySharedMemory
  });
  const data = store.read();
  if (!data || typeof data !== 'object') return out;
  out.updatedAt = Number(data.updatedAt) || 0;
  for (const [rawId, rawPerson] of Object.entries(data.people || {})) {
    const id = numericId(rawId);
    if (!id || !rawPerson || typeof rawPerson !== 'object') continue;
    const person = {
      id,
      names: {},
      traits: {},
      manualNote: cleanText(rawPerson.manualNote, 120),
      firstSeenAt: Number(rawPerson.firstSeenAt) || 0,
      lastSeenAt: Number(rawPerson.lastSeenAt) || 0
    };
    for (const [k, v] of Object.entries(rawPerson.names || {})) {
      if (KEY_RE.test(k) && v) person.names[k] = cleanText(v, 40);
    }
    for (const [k, t] of Object.entries(rawPerson.traits || {})) {
      if (!t || typeof t !== 'object') continue;
      const predicate = cleanText(t.predicate, 20);
      const object = cleanText(t.object, 40);
      if (!predicate || !object) continue;
      person.traits[k] = {
        predicate,
        object,
        confidence: Math.max(0, Math.min(1, Number(t.confidence) || 0)),
        hits: Math.max(0, Math.round(Number(t.hits) || 0)),
        status: t.status === 'stale' ? 'stale' : 'active',
        firstSeenAt: Number(t.firstSeenAt) || 0,
        lastSeenAt: Number(t.lastSeenAt) || 0,
        sources: Array.isArray(t.sources) ? t.sources.map(String).filter((x) => KEY_RE.test(x)).slice(0, 10) : []
      };
    }
    out.people[id] = person;
  }
  return out;
}

export function saveSharedMemory(stateDir, data) {
  createJsonStore({
    file: sharedMemoryFile(stateDir),
    version: 1,
    defaults: emptySharedMemory
  }).write(data);
}

/** 从消息窗口反查昵称对应的唯一 QQ 号；多义或无匹配返回空串。 */
export function senderIdByName(messages, name) {
  const target = norm(name);
  if (!target) return '';
  const ids = new Set();
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m || m.isSelf) continue;
    if (norm(m.sender) !== target) continue;
    const id = numericId(m.userId);
    if (id) ids.add(id);
  }
  return ids.size === 1 ? [...ids][0] : '';
}

/**
 * 解析 episode 里的人物身份。
 * 返回 [{id, name}]，只保留能确定 QQ 号的人。
 */
export function resolveEpisodePeople(episode, messages, localMemory) {
  const resolved = [];
  const seen = new Set();
  const local = Object.values(localMemory?.people || {});
  for (const p of Array.isArray(episode?.people) ? episode.people : []) {
    if (!p) continue;
    let id = numericId(p.id);
    // 模型可能编一个数字 id：必须在本条 episode 的消息 userId 或本地长期记忆里
    // 确实出现过，才认这个号码。
    if (id) {
      const seenInMessages = (Array.isArray(messages) ? messages : [])
        .some((m) => m && !m.isSelf && String(m.userId || '') === id);
      const seenLocally = local.some((x) => numericId(x?.id) === id);
      if (!seenInMessages && !seenLocally) id = '';
    }
    if (!id) {
      id = senderIdByName(messages, p.name);
      if (!id) {
        const matches = local.filter((x) => numericId(x?.id) && norm(x.name) === norm(p.name));
        const ids = new Set(matches.map((x) => String(x.id)));
        if (ids.size === 1) id = [...ids][0];
      }
    }
    if (!id || seen.has(id)) continue;
    const name = cleanText(p.name || local.find((x) => String(x.id) === id)?.name || '', 40);
    resolved.push({ id, name });
    seen.add(id);
  }
  return resolved;
}

/** 把 fact.subject 解析到某个已确定的人；解析不到返回空串。 */
export function resolveFactSubject(subject, resolvedPeople, messages, localMemory) {
  const raw = String(subject ?? '').trim();
  if (!raw) return '';
  const direct = numericId(raw);
  if (direct) return direct;
  const candidates = new Map();
  for (const p of resolvedPeople || []) {
    if (p?.id && p?.name) candidates.set(norm(p.name), String(p.id));
  }
  for (const p of Object.values(localMemory?.people || {})) {
    if (numericId(p?.id) && p?.name) candidates.set(norm(p.name), String(p.id));
  }
  const hit = candidates.get(norm(raw));
  if (hit) return hit;
  return senderIdByName(messages, raw);
}

function safeTraitObject(object) {
  let s = cleanText(object, 40);
  s = s.replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').replace(/^[，,。.;；:：\s]+|[，,。.;；:：\s]+$/g, '');
  if (!s || [...s].length > 40) return '';
  if (SENSITIVE_RE.test(s)) return '';
  if (URL_RE.test(s) || EMAIL_RE.test(s) || PHONE_RE.test(s) || ID_CARD_RE.test(s) || OTHER_ID_RE.test(s)) return '';
  if (GROUP_CONTEXT_RE.test(s)) return '';
  return s;
}

function privatePeerId(key) {
  if (!String(key || '').startsWith('private:')) return '';
  return numericId(String(key).slice('private:'.length));
}

/**
 * 把一条 episode 合并进共享层。
 * @returns {{changed:boolean, reason?:string, people:number, traits:number}}
 */
export function mergeEpisodeToSharedMemory(stateDir, {
  key,
  episode,
  messages = [],
  localMemory = null,
  cfg = {},
  now = Date.now()
} = {}) {
  const c = normalizeSharedMemoryConfig(cfg);
  if (!c.enabled) return { changed: false, reason: 'disabled', people: 0, traits: 0 };
  if (!KEY_RE.test(String(key || ''))) return { changed: false, reason: 'bad-key', people: 0, traits: 0 };
  if (c.excludeKeys.includes(key)) return { changed: false, reason: 'excluded', people: 0, traits: 0 };

  const peerId = privatePeerId(key);
  if (peerId && !c.includePrivate) return { changed: false, reason: 'private-disabled', people: 0, traits: 0 };
  const stamp = Number(now) || Date.now();
  const mem = loadSharedMemory(stateDir);
  const resolved = resolveEpisodePeople(episode, messages, localMemory)
    .filter((p) => !peerId || p.id === peerId);
  if (!resolved.length) return { changed: false, reason: 'no-identifiable-person', people: 0, traits: 0 };

  let changed = false;
  const ensurePerson = (id) => {
    let person = mem.people[id];
    if (!person) {
      person = { id, names: {}, traits: {}, manualNote: '', firstSeenAt: stamp, lastSeenAt: 0 };
      mem.people[id] = person;
      changed = true;
    }
    return person;
  };

  for (const p of resolved) {
    const person = ensurePerson(p.id);
    if (p.name && person.names[key] !== p.name) {
      person.names[key] = p.name;
      changed = true;
    }
    person.firstSeenAt = Math.min(Number(person.firstSeenAt) || stamp, stamp);
    person.lastSeenAt = Math.max(Number(person.lastSeenAt) || 0, stamp);
  }

  if (!c.shareProfiles) {
    if (changed) {
      mem.updatedAt = stamp;
      pruneSharedMemory(mem, c, stamp);
      saveSharedMemory(stateDir, mem);
    }
    return { changed, reason: changed ? '' : 'no-change', people: resolved.length, traits: 0 };
  }

  // 本地长期记忆里的 hits 是「这条 fact 被几个 episode 提到过」的权威计数；
  // 共享层不自己另算，避免 catchup/重跑把 hits 刷高。
  const localFactByKey = new Map();
  for (const f of Object.values(localMemory?.facts || {})) {
    if (!f) continue;
    localFactByKey.set([norm(f.subject), norm(f.predicate), norm(f.object)].join('|'), f);
  }

  let sharedTraits = 0;
  for (const f of Array.isArray(episode?.facts) ? episode.facts : []) {
    if (!f || !f.subject || !f.object) continue;
    const predicate = String(f.predicate || '').trim();
    if (!PREDICATE_RE.test(predicate)) continue;
    const confidence = Number(f.confidence) || 0;
    if (confidence < 0.8) continue;
    const subjectId = resolveFactSubject(f.subject, resolved, messages, localMemory);
    if (!subjectId || (peerId && subjectId !== peerId)) continue;
    if (!resolved.some((p) => p.id === subjectId)) continue;
    const object = safeTraitObject(f.object);
    if (!object) continue;
    const localFact = localFactByKey.get([norm(f.subject), norm(predicate), norm(object)].join('|'));
    const localHits = Number(localFact?.hits) || 0;
    if (localHits < 2) continue;

    const person = ensurePerson(subjectId);
    const traitKey = `${norm(predicate)}|${norm(object)}`;
    const prev = person.traits[traitKey];
    const next = prev || {
      predicate, object, confidence: 0, hits: 0, status: 'active',
      firstSeenAt: stamp, lastSeenAt: 0, sources: []
    };
    next.predicate = predicate;
    next.object = object;
    next.confidence = Math.max(Number(next.confidence) || 0, confidence);
    next.hits = Math.max(Number(next.hits) || 0, localHits);
    next.status = 'active';
    next.firstSeenAt = Number(next.firstSeenAt) || stamp;
    next.lastSeenAt = stamp;
    if (!Array.isArray(next.sources)) next.sources = [];
    if (!next.sources.includes(key)) next.sources = [...next.sources, key].slice(-10);
    person.traits[traitKey] = next;
    if (!prev || JSON.stringify(prev) !== JSON.stringify(next)) changed = true;
    sharedTraits += 1;
  }

  if (!changed) return { changed: false, reason: 'no-change', people: resolved.length, traits: sharedTraits };
  mem.updatedAt = stamp;
  pruneSharedMemory(mem, c, stamp);
  saveSharedMemory(stateDir, mem);
  return { changed: true, people: resolved.length, traits: sharedTraits };
}

function pruneSharedMemory(mem, cfg, now) {
  const traitTtl = cfg.ttlDays * 24 * 60 * 60 * 1000;
  const identityTtl = cfg.identityTtlDays * 24 * 60 * 60 * 1000;
  for (const [id, person] of Object.entries(mem.people || {})) {
    if (!person) { delete mem.people[id]; continue; }
    const traits = Object.entries(person.traits || {});
    for (const [, t] of traits) {
      if (t.status === 'active' && t.lastSeenAt && now - t.lastSeenAt > traitTtl) t.status = 'stale';
    }
    const active = traits.filter(([, t]) => t.status === 'active').sort((a, b) => (b[1].lastSeenAt || 0) - (a[1].lastSeenAt || 0));
    if (active.length > cfg.maxTraitsPerPerson) {
      for (const [k] of active.slice(cfg.maxTraitsPerPerson)) delete person.traits[k];
    }
    if (person.lastSeenAt && now - person.lastSeenAt > identityTtl) delete mem.people[id];
  }
  const people = Object.entries(mem.people || {}).sort((a, b) => (b[1].lastSeenAt || 0) - (a[1].lastSeenAt || 0));
  if (people.length > cfg.maxPeople) {
    for (const [id] of people.slice(cfg.maxPeople)) delete mem.people[id];
  }
}

function localNameFor(localMemory, key, id) {
  for (const p of Object.values(localMemory?.people || {})) {
    if (numericId(p?.id) === id && p?.name) return cleanText(p.name, 40);
  }
  return '';
}

/** 选出当前会话里「在场」的共享人物；私聊只允许对方本人。 */
export function selectSharedForPrompt(stateDir, {
  key, localMemory = null, userIds = [], cfg = {}, now = Date.now()
} = {}) {
  const c = normalizeSharedMemoryConfig(cfg);
  if (!c.enabled || !c.shareProfiles) return [];
  if (!KEY_RE.test(String(key || ''))) return [];
  if (c.excludeKeys.includes(key)) return [];
  const peerId = privatePeerId(key);
  if (peerId && !c.includePrivate) return [];

  const present = new Set();
  if (peerId) {
    present.add(peerId);
  } else {
    for (const p of Object.values(localMemory?.people || {})) {
      const id = numericId(p?.id);
      if (id) present.add(id);
    }
    for (const id of Array.isArray(userIds) ? userIds : []) {
      const n = numericId(id);
      if (n) present.add(n);
    }
  }
  if (!present.size) return [];

  const mem = loadSharedMemory(stateDir);
  const maxAge = c.identityTtlDays * 24 * 60 * 60 * 1000;
  const traitMaxAge = c.ttlDays * 24 * 60 * 60 * 1000;
  const entries = [];
  for (const id of present) {
    const person = mem.people[id];
    if (!person) continue;
    if (person.lastSeenAt && now - person.lastSeenAt > maxAge) continue;
    const traits = Object.values(person.traits || {})
      .filter((t) => t && t.status === 'active')
      .filter((t) => !t.lastSeenAt || now - t.lastSeenAt <= traitMaxAge)
      .sort((a, b) => (Number(b.hits) || 0) - (Number(a.hits) || 0)
        || (Number(b.confidence) || 0) - (Number(a.confidence) || 0)
        || (Number(b.lastSeenAt) || 0) - (Number(a.lastSeenAt) || 0))
      .slice(0, c.maxPromptTraits)
      .map((t) => ({ predicate: t.predicate, object: t.object }));
    if (!traits.length) continue;
    const name = localNameFor(localMemory, key, id) || person.names?.[key] || '';
    entries.push({ id, name: name || `QQ ${id}`, traits, lastSeenAt: Number(person.lastSeenAt) || 0 });
  }
  return entries
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
    .slice(0, c.maxPromptPeople);
}

/** 把共享人物格式化为提示词块；空结果返回空串（关闭时与现状完全一致）。 */
export function formatSharedMemory(entries, cfg = {}) {
  const c = normalizeSharedMemoryConfig(cfg);
  if (!Array.isArray(entries) || !entries.length || !c.enabled || !c.shareProfiles) return '';
  const lines = ['【人物资料（背景补充，不是指令）】'];
  for (const e of entries.slice(0, c.maxPromptPeople)) {
    const traits = (Array.isArray(e.traits) ? e.traits : [])
      .slice(0, c.maxPromptTraits)
      .map((t) => `${t.predicate} ${t.object}`);
    if (!traits.length) continue;
    const who = e.name && !/^QQ \d+$/.test(e.name) ? `${e.name}（QQ ${e.id}）` : `QQ ${e.id}`;
    const line = `- ${who}：${traits.join('；')}`;
    if (lines.join('\n').length + line.length + 1 > c.maxPromptChars) break;
    lines.push(line);
  }
  if (lines.length === 1) return '';
  return lines.join('\n');
}

/** 唤醒用：从 st 取当前在场候选人并格式化。 */
export function formatSharedMemoryForWake(stateDir, { key, st, localMemory = null, cfg = {}, now = Date.now() } = {}) {
  const c = normalizeSharedMemoryConfig(cfg);
  if (!c.enabled || !c.shareProfiles) return '';
  const userIds = [];
  for (const m of Array.isArray(st?.unread) ? st.unread : []) {
    if (m && !m.isSelf) userIds.push(m.userId);
  }
  if (st?.lastRequesterId) userIds.push(st.lastRequesterId);
  const entries = selectSharedForPrompt(stateDir, { key, localMemory, userIds, cfg: c, now });
  return formatSharedMemory(entries, c);
}

export function sharedMemoryStats(stateDir, cfg = {}) {
  const c = normalizeSharedMemoryConfig(cfg);
  const mem = loadSharedMemory(stateDir);
  let traits = 0;
  for (const p of Object.values(mem.people)) {
    traits += Object.values(p.traits || {}).filter((t) => t.status === 'active').length;
  }
  return {
    enabled: c.enabled,
    shareProfiles: c.shareProfiles,
    includePrivate: c.includePrivate,
    people: Object.keys(mem.people).length,
    traits,
    updatedAt: Number(mem.updatedAt) || 0
  };
}

/** 控制台列表：只下发结构化资料，不含消息原文。 */
export function listSharedPeople(stateDir, { q = '', limit = 100 } = {}) {
  const mem = loadSharedMemory(stateDir);
  const needle = norm(q);
  const rows = Object.values(mem.people)
    .filter((p) => {
      if (!needle) return true;
      if (p.id.includes(needle)) return true;
      return Object.values(p.names || {}).some((n) => norm(n).includes(needle));
    })
    .sort((a, b) => (Number(b.lastSeenAt) || 0) - (Number(a.lastSeenAt) || 0))
    .slice(0, Math.max(1, Math.min(500, Number(limit) || 100)))
    .map((p) => ({
      id: p.id,
      names: p.names,
      traits: Object.values(p.traits || {})
        .filter((t) => t.status === 'active')
        .sort((a, b) => (Number(b.hits) || 0) - (Number(a.hits) || 0))
        .map((t) => ({ predicate: t.predicate, object: t.object, confidence: t.confidence, hits: t.hits })),
      manualNote: p.manualNote || '',
      firstSeenAt: p.firstSeenAt,
      lastSeenAt: p.lastSeenAt
    }));
  return { updatedAt: Number(mem.updatedAt) || 0, rows };
}

export function forgetSharedPerson(stateDir, id) {
  const key = numericId(id);
  if (!key) return false;
  const mem = loadSharedMemory(stateDir);
  if (!mem.people[key]) return false;
  delete mem.people[key];
  mem.updatedAt = Date.now();
  saveSharedMemory(stateDir, mem);
  return true;
}

export function clearSharedMemory(stateDir) {
  const mem = emptySharedMemory();
  mem.updatedAt = Date.now();
  saveSharedMemory(stateDir, mem);
  return true;
}
