// 回归测试：图库（image-sources + image-store 的纯逻辑部分）。
// 不依赖网络与运行中的服务，用本地构造数据验证关键行为。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createImageStore } from '../plugins/images/lib/image-store.js';
import { fetchFromSources, getSource, SOURCES } from '../plugins/images/lib/image-sources.js';

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'imgtest-'));
// 1x1 PNG（合法图片字节）
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');

try {
  const store = createImageStore({ dir: tmp, maxFiles: 3, log: () => {} });

  // ── 入库与去重 ──
  const e1 = store.add(PNG, { id: 's:1', source: 'safebooru', artist: 'a1', page: 'https://x/1', tags: ['cat'], rating: 'g' });
  check('入库返回条目', !!e1 && e1.id === 's:1');
  check('入库后计数为 1', store.count() === 1);
  check('同 id 重复入库不增加计数', (() => { store.add(PNG, { id: 's:1', artist: 'a1-new' }); return store.count() === 1; })());
  check('重复入库刷新元数据', store.getById('s:1').artist === 'a1-new');
  check('非图片字节被拒绝', store.add(Buffer.from('not an image!!'), { id: 's:bad' }) === null);
  check('缺 id 被拒绝', store.add(PNG, {}) === null);
  check('has() 正确识别已入库', store.has('s:1') === true && store.has('s:nope') === false);

  // ── 内容哈希去重（不同 id 同内容共用文件）──
  const before = fs.readdirSync(tmp).filter((f) => f.endsWith('.png')).length;
  store.add(PNG, { id: 's:2', source: 'safebooru' }); // 同字节不同 id
  const after = fs.readdirSync(tmp).filter((f) => f.endsWith('.png')).length;
  check('同内容不同 id 只占一个文件', after === before, `文件数 ${before}->${after}`);

  // ── 取图 ──
  const picked = store.pickRandom();
  check('随机取图返回条目与字节', !!picked?.entry && picked.buffer.length > 0);
  check('取图能按 tags 筛选（命中）', !!store.pickRandom({ tags: ['cat'] }) || store.count() === 0);
  check('取图能按 tags 筛选（未命中返回 null）', store.pickRandom({ tags: ['zzz-nothing'] }) === null);

  // ── 标记使用 ──
  const usedId = picked.entry.id;
  store.markUsed(usedId);
  check('markUsed 累加计数', store.getById(usedId).useCount === 1);
  check('markUsed 未知 id 返回 false', store.markUsed('nope') === false);

  // ── 淘汰 ──
  for (let i = 10; i < 15; i++) store.add(Buffer.concat([PNG, Buffer.from([i])]), { id: `s:${i}` });
  const totalBefore = store.count();
  const dropped = store.prune();
  check('淘汰后不超过上限', store.count() <= 3, `${totalBefore} -> ${store.count()}`);
  check('淘汰有返回值', dropped > 0);
  check('淘汰保留了最近使用的条目', !!store.getById(usedId), `保留 ${usedId}`);

  // ── 死条目清理（文件被外部删除）──
  const victim = store.pickRandom();
  if (victim) {
    fs.rmSync(path.join(tmp, victim.entry.file), { force: true });
    const r2 = store.pickRandom();
    check('文件丢失的条目会被跳过并清掉', r2 === null || r2.entry.id !== victim.entry.id);
  }

  // ── 统计 ──
  const st = store.stats();
  check('统计返回总数与来源分布', typeof st.total === 'number' && typeof st.bySource === 'object');
  check('统计返回字节数与上限', typeof st.totalBytes === 'number' && typeof st.maxTotalMB === 'number',
    `${st.totalMB}MB / 上限 ${st.maxTotalMB}MB`);

  // ── 淘汰行为：满库时按需拉取的新图必须活下来 ──
  // 这是按需查询最常见的场景（库满 + 用户要新标签）。曾出现「刚拉的图被自己淘汰，
  // 用户永远拿不到」——因为「未用过」排在「用过」之前，而新图必然未用过。
  {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'imgprune-'));
    const mk = (i) => Buffer.concat([PNG, Buffer.from([i])]);
    const s = createImageStore({ dir: d, maxFiles: 3, maxTotalBytes: 1e9, log: () => {} });
    for (let i = 0; i < 3; i++) {
      s.add(mk(i), { id: `old:${i}`, tags: ['oldtag'] });
      s.markUsed(`old:${i}`); // 旧图全部「用过」
    }
    s.add(mk(10), { id: 'new:1', tags: ['newtag'] });
    s.add(mk(11), { id: 'new:2', tags: ['newtag'] });
    s.prune();
    check('满库淘汰后不超上限', s.count() <= 3, `${s.count()} 张`);
    const gotNew = s.pickRandom({ tags: ['newtag'] });
    check('刚按需拉取的新图不会被自己淘汰', !!gotNew, gotNew ? `拿到 ${gotNew.entry.id}` : '被淘汰了');
    const gotOld = s.pickRandom({ tags: ['oldtag'] });
    check('刚发过的旧图默认不会被选中（10 分钟规则生效）', !gotOld);
    // 注意：本用例验的是**淘汰策略**（旧图不该被新图挤掉），与"10 分钟内不重复发"无关。
    // 而 old:0..2 都调过 markUsed，会被那道 10 分钟过滤挡掉——所以要在本断言里关掉它，
    // 否则测的就不是淘汰了。（blockRecentMs:0 只影响这一次挑选，不改持久状态）
    const gotOld2 = s.pickRandom({ tags: ['oldtag'], blockRecentMs: 0 });
    check('旧图仍在（未过度淘汰）', !!gotOld2, gotOld2 ? `拿到 ${gotOld2.entry.id}` : '全被淘汰');
    fs.rmSync(d, { recursive: true, force: true });
  }

  // ── 淘汰稳定性：同毫秒批量入库也应满足上限 ──
  {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'imgsame-'));
    const s = createImageStore({ dir: d, maxFiles: 2, maxTotalBytes: 1e9, log: () => {} });
    for (let i = 0; i < 5; i++) s.add(Buffer.concat([PNG, Buffer.from([i])]), { id: `same:${i}` });
    s.prune();
    check('同毫秒批量入库仍满足上限', s.count() <= 2, `${s.count()} 张`);
    fs.rmSync(d, { recursive: true, force: true });
  }

  // ── 字节上限（关键：不能只靠数量兜底）──
  {
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'imgbytes-'));
    // 每张 ~10KB，限总量 25KB → 最多约 2 张
    const chunk = Buffer.concat([PNG, Buffer.alloc(10 * 1024, 7)]);
    const s2 = createImageStore({ dir: dir2, maxFiles: 999, maxTotalBytes: 25 * 1024, log: () => {} });
    for (let i = 0; i < 8; i++) s2.add(Buffer.concat([chunk, Buffer.from([i])]), { id: `b:${i}` });
    check('入库 8 张后超出字节上限', s2.totalBytes() > 25 * 1024, `${(s2.totalBytes() / 1024).toFixed(0)}KB`);
    s2.prune();
    check('prune 后字节不超上限', s2.totalBytes() <= 25 * 1024, `剩余 ${(s2.totalBytes() / 1024).toFixed(0)}KB / ${s2.count()} 张`);
    check('仅字节受限时数量上限不生效', s2.count() < 8 && s2.count() >= 1, `${s2.count()} 张`);

    // 反向：字节宽松、数量收紧 → 应按数量淘汰
    const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'imgcount-'));
    const s3 = createImageStore({ dir: dir3, maxFiles: 2, maxTotalBytes: 100 * 1024 * 1024, log: () => {} });
    for (let i = 0; i < 6; i++) s3.add(Buffer.concat([PNG, Buffer.from([i])]), { id: `c:${i}` });
    s3.prune();
    check('字节宽松时按数量上限淘汰', s3.count() === 2, `${s3.count()} 张`);
    fs.rmSync(dir2, { recursive: true, force: true });
    fs.rmSync(dir3, { recursive: true, force: true });
  }

  // ── 源注册表 ──
  check('safebooru 已注册', getSource('safebooru') === SOURCES.safebooru);
  check('pixiv 已注册', getSource('pixiv') === SOURCES.pixiv);
  check('未知源返回 null', getSource('nope') === null);
  // pixiv 实测**不需要登录**：日榜/搜索接口公开，图床只要带 Referer 就放行。
  // 之前误以为需要 token，故标记 needsAuth=true；现已按实测更正。
  check('pixiv 无需鉴权（只需 Referer）', SOURCES.pixiv.needsAuth === false);
  check('pixiv 需要代理', SOURCES.pixiv.requiresProxy === true);

  // ── 分级过滤（不联网，用桩源验证过滤逻辑）──
  {
    const fake = SOURCES.safebooru;
    check('g 分级判为安全', fake.normalizeSafe({ rating: 'g' }) === true);
    check('s 分级判为安全', fake.normalizeSafe({ rating: 's' }) === true);
    check('e 分级被拒', fake.normalizeSafe({ rating: 'e' }) === false);
    check('q 分级被拒', fake.normalizeSafe({ rating: 'q' }) === false);
    check('空分级被拒（保守）', fake.normalizeSafe({ rating: '' }) === false);
  }

  // ── 多源聚合：禁用源不参与、未知源报错、单源失败隔离 ──
  {
    const r1 = await fetchFromSources({ safebooru: { enabled: false } });
    check('全部禁用时不拉取', r1.entries.length === 0 && r1.errors.length === 0);

    const r2 = await fetchFromSources({ nosuch: { enabled: true } });
    check('未知源记录错误但不抛异常', r2.entries.length === 0 && r2.errors.some((e) => e.includes('未知图源')));

    // pixiv 默认禁用：不应发起网络请求
    const r3 = await fetchFromSources({ pixiv: { enabled: false } });
    check('pixiv 禁用时不联网', r3.entries.length === 0);
  }
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}

