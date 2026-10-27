// 回归测试：磁盘缓存盘点与清理（控制台 17c）。
//
// 需求（2026-10-22 用户）：「全部做完后注意清理 C 盘缓存，并且控制台中给出对应功能卡片」。
//
// 本测试锁住**安全边界**，这比"能不能删"重要得多：
//   ① 只删 `kind: 'safe'` 的项；`keep`（语音模型/图库/观看记忆）**无论怎么传都不动**
//   ② 清理后回报的是**实际释放量**，删失败的不虚报
//   ③ dryRun 只算不删
//   ④ 控制台能看到"空间花在哪"（含保留项），而不是只给一个删除按钮
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readConsoleSource } from './lib/console-src.mjs';
import { readConsoleUiSource } from './lib/console-ui-src.mjs';

let pass = 0, fail = 0;
const check = (n, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };

const root = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Z]:)/, '$1') + '/..';
const src = fs.readFileSync(path.join(root, 'src', 'cache-manager.js'), 'utf8');
const bridgeSrc = readConsoleSource();
const html = readConsoleUiSource({ unescape: true });

const { collectCacheItems, summarizeCache, purgeCache, humanBytes, sizeOf, CACHE_GROUPS } =
  await import('../src/cache-manager.js');

// ── 1. 体积与人话格式 ──
console.log('── 1. 基础 ──');
{
  check('humanBytes 三级单位',
    humanBytes(500) === '500B' && humanBytes(2048) === '2KB'
    && humanBytes(5 * 1024 ** 2) === '5.0MB' && humanBytes(3 * 1024 ** 3) === '3.00GB',
    [humanBytes(500), humanBytes(2048), humanBytes(5 * 1024 ** 2), humanBytes(3 * 1024 ** 3)].join(' / '));
  check('sizeOf 对不存在路径返回 0 不抛',
    (() => { try { const r = sizeOf(path.join(root, 'state', '__nope__')); return r.bytes === 0 && r.files === 0; } catch { return false; } })());
}

// ── 2. 分类正确性 ──
console.log('\n── 2. safe / keep 分类 ──');
{
  const items = collectCacheItems({ root });
  const safe = items.filter((x) => x.kind === 'safe').map((x) => x.key);
  const keep = items.filter((x) => x.kind === 'keep').map((x) => x.key);

  check('有可清项', safe.length >= 8, safe.join(','));
  check('有保留项', keep.length >= 4, keep.join(','));
  check('语音缓存可清', safe.includes('ttsCache'));
  check('报表图可清', safe.includes('reportCache'));
  check('截图临时目录可清', safe.includes('chromeTemp'));
  check('部署残留可清', safe.includes('deployTemp'));
  check('HF 缓存可清', safe.includes('hfCache'));
  // 2026-10-22 二次重写：这些原来都漏了
  check('X 媒体缓存可清', safe.includes('xMediaCache'));
  check('X 发图中转可清', safe.includes('xHandoff'));
  check('表情解析缓存可清', safe.includes('stickerCache'));
  check('反向搜图缓存可清', safe.includes('reverseSearchCache'));
  check('菜单旧备份可清', safe.includes('menuBackup'));
  check('媒体处理临时文件可清', safe.includes('processTemp'));
  check('测试运行残留可清', safe.includes('testRuns'));
  check('调试截图可清', safe.includes('devShots'));
  // 这些删了要重新下载/丢数据，必须保留
  check('图库是保留项', keep.includes('imageLib'), keep.join(','));
  check('观看记忆是保留项', keep.includes('biliMemory'), keep.join(','));
  check('黑话库是保留项', keep.includes('slangLib'), keep.join(','));
  check('情节记忆是保留项', keep.includes('contextState'), keep.join(','));
  check('DSH 会话是保留项', keep.includes('dshSessions'), keep.join(','));
  check('收藏原图是保留项', keep.includes('collected'), keep.join(','));
  check('kind 只有两种取值', items.every((x) => x.kind === 'safe' || x.kind === 'keep'));
  check('每项都有说明', items.every((x) => x.note && x.note.length > 4));
  check('每项都有 label', items.every((x) => !!x.label));
  // 分组：每项必须落在导出的 CACHE_GROUPS 里
  check('每项都有 group', items.every((x) => !!x.group));
  const groupIds = CACHE_GROUPS.map((g) => g.id);
  check('group 都在 CACHE_GROUPS 中',
    items.every((x) => groupIds.includes(x.group)), items.filter((x) => !groupIds.includes(x.group)).map((x) => x.key).join(','));
  check('safe 项不落在 keep 分组', items.filter((x) => x.kind === 'safe').every((x) => x.group !== 'keep'));
}

