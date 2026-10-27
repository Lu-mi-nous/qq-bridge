// R2 基线：统一 JSON 状态存储（src/state/store.js）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJsonStore } from '../src/state/store.js';
import { saveTokenFuseState, loadTokenFuseState, tokenFuseFile } from '../src/token-fuse.js';
import { createSessionGap } from '../src/session-gap.js';
import { saveSharedMemory, loadSharedMemory, sharedMemoryFile } from '../plugins/shared-memory/lib/shared-memory.js';
import { saveSlang, loadSlang } from '../plugins/slang/lib/slang-learner.js';
import { saveStickerStore, loadStickerStore } from '../plugins/stickers/lib/sticker-lib.js';
import { createImageStore } from '../plugins/images/lib/image-store.js';
import { createVideoMemory } from '../plugins/bili/lib/bili.js';

let pass = 0, fail = 0;
const check = (n, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-state-store-'));
try {
  console.log('── 1. 缺失 / 默认值 ──');
  {
    const file = path.join(tmp, 'missing.json');
    const s = createJsonStore({ file, version: 1, defaults: () => ({ sessions: {}, count: 0 }) });
    const v = s.read();
    check('缺失文件返回默认值', v.sessions && v.count === 0);
    check('缺失文件不创建磁盘文件', !fs.existsSync(file));
    s.write({ sessions: { a: 1 }, count: 2 });
    check('write 落盘', fs.existsSync(file));
    check('read 返回写入值', s.read().count === 2);
  }

  console.log('\n── 2. 读写与 update ──');
  {
    const file = path.join(tmp, 'update.json');
    const s = createJsonStore({ file, version: 1, defaults: () => ({ count: 0, list: [] }) });
    s.write({ count: 0, list: [] });
    for (let i = 0; i < 100; i++) s.update((d) => { d.count += 1; d.list.push(i); return d; });
    check('100 次 update 全部保留', s.read().count === 100 && s.read().list.length === 100);
    const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
    check('磁盘内容与内存一致', disk.count === 100 && disk.list.length === 100);
    check('写入带版本号', disk.__version === 1, String(disk.__version));
  }

  console.log('\n── 3. 损坏备份 ──');
  {
    const file = path.join(tmp, 'corrupt.json');
    fs.writeFileSync(file, '{ broken json');
    const s = createJsonStore({ file, version: 1, defaults: () => ({ ok: true }) });
    const v = s.read();
    check('损坏文件回落默认值', v.ok === true);
    const backups = fs.readdirSync(tmp).filter((f) => f.startsWith('corrupt.json.corrupt-'));
    check('损坏文件已备份', backups.length === 1, backups.join(','));
  }

  console.log('\n── 4. 版本迁移 ──');
  {
    const file = path.join(tmp, 'migrate.json');
    fs.writeFileSync(file, JSON.stringify({ __version: 0, count: 5 }));
    const s = createJsonStore({
      file, version: 2, defaults: () => ({ count: 0, migrated: false }),
      migrate: (data, from) => ({ ...data, migrated: from === 0, count: (data.count || 0) + 1 })
    });
    const v = s.read();
    check('旧版本触发 migrate', v.migrated === true && v.count === 6, JSON.stringify(v));
    check('迁移后版本号更新（下次写入）', (() => { s.write(v); return JSON.parse(fs.readFileSync(file, 'utf8')).__version === 2; })());
  }

  console.log('\n── 5. 原子写入残留 ──');
  {
    const before = fs.readdirSync(tmp).length;
    const file = path.join(tmp, 'atomic.json');
    const s = createJsonStore({ file, version: 1, defaults: () => ({ n: 0 }) });
    for (let i = 0; i < 20; i++) s.write({ n: i });
    const leftovers = fs.readdirSync(tmp).filter((f) => f.includes('.tmp'));
    check('无临时文件残留', leftovers.length === 0, leftovers.join(','));
    check('文件可解析且为最后值', JSON.parse(fs.readFileSync(file, 'utf8')).n === 19);
    check('目录条目数量只增加目标文件', fs.readdirSync(tmp).length === before + 1);
  }

  console.log('\n── 5b. BOM / 非对象 / 缓存 ──');
  {
    const bom = path.join(tmp, 'bom.json');
    fs.writeFileSync(bom, '\uFEFF{"__version":1,"ok":true}');
    check('带 BOM 的状态文件可读', createJsonStore({ file: bom, version: 1, defaults: () => ({ ok: false }) }).read().ok === true);

    const arr = path.join(tmp, 'array.json');
    fs.writeFileSync(arr, '[1,2,3]');
    const arrStore = createJsonStore({ file: arr, version: 1, defaults: () => ({ ok: true }) });
    check('顶层数组按损坏处理并回落默认值', arrStore.read().ok === true);
    check('顶层数组文件已备份', fs.readdirSync(tmp).some((f) => f.startsWith('array.json.corrupt-')));

    const ret = path.join(tmp, 'return.json');
    const retStore = createJsonStore({ file: ret, version: 1, defaults: () => ({ count: 0 }) });
    retStore.write({ count: 1 });
    retStore.update(() => ({ count: 9 }));
    check('update 支持显式返回新对象', retStore.read().count === 9);

    const cached = path.join(tmp, 'cache.json');
    const cachedStore = createJsonStore({ file: cached, version: 1, defaults: () => ({ count: 0 }) });
    cachedStore.write({ count: 1 });
    fs.writeFileSync(cached, JSON.stringify({ __version: 1, count: 7 }));
    cachedStore.clearCache();
    check('clearCache 后重新读取磁盘', cachedStore.read().count === 7);
  }

  console.log('\n── 5b-2. 数组状态 / mtime 热重载 ──');
  {
    const missing = path.join(tmp, 'missing-array.json');
    const empty = createJsonStore({ file: missing, version: 1, array: true, defaults: () => [] });
    check('数组状态缺失返回空数组', Array.isArray(empty.read()) && empty.read().length === 0);

    const arrFile = path.join(tmp, 'list.json');
    const arrStore = createJsonStore({ file: arrFile, version: 1, array: true, defaults: () => [] });
    arrStore.write([{ id: 'a' }, { id: 'b' }]);
    const arrDisk = JSON.parse(fs.readFileSync(arrFile, 'utf8'));
    check('数组状态落盘为 {__version, items}', arrDisk.__version === 1 && Array.isArray(arrDisk.items) && arrDisk.items.length === 2);
    arrStore.update((list) => { list.push({ id: 'c' }); return list; });
    check('数组 update 保留并追加', arrStore.read().length === 3 && arrStore.read()[2].id === 'c');

    const legacy = path.join(tmp, 'legacy-array.json');
    fs.writeFileSync(legacy, JSON.stringify([{ id: 'old' }]));
    const legacyStore = createJsonStore({ file: legacy, version: 1, array: true, defaults: () => [] });
    check('旧裸数组可直接读取', legacyStore.read().length === 1 && legacyStore.read()[0].id === 'old');

    const hot = path.join(tmp, 'hot.json');
    const hotStore = createJsonStore({ file: hot, version: 1, reloadOnMtime: true, defaults: () => ({ n: 0 }) });
    hotStore.write({ n: 1 });
    fs.writeFileSync(hot, JSON.stringify({ __version: 1, n: 42 }));
    check('reloadOnMtime 能感知外部写入', hotStore.read().n === 42);
  }

  console.log('\n── 5c. R2-2 域接线 ──');
  {
    const fuseFile = tokenFuseFile(path.join(tmp, 'fuse'));
    saveTokenFuseState(path.join(tmp, 'fuse'), {
      version: 1,
      day: '2026-10-26',
      keys: { 'group:100': { totalInput: 123, uncached: 45, calls: 2, state: 'warn' } }
    });
    const fuseDisk = JSON.parse(fs.readFileSync(fuseFile, 'utf8'));
    check('token-fuse 落盘带 __version', fuseDisk.__version === 1);
    const fuseLoaded = loadTokenFuseState(path.join(tmp, 'fuse'));
    check('token-fuse 往返保留会话桶', fuseLoaded.day === '2026-10-26' && fuseLoaded.keys['group:100'].totalInput === 123);

    const gapFile = path.join(tmp, 'gap', 'session-gap.json');
    const gap = createSessionGap({ file: gapFile, now: () => 1_700_000_000_000 });
    gap.markProcessed('group:200', 1_700_000_000_000);
    const gapDisk = JSON.parse(fs.readFileSync(gapFile, 'utf8'));
    check('session-gap 落盘带 __version', gapDisk.__version === 1);
    const gap2 = createSessionGap({ file: gapFile });
    check('session-gap 重启保留 lastProcessedAt', gap2.get('group:200')?.lastProcessedAt === 1_700_000_000_000);

    const shareDir = path.join(tmp, 'share');
    saveSharedMemory(shareDir, {
      version: 1,
      updatedAt: 123,
      people: { 10001: { id: '10001', names: { 'group:1': '甲' }, traits: {} } }
    });
    const shareDisk = JSON.parse(fs.readFileSync(sharedMemoryFile(shareDir), 'utf8'));
    check('shared-memory 落盘带 __version', shareDisk.__version === 1);
    const shareLoaded = loadSharedMemory(shareDir);
    check('shared-memory 往返保留人物', shareLoaded.updatedAt === 123 && !!shareLoaded.people['10001']);
  }

  console.log('\n── 5d. R2-3 数组 / 图库 / B站 / 角色 ──');
  {
    const slangFile = path.join(tmp, 'slang.json');
    saveSlang(slangFile, [{ content: 'yyds', meaning: '永远的神', status: 'confirmed' }]);
    const slangDisk = JSON.parse(fs.readFileSync(slangFile, 'utf8'));
    check('slang 落盘为数组包装', slangDisk.__version === 1 && Array.isArray(slangDisk.items));
    check('slang 往返保留词条', loadSlang(slangFile)[0]?.content === 'yyds');

    const stickerFile = path.join(tmp, 'stickers.json');
    saveStickerStore(stickerFile, [{ emoji_id: 'a', desc: '笑死' }]);
    const stickerDisk = JSON.parse(fs.readFileSync(stickerFile, 'utf8'));
    check('stickers 落盘为数组包装', stickerDisk.__version === 1 && Array.isArray(stickerDisk.items));
    check('stickers 往返归一化', loadStickerStore(stickerFile)[0]?.id === 'a');

    const libDir = path.join(tmp, 'image-lib');
    const imgStore = createImageStore({ dir: libDir, maxFiles: 10, maxTotalBytes: 1e9, log: () => {} });
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x74, 0x65, 0x73, 0x74]);
    imgStore.add(png, { id: 'src:a', source: 'pixiv', tags: ['hero'] });
    imgStore.markUsed('src:a');
    imgStore.reject('src:a', { reason: '不好看' });
    const imgIndex = JSON.parse(fs.readFileSync(path.join(libDir, 'index.json'), 'utf8'));
    const imgRecent = JSON.parse(fs.readFileSync(path.join(libDir, 'recent-sent.json'), 'utf8'));
    const imgRejected = JSON.parse(fs.readFileSync(path.join(libDir, 'rejected.json'), 'utf8'));
    check('image index 带 __version', imgIndex.__version === 1 && Array.isArray(imgIndex.items));
    check('image recent-sent 带 __version', imgRecent.__version === 1 && !!imgRecent.at);
    check('image rejected 带 __version', imgRejected.__version === 1 && imgRejected.ids.includes('src:a'));

    const biliFile = path.join(tmp, 'bili-memory.json');
    const mem = createVideoMemory(biliFile);
    mem.record({ bvid: 'BV1xx411c7mD', title: '测试视频' });
    const biliDisk = JSON.parse(fs.readFileSync(biliFile, 'utf8'));
    check('bili-memory 落盘带 __version', biliDisk.__version === 1 && !!biliDisk.videos['BV1xx411c7mD']);
    fs.writeFileSync(biliFile, JSON.stringify({ ...biliDisk, updatedAt: 777, videos: {} }));
    fs.utimesSync(biliFile, new Date(), new Date(Date.now() + 2000));
    check('bili-memory 同实例感知外部写入', mem.load().updatedAt === 777);
  }
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}

