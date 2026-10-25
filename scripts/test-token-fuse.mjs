// 回归测试：会话级 Token 熔断（src/token-fuse.js）。
//
// 锁住：阈值状态机、warn/fused 各只通知一次、未缓存第二阈值、日切重置、
// 重启持久化、管理员解除、关闭时完全不计数。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_TOKEN_FUSE,
  normalizeTokenFuseConfig,
  createTokenFuse,
  effectiveTokenFuseThresholds,
  loadTokenFuseState,
  tokenFuseFile
} from '../src/token-fuse.js';

let pass = 0, fail = 0;
const check = (n, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tokfuse-'));
const stateDir = path.join(tmp, 'state');
let dirSeq = 0;
const KEY = 'group:1001';
const SID = 'session-abc';
const DAY1 = Date.parse('2026-10-25T02:00:00Z'); // 上海 10:00
const DAY2 = Date.parse('2026-10-26T02:00:00Z');

function make({ now = () => DAY1, cfg = {}, resolve = () => KEY } = {}) {
  const calls = [];
  const fuse = createTokenFuse({
    stateDir: path.join(tmp, `case-${++dirSeq}`),
    getConfig: () => cfg,
    resolveKey: resolve,
    notifyOwner: (...args) => calls.push(args),
    appendActivity: (line) => calls.push(['activity', line]),
    log: () => {},
    now,
    saveIntervalMs: 0
  });
  return { fuse, calls };
}

console.log('── 1. 配置归一化 ──');
{
  const c = normalizeTokenFuseConfig({});
  check('默认关闭', c.enabled === false && DEFAULT_TOKEN_FUSE.enabled === false);
  check('默认阈值 1B / 2B / 300M', c.warnTokens === 1_000_000_000
    && c.fuseTokens === 2_000_000_000 && c.fuseUncachedTokens === 300_000_000, JSON.stringify(c));
  const c2 = normalizeTokenFuseConfig({ enabled: true, warnTokens: -1, fuseTokens: 'x' });
  check('负阈值夹到 0（0=不启用该阈值），非数字回落默认', c2.warnTokens === 0 && c2.fuseTokens === 2_000_000_000);
}

console.log('\n── 2. warn → fused 状态机与通知去重 ──');
{
  const { fuse, calls } = make({
    cfg: { enabled: true, warnTokens: 500, fuseTokens: 1000, fuseUncachedTokens: 0 }
  });
  check('未达阈值保持 normal', fuse.recordUsage(SID, { inputTokens: 100, cacheReadTokens: 200 })?.state === 'normal');
  check('达到 warn', fuse.recordUsage(SID, { inputTokens: 100, cacheReadTokens: 200 })?.state === 'warn');
  check('warn 只通知一次', calls.filter((c) => c[0] === KEY && /提醒/.test(c[1])).length === 1,
    JSON.stringify(calls));
  check('warn 后仍非熔断', fuse.isFused(KEY) === false);
  check('达到 fuse', fuse.recordUsage(SID, { inputTokens: 100, cacheReadTokens: 500 })?.state === 'fused');
  check('fused 只通知一次', calls.filter((c) => c[0] === KEY && /熔断/.test(c[1])).length === 1);
  check('熔断后 isFused=true', fuse.isFused(KEY) === true);
  fuse.recordUsage(SID, { inputTokens: 100, cacheReadTokens: 100 });
  check('熔断后继续累计但不再通知',
    fuse.status().keys[0].totalInput === 1400
    && calls.filter((c) => c[0] === KEY && /熔断/.test(c[1])).length === 1,
    JSON.stringify(fuse.status().keys[0]));
}

console.log('\n── 3. 未缓存第二阈值 / 关闭 / 日切 ──');
{
  const { fuse } = make({ cfg: { enabled: true, warnTokens: 0, fuseTokens: 0, fuseUncachedTokens: 100 } });
  fuse.recordUsage(SID, { inputTokens: 120, cacheReadTokens: 9999 });
  check('未缓存达到第二阈值即熔断', fuse.isFused(KEY) === true);

  const offDir = path.join(tmp, 'off');
  const off = createTokenFuse({
    stateDir: offDir,
    getConfig: () => ({ enabled: false, warnTokens: 1, fuseTokens: 2 }),
    resolveKey: () => KEY,
    now: () => DAY1
  });
  check('关闭时 recordUsage 不计数', off.recordUsage(SID, { inputTokens: 1000 }) === null);
  check('关闭时 isFused 恒 false', off.isFused(KEY) === false);
  check('关闭时不写状态文件', !fs.existsSync(tokenFuseFile(offDir)));

  let now = DAY1;
  const day = make({ now: () => now, cfg: { enabled: true, warnTokens: 100, fuseTokens: 200 } });
  day.fuse.recordUsage(SID, { inputTokens: 200 });
  check('第一天已熔断', day.fuse.isFused(KEY) === true);
  now = DAY2;
  check('跨天后自动解除', day.fuse.isFused(KEY) === false);
  check('跨天后计数归零', (day.fuse.status().keys.find((k) => k.key === KEY)?.totalInput || 0) === 0);
}

console.log('\n── 3b. 每会话单独阈值 ──');
{
  const dir = path.join(tmp, 'override');
  const cfg = {
    enabled: true, warnTokens: 1000, fuseTokens: 2000,
    overrides: { 'group:1': { warnTokens: 100, fuseTokens: 200 } }
  };
  const fuse = createTokenFuse({
    stateDir: dir,
    getConfig: () => cfg,
    resolveKey: (sid) => sid === 'a' ? 'group:1' : 'group:2',
    now: () => DAY1,
    saveIntervalMs: 0
  });
  fuse.recordUsage('a', { inputTokens: 150 });
  check('group:1 用自定义 warn 阈值', fuse.status().keys.find((k) => k.key === 'group:1')?.state === 'warn');
  fuse.recordUsage('b', { inputTokens: 500 });
  check('group:2 用全局阈值仍 normal', fuse.status().keys.find((k) => k.key === 'group:2')?.state === 'normal');
  fuse.recordUsage('a', { inputTokens: 100 });
  check('group:1 用自定义 fuse 阈值', fuse.isFused('group:1') === true);
  const eff = effectiveTokenFuseThresholds(cfg, 'group:1');
  check('生效阈值返回 override 标记', eff.warnTokens === 100 && eff.fuseTokens === 200 && eff.overridden === true,
    JSON.stringify(eff));
  check('配置归一化保留合法 override、丢弃非法 key',
    Object.keys(normalizeTokenFuseConfig({ overrides: { 'group:1': { warnTokens: 5 }, bad: { warnTokens: 6 } } }).overrides).join(',') === 'group:1');
}

console.log('\n── 4. 持久化 / 解除 / 状态 ──');
{
  const dir = path.join(tmp, 'persist');
  let now = DAY1;
  const first = createTokenFuse({
    stateDir: dir,
    getConfig: () => ({ enabled: true, warnTokens: 100, fuseTokens: 200 }),
    resolveKey: () => KEY,
    now: () => now,
    saveIntervalMs: 0
  });
  first.recordUsage(SID, { inputTokens: 300 });
  check('状态已落盘', fs.existsSync(tokenFuseFile(dir)));
  const loaded = loadTokenFuseState(dir);
  check('重启后熔断状态保留', loaded.keys[KEY]?.state === 'fused'
    && loaded.keys[KEY]?.totalInput === 300, JSON.stringify(loaded));

  const second = createTokenFuse({
    stateDir: dir,
    getConfig: () => ({ enabled: true, warnTokens: 100, fuseTokens: 200 }),
    resolveKey: () => KEY,
    now: () => now,
    saveIntervalMs: 0
  });
  check('新实例读到熔断', second.isFused(KEY) === true);
  check('解除成功', second.resetKey(KEY) === true && second.isFused(KEY) === false);
  check('解除后计数归零', second.status().keys[0].totalInput === 0);
  check('解除不存在的 key 返回 false', second.resetKey('group:9999') === false);
  check('status 含当天与阈值', second.status().day === '2026-10-25'
    && second.status().config.fuseTokens === 200);
}

console.log('\n── 5. key 解析与排序 ──');
{
  const { fuse } = make({
    cfg: { enabled: true, warnTokens: 1e9, fuseTokens: 2e9 },
    resolve: (sid) => sid === 'session-a' ? 'group:1' : ''
  });
  fuse.recordUsage('session-a', { inputTokens: 10, cacheReadTokens: 20 });
  fuse.recordUsage('session-unknown', { inputTokens: 10 });
  const st = fuse.status();
  check('无映射的 session 不计数', st.keys.length === 1 && st.keys[0].key === 'group:1');
  check('status 按总量降序', st.keys[0].totalInput === 30);
}

console.log('\n── 6. 接线闸门 ──');
{
  const bridge = fs.readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
  const events = fs.readFileSync(new URL('../src/pipeline/dsh-events.js', import.meta.url), 'utf8');
  const bili = fs.readFileSync(new URL('../src/pipeline/bili-runtime.js', import.meta.url), 'utf8');
  check('assistant/message 的 usage 进入计数器',
    /'assistant\/message', handleAssistantMessage/.test(events) && /recordTokenUsage/.test(events));
  check('计划唤醒有熔断闸门', /function scheduleWakeV2[\s\S]{0,800}tokenFuse\.isFused\(key\)/.test(bridge));
  check('发送唤醒有熔断闸门且手动放行', /!opts\.manual && tokenFuse\.isFused\(key\)/.test(bridge));
  check('B 站自主刷有熔断闸门', /isTokenFused/.test(bili) && /token-fused/.test(bili));
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
