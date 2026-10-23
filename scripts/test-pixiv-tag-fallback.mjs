// 验证 pixiv 的 booru 标签兜底：angelina_(arknights) 应能自动改用空格写法并拿到图。
import { pixiv } from '../src/image-sources.js';
import { proxyGet } from '../src/proxy-tunnel.js';

const PROXY = process.env.QQB_PROXY || 'http://127.0.0.1:7897';
let pass = 0, fail = 0, skip = 0;
const check = (n, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };
// 维护期（实测 2026-10-21 全站 503，官方维护到 10-22 凌晨 JST）跳过而非判红：
// 那一整段时间里"取到图"这条断言必然失败，与标签兜底逻辑无关。
const skipped = (n, why) => { skip++; console.log(`SKIP  ${n}  （${why}）`); };
const isMaintenance = (e) => /站点维护|503/.test(String(e?.message ?? e));
const WAIT = [1500, 3500];

const jsonFetch = async (url, opts = {}) => {
  let last;
  for (let i = 0; i <= WAIT.length; i++) {
    try {
      const r = await proxyGet(url, { proxy: PROXY, headers: { 'user-agent': 'qq-bridge/0.1', ...(opts.referer ? { referer: opts.referer } : {}) }, timeoutMs: 40000 });
      if (r.status < 200 || r.status >= 300) { const e = new Error(`HTTP ${r.status}`); e.status = r.status; throw e; }
      return JSON.parse(r.body.toString('utf8'));
    } catch (e) { last = e; if (Number.isFinite(e?.status)) throw e; if (WAIT[i]) await new Promise((s) => setTimeout(s, WAIT[i])); }
  }
  throw last;
};
const rawFetch = async () => 0;

const cases = [
  ['angelina_(arknights)', '安洁丽娜（截图里那个）'],
  ['varesa_(genshin_impact)', '沃雅妮莎'],
  ['skadi_(arknights)', '斯卡蒂'],
];
for (const [tag, label] of cases) {
  const corrections = [];
  try {
    const r = await pixiv.fetchList({
      tags: [tag], limit: 3, jsonFetch, rawFetch,
      onCorrection: (list) => corrections.push(...list)
    });
    check(`${label} [${tag}] 取到图`, r.length > 0, `${r.length} 条`);
    if (corrections.length) {
      console.log(`     纠错记录: ${corrections.map((c) => `${c.from} → ${c.to}`).join('; ')}`);
      check(`${label} 有纠错说明`, corrections.some((c) => c.note?.includes('booru')));
    }
    if (r[0]) console.log(`     样本: ${r[0].page}`);
  } catch (e) {
    if (isMaintenance(e)) skipped(`${label} [${tag}] 取到图`, 'pixiv 维护中');
    else check(`${label} [${tag}] 取到图`, false, `抛错: ${e.message.slice(0, 70)}`);
  }
  await new Promise((s) => setTimeout(s, 2500));
}

// 对照：正常标签不该被兜底影响
console.log('\n── 正常标签不受影响 ──');
try {
  const r = await pixiv.fetchList({ tags: ['アンジェリーナ'], limit: 3, jsonFetch, rawFetch });
  check('日文标签直接可用', r.length > 0, `${r.length} 条`);
} catch (e) {
  if (isMaintenance(e)) skipped('日文标签直接可用', 'pixiv 维护中');
  else check('日文标签直接可用', false, e.message.slice(0, 60));
}

console.log(`\n${pass} passed, ${fail} failed${skip ? `, ${skip} skipped` : ''}`);
process.exit(fail ? 1 : 0);
