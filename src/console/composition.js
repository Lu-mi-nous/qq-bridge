// R4.7-1：Console 领域 Facade。
//
// 目的：`bridge.js` 不再向控制台平铺传 260+ 个实现细节；它只装配 8 个稳定领域对象，
// 领域内部键的变化不再扩散到 composition root。路由逐步改为只消费自己需要的领域对象；
// 迁移期间保留 `flattenConsoleServices()` 作为兼容视图，禁止新增代码依赖该兼容视图。
//
// 领域划分（与 R4.7 方案一致）：
//   config / sessions / messaging / social / media / context / plugins / operations
//
// 约束：
// - 每个键只能属于一个领域；重复或遗漏由 `assertConsoleDomainKeys()` 在启动时直接抛错。
// - `operations.live` / `operations.ops` 保持对象引用，不能用展开复制，否则 getter/setter 会失效。

export const CONSOLE_DOMAINS = Object.freeze([
  'config', 'sessions', 'messaging', 'social', 'media', 'context', 'plugins', 'operations'
]);

export const CONSOLE_DOMAIN_KEYS = Object.freeze({
  config: [
    'ACTIVITY_LOG', 'CACHE_GROUPS', 'CREDENTIAL_ITEMS', 'DEFAULT_AUTO_AT', 'DEFAULT_ERROR_MESSAGES',
    'DEFAULT_SOVITS_DIR', 'FEEDBACK_FILE', 'FORCE_WRAPUP_HINT', 'KNOWN_AGENT_TOKENS', 'MAX_MEDIA_BYTES',
    'MAX_MEDIA_PIXELS', 'REACTION_EMOJIS', 'ROOT', 'SENSITIVE_RE', 'SLANG_STATUS', 'SOCIAL_V2_FILE',
    'STATE_DIR', 'STICKER_CACHE_DIR', 'TOOL_FLAGS', 'TOOL_LOG_FILE', 'TTS_DEFAULT_PROBABILITY',
    'WAIT_QUIET_CAP_MS', 'WAIT_TURN_MAX_COUNT', 'WAIT_TURN_MAX_MS', 'WAIT_WINDOW_MAX', 'WAIT_WINDOW_MS',
    'atomicWriteJson', 'atomicWriteText', 'cfg', 'crypto', 'fs', 'http', 'humanBytes', 'humanSize', 'log',
    'maskValue', 'path', 'readJsonSafe', 'readActivityTail', 'readConversationRoles', 'readRoleState',
    'writeRoleState', 'writeConversationRole', 'listRoles', 'roleExists', 'roleFor', 'sanitizeRoleName',
    'currentRoleHint', 'currentRoleHintV2', 'sleep', 'text', 'allowSlangSubmit', 'readToolLog',
    'readFeedbackEntries', 'applyPixivAuth'
  ],
  sessions: [
    'activeWaits', 'allowed', 'biliBrowseState', 'biliInfoCache', 'collectors', 'contextMetrics',
    'feedbackTimes', 'gitHubShotTimes', 'imageSendTimes', 'lastSentImage', 'markReadCalledKeys',
    'messageMediaStore', 'pending', 'pendingSendToolCalls', 'pendingWakeKeys', 'promptQueues', 'queued',
    'queuedHintAt', 'reverse', 'seenForwardIds', 'sendToolSucceededSessions', 'sessionPromises',
    'slangExtractionCooldowns', 'slangResearchingIds', 'slangSubmitTimes', 'slangWindows', 'socialV2',
    'state', 'toolCallNames', 'v2TurnStartAt', 'waitTurnStats', 'waitTurnTotals', 'wakeConfigMissCount',
    'wakeConfigUpdatedKeys', 'canonicalV2Key', 'saveState'
  ],
  messaging: [
    'api', 'bot', 'escapeCqText', 'findCjkSpaceWarning', 'findSplitBoundaryWarning', 'normalizeMessagesInput',
    'recordSentMessage', 'recordSentMessagesV2', 'redactKnownTokensOnly', 'resolveGroupMemberName',
    'resolvePokeTarget', 'resolveReplyTargetV2', 'sendMessagesV2', 'sendToQQ', 'stripLeadingMetaMarker',
    'stripLeadingMetaMarkers', 'unquoteJsonString', 'formatForwardResponse', 'resolveReplyInfo',
    'isOwnerTurn', 'isSymbolicPokeRef', 'isSymbolicReplyRef', 'looksLikeUnfinished'
  ],
  social: [
    'cleanupSocialForModeChange', 'clearAllPendingWakeLeases', 'clearAllSocialV2Timers',
    'clearSocialV2Timers', 'cancelAllSocialTimers', 'cancelPendingEntry', 'cancelReplyCheckV2',
    'cancelSocialTimers', 'computeGapsV2', 'computeWakeSafetyV2', 'deliverPrompt', 'drainAllPromptQueues',
    'drainPromptQueue', 'ensureSession', 'ensureWakeableV2', 'enterActive', 'findCallersV2', 'flushSummaries',
    'formatParticipationV2', 'formatSummary', 'getSocialV2State', 'isConversationBusyV2', 'isSleepingConfigV2',
    'leaveActive', 'modeAllowed', 'normalizeOwnerQQ', 'normalizePrivateMode', 'normalizeSpeakerIdsV2',
    'preSleepWaitBlockedV2', 'refreshAllDefaultWakeConfigsV2', 'saveSocialV2State', 'scheduleProactiveCheckV2',
    'scheduleReplyCheckV2', 'sendWakePromptV2', 'setupSleepTimerV2', 'shouldBlockSilentReply', 'social',
    'suggestQuietMsV2', 'isSessionAllowedInCurrentMode'
  ],
  media: [
    'archiveImage', 'collectCacheItems', 'collectStickerV2', 'crawlAigengtu', 'crawlUrl', 'deleteStickerV2',
    'emojiCatalogIds', 'emojiReactGate', 'extractGitHubUrl', 'fetchMediaData', 'fetchVideoInfo',
    'findMessageMediaAsync', 'getImageDimensions', 'getStickerImageData', 'groupActivityScore', 'imagesEnabled',
    'imagePreflightV2', 'imageSendAllowed', 'imageStore', 'isAigengtuUrl', 'onebotSendImageFile',
    'onebotSendVideoFile', 'onebotSendVoiceFile', 'purgeCache', 'refreshImageLib', 'rememberBiliInfo',
    'renderFeatureMenu', 'resolveBiliId', 'reverseSearcher', 'runBiliBrowse', 'safeFetchBuffer',
    'saveStickerImage', 'scheduleBiliBrowse', 'screenshotGitHubRepo', 'searchVideos', 'sendImageV2',
    'sendStickerV2', 'setEmojiLike', 'setStickerRemarkV2', 'applyStickerNoteV2', 'sniffImageMime',
    'sourcePageOf', 'stickerCacheOpts', 'stickerEnabled', 'summarizeCache', 'syncStickerLibrary', 'ttsNum',
    'ttsSpeechParams', 'validateEmojiId', 'watchVideo', 'writeStickerCacheImage', 'formatStickerList',
    'mimeFromBuffer', 'mimeFromUrl', 'joinQueue', 'buildStickerContext', 'buildStickerStrategyHint',
    'normalizeSourceFilter', 'parseGitHubUrl', 'searchGroupFiles', 'summarizeGroupFiles'
  ],
  context: [
    'appendMemoryV2', 'backfillLongTermMemory', 'buildSlangContext', 'clearRecallIndex', 'confirmedSlangListV2',
    'contextCfg', 'contextDir', 'contextDisplayName', 'contextStats', 'countContextPendingV2',
    'createSlangEntry', 'formatMemoryV2', 'getRecallIndexV2', 'invalidateSlangLearnerSession',
    'journalCoverage', 'journalStats', 'loadEpisodes', 'loadLongTermMemory', 'longTermStats', 'makeEpisodeNow',
    'mergeEvidence', 'publicSlangEntry', 'queueSlangTask', 'readBacklogHistory', 'readRecallAudit',
    'recallAuditStats', 'refreshContextNames', 'runSlangExtraction', 'runSlangResearch', 'saveSlangStore',
    'searchMemory', 'sessionFileBytes', 'buildTokenReport', 'pruneTokenReportCache', 'refreshTokenUsage',
    'renderTokenReport', 'summarizeTokenReport', 'loadTokenUsage'
  ],
  plugins: ['pluginHost', 'taskService', 'toolNamesOf', 'groupedToolFlags', 'xMonitor'],
  operations: [
    'loadOrCreateConsoleToken', 'releaseLock', 'unwrap', 'notifyOwnerOfError', 'appendActivity',
    'appendFeedbackEntry', 'refreshFriendList', 'live', 'ops'
  ]
});

