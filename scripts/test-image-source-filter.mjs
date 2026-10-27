// 回归测试：限定图源（群主说「从某站找」时不许返回别站的图）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createImageStore } from '../plugins/images/lib/image-store.js';
import { fetchFromSources } from '../plugins/images/lib/image-sources.js';

let pass = 0, fail = 0;
const check = (n, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };

// 每张图用不同字节，否则 store 按内容 md5 命名会互相覆盖
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000064000000640802000000ff1099e9000000064944415478da63fcffff3f030005fe02fea6d5b17c', 'hex');
const pngFor = (n) => Buffer.concat([PNG, Buffer.from(`pad-${n}`)]);

const d = fs.mkdtempSync(path.join(os.tmpdir(), 'src-filter-'));
const store = createImageStore({ dir: d, maxFiles: 100, maxTotalBytes: 1e9, log: () => {} });
// 同一角色，分布在三个源
store.add(pngFor(1), { id: 'safebooru:1', source: 'safebooru', artist: 'a', page: 'p/1', tags: ['1girl', 'hero_(game)'], rating: 'g' });
store.add(pngFor(2), { id: 'pixiv:2', source: 'pixiv', artist: 'a', page: 'p/2', tags: ['1girl', 'hero_(game)'], rating: 'safe' });
store.add(pngFor(3), { id: 'yandere:3', source: 'yandere', artist: 'a', page: 'p/3', tags: ['1girl', 'hero_(game)'], rating: 's' });
store.add(pngFor(4), { id: 'safebooru:4', source: 'safebooru', artist: 'a', page: 'p/4', tags: ['1girl', 'hero_(game)'], rating: 'g' });

const cnt = (filter) => store.pickRandom({ dryRun: true, ...filter }).count;
const idsOf = (filter) => {
  const seen = new Set();
  for (let i = 0; i < 60; i++) {
    const r = store.pickRandom(filter);
    if (r?.entry) seen.add(r.entry.id);
  }
  return seen;
};

console.log('── 不限源（基线）──');
check('不传 sources 时命中全部 4 张', cnt({ tags: ['hero_(game)'] }) === 4, `count=${cnt({ tags: ['hero_(game)'] })}`);

console.log('\n── 单源限定 ──');
check('只 safebooru → 2 张', cnt({ tags: ['hero_(game)'], sources: ['safebooru'] }) === 2, `count=${cnt({ tags: ['hero_(game)'], sources: ['safebooru'] })}`);
check('只 pixiv → 1 张', cnt({ tags: ['hero_(game)'], sources: ['pixiv'] }) === 1);
check('只 yandere → 1 张', cnt({ tags: ['hero_(game)'], sources: ['yandere'] }) === 1);
check('不存在的源 → 0 张', cnt({ tags: ['hero_(game)'], sources: ['nonexistent'] }) === 0);

console.log('\n── 多源限定 ──');
check('safebooru+pixiv → 3 张', cnt({ tags: ['hero_(game)'], sources: ['safebooru', 'pixiv'] }) === 3);
check('pixiv+yandere → 2 张', cnt({ tags: ['hero_(game)'], sources: ['pixiv', 'yandere'] }) === 2);

console.log('\n── 关键：抽出来的图必须都是指定源的 ──');
{
  const only = idsOf({ tags: ['hero_(game)'], sources: ['pixiv', 'yandere'], allowGroupImages: true, ignoreRecentUse: true });
  const allAllowed = [...only].every((id) => id.startsWith('pixiv:') || id.startsWith('yandere:'));
  check('60 次抽样全落在指定源内', allAllowed, [...only].join(','));
  check('不会出现被排除源的图', ![...only].some((id) => id.startsWith('safebooru:')), [...only].join(','));
}

console.log('\n── 大小写与空白容错 ──');
check('大写源名可用', cnt({ tags: ['hero_(game)'], sources: ['PIXIV'] }) === 1);
check('带空格可用', cnt({ tags: ['hero_(game)'], sources: [' pixiv '] }) === 1);
check('空数组等于不限', cnt({ tags: ['hero_(game)'], sources: [] }) === 4);
check('空字符串被忽略', cnt({ tags: ['hero_(game)'], sources: [''] }) === 4);

console.log('\n── 与标签条件叠加（AND 语义）──');
check('源对但标签不匹配 → 0', cnt({ tags: ['nonexistent_tag'], sources: ['pixiv'] }) === 0);
check('源不对但标签匹配 → 0', cnt({ tags: ['hero_(game)'], sources: ['nonexistent'] }) === 0);
{
  store.add(pngFor(5), { id: 'pixiv:9', source: 'pixiv', artist: 'a', page: 'p/9', tags: ['1girl', 'villain_(game)'], rating: 'safe' });
  check('源+标签同时生效', cnt({ tags: ['villain_(game)'], sources: ['pixiv'] }) === 1);
  check('源+标签（源内有该标签）', cnt({ tags: ['hero_(game)'], sources: ['pixiv'] }) === 1);
}

console.log('\n── 预检计数与实际抽图一致 ──');
{
  const dry = cnt({ tags: ['hero_(game)'], sources: ['safebooru'] });
  const real = idsOf({ tags: ['hero_(game)'], sources: ['safebooru'], allowGroupImages: true, ignoreRecentUse: true }).size;
  check('预检计数 = 实际能抽到的种数', dry === real, `dry=${dry} real=${real}`);
}

fs.rmSync(d, { recursive: true, force: true });

// ── fetchFromSources 的 sources 三种语义（最容易写反的地方）──
// undefined → 不限源；['pixiv'] → 只 pixiv；[]（空数组）→ 一个源都不查。
// 判据：用不存在的标签查询，看 errors 里出现了哪些源（即"确实尝试查过"的源）。
console.log('\n── 拉取侧 sources 语义 ──');
{
  const cfg = { safebooru: { enabled: true }, pixiv: { enabled: true }, yandere: { enabled: true } };
  const probe = async (sources) => {
    const r = await fetchFromSources(cfg, { limit: 1, tags: ['zzz_definitely_nonexistent_qq'], sources })
      .catch((e) => ({ errors: [`抛错 ${e.message}`] }));
    return [...new Set((r.errors ?? []).map((e) => String(e).split(':')[0].trim()))];
  };

  const all = await probe(undefined);
  check('undefined → 查全部启用源', all.length >= 3, all.join(','));
  const one = await probe(['pixiv']);
  check("['pixiv'] → 只查 pixiv", one.length === 1 && one[0] === 'pixiv', one.join(','));
  // 关键：空数组**不是**"不限源"。若当成不限源，群主要「从 pixiv 找」而 pixiv
  // 不可用时就会拿回别的站的图——正是本功能要防的事。
  const none = await probe([]);
  check('[] → 一个源都不查（非"不限源"）', none.length === 0, none.join(',') || '(无)');
  const bogus = await probe(['__unavailable__']);
  check('未知源名 → 不查任何源', bogus.length === 0, bogus.join(',') || '(无)');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
