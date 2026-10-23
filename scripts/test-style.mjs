// 回归测试：画风特征（CLIP）与选图偏向。
// 需要 models/clip-vision-quantized.onnx 与 state/style-center.json 存在。
import fs from 'node:fs';
import path from 'node:path';
import { extractStyleVectors, cosine, meanVector } from '../src/image-style.js';
import { createImageStore } from '../src/image-store.js';

let pass = 0, fail = 0, skip = 0;
const check = (n, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };
const skipped = (n) => { skip++; console.log(`SKIP  ${n}`); };

const MODEL = 'models/clip-vision-quantized.onnx';
const CENTER_FILE = 'state/style-center.json';
const LIB = 'state/image-lib';

console.log(`模型: ${fs.existsSync(MODEL) ? '存在' : '缺失'}`);
console.log(`风格中心: ${fs.existsSync(CENTER_FILE) ? '存在' : '缺失'}\n`);

if (!fs.existsSync(MODEL)) {
  skipped('全部用例（缺 CLIP 模型）');
  console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped`);
  process.exit(0);
}

// ── 纯函数 ──
check('余弦：自身为 1', Math.abs(cosine([1, 0], [1, 0]) - 1) < 1e-9);
check('余弦：正交为 0', Math.abs(cosine([1, 0], [0, 1])) < 1e-9);
check('余弦：维度不匹配返回 0', cosine([1, 0], [1, 0, 0]) === 0);
{
  const m = meanVector([[1, 0], [1, 0]]);
  check('均值向量已归一化', Math.abs(Math.hypot(...m) - 1) < 1e-9);
  check('均值向量方向正确', Math.abs(m[0] - 1) < 1e-9);
}
check('空输入返回 null', meanVector([]) === null);

// ── 画风有效性：用户收藏内「同作品」应比「跨作品」更相似 ──
// 这是"提取的是画风而非画质"的核心判据。
{
  const base = 'D:/图片/pixiv';
  if (!fs.existsSync(base)) {
    skipped('画风有效性（找不到收藏目录）');
  } else {
    const walk = (d, out = []) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p, out);
        else if (/\.(jpe?g|png)$/i.test(e.name)) out.push(p);
      }
      return out;
    };
    const groups = {};
    for (const f of walk(base)) {
      const top = path.relative(base, f).split(path.sep)[0] || '_root';
      (groups[top] ??= []).push(f);
    }
    const picks = Object.entries(groups).filter(([, v]) => v.length >= 3).slice(0, 4).map(([k, v]) => [k, v.slice(0, 3)]);
    const all = picks.flatMap(([, v]) => v);
    console.log(`  抽样 ${all.length} 张（${picks.length} 组）…`);
    const vecs = await extractStyleVectors(all);
    check('全部图片提取成功', vecs.every(Boolean), `${vecs.filter(Boolean).length}/${vecs.length}`);
    check('向量维度为 512', vecs[0]?.length === 512, `实际 ${vecs[0]?.length}`);

    let idx = 0;
    const gv = picks.map(([, v]) => { const s = vecs.slice(idx, idx + v.length); idx += v.length; return s; });
    const avg = (a) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
    const intra = [], inter = [];
    for (const g of gv) for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) intra.push(cosine(g[i], g[j]));
    for (let a = 0; a < gv.length; a++) for (let b = a + 1; b < gv.length; b++) for (const x of gv[a]) for (const y of gv[b]) inter.push(cosine(x, y));
    check('组内相似度 > 组间（画风有区分力）', avg(intra) > avg(inter),
      `组内 ${avg(intra).toFixed(4)} vs 组间 ${avg(inter).toFixed(4)}（差 ${(avg(intra) - avg(inter)).toFixed(4)}）`);
    // 稳定性：同一张图两次提取应一致。
    // 注意别写 `Math.abs(cosine - 1) < 1e-4` —— 归一化向量的点积可能因浮点舍入
    // 略大于 1（如 1.0000001），取绝对值后反而超出阈值。用双边容差。
    const again = await extractStyleVectors([all[0]]);
    const sim = cosine(vecs[0], again[0]);
    check('同一图重复提取结果稳定', sim >= 1 - 1e-4 && sim <= 1 + 1e-4, `余弦=${sim.toFixed(7)}`);
  }
}

// ── 选图偏向：挑出的图平均画风分应高于全库平均 ──
{
  if (!fs.existsSync(CENTER_FILE)) {
    skipped('选图偏向（缺风格中心）');
  } else {
    const sc = JSON.parse(fs.readFileSync(CENTER_FILE, 'utf8'));
    check('风格中心维度正确', sc.center?.length === 512, `dim=${sc.center?.length}`);
    check('风格中心含基准统计', Number.isFinite(sc.stats?.median) && Number.isFinite(sc.stats?.p10),
      `中位=${sc.stats?.median} p10=${sc.stats?.p10}`);

    const store = createImageStore({ dir: LIB, maxFiles: 1e6, maxTotalBytes: 1e12, log: () => {} });
    const items = JSON.parse(fs.readFileSync(path.join(LIB, 'index.json'), 'utf8')).items;
    const scored = items.map((x) => Number(x.taste)).filter(Number.isFinite);
    if (scored.length < 20) {
      skipped('选图偏向（库内画风分不足）');
    } else {
      const allAvg = scored.reduce((a, b) => a + b, 0) / scored.length;
      const picks = [];
      for (let i = 0; i < 20; i++) {
        const r = store.pickRandom({});
        if (r) picks.push(Number(r.entry.taste) || 0);
      }
      const pickAvg = picks.reduce((a, b) => a + b, 0) / (picks.length || 1);
      check('选图平均画风分高于全库平均', pickAvg > allAvg,
        `选图 ${pickAvg.toFixed(3)} vs 全库 ${allAvg.toFixed(3)}（+${((pickAvg - allAvg) * 1000).toFixed(1)}‰）`);
    }
  }
}

console.log(`\n${pass} passed, ${fail} failed${skip ? `, ${skip} skipped` : ''}`);
process.exit(fail ? 1 : 0);
