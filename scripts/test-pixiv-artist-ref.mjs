// 端到端验证：各种「画师 ID」写法在 pixiv 适配器里都能取到该画师的作品。
// 对照 lack（userId 83739）；136201011 是 lack 的一个作品（用于测作品链接）。
import { pixiv } from '../plugins/images/lib/image-sources.js';
import { proxyGet } from '../src/proxy-tunnel.js';

const PROXY = process.env.QQB_PROXY || 'http://127.0.0.1:7897';
let pass = 0, fail = 0, skip = 0;
const check = (n, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };
// 维护期跳过：pixiv 会整站 503（实测 2026-10-21，官方维护到 10-22 凌晨 JST）。
// 那种情况下所有网络断言都会失败，但**不是代码回归**；判红只会把真正的回归淹没。
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

// 每种写法都应取到 lack 的作品
const forms = [
  ['artist:83739', 'artist:83739'],
  ['user:83739', 'user:83739'],
  ['主页链接', 'https://www.pixiv.net/users/83739'],
  ['主页链接 /en/', 'https://www.pixiv.net/en/users/83739'],
  ['无协议域名', 'pixiv.net/users/83739'],
  ['路径片段 users/83739', 'users/83739'],
  ['artist: + 链接', 'artist:https://www.pixiv.net/users/83739'],
  ['作品链接（需二次解析）', 'https://www.pixiv.net/artworks/136201011'],
];

for (const [label, tag] of forms) {
  try {
    const r = await pixiv.fetchList({ tags: [tag], limit: 3, jsonFetch, rawFetch });
    const ok = r.length > 0 && r.every((e) => e.artist === 'lack');
    check(`${label}  → 取到 lack 的作品`, ok, `${r.length} 条${r.length ? ` 作者=${[...new Set(r.map((e) => e.artist))].join(',')}` : ''}`);
  } catch (e) {
    if (isMaintenance(e)) skipped(`${label}  → 取到 lack 的作品`, 'pixiv 维护中');
    else check(`${label}  → 取到 lack 的作品`, false, `抛错: ${e.message.slice(0, 60)}`);
  }
  await new Promise((s) => setTimeout(s, 1200));
}

// 裸数字/普通标签不能被当成画师 ID
for (const [label, tag] of [['裸数字 2026', '2026'], ['普通标签 cat', 'cat']]) {
  try {
    const r = await pixiv.fetchList({ tags: [tag], limit: 2, jsonFetch, rawFetch });
    const hitLack = r.some((e) => e.artist === 'lack');
    check(`${label} 不走画师分支`, !hitLack, `${r.length} 条`);
  } catch (e) {
    check(`${label} 不走画师分支`, true, `抛错(可接受): ${e.message.slice(0, 40)}`);
  }
  await new Promise((s) => setTimeout(s, 1200));
}

console.log(`\n${pass} passed, ${fail} failed${skip ? `, ${skip} skipped` : ''}`);
process.exit(fail ? 1 : 0);