/** 启动期断言：领域键不重复、不遗漏、不夹带未知键。 */
export function assertConsoleDomainKeys(services, { allowMissing = false } = {}) {
  const seen = new Map();
  for (const domain of CONSOLE_DOMAINS) {
    const keys = CONSOLE_DOMAIN_KEYS[domain] || [];
    for (const key of keys) {
      if (seen.has(key)) throw new Error(`Console 领域键重复：${key}（${seen.get(key)} / ${domain}）`);
      seen.set(key, domain);
    }
  }
  const actual = new Set();
  for (const domain of CONSOLE_DOMAINS) {
    const bag = services?.[domain];
    if (!bag || typeof bag !== 'object') throw new Error(`Console 领域缺失：${domain}`);
    for (const key of Object.keys(bag)) actual.add(key);
  }
  const missing = [...seen.keys()].filter((key) => !actual.has(key));
  const extra = [...actual].filter((key) => !seen.has(key));
  if (!allowMissing && missing.length) throw new Error(`Console 领域键缺失：${missing.join(', ')}`);
  if (extra.length) throw new Error(`Console 领域出现未登记键：${extra.join(', ')}`);
  return { keys: seen.size, domains: CONSOLE_DOMAINS.length };
}

/**
 * 装配 8 个领域对象。只接受领域形状，不再接受 266 个平铺键。
 * `operations.live` / `operations.ops` 保留原对象引用（getter/setter 不能展开复制）。
 */
