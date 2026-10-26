// R3-5 图库门面：补货、冷却、去重、画风分与清理定时器。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createImageFacade } from '../src/image-facade.js';

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-image-facade-'));
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x74, 0x65, 0x73, 0x74]);
const styleFile = path.join(tmp, 'style-center.json');
fs.writeFileSync(styleFile, JSON.stringify({ vectors: 2, center: [1, 0], stats: { median: 0.9 } }));

function makeFacade(overrides = {}) {
  const intervals = [];
  const cfg = {
    socialV2: {
      images: {
        enabled: true,
        libDir: path.join(tmp, 'lib'),
        maxFiles: 20,
        maxTotalBytes: 1e9,
        cooldownMs: 60000,
        sentTtlMs: 60000,
        sentSweepMs: 30000,
        ...(overrides.images || {})
      }
    }
  };
  const facade = createImageFacade({
    cfg,
    imageLibDir: cfg.socialV2.images.libDir,
    imageFetchStateFile: path.join(tmp, 'fetch-state.json'),
    styleCenterFile: styleFile,
    log: () => {},
    now: () => 1_700_000_000_000,
    fetchSources: async () => ({
      entries: [
        { id: 'a', source: 'test', url: 'https://x/a.png', tags: ['hero'] },
        { id: 'b', source: 'test', url: 'https://x/b.png', tags: ['hero'] }
      ],
      errors: [],
      corrections: [{ from: 'x', to: 'y', postCount: 2 }]
    }),
    fetchBuffer: async () => ({ buffer: png }),
    extractStyle: async () => [[1, 0]],
    cosineFn: () => 0.88,
    setIntervalFn: (fn, ms) => { const t = { fn, ms, unref() {} }; intervals.push(t); return t; },
    clearIntervalFn: () => {},
    ...overrides
  });
  return { facade, cfg, intervals };
}

try {
  console.log('── 1. 开关 / 冷却 ──');
  {
    const off = makeFacade({ images: { enabled: false } });
    const r = await off.facade.refreshImageLib({ force: true });
    check('关闭时拒绝补货', r.ok === false && /未启用/.test(r.error));

    const on = makeFacade();
    on.facade.imageFetchedAt = 1_700_000_000_000 - 1000;
    const cooled = await on.facade.refreshImageLib();
    check('冷却期内返回 cooled', cooled.ok === true && cooled.cooled === true && cooled.added === 0);
  }

  console.log('\n── 2. 补货 / 去重 / 画风分 ──');
  {
    const { facade } = makeFacade();
    const r1 = await facade.refreshImageLib({ force: true });
    check('补货新增两张', r1.ok === true && r1.added === 2 && facade.imageStore.count() === 2);
    check('记录纠错信息', facade.lastFetchCorrections.length === 1 && facade.lastFetchCorrections[0].to === 'y');
    check('记录上次拉取时间', facade.imageFetchedAt === 1_700_000_000_000);
    check('写入 image-fetch-state', JSON.parse(fs.readFileSync(path.join(tmp, 'fetch-state.json'), 'utf8')).lastFetchedAt === 1_700_000_000_000);
    const r2 = await facade.refreshImageLib({ force: true });
    check('重复条目被跳过', r2.added === 0 && r2.skipped === 2);
    check('画风分已写入', Number(facade.imageStore.getById('a')?.taste) === 0.88);
  }

  console.log('\n── 3. 已发图清理 ──');
  {
    const { facade, intervals } = makeFacade();
    facade.startSentSweep();
    check('启用已发图清理定时器', intervals.length === 1 && intervals[0].ms === 30000);
    const off = makeFacade({ images: { sentTtlMs: 0 } });
    off.facade.startSentSweep();
    check('TTL=0 不设定时器', off.intervals.length === 0);
  }
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
