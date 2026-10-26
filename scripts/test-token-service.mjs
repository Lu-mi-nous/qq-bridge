// R3-8 Token 服务：摘要器记账、聚合刷新与任务注册。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTokenService } from '../src/token-service.js';

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-token-service-'));
const file = path.join(tmp, 'token-usage.json');
const sessionsRoot = path.join(tmp, 'sessions');
fs.mkdirSync(path.join(sessionsRoot, '--E-qq-bridge-state-agents--'), { recursive: true });
const readJsonSafe = (f, fallback) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; } };
const atomicWriteJson = (f, obj) => fs.writeFileSync(f, JSON.stringify(obj, null, 2));

function makeService(overrides = {}) {
  const tasks = [];
  const contextMetrics = new Map();
  const taskService = {
    define: (name, opts) => tasks.push({ name, opts }),
    start: () => {}
  };
  const service = createTokenService({
    file,
    sessionHistory: { mapping: () => ({ s1: 'group:1' }) },
    state: { sessions: { 'group:1': 's1' } },
    contextMetrics,
    appendActivity: () => {},
    taskService,
    readJsonSafe,
    atomicWriteJson,
    aggregateFn: () => ({
      days: { '2026-10-26': { input: 100, output: 10, cacheRead: 900, calls: 2 } },
      models: { m: { input: 100, output: 10, cacheRead: 900, calls: 2 } },
      dayModels: {},
      sessions: {},
      turns: 2,
      calls: 2,
      files: 1,
      cache: {},
      scanned: 1,
      reused: 0
    }),
    sessionsRoot,
    now: () => Date.parse('2026-10-26T02:00:00Z'),
    log: () => {},
    ...overrides
  });
  return { service, tasks, contextMetrics };
}

try {
  console.log('── 1. 摘要器记账 ──');
  {
    const { service, contextMetrics } = makeService();
    service.recordSummarizerUsage('group:1', { input: 20, output: 5, cacheRead: 30 });
    const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
    check('写入 summarizer 桶', disk.summarizer['group:1'].input === 20 && disk.summarizer['group:1'].calls === 1);
    check('写入按日明细', disk.summarizer['group:1'].days['2026-10-26'].input === 20);
    check('更新 contextMetrics', contextMetrics.get('group:1')?.lastSummaryTokens === 25);
  }

  console.log('\n── 2. 聚合刷新 ──');
  {
    const { service } = makeService();
    const out = await service.refresh({ force: true });
    check('刷新写入今日数据', out.days['2026-10-26'].input === 100);
    check('刷新保留 summarizer', !!out.summarizer);
    check('刷新写入文件', JSON.parse(fs.readFileSync(file, 'utf8')).days['2026-10-26'].output === 10);
    check('get 返回缓存', service.get()?.updatedAt === Date.parse('2026-10-26T02:00:00Z'));
  }

  console.log('\n── 3. 定时任务注册 ──');
  {
    const { service, tasks } = makeService();
    service.startScheduler();
    check('注册首次任务', tasks.some((t) => t.name === 'tokenUsageFirst' && t.opts.kind === 'timeout'));
    check('注册每小时任务', tasks.some((t) => t.name === 'tokenUsage' && t.opts.everyMs === 3600000));
  }
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