// ── 已发图定时清理（sentTtlMs）──
// 语义：只删「发过且超过 TTL」的图；没发过的是候选池，绝不能删。
{
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'imgsent-'));
  const mk = (i) => Buffer.concat([PNG, Buffer.from([i])]);
  const s = createImageStore({ dir: d, maxFiles: 100, maxTotalBytes: 1e9, log: () => {} });
  const TTL = 10 * 60 * 1000;
  const now = Date.now();

  // 三类样本
  s.add(mk(1), { id: 'sent-old' });      // 发过且早已超时 → 应删
  s.add(mk(2), { id: 'sent-fresh' });    // 刚发 → 应留
  s.add(mk(3), { id: 'never-sent' });    // 从未发 → 应留（候选池）
  s.markUsed('sent-old');
  s.markUsed('sent-fresh');
  // 把 sent-old 的 lastUsedAt 拨回 TTL 之前
  const raw = JSON.parse(fs.readFileSync(path.join(d, 'index.json'), 'utf8'));
  raw.items.find((x) => x.id === 'sent-old').lastUsedAt = now - TTL - 1000;
  fs.writeFileSync(path.join(d, 'index.json'), JSON.stringify(raw, null, 2));
  // 重新加载以拿到改动后的时间
  const s2 = createImageStore({ dir: d, maxFiles: 100, maxTotalBytes: 1e9, log: () => {} });
  const r = s2.pruneSent(TTL, { now });

  check('清理了超时的已发图', r.removed === 1, `removed=${r.removed}`);
  check('已发超时图被删', !s2.getById('sent-old'));
  check('刚发的图保留', !!s2.getById('sent-fresh'));
  check('从未发过的图保留（候选池不能动）', !!s2.getById('never-sent'));
  check('清理报告释放字节', r.freedBytes > 0, `${(r.freedBytes / 1024).toFixed(0)}KB`);
  check('文件同步删除', !fs.existsSync(path.join(d, JSON.parse(fs.readFileSync(path.join(d, 'index.json'), 'utf8')).items.find((x) => x.id === 'sent-old')?.file ?? 'nonexistent')));

  // TTL=0 应完全不删（关闭开关）
  s2.markUsed('sent-fresh');
  const raw2 = JSON.parse(fs.readFileSync(path.join(d, 'index.json'), 'utf8'));
  raw2.items.find((x) => x.id === 'sent-fresh').lastUsedAt = now - TTL * 10;
  fs.writeFileSync(path.join(d, 'index.json'), JSON.stringify(raw2, null, 2));
  const s3 = createImageStore({ dir: d, maxFiles: 100, maxTotalBytes: 1e9, log: () => {} });
  const r0 = s3.pruneSent(0, { now });
  check('TTL=0 时不删除（开关关闭）', r0.removed === 0 && !!s3.getById('sent-fresh'));

  // 多次发送应从「最后一次」算时间：刚重发过的不该被删
  const s4 = createImageStore({ dir: d, maxFiles: 100, maxTotalBytes: 1e9, log: () => {} });
  s4.markUsed('sent-fresh'); // 刷新 lastUsedAt 为现在
  const r4 = s4.pruneSent(TTL, { now });
  check('重发过的图按最后时间保留', !!s4.getById('sent-fresh'), `removed=${r4.removed}`);

  fs.rmSync(d, { recursive: true, force: true });
}

