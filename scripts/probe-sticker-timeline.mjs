// 诊断脚本（保留）：按天统计表情类工具调用，定位"从哪天起不再使用"。
// 用法：node scripts/probe-sticker-timeline.mjs
// 画表情工具调用的时间线：按天聚合，看从哪天起彻底停了。
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

const byDay = {};
const totals = {};
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
    const name = j.data?.name || '?';
    const day = new Date(j.time).toISOString().slice(0, 10);
    totals[day] = (totals[day] || 0) + 1;
    if (/qq_send_sticker|qq_list_stickers|qq_collect_sticker|qq_sticker_note|qq_get_sticker_image|qq_send_poke|qq_react_message/.test(name)) {
      const short = name.replace('mcp__snowluma__', '');
      byDay[day] = byDay[day] || {};
      byDay[day][short] = (byDay[day][short] || 0) + 1;
    }
  }
}

const days = [...new Set([...Object.keys(totals)])].sort();
console.log('日期        总调用  表情类明细');
for (const d of days) {
  const st = byDay[d] || {};
  const sum = Object.values(st).reduce((a, b) => a + b, 0);
  const detail = Object.entries(st).map(([k, v]) => `${k.replace('qq_', '')}=${v}`).join(' ');
  console.log(`${d}  ${String(totals[d]).padStart(6)}  ${sum ? detail : '—'}`);
}
