import { humanTokens } from './plugin-api/format.js';
export { humanTokens } from './plugin-api/format.js';
// Token 用量统计：从 DSH 会话转录里解析 usage，按天聚合。
//
// 需求（2026-10-21 用户）：「把 token 记录做成日志，每日更新并且放进控制台」。
//
// ── 为什么复用 scripts/token-usage.mjs 的解析逻辑 ────────────────────────
//
// 那个脚本已经踩平了两个坑，照抄比重新踩一遍划算：
//   ① 会话文件是 **zstd 多帧拼接**（每行一帧）。`zstdDecompressSync` 一次性解只拿到第一帧，
//      必须按魔数 `28 B5 2F FD` 切帧逐个解。
//   ② **同一份 usage 会出现两次**：`assistant/chunk`（流式增量）与 `assistant/message`
//      （该步最终汇总）。直接累加会把用量算成两倍（实测 65 组里 15 组重复）。
//      所以按 `(turn, step, input, output, cacheRead)` 去重，并优先保留 message 那条。
//   ③ 缓存字段名是 `cacheReadTokens`（不是 openai 的 cache_read_input_tokens）。
//
// ── 本模块在此之上补的两件事 ────────────────────────────────────────────
//
//   - **模型名**：usage 事件里**没有** model 字段（实测 30617 条 usage 行都没有）。
//     它在 `request/header` 事件里（`data.header.config.model`）。所以要先扫一遍
//     request/header 建立「turn → 模型」映射，再给 usage 归属。旧脚本按
//     `data.model` 取，所以「按模型」那段只统计到 67 次（总数 40006）——这里修正。
//   - **增量扫描**：桥接要每天算一次，不能每次把 72MB × N 个会话全解一遍。
//     用文件 mtime + size 做指纹，未变的文件直接复用上次结果。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** 解 zstd 多帧拼接的会话文件。 */
export function readSessionText(file) {
  const buf = fs.readFileSync(file);
  const starts = [];
  let pos = 0;
  while (true) {
    const i = buf.indexOf(ZSTD_MAGIC, pos);
    if (i < 0) break;
    starts.push(i);
    pos = i + 1;
  }
  const parts = [];
  for (let k = 0; k < starts.length; k++) {
    const s = starts[k];
    const e = k + 1 < starts.length ? starts[k + 1] : buf.length;
    try { parts.push(zlib.zstdDecompressSync(buf.subarray(s, e)).toString('utf8')); } catch { /* 跳过坏帧 */ }
  }
  return parts.join('');
}

/** 归一化 usage（兼容多种命名）。 */
export function pickUsage(u) {
  if (!u || typeof u !== 'object') return null;
  const input = Number(u.inputTokens ?? u.prompt_tokens ?? 0) || 0;
  const output = Number(u.outputTokens ?? u.completion_tokens ?? 0) || 0;
  const cacheRead = Number(u.cacheReadTokens ?? u.cache_read_input_tokens ?? 0) || 0;
  const cacheWrite = Number(u.cacheWriteTokens ?? u.cache_creation_input_tokens ?? 0) || 0;
  const reasoning = Number(u.reasoningTokens ?? u.completion_thinking_tokens ?? u.reasoning_tokens ?? 0) || 0;
  if (!input && !output && !cacheRead && !cacheWrite && !reasoning) return null;
  return { input, output, cacheRead, cacheWrite, reasoning };
}

/** 上海时区的 YYYY-MM-DD（按天归档用它，避免 UTC 跨日错位）。 */
export function dayKey(ms) {
  try {
    return new Date(Number(ms)).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
  } catch {
    return '';
  }
}

/**
 * 解析一个会话文件，返回按天、按模型的用量明细。
 *
 * @param {string} file session.jsonl.zstd 的绝对路径
 * @returns {{days:Object<string,object>, models:Object<string,object>, turns:number, calls:number}|null}
 */