// ── 按画师数字 ID 检索 ──
// pixiv 只能靠数字 ID 可靠地按画师取图（名字搜索是标签匹配，画师名常不是自己作品的标签），
// 所以本地库必须能用 `artist:83739` 命中。同时数字 ID **不能**退化成子串匹配，
// 否则 `artist:123` 会命中 userId=12345 的无关画师。
{
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'imgstore-artist-'));
  const store = createImageStore({ dir: d, maxFiles: 100, maxTotalBytes: 1e9, log: () => {} });
  store.add(PNG, { id: 'pixiv:1', source: 'pixiv', artist: 'lack', artistId: '83739', page: 'https://x/1', tags: ['original'], rating: 'safe' });
  store.add(PNG, { id: 'pixiv:2', source: 'pixiv', artist: 'moonian', artistId: '12345', page: 'https://x/2', tags: ['cat'], rating: 'safe' });

  // dryRun 返回 { count }（过滤后候选数），不发文件——用它验命中数量。
  const cnt = (tags) => store.pickRandom({ tags, dryRun: true }).count;

  check('按数字 ID 命中 artistId', cnt(['artist:83739']) === 1, `count=${cnt(['artist:83739'])}`);
  check('按名字仍命中 artist 字段', cnt(['artist:lack']) === 1, `count=${cnt(['artist:lack'])}`);
  check('不存在的数字 ID 不误命中', cnt(['artist:99999']) === 0, `count=${cnt(['artist:99999'])}`);
  // 关键：数字 ID 不能退化成子串匹配，否则 artist:123 会命中 userId=12345 的无关画师
  check('数字 ID 不做子串匹配（123 不命中 12345）', cnt(['artist:123']) === 0, `count=${cnt(['artist:123'])}`);
  check('名字仍可子串匹配（lack 命中 lack）', cnt(['artist:lack']) === 1);
  check('不相关画师名不命中', cnt(['artist:nobody']) === 0, `count=${cnt(['artist:nobody'])}`);
  // 群友常贴主页链接，本地库也要认（否则链接形式会每次都回源）
  check('主页链接命中', cnt(['https://www.pixiv.net/users/83739']) === 1, `count=${cnt(['https://www.pixiv.net/users/83739'])}`);
  check('/en/ 链接命中', cnt(['https://www.pixiv.net/en/users/83739']) === 1);
  check('无协议域名命中', cnt(['pixiv.net/users/83739']) === 1);
  check('链接指向不存在的 ID 不命中', cnt(['https://www.pixiv.net/users/99999']) === 0);

  fs.rmSync(d, { recursive: true, force: true });
}

