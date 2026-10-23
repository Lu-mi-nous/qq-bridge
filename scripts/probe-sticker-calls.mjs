// 诊断脚本（保留）：统计 DSH 会话里真实 tool/call，用于排查"某工具从不被调用"。
// 用法：node scripts/probe-sticker-calls.mjs   —— 按工具名排行
// 统计 DSH 会话里的真实工具调用（type=tool/call），按工具名聚合。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';

const dir = process.argv[2]
  || process.env.DSH_SESSIONS_DIR
  || path.join(os.homedir(), '.dsh', 'sessions');
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

function lines(file) {
  const buf = fs.readFileSync(file);
  const parts = [];
  let i = 0;
  while (i < buf.length) {
    let j = buf.indexOf(MAGIC, i + 1);
    if (j < 0) j = buf.length;
    const f = buf.subarray(i, j);
    i = j;
    if (f.length > 8) { try { parts.push(zlib.zstdDecompressSync(f).toString('utf8')); } catch {} }
  }
  return parts.join('\n').split('\n');
}

const counts = {};
const stickerCalls = [];
let total = 0;
const sessions = fs.readdirSync(dir).filter((d) => d.startsWith('session-')).map((d) => path.join(dir, d)).filter((p) => fs.statSync(p).isDirectory());
for (const s of sessions) {
  const f = path.join(s, 'session.jsonl.zstd');
  if (!fs.existsSync(f)) continue;
  for (const line of lines(f)) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    let j;
    try { j = JSON.parse(t); } catch { continue; }
    if (j.type !== 'tool/call') continue;
    total++;
    const name = j.data?.name || j.data?.tool || j.data?.toolName || '?';
    counts[name] = (counts[name] || 0) + 1;
    if (/sticker|react|poke/i.test(name)) stickerCalls.push({ t: j.time, name, args: JSON.stringify(j.data?.arguments ?? j.data?.args ?? {}).slice(0, 160) });
  }
}

console.log('total tool/call:', total);
console.log('--- 排行 ---');
for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) console.log(String(v).padStart(5), k);
console.log('\n--- 表情相关调用 ---');
if (!stickerCalls.length) console.log('(无)');
for (const c of stickerCalls.slice(0, 20)) console.log(new Date(c.t).toISOString(), c.name, c.args);
