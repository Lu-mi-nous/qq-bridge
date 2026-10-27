// 从用户收藏目录建立「风格中心」：CLIP 画风向量的均值。
// 用法: node scripts/build-style-center.mjs [收藏目录] [抽样数]
// 输出: state/style-center.json（512 维向量 + 元信息）
import fs from 'node:fs';
import path from 'node:path';
import { extractStyleVectors, meanVector } from '../plugins/images/lib/image-style.js';

const DIR = process.argv[2] || 'C:/pixiv';
const SAMPLE = Number(process.argv[3]) || 400;
const OUT = 'state/style-center.json';

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(jpe?g|png)$/i.test(e.name)) out.push(p);
  }
  return out;
}

const all = walk(DIR);
console.log(`收藏目录 ${DIR}: ${all.length} 张`);
// 等距抽样（覆盖各子目录，避免只取到某一批）
const step = Math.max(1, Math.floor(all.length / SAMPLE));
const sample = all.filter((_, i) => i % step === 0).slice(0, SAMPLE);
console.log(`抽样 ${sample.length} 张，提取画风向量…`);

const t0 = Date.now();
const vecs = (await extractStyleVectors(sample)).filter(Boolean);
console.log(`有效 ${vecs.length} 个向量，耗时 ${((Date.now() - t0) / 1000).toFixed(0)}s`);

const center = meanVector(vecs);
if (!center) { console.error('无法生成风格中心'); process.exit(1); }

// 同时记录「个体离散度」：用每张图与中心的余弦相似度分布，
// 后续可用它判断"多像才算像"（而不是拍一个阈值）
const sims = vecs.map((v) => v.reduce((s, x, i) => s + x * center[i], 0)).sort((a, b) => a - b);
const q = (p) => +sims[Math.floor(sims.length * p)].toFixed(4);

const payload = {
  version: 1,
  builtAt: new Date().toISOString(),
  sourceDir: DIR,
  sampled: sample.length,
  vectors: vecs.length,
  dim: center.length,
  center,
  stats: { min: +sims[0].toFixed(4), p10: q(0.1), p25: q(0.25), median: q(0.5), p75: q(0.75), p90: q(0.9), max: +sims[sims.length - 1].toFixed(4) },
};
fs.writeFileSync(OUT, JSON.stringify(payload));
console.log(`\n风格中心已写入 ${OUT}`);
console.log('收藏内部相似度分布（图 vs 中心）:', JSON.stringify(payload.stats));