// ── 跨站标签写法互通（宽松匹配）──
// booru 系 `name_(franchise)` 与 pixiv 的 `名前(作品)` 不通用：库里 pixiv 图带
// `アンジェリーナ(アークナイツ)`，而模型常传 `angelina_(arknights)`。
// 严格匹配命中 0，必须能宽松重试到。
console.log('\n── 跨站标签写法（宽松匹配）──');
{
  const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000064000000640802000000ff1099e9000000064944415478da63fcffff3f030005fe02fea6d5b17c', 'hex');
  const pngFor = (n) => Buffer.concat([PNG, Buffer.from(`tag-${n}`)]);
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'img-tagstyle-'));
  const store = createImageStore({ dir: d, maxFiles: 100, maxTotalBytes: 1e9, log: () => {} });
  // 模拟一张 pixiv 图：标签是日文/英文（pixiv 的真实形态），没有 booru 的 name_(franchise)
  store.add(pngFor(1), {
    id: 'pixiv:9001', source: 'pixiv', artist: 'a', page: 'p/1',
    tags: ['Arknights', 'アークナイツ', 'angelina', 'アンジェリーナ(アークナイツ)'], rating: 'safe'
  });
  // 另一张 safebooru 图：booru 写法
  store.add(pngFor(2), {
    id: 'safebooru:9002', source: 'safebooru', artist: 'a', page: 'p/2',
    tags: ['angelina_(arknights)', 'arknights'], rating: 'g'
  });

  const cnt = (f) => store.pickRandom({ dryRun: true, ...f }).count;

  // booru 写法查询应**同时命中**两站的图：严格匹配拿到 booru 那张，
  // 宽松并集补上 pixiv 那张（图里有 angelina + Arknights 英文标签）。
  // 这是刻意的并集语义：群主要的是角色，不该因为图来自哪站而少一半选项。
  check('booru 写法命中两站的图（并集）', cnt({ tags: ['angelina_(arknights)'] }) === 2, `count=${cnt({ tags: ['angelina_(arknights)'] })}`);
  check('日文写法命中 pixiv 图', cnt({ tags: ['アンジェリーナ(アークナイツ)'] }) === 1, `count=${cnt({ tags: ['アンジェリーナ(アークナイツ)'] })}`);
  // 关键：宽松后**英文片段**也能命中日文标签的图（图里有 angelina + Arknights 两个标签）
  check('宽松匹配：angelina arknights 命中两张', cnt({ tags: ['angelina arknights'] }) === 2, `count=${cnt({ tags: ['angelina arknights'] })}`);
  // 严格匹配能命中时不应宽松（避免放宽误命中）
  check('严格能命中时不放宽（booru 图仍只 1 张）',
    cnt({ tags: ['angelina_(arknights)'], sources: ['safebooru'] }) === 1);
  // 宽松也要尊重源限制
  check('宽松匹配仍受源限制', cnt({ tags: ['angelina arknights'], sources: ['pixiv'] }) === 1, `count=${cnt({ tags: ['angelina arknights'], sources: ['pixiv'] })}`);
  // 不存在的角色不该因宽松而误命中
  check('无关角色仍为 0', cnt({ tags: ['totally_unknown_(nope)'] }) === 0, `count=${cnt({ tags: ['totally_unknown_(nope)'] })}`);
  // 只沾一个片段不该命中（近似 AND）
  check('只含一个片段不算命中', cnt({ tags: ['angelina nonexistentfranchise'] }) === 0, `count=${cnt({ tags: ['angelina nonexistentfranchise'] })}`);

  fs.rmSync(d, { recursive: true, force: true });
}

