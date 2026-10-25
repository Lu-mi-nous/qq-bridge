// 统计 DSH 会话转录里的 token 用量。
//
// 两个实现要点（都踩过）：
//   1) 会话文件是 **zstd 多帧拼接**（每行一帧），zstdDecompressSync 一次性解只拿到第一帧，
//      必须按魔数 28 B5 2F FD 切帧逐个解。
//   2) **同一份 usage 会出现两次**：`assistant/chunk`（流式增量）与
//      `assistant/message`（该步最终汇总）各带一份。直接累加会把用量算成两倍
//      （实测 65 组里 15 组重复）。所以按 (turn, step, input, output) 去重，
//      并优先保留 message 那条。
//   3) 缓存字段名是 `cacheReadTokens`（不是 openai 风格的 cache_read_input_tokens）。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

function readSession(file) {
  const buf = fs.readFileSync(file);
  const starts = [];
  let pos = 0;
  while (true) {
    const i = buf.indexOf(MAGIC, pos);
    if (i < 0) break;
    starts.push(i);
    pos = i + 1;
  }
  let text = '';
  for (let k = 0; k < starts.length; k++) {
    const s = starts[k];
    const e = k + 1 < starts.length ? starts[k + 1] : buf.length;
    try { text += zlib.zstdDecompressSync(buf.subarray(s, e)).toString('utf8'); } catch {}
  }
  return text;
}

function pickUsage(u) {
  if (!u || typeof u !== 'object') return null;
  const input = Number(u.inputTokens ?? u.prompt_tokens ?? 0) || 0;
  const output = Number(u.outputTokens ?? u.completion_tokens ?? 0) || 0;
  const cacheRead = Number(u.cacheReadTokens ?? u.cache_read_input_tokens ?? 0) || 0;
  const cacheWrite = Number(u.cacheWriteTokens ?? u.cache_creation_input_tokens ?? 0) || 0;
  const reasoning = Number(u.reasoningTokens ?? u.completion_thinking_tokens ?? u.reasoning_tokens ?? 0) || 0;
  if (!input && !output && !cacheRead && !cacheWrite && !reasoning) return null;
  return { input, output, cacheRead, cacheWrite, reasoning };
}

const roots = process.argv.slice(2);
if (!roots.length) { console.error('用法: node token-usage.mjs <会话目录...>'); process.exit(1); }

const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, calls: 0, turns: 0 };
const byModel = new Map();
const byDay = new Map();
const bySession = new Map();

function bump(map, key, u) {
  const c = map.get(key) || { input: 0, output: 0, cacheRead: 0, calls: 0 };
  c.input += u.input; c.output += u.output; c.cacheRead += u.cacheRead; c.calls += 1;
  map.set(key, c);
}

for (const root of roots) {
  let dirs = [];
  try { dirs = fs.readdirSync(root); } catch { continue; }
  for (const d of dirs) {
    const f = path.join(root, d, 'session.jsonl.zstd');
    if (!fs.existsSync(f)) continue;
    const text = readSession(f);
    if (!text) continue;

    const sess = { input: 0, output: 0, cacheRead: 0, calls: 0 };
    let turns = 0;
    // 去重表：key → { u, fromMessage }
    const seen = new Map();

    for (const line of text.split('\n')) {
      if (line.includes('"turn/end"')) turns++;
      if (!line.includes('"usage"')) continue;
      let j;
      try { j = JSON.parse(line); } catch { continue; }
      const data = j?.data ?? {};
      const u = pickUsage(data.chunk?.usage ?? data.usage);
      if (!u) continue;
      const turn = Number(data.turn ?? -1);
      const step = Number(data.step ?? -1);
      const key = `${turn}|${step}|${u.input}|${u.output}|${u.cacheRead}`;
      const isMsg = (j.type || '').includes('message');
      const prev = seen.get(key);
      // 同 key：message 优先（更权威）；否则保留先到的
      if (!prev || (isMsg && !prev.fromMessage)) seen.set(key, { u, fromMessage: isMsg, model: String(data.model || ''), time: Number(j.time) || 0 });
    }

    for (const { u, model, time } of seen.values()) {
      sess.input += u.input; sess.output += u.output; sess.cacheRead += u.cacheRead; sess.calls += 1;
      totals.input += u.input; totals.output += u.output;
      totals.cacheRead += u.cacheRead; totals.cacheWrite += u.cacheWrite;
      totals.reasoning += u.reasoning; totals.calls += 1;
      if (model) bump(byModel, model, u);
      if (time) bump(byDay, new Date(time).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }), u);
    }
    totals.turns += turns;
    if (sess.calls) bySession.set(d, sess);
  }
}

const n = (x) => x.toLocaleString('en-US');
const k = (x) => x >= 1e9 ? (x / 1e9).toFixed(2) + 'B' : x >= 1e6 ? (x / 1e6).toFixed(2) + 'M' : x >= 1e3 ? (x / 1e3).toFixed(1) + 'K' : String(x);

console.log('═══ 合计（已去重）═══');
console.log(`  模型调用次数: ${n(totals.calls)}`);
console.log(`  turn 数:      ${n(totals.turns)}`);
console.log(`  未缓存输入:   ${n(totals.input)}  (${k(totals.input)})`);
console.log(`  缓存读:       ${n(totals.cacheRead)}  (${k(totals.cacheRead)})`);
console.log(`  总输入(prompt): ${n(totals.input + totals.cacheRead)} (${k(totals.input + totals.cacheRead)})`);
console.log(`  输出 tokens:  ${n(totals.output)}  (${k(totals.output)})`);
if (totals.reasoning) console.log(`    其中推理:   ${n(totals.reasoning)}  (${k(totals.reasoning)})`);
console.log(`  总 tokens:    ${n(totals.input + totals.cacheRead + totals.output)} (${k(totals.input + totals.cacheRead + totals.output)})`);

if (byModel.size) {
  console.log('\n═══ 按模型 ═══');
  for (const [m, v] of [...byModel.entries()].sort((a, b) => b[1].input - a[1].input)) {
    console.log(`  ${m}: 未缓存=${k(v.input)} 缓存读=${k(v.cacheRead)} 总输入=${k(v.input + v.cacheRead)} out=${k(v.output)} 调用=${n(v.calls)}`);
  }
}

if (byDay.size) {
  console.log('\n═══ 按日期 ═══');
  for (const [d, v] of [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(`  ${d}: 总输入=${k(v.input + v.cacheRead).padStart(9)} 未缓存=${k(v.input).padStart(8)} 缓存读=${k(v.cacheRead).padStart(9)} out=${k(v.output).padStart(8)} 调用=${String(v.calls).padStart(5)}`);
  }
}

if (bySession.size) {
  console.log('\n═══ 最耗 token 的会话（前 10）═══');
  for (const [s, v] of [...bySession.entries()].sort((a, b) => b[1].input - a[1].input).slice(0, 10)) {
    console.log(`  ${s.slice(8, 30)}: in=${k(v.input).padStart(8)} out=${k(v.output).padStart(7)} 调用=${v.calls}`);
  }
}
