// 回归测试：群像识别人与选图降权（纯逻辑，不依赖网络）。
//
// 背景：群像图带多个角色标签，查任何角色都能命中（实测群像平均 9.8 个角色标签、
// 单角色图仅 1.0），于是「要什么角色都发同一张大合照」。这里锁住判定规则。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createImageStore } from '../src/image-store.js';
import {
  isGroupImage, isGroupLike, characterTagCount, personCount, GROUP_IMAGE_TAGS
} from '../src/image-quality.js';

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
};
const mk = (tags) => ({ id: 'x', tags });

// ── personCount ──
console.log('── 人数识别 ──');
check('1girl → 1 人', personCount(mk(['1girl'])) === 1);
check('1boy+1girl → 2 人', personCount(mk(['1boy', '1girl'])) === 2);
check('2girls → 2 人', personCount(mk(['2girls'])) === 2);
check('3girls → 3 人', personCount(mk(['3girls'])) === 3);
check('6+girls → 6 人（下界）', personCount(mk(['6+girls'])) === 6);
check('multiple_girls 不计人数（靠标签判）', personCount(mk(['multiple_girls'])) === 0);
check('无人数标签 → 0', personCount(mk(['scenery', 'sky'])) === 0);
check('solo 不算人（是构图标签）', personCount(mk(['solo'])) === 0);
check('不误认 solo_girl 里的数字', personCount(mk(['solo_girl'])) === 0);

// ── isGroupImage（标签判定）──
console.log('\n── 群像标签判定 ──');
check('multiple_girls 命中', isGroupImage(mk(['multiple_girls'])) === true);
check('multiple_boys 命中', isGroupImage(mk(['multiple_boys'])) === true);
check('2girls 命中', isGroupImage(mk(['2girls'])) === true);
check('group 命中', isGroupImage(mk(['group'])) === true);
check('大小写不敏感', isGroupImage(mk(['Multiple_Girls'])) === true);
check('单人图不命中', isGroupImage(mk(['1girl', 'solo'])) === false);
check('风景图不命中', isGroupImage(mk(['scenery', 'no_humans'])) === false);
check('空 tags 不抛', isGroupImage(mk([])) === false);
check('undefined 不抛', isGroupImage(undefined) === false);

// ── isGroupLike（综合判定）──
console.log('\n── 综合判定（含兜底）──');
check('1girl+1boy 判群像', isGroupLike(mk(['1boy', '1girl'])) === true);
check('2girls 判群像', isGroupLike(mk(['2girls'])) === true);
// 关键误伤防护：实测有 chibi 单人图带 5 个角色标签，不能当群像
check('1girl+5 角色标签 不误判（真实样本）',
  isGroupLike(mk(['1girl', '?', 'black_eyes', 'arlecchino_(genshin_impact)', 'furina_(genshin_impact)', 'chibi', 'x_(y)', 'a_(b)', 'c_(d)'])) === false);
check('11 个角色标签（合集图，无人数据标签）判群像',
  isGroupLike(mk(Array.from({ length: 11 }, (_, i) => `c${i}_(f)`))) === true);
check('纯单人 1girl 判非群像', isGroupLike(mk(['1girl', 'solo', 'cat'])) === false);
check('阈值可调（3 个角色标签 + 阈值 3）',
  isGroupLike(mk(['a_(b)', 'c_(d)', 'e_(f)']), { charTagThreshold: 3 }) === true);
check('阈值可调（3 个角色标签 + 默认阈值 6）',
  isGroupLike(mk(['a_(b)', 'c_(d)', 'e_(f)'])) === false);

// ── characterTagCount ──
console.log('\n── 角色标签计数 ──');
check('识别 name_(franchise) 形态', characterTagCount(mk(['a_(b)', 'plain', 'c_(d)'])) === 2);
check('不误认普通括号', characterTagCount(mk(['a_b', '(x)'])) === 0);