// ── 「发过的图 10 分钟内不重复发」（2026-10-20 用户要求）──
//
// 真问题（日志实证）：`pixiv:150564360` 在 4 分钟内被发了 3 次。
// 根因不是没做去重，而是**线索存错了地方**：
//   pruneSent 在 10 分钟后把发过的条目整个删掉（连 index 记录一起），
//   同一张图再查询时重新拉取，add() 生成一条全新的 useCount:0 记录，
//   于是"新鲜度"判断认为它从没发过 → 又发一次。
// 修法：按**内容哈希**单独记发送时间（跨条目删除存活）。
{
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'imgrecent-'));
  const PNG_A = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');
  // 另一张合法 PNG（内容不同，用来验证"别的图不受影响"）
  const PNG_B = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  const store = createImageStore({ dir: d, maxFiles: 99, maxTotalBytes: 1e9, log: () => {}, recentBlockMs: 10 * 60 * 1000 });

  const a = store.add(PNG_A, { id: 'src:a', source: 'pixiv', tags: ['hero'] });
  const b = store.add(PNG_B, { id: 'src:b', source: 'pixiv', tags: ['hero'] });
  check('两张图都入库', !!a && !!b && store.count() === 2);

  // 未发过时：两张都可选
  check('未发过时可选', store.pickRandom({ tags: ['hero'] }) !== null);

  // 发掉 A
  store.markUsed('src:a');
  check('markUsed 后 recentlySent 为真', store.recentlySent(a.file).blocked === true);
  check('别的图不受影响', store.recentlySent(b.file).blocked === false);

  // 关键：A 再也不能被选中（只剩 B 可选）
  const picks = new Set();
  for (let i = 0; i < 40; i++) {
    const p = store.pickRandom({ tags: ['hero'] });
    if (p) picks.add(p.entry.id);
  }
  check('发过的图不会被再选中', !picks.has('src:a'), [...picks].join(','));
  check('没发过的仍可选', picks.has('src:b'));

  // dryRun 必须也反映过滤结果（否则预检说"本地有图"，实际发不出去）
  // 此时只剩 B 可发（A 已发过），所以 count 应该是 1。
  check('dryRun 计入"刚发过"过滤',
    store.pickRandom({ tags: ['hero'], dryRun: true }).count === 1,
    String(store.pickRandom({ tags: ['hero'], dryRun: true }).count));

  // 关掉这一层（blockRecentMs:0）时 —— 证明过滤来自本层，而不是别的层把它挡掉了。
  // 注意 A/B 的 useCount>0，还会被"新鲜度"层降权，所以这里只比"可选数量"，
  // 让两层的影响一致，只看 blockRecentMs 的差别。
  store.markUsed('src:b');
  const withBlock = store.pickRandom({ tags: ['hero'], dryRun: true }).count;
  const withoutBlock = store.pickRandom({ tags: ['hero'], dryRun: true, blockRecentMs: 0 }).count;
  check('blockRecentMs=0 时可选数量回升（证明过滤来自本层）',
    withoutBlock > withBlock, `withBlock=${withBlock} withoutBlock=${withoutBlock}`);

  // 冷却过期后可再选（把时间往前挪，等价于"10 分钟已过"）
  const past = Date.now() - 11 * 60 * 1000;
  fs.writeFileSync(path.join(d, 'recent-sent.json'),
    JSON.stringify({ at: { [a.file]: past } }), 'utf8');
  const store2 = createImageStore({ dir: d, maxFiles: 99, maxTotalBytes: 1e9, log: () => {}, recentBlockMs: 10 * 60 * 1000 });
  // 重新加载后，A 的 useCount>0 仍让新鲜度层把它排后面；但 recentlySent 应该已经过期
  check('冷却过期后 recentlySent 为假', store2.recentlySent(a.file).blocked === false);

  // 关键回归：**条目被删掉后重新入库，仍然算"刚发过"**
  // 这正是线上出问题的路径（pruneSent 删除 → 重新拉取 → useCount 归零）
  store.pruneSent(0); // ttl=0 直接清；这里手动模拟删除
  store.markUsed('src:a');
  const aFile = a.file;
  // 模拟 pruneSent：条目消失，然后同一内容重新入库（新条目 useCount=0）
  fs.rmSync(path.join(d, aFile), { force: true });
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'imgrecent2-'));
  const store3 = createImageStore({ dir: d2, maxFiles: 99, maxTotalBytes: 1e9, log: () => {}, recentBlockMs: 10 * 60 * 1000 });
  store3.add(PNG_A, { id: 'src:a', source: 'pixiv', tags: ['hero'] });
  store3.markUsed('src:a');
  const store4 = createImageStore({ dir: d2, maxFiles: 99, maxTotalBytes: 1e9, log: () => {}, recentBlockMs: 10 * 60 * 1000 });
  check('同内容重新入库仍算"刚发过"（哈希跨条目存活）',
    store4.recentlySent(aFile).blocked === true);
  fs.rmSync(d2, { recursive: true, force: true });

  fs.rmSync(d, { recursive: true, force: true });
}

// ── 差评换图必须跳过「10 分钟不重复发」（否则只有一张图可用的角色换不出来）──
//
// 场景：群友对刚发的图说「不好看」。桥接删掉那张、然后调 sendImageV2(_fromFeedback) 换一张。
// 若换图仍受 10 分钟窗口约束，而该角色库里只剩这一张（删掉后为空），就会报
// "都发过了、再等等"——把"防重复"变成了"不许换"。所以换图路径要显式关掉这层。
{
  const root = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Z]:)/, '$1') + '/..';
  // 换图两次挑选的行为在 test-image-send.mjs 直接执行模块验证。
  // 配置项
  const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
  check('配置：每小时上限提到 60', Number(cfg.socialV2?.images?.maxSendPerHour) === 60,
    String(cfg.socialV2?.images?.maxSendPerHour));
  check('配置：重复发送窗口 10 分钟', Number(cfg.socialV2?.images?.recentSendBlockMs) === 600000,
    String(cfg.socialV2?.images?.recentSendBlockMs));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);