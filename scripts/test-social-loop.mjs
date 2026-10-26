// R3-13 社交循环：活跃期新消息、冷场、试探超时与退场兜底。
import { createSocialLoop } from '../src/social-loop.js';

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
};

function makeLoop(overrides = {}) {
  const states = new Map();
  const recent = new Map();
  const replies = [];
  const summaries = [];
  const now = 1_700_000_000_000;
  const social = {
    states,
    recentMessages: recent,
    silentContext: new Map(),
    exitingSessions: new Set(),
    loopTimer: null
  };
  const st = {
    phase: 'active',
    nextCheckAt: 0,
    lastCheckAt: 0,
    lastActiveMessageAt: now,
    activeDeadlineAt: 0,
    activeExitAt: 0,
    probeDeadline: 0,
    lastAiReplyAt: now,
    proactiveNextCheckAt: 0
  };
  states.set('group:1', st);
  recent.set('group:1', [{ time: now + 1, plain: '普通消息', sender: '甲', media: [], messageId: 'm1' }]);
  const loop = createSocialLoop({
    cfg: {
      social: {
        activeCheckMinMs: 1,
        activeCheckMaxMs: 1,
        skipProbability: 0,
        idleWindowMs: 1,
        idleRetryProbability: 0,
        proactiveEnabled: false
      }
    },
    social,
    socialState: () => st,
    isSocialEnabled: () => true,
    enterActive: () => {},
    leaveActive: () => { st.phase = 'idle'; },
    triggerActiveDurationExit: () => false,
    currentRoleHint: () => '',
    buildProactivePrompt: () => 'proactive',
    scheduleSocialReply: (...args) => replies.push(args),
    buildBatchPrompt: () => 'batch',
    buildProbePrompt: () => 'probe',
    appendSummary: (...args) => summaries.push(args),
    isMustReplyText: () => false,
    state: { sessions: {} },
    log: () => {},
    randInt: () => 1,
    ...overrides
  });
  return { loop, st, replies, summaries, now };
}

console.log('── 1. 活跃期新消息 ──');
{
  const { loop, st, replies } = makeLoop();
  st.nextCheckAt = 0;
  loop.tick();
  check('检测到新消息并投递', replies.length === 1 && replies[0][1] === 'batch');
  check('更新最后活跃时间', st.lastActiveMessageAt > 0);
}

console.log('\n── 2. 冷场 / 试探 / 退场 ──');
{
  const { loop, st, replies } = makeLoop();
  st.nextCheckAt = 0;
  st.lastActiveMessageAt = 0;
  st.lastCheckAt = 1_700_000_000_002; // 让本群没有新消息
  loop.tick();
  check('冷场后回到观望', st.phase === 'idle');

  const t = makeLoop();
  t.st.phase = 'probing';
  t.st.probeDeadline = 0;
  t.loop.tick();
  check('试探超时回观望', t.st.phase === 'idle');

  const e = makeLoop();
  e.st.phase = 'exiting';
  e.st.activeExitAt = 0;
  e.loop.tick();
  check('退场超时强制回观望', e.st.phase === 'idle');
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