// ── pickRandom 群像降权（核心行为）──
console.log('\n── 选图降权 ──');
{
  const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000064000000640802000000ff1099e9000000064944415478da63fcffff3f030005fe02fea6d5b17c', 'hex');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'img-group-'));
  const store = createImageStore({ dir: d, maxFiles: 100, maxTotalBytes: 1e9, log: () => {} });
  // 库里只有 1 张单人图 + 3 张群像图（都标同一角色）
  store.add(PNG, { id: 'g:single', source: 'safebooru', artist: 'a', page: 'p/1', tags: ['1girl', 'hero_(game)'], rating: 'g' });
  store.add(PNG, { id: 'g:group1', source: 'safebooru', artist: 'a', page: 'p/2', tags: ['multiple_girls', 'hero_(game)'], rating: 'g' });
  store.add(PNG, { id: 'g:group2', source: 'safebooru', artist: 'a', page: 'p/3', tags: ['2girls', 'hero_(game)'], rating: 'g' });
  store.add(PNG, { id: 'g:group3', source: 'safebooru', artist: 'a', page: 'p/4', tags: ['1boy', '1girl', 'hero_(game)'], rating: 'g' });

  // 默认（降权开）：多次抽取必须总是那张单人图
  const picks = new Set();
  for (let i = 0; i < 30; i++) picks.add(store.pickRandom({ tags: ['hero_(game)'] })?.entry?.id);
  check('降权开：只发单人图（30 次抽样）', picks.size === 1 && picks.has('g:single'), [...picks].join(','));

  // 关掉降权：会抽到群像（证明开关有效，也证明降权确实在起作用）
  const off = new Set();
  for (let i = 0; i < 60; i++) off.add(store.pickRandom({ tags: ['hero_(game)'], allowGroupImages: true })?.entry?.id);
  check('降权关：会抽到群像图', off.size > 1, [...off].join(','));

  fs.rmSync(d, { recursive: true, force: true });
}

// ── 全是群像时退回群像（不能说「没找到」）──
// ── 池里只有群像：**排除**而不是退回群像（2026-10-15 用户要求的行为变更）──
// 原先这里是"退路"逻辑：池里全是群像时仍发群像，理由是"有图总比没图好"。
// 用户要求改成「别发群像图（超过 10 个角色那种）」——群像从候选里彻底排除，
// 返回空结果让上层去外站现拉单人图（拉不到就如实说没找到）。
// 依据：库里 91 个角色标签中有 66 个（73%）只有群像候选，降权挡不住它们，
// 每次要这些角色都会发大合照。
console.log('\n── 池里只有群像：排除（不再退回群像）──');
{
  const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000064000000640802000000ff1099e9000000064944415478da63fcffff3f030005fe02fea6d5b17c', 'hex');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'img-group2-'));
  const store = createImageStore({ dir: d, maxFiles: 100, maxTotalBytes: 1e9, log: () => {} });
  store.add(PNG, { id: 'only:group', source: 'safebooru', artist: 'a', page: 'p/1', tags: ['multiple_girls', 'hero_(game)'], rating: 'g' });
  const r = store.pickRandom({ tags: ['hero_(game)'] });
  check('池里只有群像 → 不发群像（返回空，交给上层现拉）', !r?.entry, r?.entry?.id || '(空)');

  // 预检也要如实报 0，否则会出现"说本地有→发不出去"的矛盾
  const probe = store.pickRandom({ tags: ['hero_(game)'], dryRun: true });
  check('预检计数为 0（如实反映无可发候选）', Number(probe?.count) === 0, `count=${probe?.count}`);

  // 显式退出口仍可用（配置想恢复"有图总比没图好"时）
  const forced = store.pickRandom({ tags: ['hero_(game)'], allowGroupImages: true });
  check('开启退出口后仍能发群像', forced?.entry?.id === 'only:group', forced?.entry?.id);
  fs.rmSync(d, { recursive: true, force: true });
}

// ── 混合池：群像永不入选，只发单人图 ──
console.log('\n── 混合池：群像永不入选 ──');
{
  const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000064000000640802000000ff1099e9000000064944415478da63fcffff3f030005fe02fea6d5b17c', 'hex');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'img-group3-'));
  const store = createImageStore({ dir: d, maxFiles: 100, maxTotalBytes: 1e9, log: () => {} });
  store.add(PNG, { id: 'mix:group', source: 'safebooru', artist: 'a', page: 'p/1', tags: ['multiple_girls', 'hero_(game)'], rating: 'g' });
  store.add(PNG, { id: 'mix:single', source: 'safebooru', artist: 'b', page: 'p/2', tags: ['1girl', 'hero_(game)'], rating: 'g' });
  const ids = [];
  for (let i = 0; i < 8; i++) { const r = store.pickRandom({ tags: ['hero_(game)'] }); if (r?.entry) ids.push(r.entry.id); }
  check('多次抽取只出现单人图', ids.length > 0 && ids.every((x) => x === 'mix:single'), [...new Set(ids)].join(','));
  fs.rmSync(d, { recursive: true, force: true });
}