console.log('\n── 6. 桥接接线 ──');
{
  const bridge = fs.readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
  const social = fs.readFileSync(new URL('../src/pipeline/social-state.js', import.meta.url), 'utf8');
  check('sessions 使用统一 store', /sessionsStateStore = createJsonStore/.test(bridge)
    && /sessionsStateStore\.read\(\)/.test(bridge) && /sessionsStateStore\.write\(state\)/.test(bridge));
  check('social-v2 使用统一 store', /socialStateStore = createJsonStore/.test(bridge)
    && /stateStore: socialStateStore/.test(bridge) && /stateStore\.read\(\)/.test(social) && /stateStore\.write\(obj\)/.test(social));
  const storeSrc = fs.readFileSync(new URL('../src/state/store.js', import.meta.url), 'utf8');
  check('store 带版本与损坏备份', /__version/.test(storeSrc) && /corrupt-/.test(storeSrc));
  const fuseSrc = fs.readFileSync(new URL('../src/token-fuse.js', import.meta.url), 'utf8');
  check('token-fuse 经 store 且无直接写文件', /createJsonStore/.test(fuseSrc) && !/fs\.writeFileSync/.test(fuseSrc));
  const gapSrc = fs.readFileSync(new URL('../src/session-gap.js', import.meta.url), 'utf8');
  const shareSrc = fs.readFileSync(new URL('../plugins/shared-memory/lib/shared-memory.js', import.meta.url), 'utf8');
  check('session-gap / shared-memory 经 store 且无直接读写文件',
    /createJsonStore/.test(gapSrc) && !/fs\.readFileSync|fs\.writeFileSync/.test(gapSrc)
    && /createJsonStore/.test(shareSrc) && !/fs\.readFileSync|fs\.writeFileSync/.test(shareSrc));
  const slangSrc = fs.readFileSync(new URL('../plugins/slang/lib/slang-learner.js', import.meta.url), 'utf8');
  const stickerSrc = fs.readFileSync(new URL('../plugins/stickers/lib/sticker-lib.js', import.meta.url), 'utf8');
  check('slang / stickers 使用数组 store', /array: true/.test(slangSrc) && /array: true/.test(stickerSrc)
    && /slangSessionStore = createJsonStore/.test(bridge));
  const imageSrc = fs.readFileSync(new URL('../plugins/images/lib/image-store.js', import.meta.url), 'utf8');
  const imageFacadeSrc = fs.readFileSync(new URL('../src/image-facade.js', import.meta.url), 'utf8');
  check('image index/recent/rejected 使用 store',
    /indexStore = createJsonStore/.test(imageSrc) && /recentStore = createJsonStore/.test(imageSrc)
    && /rejectedStore = createJsonStore/.test(imageSrc));
  const biliSrc = fs.readFileSync(new URL('../plugins/bili/lib/bili.js', import.meta.url), 'utf8');
  check('bili-memory 使用 store 且保留 mtime 刷新', /createJsonStore/.test(biliSrc) && /reloadOnMtime: true/.test(biliSrc));
  check('roles 状态使用 store', /roleStateStore = createJsonStore/.test(bridge) && /conversationRoleStore = createJsonStore/.test(bridge));
  check('image-fetch-state 使用 store', /imageFetchStateStore = createJsonStore/.test(imageFacadeSrc) && /imageFetchStateStore\.write/.test(imageFacadeSrc));
}


console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
