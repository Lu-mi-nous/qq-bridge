// 真实模块的内存适配器；不读取运行配置，不联网，不启动 QQ/DSH。
import { createIncomingStages } from '../../src/pipeline/incoming.js';
import { createSocialStateStore } from '../../src/pipeline/social-state.js';
import { modeAllowed } from '../../src/pipeline/admission.js';

export function incomingHarness(overrides = {}) {
  const calls = [], friends = new Set(), media = new Map(), pending = new Map();
  const live = { mode: 'chat', role: { mode: 'normal' }, transcript: '', quoteSelf: false };
  const cfg = { ownerQQ: '42', allow: { groups: ['1'], private: [], privateMode: 'friends' }, deny: { groups: [], private: [] }, allowAllWhenEmpty: false };
  const deps = {
    getMode: () => live.mode,
    modeAllowed: (key, kind, id, config, mode) => modeAllowed(key, kind, id, config, mode, friends),
    maybeSendWhitelistNotice: async (...a) => calls.push(['notice', ...a]),
    refreshFriendList: async () => calls.push(['refresh']), log: (...a) => calls.push(['log', ...a]),
    resolveGroupMemberName: async () => '群名片', resolveReplyInfo: async () => null,
    extractMediaFromSegments: (segs) => segs.filter(s => s.type === 'image').map(s => ({ kind: 'image', ...s.data })),
    transcribeIncomingVoice: async () => live.transcript, messageMediaStore: media, MAX_MEDIA_STORE_PER_KEY: 2,
    isQuoteTargetSelf: async () => live.quoteSelf, readRoleState: () => live.role,
    adminCommands: {
      handleJoinDecisionCommand: async () => false,
      handleAdminCommand: async (ctx) => { calls.push(['admin', ctx]); return false; }
    },
    pending, handlePendingAnswer: async (...a) => calls.push(['answer', ...a]),
    appendActivity: (...a) => calls.push(['activity', ...a]), sendToQQ: async (...a) => calls.push(['send', ...a]),
    ...overrides
  };
  const stages = createIncomingStages(deps);
  const context = (text = '你好', event = {}, kind = 'group', id = '1') => ({
    key: `${kind}:${id}`, kind, id, cfg,
    event: { user_id: 7, self_id: 9, message_id: 100, group_id: 1,
      message: [{ type: 'text', data: { text } }], ...event }
  });
  return { stages, context, deps, live, calls, friends, media, pending, cfg };
}

export function socialStateHarness(raw = null, overrides = {}) {
  const writes = [], calls = [];
  const deps = {
    cfg: { socialV2: { wake: {} } }, socialV2: { paused: false, conversations: new Map() },
    state: { sessions: {} }, v2TurnStartAt: new Map(), KNOWN_AGENT_TOKENS: new Set(), seenForwardIds: new Map(),
    SOCIAL_V2_FILE: 'memory-only', readJsonSafe: () => raw,
    atomicWriteJson: (_file, value) => writes.push(structuredClone(value)),
    scheduleProactiveCheckV2: (k) => calls.push(['proactive', k]),
    setupSleepTimerV2: (k) => calls.push(['sleep', k]), log: (...a) => calls.push(['log', ...a]),
    ...overrides
  };
  return { store: createSocialStateStore(deps), deps, writes, calls };
}

export function checks() {
  let pass = 0, fail = 0;
  return {
    check(name, ok, detail = '') {
      ok ? pass++ : fail++;
      console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ': ' + detail : ''}`);
    },
    finish() { console.log(`✅ ${pass} 通过 / ${fail} 失败`); process.exitCode = fail ? 1 : 0; }
  };
}
