import { createEventHarness, sessionEvent, assistantMessage, turnEnd } from './helpers/dsh-event-harness.mjs';
// 回归测试：DSH 上下文超限的识别、会话轮换与单次重试。
//
// 背景（2026-10-24 线上）：长寿命群会话的 DSH 历史涨到模型上限以上，
// 实测 session-237cd418... 在 turn 2575 报
//   prompt_too_long: 100001 tokens > 100000 maximum
// 后续到 1.4M tokens；连 compaction/end 也报同一个错，DSH 自己压不动。
// 桥接必须在 turn/error 时换掉中毒会话，否则该群之后每一轮都会失败。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContextRecovery, isContextOverflowError, rotateContextSession, shouldRotateProactive } from '../src/context-recovery.js';

let pass = 0, fail = 0;
const check = (n, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

console.log('── 1. 错误识别 ──');
{
  const positive = [
    '400: {"code":"CONTEXT_WINDOW_EXCEEDED"}',
    '{"code":"prompt_too_long","message":"prompt is too long: 100001 tokens > 100000 maximum"}',
    '{"extError":{"code":"context_length_exceeded"}}',
    "request context exceeds the model's limit; reduce history/message size",
    'prompt is too long: 1412836 tokens > 1048576 maximum'
  ];
  const negative = [
    'rate_limit_exceeded',
    'model_unavailable',
    'ECONNRESET',
    'request timeout',
    '{"type":"request/context","data":{"contextWindow":1000000}}',
    'prompt completed',
    ''
  ];
  for (const s of positive) check(`识别上下文超限：${s.slice(0, 50)}`, isContextOverflowError(s) === true);
  for (const s of negative) check(`不误判：${JSON.stringify(s.slice(0, 50))}`, isContextOverflowError(s) === false);
  check('null 不崩', isContextOverflowError(null) === false);
}

console.log('\n── 2. 恢复编排（轮换 + 单次重试 + 冷却）──');
{
  let now = 1000;
  const calls = [];
  const deps = {
    rotateSession: (key, sid) => calls.push(['rotate', key, sid]),
    buildWakePrompt: (key) => `PROMPT:${key}`,
    deliverPrompt: async (key, prompt) => { calls.push(['deliver', key, prompt]); return { ok: true }; },
    notifyOwnerOfError: (...args) => calls.push(['notify', ...args]),
    appendActivity: (line) => calls.push(['activity', line]),
    log: (...args) => calls.push(['log', ...args]),
    cooldownMs: 1000,
    retryDelayMs: 0,
    now: () => now
  };
  const rec = createContextRecovery(deps);
  const count = (type) => calls.filter((c) => c[0] === type).length;

  const r1 = await rec.recover({ key: 'group:1', sessionId: 'old-1', error: 'prompt_too_long', mode: 'reserved2' });
  await new Promise((r) => setTimeout(r, 20));
  check('第一次恢复被处理', r1.handled === true && r1.retried === true);
  check('第一次恢复摘除旧会话', count('rotate') === 1 && calls.find((c) => c[0] === 'rotate')[2] === 'old-1');
  check('第一次恢复写活动流', calls.some((c) => c[0] === 'activity' && /上下文超限/.test(c[1])));
  check('第一次恢复通知管理员', calls.some((c) => c[0] === 'notify' && /上下文超限/.test(c.slice(1).join(' '))));
  check('第一次恢复用新提示重试', count('deliver') === 1 && calls.find((c) => c[0] === 'deliver')[2] === 'PROMPT:group:1');

  const before = calls.length;
  const r2 = await rec.recover({ key: 'group:1', sessionId: 'old-2', error: 'prompt_too_long', mode: 'reserved2' });
  await new Promise((r) => setTimeout(r, 20));
  check('冷却期内不重复轮换', r2.retried === false && r2.reason === 'cooldown');
  check('冷却期内不重复投递', count('deliver') === 1);
  check('冷却期内仍通知管理员', calls.slice(before).some((c) => c[0] === 'notify' && /冷却/.test(c.slice(1).join(' '))));

  now += 1001;
  const r3 = await rec.recover({ key: 'group:1', sessionId: 'old-3', error: 'prompt_too_long', mode: 'reserved2' });
  await new Promise((r) => setTimeout(r, 20));
  check('冷却结束后可再次恢复', r3.retried === true && count('rotate') === 2 && count('deliver') === 2);
}

console.log('\n── 2b. 主动轮换（T4）──');
{
  let now = 1000000;
  const calls = [];
  const rec = createContextRecovery({
    rotateSession: (key, sid) => calls.push(['rotate', key, sid]),
    buildWakePrompt: () => 'P',
    deliverPrompt: async () => { calls.push(['deliver']); return { ok: true }; },
    notifyOwnerOfError: (...a) => calls.push(['notify', ...a]),
    appendActivity: (line) => calls.push(['activity', line]),
    log: () => {},
    cooldownMs: 60000,
    retryDelayMs: 1,
    now: () => now
  });
  const r1 = await rec.rotateProactive({ key: 'group:9', sessionId: 'sid-9', estimatedTokens: 700000 });
  check('主动轮换摘除会话且不重投/不通知', r1.rotated === true
    && calls.some((c) => c[0] === 'rotate' && c[2] === 'sid-9')
    && !calls.some((c) => c[0] === 'deliver' || c[0] === 'notify'));
  check('主动轮换写活动流（预估 k tokens）', calls.some((c) => c[0] === 'activity' && /700k/.test(c[1])));
  const r2 = await rec.rotateProactive({ key: 'group:9', sessionId: 'sid-10', estimatedTokens: 800000 });
  check('主动轮换受冷却限制', r2.rotated === false && r2.reason === 'cooldown');
  now += 60001;
  const r3 = await rec.rotateProactive({ key: 'group:9', sessionId: 'sid-11', estimatedTokens: 900000 });
  check('冷却后可再轮换', r3.rotated === true);
}

console.log('\n── 2c. 主动轮换阈值（T4）──');
{
  check('70% 默认阈值（1M 上限 ≈ 734003）：734002 不轮换、734004 轮换',
    shouldRotateProactive(734002) === false && shouldRotateProactive(734004) === true);
  check('自定义比例与上限', shouldRotateProactive(500000, { rotateAtRatio: 0.5, modelLimitTokens: 1000000 }) === true
    && shouldRotateProactive(499999, { rotateAtRatio: 0.5, modelLimitTokens: 1000000 }) === false);
  check('0/负数按默认处理且不轮换 0', shouldRotateProactive(0) === false
    && shouldRotateProactive(734004, { rotateAtRatio: 0, modelLimitTokens: 0 }) === true);
}

console.log('\n── 3. 不重试的分支 ──');
{
  const make = (overrides = {}) => {
    const calls = [];
    const deps = {
      rotateSession: (key, sid) => calls.push(['rotate', key, sid]),
      buildWakePrompt: () => 'PROMPT',
      deliverPrompt: async () => { calls.push(['deliver']); return { ok: true }; },
      notifyOwnerOfError: (...args) => calls.push(['notify', ...args]),
      appendActivity: () => {},
      log: () => {},
      cooldownMs: 0,
      retryDelayMs: 0,
      ...overrides
    };
    return { rec: createContextRecovery(deps), calls };
  };

  const silent = make();
  const rs = await silent.rec.recover({ key: 'group:2', sessionId: 's', error: 'prompt_too_long', mode: 'reserved2', silent: true });
  await new Promise((r) => setTimeout(r, 10));
  check('静默回合只轮换不重试', rs.retried === false && rs.reason === 'silent'
    && silent.calls.some((c) => c[0] === 'rotate') && !silent.calls.some((c) => c[0] === 'deliver'));

  const chat = make();
  const rc = await chat.rec.recover({ key: 'group:3', sessionId: 's', error: 'prompt_too_long', mode: 'chat' });
  await new Promise((r) => setTimeout(r, 10));
  check('非 reserved2 只轮换不重试', rc.retried === false && rc.reason === 'mode'
    && chat.calls.some((c) => c[0] === 'rotate') && !chat.calls.some((c) => c[0] === 'deliver'));

  const buildFail = make({ buildWakePrompt: () => { throw new Error('boom'); } });
  const rb = await buildFail.rec.recover({ key: 'group:4', sessionId: 's', error: 'prompt_too_long', mode: 'reserved2' });
  check('重建提示失败时明确报错', rb.retried === false && rb.reason === 'build-failed'
    && buildFail.calls.some((c) => c[0] === 'notify' && /重建唤醒提示失败/.test(c.slice(1).join(' '))));

  const deliverFail = make({ deliverPrompt: async () => ({ ok: false, error: 'still too long' }) });
  await deliverFail.rec.recover({ key: 'group:5', sessionId: 's', error: 'prompt_too_long', mode: 'reserved2' });
  await new Promise((r) => setTimeout(r, 20));
  check('重试仍失败时通知管理员', deliverFail.calls.some((c) => c[0] === 'notify' && /重试仍失败/.test(c.slice(1).join(' '))));

  const deliverThrow = make({ deliverPrompt: async () => { throw new Error('network'); } });
  await deliverThrow.rec.recover({ key: 'group:6', sessionId: 's', error: 'prompt_too_long', mode: 'reserved2' });
  await new Promise((r) => setTimeout(r, 20));
  check('重试抛异常时通知管理员', deliverThrow.calls.some((c) => c[0] === 'notify' && /重试异常/.test(c.slice(1).join(' '))));
}

console.log('\n── 4. 会话轮换行为（import 真实模块）──');
{
  const state = { sessions: { 'group:1': 'old-1' } };
  const reverse = new Map([['old-1', 'group:1']]);
  const collectors = new Map([['old-1', {}]]);
  const v2TurnStartAt = new Map([['old-1', 1]]);
  const sendToolSucceededSessions = new Set(['old-1']);
  const pendingSendToolCalls = new Map([['old-1', new Set(['c1'])]]);
  const toolCallNames = new Map([['old-1', new Map()]]);
  const social = {
    silentTurns: new Map([['old-1', [{ id: 'x' }]]]),
    exitingSessions: new Set(['old-1']),
    conversations: new Map([['group:1', { keep: 'memory' }]])
  };
  const biliJudgeCollectors = new Map([['old-1', {}]]);
  const currentTurnBySession = new Map([['old-1', { turn: 1 }]]);
  const autoAtTurnDone = new Map([['old-1', 1]]);
  let judgeResolved = 0;
  const biliJudgeWaiters = new Map([['old-1', { resolve: () => { judgeResolved++; } }]]);
  const sessionPromises = new Map([['group:1', Promise.resolve('old-1')]]);
  let cancelled = 0;
  const pending = new Map([['group:1', { sessionId: 'old-1', timer: null }]]);
  let saved = 0;
  let epoch = 0;
  const historyRecords = [];
  const getEpoch = () => epoch;
  const rotateSessionForContextOverflow = (key, sid) => rotateContextSession({
    state, reverse, collectors, v2TurnStartAt, sendToolSucceededSessions,
    pendingSendToolCalls, toolCallNames, social, biliJudgeCollectors, biliJudgeWaiters,
    currentTurnBySession, autoAtTurnDone, sessionPromises, pending,
    cancelPendingEntry: async () => { cancelled++; }, saveState: () => { saved++; }, log: () => {},
    recordSessionHistory: (sessionId, key2, reason) => historyRecords.push([sessionId, key2, reason]),
    bumpSessionEpoch: () => { epoch++; }
  }, key, sid);

  rotateSessionForContextOverflow('group:1', 'old-1');
  check('轮换删除 state.sessions 映射', state.sessions['group:1'] === undefined);
  check('轮换删除 reverse 映射', !reverse.has('old-1'));
  check('轮换清理 session 级 collector/队列', !collectors.has('old-1') && !v2TurnStartAt.has('old-1')
    && !sendToolSucceededSessions.has('old-1') && !pendingSendToolCalls.has('old-1') && !toolCallNames.has('old-1')
    && !currentTurnBySession.has('old-1') && !autoAtTurnDone.has('old-1'));
  check('轮换清理静默/退场标记', !social.silentTurns.has('old-1') && !social.exitingSessions.has('old-1'));
  check('轮换清理 bili 初判 collector/waiter', !biliJudgeCollectors.has('old-1') && !biliJudgeWaiters.has('old-1') && judgeResolved === 1);
  check('轮换清理 session 创建 promise', !sessionPromises.has('group:1'));
  check('轮换取消旧会话挂起请求', cancelled === 1 && !pending.has('group:1'));
  check('轮换递增 sessionEpoch', getEpoch() === 1);
  check('轮换保存 state', saved === 1);
  check('轮换写入会话映射历史', historyRecords.length === 1
    && historyRecords[0][0] === 'old-1' && historyRecords[0][1] === 'group:1'
    && historyRecords[0][2] === 'rotate', JSON.stringify(historyRecords));
  check('轮换不动 bridge 侧社交记忆', social.conversations.get('group:1')?.keep === 'memory');
}

console.log('\n── 5. bridge 接线 ──');
{
  
  
  
  for (const silent of [false, true]) {
    const h = createEventHarness({ mode: 'reserved2' });
    if (silent) h.deps.social.silentTurns.set('session-fixture', [{ ts: h.deps.now() }]);
    await h.turn(1, '', { kind: 'error', error: { message: 'prompt_too_long' } });
    check(silent ? '静默错误调用恢复器且禁止重试摘要' : '正常错误调用恢复器',
      h.get('recover').length === 1 && h.get('recover')[0][1].silent === silent && h.get('send').length === 0);
  }
  
  check('恢复器只重试一次（模块内单次 setTimeout）', (fs.readFileSync(path.join(root, 'src', 'context-recovery.js'), 'utf8').match(/setTimeout\(/g) || []).length === 1);
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