// ── 新鲜度降权：同一个角色不该老发同一张 ──
//
// 2026-10-20 调整：原先三张"不同的图"用的是**同一段 PNG 字节**，
// 而 add() 按内容哈希命名文件 → 三个条目共用同一个文件。
// 新的「10 分钟不重复发」按内容哈希记，于是 markUsed 其中一条等于把三条一起挡住。
// 测试数据必须换成**真正不同**的图，否则测的不是新鲜度逻辑。
console.log('\n── 新鲜度降权 ──');
{
  // 同一张 1x1 PNG，在末尾追加不同字节 → 仍是合法 PNG 前缀但内容不同
  const PNG_BASE = Buffer.from('89504e470d0a1a0a0000000d4948445200000064000000640802000000ff1099e9000000064944415478da63fcffff3f030005fe02fea6d5b17c', 'hex');
  const mkPng = (n) => Buffer.concat([PNG_BASE, Buffer.from([n])]);
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'img-fresh-'));
  const store = createImageStore({ dir: d, maxFiles: 100, maxTotalBytes: 1e9, log: () => {} });
  for (const i of [1, 2, 3]) {
    store.add(mkPng(i), { id: `f:${i}`, source: 'safebooru', artist: 'a', page: `p/${i}`, tags: ['1girl', 'hero_(game)'], rating: 'g' });
  }
  // 三张必须是不同文件（否则下面的断言没有意义）
  const files = new Set([1, 2, 3].map((i) => store.getById(`f:${i}`).file));
  check('测试数据是三张不同的图', files.size === 3, [...files].join(','));

  // 发掉 1 和 2
  store.markUsed('f:1');
  store.markUsed('f:2');

  const picks = new Set();
  for (let i = 0; i < 30; i++) picks.add(store.pickRandom({ tags: ['hero_(game)'] })?.entry?.id);
  check('未发过的图优先（只抽到 f:3）', picks.size === 1 && picks.has('f:3'), [...picks].join(','));

  // 全都发过之后：10 分钟规则下**应当一个都发不出**（这是用户明确要求的行为），
  // 而不是像以前那样"退回发过的图"。所以这里断言返回 null。
  store.markUsed('f:3');
  check('全部刚发过 → 返回 null（10 分钟内不重复发）',
    store.pickRandom({ tags: ['hero_(game)'] }) === null);

  // 关掉这道过滤：应能抽到已发过的（证明"全 null"来自本层，不是别的层清空了池子）
  const raw = new Set();
  for (let i = 0; i < 60; i++) raw.add(store.pickRandom({ tags: ['hero_(game)'], blockRecentMs: 0 })?.entry?.id);
  check('关掉 10 分钟过滤后可抽到已发图', raw.size > 1, [...raw].join(','));

  // 关掉新鲜度层（但仍开着 10 分钟过滤）→ 依然发不出，说明两道锁是独立的
  check('只关新鲜度层仍发不出（10 分钟规则独立生效）',
    store.pickRandom({ tags: ['hero_(game)'], ignoreRecentUse: true }) === null);

  fs.rmSync(d, { recursive: true, force: true });
}

// ── 拒绝名单：删掉的图不许再被拉回 ──
console.log('\n── 差评删图（拒绝名单）──');
{
  const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000064000000640802000000ff1099e9000000064944415478da63fcffff3f030005fe02fea6d5b17c', 'hex');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'img-rej-'));
  const store = createImageStore({ dir: d, maxFiles: 100, maxTotalBytes: 1e9, log: () => {} });
  store.add(PNG, { id: 'bad:1', source: 'safebooru', artist: 'a', page: 'p/1', tags: ['1girl', 'hero_(game)'], rating: 'g' });
  store.add(PNG, { id: 'ok:2', source: 'safebooru', artist: 'a', page: 'p/2', tags: ['1girl', 'hero_(game)'], rating: 'g' });

  const r = store.reject('bad:1', { reason: '不好看' });
  check('reject 删除成功', r.ok === true && r.existed === true, JSON.stringify(r));
  check('文件已删除', store.getById('bad:1') === null);
  check('计数减 1', store.count() === 1);
  // **最关键**：has() 必须仍为 true，否则拉取循环会把它再拉回来
  check('has() 仍为 true（阻止重拉）', store.has('bad:1') === true);
  check('isRejected 为 true', store.isRejected('bad:1') === true);

  // 重启后依然生效（持久化）
  const store2 = createImageStore({ dir: d, maxFiles: 100, maxTotalBytes: 1e9, log: () => {} });
  check('重启后仍拒绝', store2.isRejected('bad:1') === true && store2.has('bad:1') === true);
  check('重启后拒绝名单有 1 条', store2.rejectedStats().count === 1);

  // 选图不会再取到被拒的
  const picks = new Set();
  for (let i = 0; i < 20; i++) picks.add(store2.pickRandom({ tags: ['hero_(game)'] })?.entry?.id);
  check('选图不会取到被拒的图', !picks.has('bad:1'), [...picks].join(','));

  // 重复 reject 幂等
  const again = store2.reject('bad:1');
  check('重复 reject 幂等（不重复入名单）', again.ok === true && store2.rejectedStats().count === 1);
  // reject 不存在的 id 也能加入名单（防将来拉到）
  store2.reject('future:9');
  check('reject 未入库的 id 也进名单', store2.isRejected('future:9') === true);
  // unreject 可撤销
  store2.unreject('bad:1');
  check('unreject 后可再拉', store2.isRejected('bad:1') === false && store2.has('bad:1') === false);

  fs.rmSync(d, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