// ── 3. 清理只动 safe（核心安全断言）──
console.log('\n── 3. 清理边界 ──');
{
  // 造一个假项目目录，放 safe 与 keep 各一个，验证 keep 不会被删
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cachetest-'));
  try {
    const stateDir = path.join(tmp, 'state');
    fs.mkdirSync(path.join(stateDir, 'tts-cache'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'image-lib'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'tts-cache', 'a.wav'), Buffer.alloc(2048, 1));
    fs.writeFileSync(path.join(stateDir, 'image-lib', 'keep.png'), Buffer.alloc(4096, 2));

    const items = collectCacheItems({
      root: tmp,
      // 隔离：不要扫描真实 HOME 下的 DSH 会话/收藏目录（会影响耗时与计数）
      dshSessionsDir: path.join(tmp, '__no_dsh__'),
      collectedDir: path.join(tmp, '__no_collected__')
    });
    const tts = items.find((x) => x.key === 'ttsCache');
    const lib = items.find((x) => x.key === 'imageLib');
    check('假项目里识别到语音缓存', tts && tts.bytes >= 2048, `${tts?.bytes}`);
    check('假项目里识别到图库（保留）', lib && lib.bytes >= 4096, `${lib?.bytes}`);

    // 关键：即使**显式**点名要删 keep 项，也必须拒绝
    const r = purgeCache(items, { keys: ['ttsCache', 'imageLib'] });
    check('safe 项被删除', !fs.existsSync(path.join(stateDir, 'tts-cache', 'a.wav')));
    check('keep 项**没有**被删（即使显式点名）', fs.existsSync(path.join(stateDir, 'image-lib', 'keep.png')));
    check('释放量只含 safe 项（≈2KB）', r.freedBytes >= 2048 && r.freedBytes < 4096, `${r.freedBytes}`);
    check('details 里不含 keep 项', !r.details.some((d) => d.key === 'imageLib'), JSON.stringify(r.details.map((d) => d.key)));
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

// ── 4. dryRun ──
console.log('\n── 4. dryRun ──');
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cachedry-'));
  try {
    const stateDir = path.join(tmp, 'state');
    fs.mkdirSync(path.join(stateDir, 'tts-cache'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'tts-cache', 'b.wav'), Buffer.alloc(1024, 1));
    const items = collectCacheItems({
      root: tmp,
      // 隔离：不要扫描真实 HOME 下的 DSH 会话/收藏目录（会影响耗时与计数）
      dshSessionsDir: path.join(tmp, '__no_dsh__'),
      collectedDir: path.join(tmp, '__no_collected__')
    });
    const r = purgeCache(items, { dryRun: true });
    check('dryRun 报告释放量', r.freedBytes >= 1024, `${r.freedBytes}`);
    check('dryRun 不真删', fs.existsSync(path.join(stateDir, 'tts-cache', 'b.wav')));
    check('dryRun 标记为 dryRun', r.dryRun === true && r.details.every((d) => d.dryRun === true));
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

// ── 5. 汇总 ──
console.log('\n── 5. 汇总 ──');
{
  const items = [
    { key: 'a', kind: 'safe', bytes: 100, files: 1 },
    { key: 'b', kind: 'safe', bytes: 200, files: 2 },
    { key: 'c', kind: 'keep', bytes: 900, files: 9 }
  ];
  const s = summarizeCache(items);
  check('safeBytes 只算 safe', s.safeBytes === 300, `${s.safeBytes}`);
  check('totalBytes 含 keep', s.totalBytes === 1200, `${s.totalBytes}`);
  check('safeFiles 累加', s.safeFiles === 3, `${s.safeFiles}`);
  check('safeCount 统计项数', s.safeCount === 2, `${s.safeCount}`);
}

// ── 6. 接线 ──
console.log('\n── 6. 接线（API + 控制台）──');
{
  check('有 GET /cache 盘点端点', /pathname === '\/api\/socialV2\/cache'/.test(bridgeSrc));
  check('有 POST /cache-purge 清理端点', /pathname === '\/api\/socialV2\/cache-purge'/.test(bridgeSrc));
  check('清理写日志（可追溯）', /\[缓存\] 清理完成：释放/.test(bridgeSrc));
  check('端点传 ttsDir 用于展示模型占用', /ttsDir: cfg\.socialV2\?\.tts\?\.enabled === true/.test(bridgeSrc));
  check('端点把分组下发给界面', /groups: CACHE_GROUPS/.test(bridgeSrc));

  check('控制台有磁盘缓存卡片（15 号）', /19 磁盘缓存卡片/.test(html) && /const refreshBtn = document\.createElement\('button'\)/.test(html));
  // 目录已删除（2026-10-22 用户要求）；改为断言摘要卡会展示缓存占用
  check('摘要卡有缓存状态', /__CONSOLE_CARD_STATE__\['15'\]/.test(html));
  check('有盘点按钮', /重新盘点/.test(html));
  check('有清理按钮', /清理可删项/.test(html));
  // 确认框必须按**当前清单**生成（写死的文案会与后端漂移，这正是二次重写的原因）
  check('确认框动态列出将删项', /会删：\\n\$\{willDelete\}/.test(html));
  check('确认框动态列出保留项', /不会动：\$\{wontTouch\}/.test(html));
  check('界面按分组渲染', /cache-group-title/.test(html) && /for \(const g of groups\)/.test(html));
  check('显示可清/保留两类标记', /可安全清理/.test(html) && /保留<\/span>/.test(html));
  check('体积用字节单位而非 token 单位', /function cacheBytes/.test(html) && /'MB'|'GB'/.test(html));
  check('说明只删可再生成的', /只删能重新生成的/.test(html));
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