export function parseSessionFile(file) {
  let text;
  try { text = readSessionText(file); } catch { return null; }
  if (!text) return null;

  // ① 模型来源：`request/header` 事件里带 `data.header.config.model`，
  //    但它**没有 turn 字段**（2026-10-21 实测：dataKeys 只有 header,reason）——
  //    所以不能按 turn 关联，只能**按时间顺序**：header 出现在其后的 usage 之前，
  //    代表"接下来这次请求用的是这个模型"。用一个游标顺序继承即可；
  //    同一会话中途换模型时，顺序继承也正好跟得上。
  let currentModel = '';
  const lines = text.split('\n');

  // ② 第二遍：收集 usage 并去重
  //    去重键 (turn, step, input, output, cacheRead)；同键优先 message 那条。
  const seen = new Map();
  let turns = 0;

  for (const line of lines) {
    if (!line) continue;
    if (line.includes('"turn/end"')) turns++;
    const hasUsage = line.includes('"usage"');
    const isHeader = line.includes('request/header');
    if (!hasUsage && !isHeader) continue;
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    const data = j?.data ?? {};

    if (isHeader) {
      const m = String(data?.header?.config?.model ?? '').trim();
      if (m) currentModel = m;
      continue;
    }

    const u = pickUsage(data.chunk?.usage ?? data.usage);
    if (!u) continue;
    const turn = Number(data.turn ?? -1);
    const step = Number(data.step ?? -1);
    const key = `${turn}|${step}|${u.input}|${u.output}|${u.cacheRead}`;
    const isMsg = String(j.type || '').includes('message');
    const prev = seen.get(key);
    if (!prev || (isMsg && !prev.fromMessage)) {
      seen.set(key, { u, fromMessage: isMsg, turn, model: currentModel, time: Number(j.time) || 0 });
    }
  }

  if (!seen.size) return { days: {}, models: {}, dayModels: {}, turns, calls: 0, firstAt: 0, lastAt: 0 };

  let firstAt = 0;
  let lastAt = 0;
  for (const { time } of seen.values()) {
    const t = Number(time) || 0;
    if (!t) continue;
    if (!firstAt || t < firstAt) firstAt = t;
    if (t > lastAt) lastAt = t;
  }

  const days = {};
  const models = {};
  // dayModels：{ 'YYYY-MM-DD': { '模型名': {input,output,...} } }
  //
  // 需求（2026-10-21 用户）：「token用量卡片增加按日审阅的下拉菜单（默认总计），
  // 按模型改成选择的日期按模型调用的token数」。
  // 原来的 `models` 是**全时段**汇总，无法回答「10-19 那天哪个模型用得最多」。
  // 这里在解析阶段就按 (天, 模型) 分桶——不能事后从 days/models 反推：
  // 两个维度的边际汇总推不出联合分布（比如某模型跨 3 天用了 10M，
  // 不知道每天各多少）。必须在看到每条 usage 时就同时记两个维度。
  const dayModels = {};
  const bump = (obj, key, u) => {
    const c = obj[key] || (obj[key] = { input: 0, output: 0, cacheRead: 0, reasoning: 0, calls: 0 });
    c.input += u.input;
    c.output += u.output;
    c.cacheRead += u.cacheRead;
    c.reasoning += u.reasoning;
    c.calls += 1;
  };

  for (const { u, model, time } of seen.values()) {
    const dk = dayKey(time);
    const m = model || '(未知模型)';
    if (dk) {
      bump(days, dk, u);
      bump(dayModels[dk] || (dayModels[dk] = {}), m, u);
    }
    bump(models, m, u);
  }
  return { days, models, dayModels, turns, calls: seen.size, firstAt, lastAt };
}

/**
 * 扫描多个会话根目录并聚合。
 *
 * @param {string[]} roots 形如 ~/.dsh/sessions 或其中某个具体目录
 * @param {object} opts
 *   - cache    上次的缓存（{ [filePath]: { mtimeMs, size, days, models, turns, calls } }）
 *   - maxFiles 最多处理多少个文件（按 mtime 从新到旧；防止首次扫描太久）
 * @returns {{days:Object, models:Object, turns:number, calls:number, cache:Object, scanned:number, reused:number}}
 */
