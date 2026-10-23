// download.mjs — 用 node 下载文件（git 直连被重置时使用）
// 用法: node scripts/download.mjs <url> <dest>
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const [url, dest] = process.argv.slice(2);
if (!url || !dest) {
  console.error('usage: node scripts/download.mjs <url> <dest>');
  process.exit(1);
}
console.log(`downloading ${url} -> ${dest}`);
const r = await fetch(url, { redirect: 'follow' });
if (!r.ok) throw new Error(`HTTP ${r.status}`);
fs.mkdirSync(path.dirname(dest), { recursive: true });
await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(dest));
const size = fs.statSync(dest).size;
console.log(`done: ${(size / 1048576).toFixed(1)} MB`);
