// 给图库图片算「画风分」：与用户风格中心（state/style-center.json）的余弦相似度。
// 用法: node scripts/score-style.mjs [数量上限]
import fs from 'node:fs';
import path from 'node:path';
import { createImageStore } from '../plugins/images/lib/image-store.js';
import { extractStyleVectors, cosine } from '../plugins/images/lib/image-style.js';

const LIB = 'state/image-lib';
const CENTER_FILE = 'state/style-center.json';
const limit = Number(process.argv[2]) || 2000;

if (!fs.existsSync(CENTER_FILE)) {
  console.error(`缺少 ${CENTER_FILE}，请先跑 scripts/build-style-center.mjs`);
  process.exit(1);
}
const sc = JSON.parse(fs.readFileSync(CENTER_FILE, 'utf8'));
console.log(`风格中心: 基于 ${sc.vectors} 张收藏（${sc.sourceDir}）`);
console.log(`收藏内部相似度: p10=${sc.stats.p10} 中位=${sc.stats.median} p90=${sc.stats.p90}\n`);

const store = createImageStore({ dir: LIB, maxFiles: 100000, maxTotalBytes: 1e12, log: () => {} });
const todo = store.listWithoutTaste(limit);
console.log(`待算: ${todo.length} 张`);

// 批量提取（一次起一个 Python 进程，按批处理）
const BATCH = 50;
let done = 0, failed = 0;
const t0 = Date.now();
for (let i = 0; i < todo.length; i += BATCH) {
  const chunk = todo.slice(i, i + BATCH);
  const files = chunk.map((it) => path.join(LIB, it.file));
  const exists = files.map((f) => fs.existsSync(f));
  let vecs;
  try {
    vecs = await extractStyleVectors(files.filter((_, k) => exists[k]));
  } catch (e) {
    console.log(`  批次失败: ${e.message.slice(0, 60)}`);
    failed += chunk.length;
    continue;
  }
  let vi = 0;
  for (let k = 0; k < chunk.length; k++) {
    if (!exists[k]) { failed++; continue; }
    const v = vecs[vi++];
    if (!v) { failed++; continue; }
    store.setTaste(chunk[k].id, +cosine(v, sc.center).toFixed(4), { defer: true });
    done++;
  }
  process.stdout.write(`  已算 ${done}…\r`);
}
store.save(); // 批末统一落盘（setTaste 用了 defer）
console.log(`\n完成: ${done} 张，失败 ${failed}，耗时 ${((Date.now() - t0) / 1000).toFixed(0)}s`);

const items = JSON.parse(fs.readFileSync(path.join(LIB, 'index.json'), 'utf8')).items;
const scores = items.filter((x) => Number.isFinite(Number(x.taste))).map((x) => Number(x.taste)).sort((a, b) => a - b);
if (scores.length) {
  const q = (p) => scores[Math.floor(scores.length * p)].toFixed(3);
  console.log(`\n图库画风分分布: min=${q(0)} p10=${q(0.1)} p25=${q(0.25)} 中位=${q(0.5)} p75=${q(0.75)} max=${q(0.999)}`);
  console.log(`对照你的收藏分布:        min=${sc.stats.min} p10=${sc.stats.p10} p25=${sc.stats.p25} 中位=${sc.stats.median} p75=${sc.stats.p75} max=${sc.stats.max}`);
  const below = scores.filter((s) => s < sc.stats.p10).length;
  console.log(`\n低于收藏 p10（${sc.stats.p10}）的图库图: ${below}/${scores.length}（${(below / scores.length * 100).toFixed(0)}%）—— 这些是"最不像你画风"的`);
}