export function aggregateTokenUsage(roots, opts = {}) {
  const prevCache = opts.cache && typeof opts.cache === 'object' ? opts.cache : {};
  const maxFiles = Math.max(1, Number(opts.maxFiles) || 400);

  // 收集所有会话文件
  const files = [];
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) { walk(p, depth + 1); continue; }
      // 两种命名都出现：session.jsonl.zstd / session.v4.jsonl.zstd
      if (/^session(\.[\w-]+)?\.jsonl\.zstd$/.test(ent.name)) files.push(p);
    }
  };
  for (const root of (Array.isArray(roots) ? roots : [])) walk(root, 0);

  // 按 mtime 从新到旧取前 maxFiles
  const withStat = files.map((f) => {
    let st = null;
    try { st = fs.statSync(f); } catch {}
    return { f, st };
  }).filter((x) => x.st).sort((a, b) => b.st.mtimeMs - a.st.mtimeMs).slice(0, maxFiles);

  const days = {};
  const models = {};
  const dayModels = {};
  const cache = {};
  const sessions = {};
  let turns = 0;
  let calls = 0;
  let scanned = 0;
  let reused = 0;

  // sessionId → QQ 会话 key：当前映射优先，其次历史映射。
  const keyMap = new Map();
  if (opts.sessionKeys instanceof Map) {
    for (const [sid, key] of opts.sessionKeys) if (key) keyMap.set(String(sid), String(key));
  } else if (opts.sessionKeys && typeof opts.sessionKeys === 'object') {
    for (const [sid, key] of Object.entries(opts.sessionKeys)) if (key) keyMap.set(String(sid), String(key));
  }
  if (opts.currentSessions && typeof opts.currentSessions === 'object') {
    for (const [key, sid] of Object.entries(opts.currentSessions)) {
      if (sid) keyMap.set(String(sid), String(key));
    }
  }

  const bumpSessionDay = (bucket, day, value) => {
    const target = bucket.days[day] || (bucket.days[day] = {
      input: 0, output: 0, cacheRead: 0, reasoning: 0, calls: 0
    });
    target.input += Number(value.input) || 0;
    target.output += Number(value.output) || 0;
    target.cacheRead += Number(value.cacheRead) || 0;
    target.reasoning += Number(value.reasoning) || 0;
    target.calls += Number(value.calls) || 0;
  };

  const bumpSession = (sid, parsed) => {
    // DSH 会话目录名就是 sessionId；同一目录下可能有 session.jsonl.zstd
    // 与 session.v4.jsonl.zstd 两个文件，按 sessionId 合并。
    const bucket = sessions[sid] || (sessions[sid] = {
      sessionId: sid,
      key: keyMap.get(sid) || '',
      input: 0,
      cacheRead: 0,
      output: 0,
      reasoning: 0,
      calls: 0,
      firstAt: 0,
      lastAt: 0,
      days: {}
    });
    if (parsed.firstAt && (!bucket.firstAt || parsed.firstAt < bucket.firstAt)) bucket.firstAt = parsed.firstAt;
    if (parsed.lastAt && parsed.lastAt > bucket.lastAt) bucket.lastAt = parsed.lastAt;
    for (const [day, value] of Object.entries(parsed.days || {})) {
      bumpSessionDay(bucket, day, value);
      bucket.input += Number(value.input) || 0;
      bucket.cacheRead += Number(value.cacheRead) || 0;
      bucket.output += Number(value.output) || 0;
      bucket.reasoning += Number(value.reasoning) || 0;
      bucket.calls += Number(value.calls) || 0;
    }
  };

  const bump = (obj, key, u) => {
    const c = obj[key] || (obj[key] = { input: 0, output: 0, cacheRead: 0, reasoning: 0, calls: 0 });
    c.input += u.input;
    c.output += u.output;
    c.cacheRead += u.cacheRead;
    c.reasoning += u.reasoning;
    c.calls += u.calls;
  };

  for (const { f, st } of withStat) {
    const key = f;
    const hit = prevCache[key];
    let parsed;
    // 指纹：mtime + size 都没变就复用（桥接每天跑一次，不能每次全解）
    //
    // 注意 `hit.dayModels !== undefined` 这个条件：老缓存里没有 dayModels 字段，
    // 若只按 mtime/size 复用，升级后第一次统计会拿到 `undefined`，
    // 「按日看模型」就会静默显示空表（文件没变、数字却是 0，最难查的一类 bug）。
    // 要求缓存里确实有这个维度才算命中，否则重解该文件。
    // firstAt/lastAt 是 2026-10-25 为会话级报表新增的字段：老缓存没有，
    // 升级后首次会重解一遍（只发生一次），之后继续按 mtime+size 复用。
    const cacheComplete = hit && hit.dayModels !== undefined && hit.firstAt !== undefined;
    if (cacheComplete && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
      parsed = {
        days: hit.days || {}, models: hit.models || {}, dayModels: hit.dayModels || {},
        turns: hit.turns || 0, calls: hit.calls || 0,
        firstAt: hit.firstAt || 0, lastAt: hit.lastAt || 0
      };
      reused += 1;
    } else {
      parsed = parseSessionFile(f) || {
        days: {}, models: {}, dayModels: {}, turns: 0, calls: 0, firstAt: 0, lastAt: 0
      };
      scanned += 1;
    }
    cache[key] = {
      mtimeMs: st.mtimeMs, size: st.size,
      days: parsed.days, models: parsed.models, dayModels: parsed.dayModels,
      turns: parsed.turns, calls: parsed.calls,
      firstAt: parsed.firstAt || 0, lastAt: parsed.lastAt || 0
    };
    turns += parsed.turns;
    calls += parsed.calls;
    for (const [d, v] of Object.entries(parsed.days)) bump(days, d, v);
    for (const [m, v] of Object.entries(parsed.models)) bump(models, m, v);
    for (const [d, mm] of Object.entries(parsed.dayModels || {})) {
      const target = dayModels[d] || (dayModels[d] = {});
      for (const [m, v] of Object.entries(mm || {})) bump(target, m, v);
    }
    // 同一 session 可能对应多个文件（session.jsonl.zstd / session.v4.jsonl.zstd），
    // 按目录名合并；key 由调用方传入的当前映射 + 历史映射解析。
    bumpSession(path.basename(path.dirname(f)), parsed);
  }

  for (const bucket of Object.values(sessions)) {
    bucket.totalInput = (Number(bucket.input) || 0) + (Number(bucket.cacheRead) || 0);
    if (!bucket.key) bucket.key = null;
  }

  return { days, models, dayModels, turns, calls, sessions, cache, scanned, reused, files: withFilesCount(withStat.length) };
}

function withFilesCount(n) { return n; }

