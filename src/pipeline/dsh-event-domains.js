// R4.7-5：DshEventPump 领域接口。
//
// 原先 pump 直接解构 70 个平铺依赖。这里定义 8 个稳定领域：
//   runtime / social / context / metrics / tools / access / config / lifecycle
// 生产 bridge 按领域装配；旧测试/旧调用仍可传平铺对象（迁移期兼容）。
//
// 注意：这只是注入契约收口，不是沙箱。领域对象内部仍是同一批函数引用。

export const DSH_EVENT_DOMAINS = Object.freeze([
  'runtime', 'social', 'context', 'metrics', 'tools', 'access', 'config', 'lifecycle'
]);

export const DSH_EVENT_DOMAIN_KEYS = Object.freeze({
  runtime: [
    'api', 'reverse', 'collectors', 'currentTurnBySession', 'v2TurnStartAt',
    'sendToolSucceededSessions', 'sendToolAttemptedSessions', 'pendingSendToolCalls',
    'toolCallNames', 'biliJudgeWaiters', 'biliJudgeCollectors', 'learnerSessions',
    'learnerCollectors', 'learnerWaiters', 'getSlangLearnerSessionId', 'getMode',
    'getRoleName', 'activeWaits'
  ],
  social: [
    'social', 'getSocialV2State', 'defaultWakeConfigV2', 'saveSocialV2State',
    'pendingWakeKeys', 'wakeConfigUpdatedKeys', 'markReadCalledKeys', 'wakeConfigMissCount',
    'clearAllPendingWakeLeases', 'armPendingWakeLease', 'disarmPendingWakeLease',
    'ensureWakeableV2', 'autoWrapAfterReply', 'deliverPrompt', 'buildWakeReminderPromptV2',
    'wakePriorityV2', 'pendingWakeSnapshotFromJournalV2', 'scheduleWakeV2',
    'isSocialEnabled', 'socialState', 'shouldBlockSilentReply', 'planSocialTimeline',
    'sendBurstToQQ', 'sendToQQ', 'registerPending', 'appendActivity'
  ],
  context: [
    'contextRecovery', 'recordSessionProcessed', 'contextCfg', 'STATE_DIR',
    'appendCompaction', 'contextMetrics', 'redactSensitiveText',
    'sessionContextTokens', 'rotateContextIfNeeded'
  ],
  metrics: ['recordTokenUsage', 'turnMetrics'],
  tools: ['sanitizeToolArgs', 'appendToolLog', 'isSendToolName'],
  access: ['KNOWN_AGENT_TOKENS', 'shouldAuditKey', 'SENSITIVE_RE', 'isSilentMarker', 'SILENT_MARKER'],
  config: ['cfg', 'SILENT_TURN_TIMEOUT_MS'],
  lifecycle: ['handleUpstreamError', 'notifyOwnerOfError', 'log', 'sleep', 'now']
});

/** 把平铺依赖按领域分组（仅迁移期兼容）。未知键忽略。 */
export function normalizeDshEventDeps(input = {}) {
  if (DSH_EVENT_DOMAINS.every((domain) => input[domain] && typeof input[domain] === 'object')) {
    return input;
  }
  const out = {};
  for (const domain of DSH_EVENT_DOMAINS) {
    out[domain] = {};
    for (const key of DSH_EVENT_DOMAIN_KEYS[domain]) {
      if (input[key] !== undefined) out[domain][key] = input[key];
    }
  }
  return out;
}

/** 启动期断言：领域键不重复、不夹带未登记键。 */
export function assertDshEventDomains(domains, { allowMissing = true } = {}) {
  const seen = new Map();
  for (const domain of DSH_EVENT_DOMAINS) {
    for (const key of DSH_EVENT_DOMAIN_KEYS[domain]) {
      if (seen.has(key)) throw new Error(`DshEvent 领域键重复：${key}（${seen.get(key)} / ${domain}）`);
      seen.set(key, domain);
    }
  }
  const actual = new Set();
  for (const domain of DSH_EVENT_DOMAINS) {
    const bag = domains?.[domain];
    if (!bag || typeof bag !== 'object') throw new Error(`DshEvent 领域缺失：${domain}`);
    for (const key of Object.keys(bag)) actual.add(key);
  }
  const missing = [...seen.keys()].filter((key) => !actual.has(key));
  const extra = [...actual].filter((key) => !seen.has(key));
  if (!allowMissing && missing.length) throw new Error(`DshEvent 领域键缺失：${missing.join(', ')}`);
  if (extra.length) throw new Error(`DshEvent 领域出现未登记键：${extra.join(', ')}`);
  return { keys: seen.size, domains: DSH_EVENT_DOMAINS.length };
}