export function createConsoleServices(domains = {}) {
  const services = {};
  for (const domain of CONSOLE_DOMAINS) {
    const bag = domains[domain];
    if (!bag || typeof bag !== 'object') throw new Error(`createConsoleServices 缺少领域：${domain}`);
    services[domain] = bag;
  }
  return services;
}

/**
 * 兼容视图：把选定领域摊平成旧路由仍在使用的 `deps` 形状。
 * 仅用于 R4.7-2~4 迁移期间；新代码不得依赖它，迁移完成后删除。
 */
export function flattenConsoleServices(services, domainNames = CONSOLE_DOMAINS) {
  const out = {};
  for (const domain of domainNames) {
    const bag = services?.[domain];
    if (!bag) continue;
    for (const [key, value] of Object.entries(bag)) out[key] = value;
  }
  return out;
}

/**
 * 迁移期兼容：旧测试/旧调用可能仍传平铺 deps。
 * 生产 composition root 必须走 createConsoleServices；这里只在检测到平铺形状时兜底分组。
 */
export function ensureConsoleServices(input = {}) {
  if (CONSOLE_DOMAINS.every((domain) => input[domain] && typeof input[domain] === 'object')) {
    return createConsoleServices(input);
  }
  const services = {};
  for (const domain of CONSOLE_DOMAINS) services[domain] = {};
  for (const [key, value] of Object.entries(input)) {
    const domain = Object.keys(CONSOLE_DOMAIN_KEYS).find((d) => CONSOLE_DOMAIN_KEYS[d].includes(key));
    if (!domain) continue;
    services[domain][key] = value;
  }
  // live/ops 是旧平铺形状里的特殊对象。
  if (input.live) services.operations.live = input.live;
  if (input.ops) services.operations.ops = input.ops;
  return services;
}
