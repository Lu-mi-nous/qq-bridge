// 仅内存替身：不读运行配置、不连接 DSH、不发送 QQ。
import fs from 'node:fs';
import { createDshEventPump } from '../../src/pipeline/dsh-events.js';
import { SENSITIVE_RE } from '../../src/sensitive.js';

export const fixture = JSON.parse(fs.readFileSync(new URL('../../test-fixtures/dsh-session-events.json', import.meta.url), 'utf8'));

export function sessionEvent(type, turn = 1, data = {}, sessionId = 'session-fixture') {
  const event = structuredClone(fixture.events[type] || { type, seq: 1, time: 1000, data: {} });
  event.data = { ...event.data, turn, ...data };
  return { rpcId: 'rpc-fixture', payload: { type: 'session/event', sessionId, event } };
}

export function assistantMessage(turn, text, sessionId) {
  const frame = sessionEvent('assistant/message', turn, {}, sessionId);
  frame.payload.event.data.message.content = [{ type: 'text', text }];
  return frame;
}

export function turnEnd(turn, reason = { kind: 'completed' }, sessionId) {
  return sessionEvent('turn/end', turn, { reason }, sessionId);
}

export function toolCall(turn, callId = 'call-1', name = 'mcp__snowluma__qq_send_message', sessionId) {
  return sessionEvent('tool/call', turn, { callId, name, arguments: '{"text":"测试"}' }, sessionId);
}

export function toolResult(turn, callId = 'call-1', isError = false, sessionId) {
  const frame = sessionEvent('tool/result', turn, {}, sessionId);
  const message = frame.payload.event.data.message;
  message.source.callId = callId;
  message.content[0].toolCallId = callId;
  message.content[0].isError = isError;
  return frame;
}

export function createEventHarness(options = {}) {
  let mode = options.mode || 'chat';
  let at = 1792886400000;
  let learnerSessionId = 'learner-current';
  const effects = [];
  const states = new Map();
  const socialStates = new Map();
  const record = (type) => (...args) => { effects.push([type, ...args]); };
  const defaults = () => ({ noActionCount: 0, triggers: {} });
  const deps = {
    api: { events: { async *mux() {} }, respond: async (...args) => record('respond')(...args) },
    reverse: new Map([['session-fixture', 'group:1'], ['session-other', 'group:2']]),
    collectors: new Map(), currentTurnBySession: new Map(), v2TurnStartAt: new Map(),
    sendToolSucceededSessions: new Set(), pendingSendToolCalls: new Map(), toolCallNames: new Map(),
    biliJudgeWaiters: new Map(), biliJudgeCollectors: new Map(),
    learnerSessions: new Set(), learnerCollectors: new Map(), learnerWaiters: new Map(),
    getSlangLearnerSessionId: () => learnerSessionId,
    getMode: () => mode,
    cfg: { socialV2: { wake: { noActionLimit: 3, maxWakeConfigReminders: 2 } }, social: {} },
    social: { silentTurns: new Map(), exitingSessions: new Set() },
    getSocialV2State: key => {
      if (!states.has(key)) states.set(key, { wakeConfig: defaults(), lastActionAt: 0, unread: [], pendingWakeReasons: [] });
      return states.get(key);
    },
    defaultWakeConfigV2: defaults, saveSocialV2State: record('save'),
    pendingWakeKeys: new Set(), wakeConfigUpdatedKeys: new Set(), markReadCalledKeys: new Set(),
    wakeConfigMissCount: new Map(), activeWaits: new Set(),
    clearAllPendingWakeLeases: record('clearLeases'), armPendingWakeLease: record('armLease'),
    disarmPendingWakeLease: record('disarmLease'), ensureWakeableV2: record('ensureWakeable'),
    deliverPrompt: async (...args) => { record('deliver')(...args); return { ok: true }; },
    buildWakeReminderPromptV2: key => `reminder:${key}`,
    wakePriorityV2: reason => ({ private: 100, atMention: 90, pokeSelf: 85, question: 80, anyMessage: 50, poke: 35 }[reason] || 0),
    pendingWakeSnapshotFromJournalV2: (key, seq) => ({ seq, text: '完整日志里的触发消息' }),
    scheduleWakeV2: record('scheduleWake'), SILENT_TURN_TIMEOUT_MS: 60000,
    contextRecovery: { recover: async (...args) => { record('recover')(...args); return { handled: true }; } },
    contextCfg: () => ({ compactionKeep: 10 }), STATE_DIR: 'fixture-state',
    appendCompaction: record('compaction'), contextMetrics: new Map(),
    redactSensitiveText: s => String(s).replace(/fixture-secret/g, '***'),
    sanitizeToolArgs: s => s, appendToolLog: record('toolLog'),
    isSendToolName: name => /^mcp__snowluma__qq_(send_group_message|send_private_message|reply|send_burst|send_message)$/.test(name),
    KNOWN_AGENT_TOKENS: new Set(['fixture-secret']), shouldAuditKey: () => true, SENSITIVE_RE,
    isSilentMarker: s => /^\s*\[SILENT\]\s*$/i.test(s), SILENT_MARKER: '[SILENT]',
    isSocialEnabled: () => mode === 'reserved',
    socialState: key => {
      if (!socialStates.has(key)) socialStates.set(key, { phase: 'active' });
      return socialStates.get(key);
    },
    shouldBlockSilentReply: () => false,
    planSocialTimeline: text => ({ main: text.split(' ') }),
    sendBurstToQQ: async (...args) => record('burst')(...args),
    sendToQQ: async (...args) => record('send')(...args),
    registerPending: async (...args) => record('pending')(...args),
    handleUpstreamError: async (...args) => { record('upstreamError')(...args); return false; },
    appendActivity: record('activity'), notifyOwnerOfError: record('ownerError'),
    log: record('log'), sleep: async ms => record('sleep')(ms), now: () => at,
    ...options.deps
  };
  const pump = createDshEventPump(deps);
  return {
    deps, pump, effects, states, socialStates,
    handle: pump.handleEnvelope,
    get: type => effects.filter(e => e[0] === type),
    setMode: value => { mode = value; },
    setNow: value => { at = value; },
    setLearner: value => { learnerSessionId = value; },
    async turn(turn, text = '', reason, sessionId) {
      await pump.handleEnvelope(sessionEvent('turn/start', turn, {}, sessionId));
      if (text) await pump.handleEnvelope(assistantMessage(turn, text, sessionId));
      await pump.handleEnvelope(turnEnd(turn, reason, sessionId));
    }
  };
}
