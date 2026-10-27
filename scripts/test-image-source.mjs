// 回归测试：图片「来源」查询（figure out 图源站点页 vs 原始发布处）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sourcePageOf, SOURCE_PAGE_RULES } from '../plugins/images/lib/image-sources.js';
import { createImageStore } from '../plugins/images/lib/image-store.js';

let pass = 0, fail = 0;
const check = (n, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };

console.log('── sourcePageOf：按 id 推导图源站点页 ──');
check('safebooru', sourcePageOf({ id: 'safebooru:5652039' }) === 'https://safebooru.donmai.us/posts/5652039');
check('yandere', sourcePageOf({ id: 'yandere:1269004' }) === 'https://yande.re/post/show/1269004');
check('pixiv', sourcePageOf({ id: 'pixiv:149989168' }) === 'https://www.pixiv.net/artworks/149989168');
check('存了 sourcePage 时优先用它', sourcePageOf({ id: 'safebooru:1', sourcePage: 'https://stored/x' }) === 'https://stored/x');
check('未知源返回空', sourcePageOf({ id: 'weird:1' }) === '');
check('id 格式异常返回空', sourcePageOf({ id: 'nonsense' }) === '');
check('空对象返回空', sourcePageOf({}) === '');
check('undefined 不抛', sourcePageOf(undefined) === '');
check('id 含非数字返回空', sourcePageOf({ id: 'safebooru:abc' }) === '');
check('三种源都有规则', ['safebooru', 'yandere', 'pixiv'].every((s) => typeof SOURCE_PAGE_RULES[s] === 'function'));

console.log('\n── 关键：sourcePage 与 page 是两件事 ──');
// 真实场景：booru 站转载 twitter 的图 → page 指向推特，sourcePage 指向 booru
{
  const entry = { id: 'safebooru:5652039', source: 'safebooru', page: 'https://twitter.com/Mizutsunya/status/1567156991109529601' };
  const sp = sourcePageOf(entry);
  check('page 是推特原帖', entry.page.includes('twitter.com'));
  check('sourcePage 是 booru 站点页', sp.includes('safebooru.donmai.us/posts/'));
  check('两者不同', sp !== entry.page);
}

console.log('\n── 存库与读回 ──');
{
  const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000064000000640802000000ff1099e9000000064944415478da63fcffff3f030005fe02fea6d5b17c', 'hex');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'img-src-'));
  const store = createImageStore({ dir: d, maxFiles: 100, maxTotalBytes: 1e9, log: () => {} });
  store.add(PNG, {
    id: 'safebooru:777', source: 'safebooru',
    page: 'https://twitter.com/someone/status/123',
    sourcePage: 'https://safebooru.donmai.us/posts/777',
    tags: ['1girl'], rating: 'g'
  });
  const back = store.getById('safebooru:777');
  check('sourcePage 已存库', back.sourcePage === 'https://safebooru.donmai.us/posts/777');
  check('page 保持原始出处', back.page === 'https://twitter.com/someone/status/123');

  // 重启后仍在
  const store2 = createImageStore({ dir: d, maxFiles: 100, maxTotalBytes: 1e9, log: () => {} });
  check('重启后 sourcePage 仍在', store2.getById('safebooru:777').sourcePage.includes('posts/777'));

  // 老条目（没存 sourcePage）也能推导出站点页
  const legacy = { id: 'yandere:999', source: 'yandere', page: 'https://x.com/a/status/1' };
  store2.add(Buffer.concat([PNG, Buffer.from('x')]), { id: 'yandere:999', source: 'yandere', page: 'https://x.com/a/status/1', tags: [], rating: 'g' });
  const le = store2.getById('yandere:999');
  check('老条目 sourcePage 为空但可推导', le.sourcePage === '' && sourcePageOf(le) === 'https://yande.re/post/show/999');
  fs.rmSync(d, { recursive: true, force: true });
}

console.log('\n── 真实图库抽样（推导覆盖率）──');
{
  const idx = JSON.parse(fs.readFileSync('state/image-lib/index.json', 'utf8'));
  const items = idx.items || [];
  let ok = 0, distinct = 0;
  for (const it of items) {
    const sp = sourcePageOf(it);
    if (sp) ok++;
    if (sp && it.page && sp !== it.page) distinct++;
  }
  console.log(`    ${items.length} 张中可推导出站点页 ${ok} 张；其中与原始出处不同的有 ${distinct} 张`);
  check('绝大多数图能推导出站点页', ok / items.length > 0.9, `${ok}/${items.length}`);
  check('确实存在「原始出处≠站点页」的情况（证明该字段有意义）', distinct > 0, `${distinct} 张`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
