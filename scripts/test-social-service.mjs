// R3-2 社交调度服务：唤醒优先级、合并窗口、忙碌暂存、熔断与定时器清理。
import { createSocialService } from '../src/social-service.js';

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
};

function makeService(overrides = {}) {
  const conversations = new Map();
  const state = (key, patch = {}) => {
    const st = {
      pendingWakeTimer: null,
      pendingWakeReason: null,
      sleepTimer: null,
      replyCheckTimer: null,
      proactiveTimer: null,
      pendingWakeReasons: [],
      wakeConfig: { batchWindowMs: 8000 },
      recentMessages: [],
      ...patch
    };
    conversations.set(key, st);
    return st;
  };
  const timers = [];
  const cleared = [];
  const wakes = [];
  const queued = [];
  const activity = [];
  const logs = [];
  let paused = false;
  let mode = 'reserved2';
  const service = createSocialService({
    cfg: {
      socialV2: {
        enabled: true,
        autoReplyCheckMs: 30000,
        proactive: { enabled: false },
        ...(overrides.cfg || {})
      }
    },
    socialV2: {
      get paused() { return paused; },
      conversations
    },
    getState: (key) => conversations.get(key) || state(key),
    getMode: () => mode,
    isSessionAllowed: () => overrides.allowed !== false,
    isBusy: () => overrides.busy === true,
    isFused: () => overrides.fused === true,
    queuePendingWakeReason: (st, key, reason, seq) => {
      queued.push({ key, reason, seq });
      st.pendingWakeReasons.push({ reason, seq });
    },
    ensureWakeable: () => {},
    sendWakePrompt: async (key, reason) => { wakes.push({ key, reason }); },
    appendActivity: (line) => activity.push(line),
    log: (...args) => logs.push(args.join(' ')),
    now: () => 1_700_000_000_000,
    random: () => 0.5,
    setTimer: (fn, ms) => {
      const t = { fn, ms, unref() {} };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => { cleared.push(t); }
  });
  return {
    service, conversations, state, timers, cleared, wakes, queued, activity, logs,
    setPaused: (v) => { paused = v; },
    setMode: (m) => { mode = m; }
  };
}

console.log('── 1. 唤醒窗口与优先级 ──');
{
  const t = makeService();
  const st = t.state('group:1');
  t.service.scheduleWake('group:1', 'anyMessage');
  check('普通唤醒使用批处理窗口', t.timers.length === 1 && t.timers[0].ms === 8000);
  check('写入待唤醒原因', st.pendingWakeReason === 'anyMessage');

  t.service.scheduleWake('group:1', 'atMention');
  check('合并窗口内只保留一个定时器', t.timers.length === 1);
  check('高优先级原因覆盖低优先级', st.pendingWakeReason === 'atMention');

  const t2 = makeService();
  const st2 = t2.state('group:2');
  t2.service.scheduleWake('group:2', 'atMention');
  check('高优先级窗口缩短到 1.5s', st2.pendingWakeTimer?.ms === 1500 && t2.timers[0].ms === 1500);
}

console.log('\n── 2. 忙碌 / 熔断 / 暂停 ──');
{
  const busy = makeService({ busy: true });
  busy.state('group:1', { lastUnreadSeq: 9 });
  busy.service.scheduleWake('group:1', 'question');
  check('忙碌时暂存原因', busy.queued.length === 1 && busy.queued[0].reason === 'question');
  check('忙碌时不创建唤醒定时器', busy.timers.length === 0);

  const fused = makeService({ fused: true });
  fused.state('group:1');
  fused.service.scheduleWake('group:1', 'atMention');
  check('熔断时跳过唤醒', fused.timers.length === 0 && fused.activity.some((x) => x.includes('熔断')));
  check('熔断不写待唤醒原因', fused.conversations.get('group:1').pendingWakeReason === null);

  const paused = makeService();
  paused.state('group:1');
  paused.setPaused(true);
  paused.service.scheduleWake('group:1', 'question');
  check('暂停时跳过唤醒', paused.timers.length === 0);
}

console.log('\n── 3. 回复检查 / 睡眠 / 清理 ──');
{
  const t = makeService();
  const st = t.state('group:1', { recentMessages: [{ isSelf: true, text: '在吗？', time: 1_700_000_000_000 - 1000 }] });
  t.service.scheduleReplyCheck('group:1');
  check('提问后回复检查延长 1.5 倍', t.timers[0].ms === 45000);
  check('写入 replyCheckTimer', !!st.replyCheckTimer);

  const t2 = makeService();
  t2.state('group:1', { wakeConfig: { sleepUntil: new Date(1_700_000_060_000).toISOString() } });
  t2.service.setupSleepTimer('group:1');
  check('有限睡眠设置定时器', t2.timers[0].ms === 60000);

  const t3 = makeService();
  const st3 = t3.state('group:1', { pendingWakeReason: 'x', pendingWakeReasons: [{ reason: 'x' }] });
  st3.pendingWakeTimer = { unref() {} };
  st3.sleepTimer = { unref() {} };
  st3.replyCheckTimer = { unref() {} };
  st3.proactiveTimer = { unref() {} };
  t3.service.clearTimers('group:1');
  check('清理四类定时器与待唤醒原因', t3.cleared.length === 4 && st3.pendingWakeReason === null
    && st3.pendingWakeReasons.length === 0);
}

console.log('\n── 4. 主动检查开关 ──');
{
  const off = makeService();
  off.state('group:1');
  off.service.scheduleProactiveCheck('group:1');
  check('主动检查关闭时不设定时器', off.timers.length === 0);

  const on = makeService({ cfg: { proactive: { enabled: true, checkIntervalMinMs: 60000, checkIntervalMaxMs: 120000 } } });
  on.state('group:1');
  on.service.scheduleProactiveCheck('group:1');
  check('主动检查开启时设定时器', on.timers.length === 1 && on.timers[0].ms === 90000);
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
