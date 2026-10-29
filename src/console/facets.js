// R4.7-2/3：控制台用例层装配。
//
// 从 R4.7-1 的 8 个领域对象里取实现，装配成「读模型 + 命令」两组小接口。
// 路由拿到的是面向用例的 `ctx.readModels.<domain>` / `ctx.commands.<domain>`，
// 而不是 266 项平铺 deps；领域键变化不再扩散到每个 route。
//
// 约束：
// - 这里只做装配，不缓存动态值：live/state 以对象引用传入，读模型每次调用现读。
// - 不用 Service Locator（route 拿到的是具名接口，不是 `get(name)`）。
// - 新增领域时在对应 read-model/commands 模块里显式列依赖；缺能力时降级为空读/明确报错。

import { createTokenReadModel } from './read-model/token.js';
import { createTokenCommands } from './commands/token.js';
import { createActivityReadModel } from './read-model/activity.js';
import { createActivityCommands } from './commands/activity.js';
import { createTaskCommands } from './commands/tasks.js';
import { createContextReadModel } from './read-model/context.js';
import { createContextCommands } from './commands/context.js';
import { createOpsCommands } from './commands/ops.js';
import { createImagesReadModel } from './read-model/images.js';
import { createImagesCommands } from './commands/images.js';
import { createStickersReadModel } from './read-model/stickers.js';
import { createStickersCommands } from './commands/stickers.js';
import { createWaitReadModel } from './read-model/wait.js';
import { createWaitCommands } from './commands/wait.js';
import { createBiliReadModel } from './read-model/bili.js';
import { createBiliCommands } from './commands/bili.js';
import { createSocialReadModel } from './read-model/social-read.js';
import { createSocialReadCommands } from './commands/social-read.js';
import { createCoreReadModel } from './read-model/core.js';
import { createCoreCommands } from './commands/core.js';
import { createMemoryReadModel } from './read-model/memory.js';
import { createMemoryCommands } from './commands/memory.js';
import { createAccessReadModel } from './read-model/access.js';
import { createAccessCommands } from './commands/access.js';
import { createAgentReadModel } from './read-model/agent.js';
import { createAgentCommands } from './commands/agent.js';
import { createMessagingCommands } from './commands/messaging.js';
import { createSocialV1ReadModel } from './read-model/social-v1.js';
import { createSocialV1Commands } from './commands/social-v1.js';
import { createSlangReadModel } from './read-model/slang.js';
import { createSlangCommands } from './commands/slang.js';
import { createConfigReadModel } from './read-model/config.js';
import { createConfigCommands } from './commands/config.js';
import { createForwardReadModel } from './read-model/forward.js';
import { createOverviewReadModel } from './read-model/overview.js';
import { createPluginCommands } from './commands/plugins.js';

export function createConsoleFacets(services = {}, { buildSessionUsageRows, now, helpers = {} } = {}) {
  const config = services.config || {};
  const sessions = services.sessions || {};
  const context = services.context || {};
  const messaging = services.messaging || {};
  const media = services.media || {};
  const social = services.social || {};
  const operations = services.operations || {};

  const readModels = {
    token: createTokenReadModel({
      live: operations.live,
      state: sessions.state,
      loadTokenUsage: context.loadTokenUsage,
      contextDisplayName: context.contextDisplayName,
      buildSessionUsageRows,
      now
    }),
    activity: createActivityReadModel({
      live: operations.live,
      socialV2: sessions.socialV2,
      cfg: config.cfg,
      state: sessions.state,
      contextDisplayName: context.contextDisplayName,
      findCallersV2: social.findCallersV2,
      isConversationBusyV2: social.isConversationBusyV2,
      getSocialV2State: social.getSocialV2State,
      computeWakeSafetyV2: social.computeWakeSafetyV2,
      roleFor: config.roleFor,
      currentRoleHint: config.currentRoleHint,
      currentRoleHintV2: config.currentRoleHintV2,
      confirmedSlangListV2: context.confirmedSlangListV2,
      buildSlangContext: context.buildSlangContext,
      formatMemoryV2: context.formatMemoryV2,
      formatParticipationV2: social.formatParticipationV2,
      stickerEnabled: media.stickerEnabled,
      stickerCacheOpts: media.stickerCacheOpts,
      buildStickerContext: media.buildStickerContext,
      buildStickerStrategyHint: media.buildStickerStrategyHint,
      syncStickerLibrary: media.syncStickerLibrary
    }),
    context: createContextReadModel({
      cfg: config.cfg,
      STATE_DIR: config.STATE_DIR,
      live: operations.live,
      socialV2: sessions.socialV2,
      state: sessions.state,
      ops: operations.ops,
      contextDisplayName: context.contextDisplayName,
      contextStats: context.contextStats,
      loadLongTermMemory: context.loadLongTermMemory,
      backfillLongTermMemory: context.backfillLongTermMemory,
      longTermStats: context.longTermStats,
      journalStats: context.journalStats,
      loadEpisodes: context.loadEpisodes,
      readRecallAudit: context.readRecallAudit,
      confirmedSlangListV2: context.confirmedSlangListV2,
      buildSlangContext: context.buildSlangContext,
      normalizeSharedMemoryConfig: helpers.normalizeSharedMemoryConfig,
      sharedMemoryStats: helpers.sharedMemoryStats,
      listSharedPeople: helpers.listSharedPeople,
      normalizeTokenFuseConfig: helpers.normalizeTokenFuseConfig,
      effectiveTokenFuseThresholds: helpers.effectiveTokenFuseThresholds
    }),
    images: createImagesReadModel({
      cfg: config.cfg,
      live: operations.live,
      imageStore: media.imageStore,
      lastSentImage: sessions.lastSentImage,
      imagesEnabled: media.imagesEnabled,
      imagePreflightV2: media.imagePreflightV2,
      imageSendAllowed: media.imageSendAllowed,
      normalizeSourceFilter: media.normalizeSourceFilter,
      sourcePageOf: media.sourcePageOf,
      reverseSearcher: media.reverseSearcher
    }),
    stickers: createStickersReadModel({
      cfg: config.cfg,
      live: operations.live,
      stickerEnabled: media.stickerEnabled,
      syncStickerLibrary: media.syncStickerLibrary,
      formatStickerList: media.formatStickerList,
      stickerCacheOpts: media.stickerCacheOpts
    }),
    wait: createWaitReadModel({
      readToolLog: config.readToolLog,
      readFeedbackEntries: config.readFeedbackEntries,
      getSocialV2State: social.getSocialV2State,
      resolveReplyInfo: messaging.resolveReplyInfo
    }),
    bili: createBiliReadModel({
      cfg: config.cfg,
      ROOT: config.ROOT,
      live: operations.live,
      socialV2: sessions.socialV2,
      biliBrowseState: sessions.biliBrowseState,
      CACHE_GROUPS: config.CACHE_GROUPS,
      DEFAULT_SOVITS_DIR: config.DEFAULT_SOVITS_DIR,
      TTS_DEFAULT_PROBABILITY: config.TTS_DEFAULT_PROBABILITY,
      joinQueue: media.joinQueue,
      collectCacheItems: media.collectCacheItems,
      summarizeCache: media.summarizeCache,
      groupActivityScore: media.groupActivityScore,
      ttsNum: media.ttsNum,
      ttsSpeechParams: media.ttsSpeechParams,
      path: config.path
    }),
    socialRead: createSocialReadModel({
      bot: messaging.bot,
      humanSize: config.humanSize,
      searchGroupFiles: media.searchGroupFiles,
      summarizeGroupFiles: media.summarizeGroupFiles,
      formatSummary: social.formatSummary,
      getSocialV2State: social.getSocialV2State,
      socialV2: sessions.socialV2,
      state: sessions.state,
      promptQueues: sessions.promptQueues,
      pendingWakeKeys: sessions.pendingWakeKeys,
      v2TurnStartAt: sessions.v2TurnStartAt,
      collectors: sessions.collectors,
      isConversationBusyV2: social.isConversationBusyV2
    }),
    core: createCoreReadModel({
      ROOT: config.ROOT,
      cfg: config.cfg,
      live: operations.live,
      socialV2: sessions.socialV2,
      state: sessions.state,
      api: config.api,
      unwrap: operations.unwrap,
      readActivityTail: config.readActivityTail,
      readRoleState: config.readRoleState,
      listRoles: config.listRoles,
      readConversationRoles: config.readConversationRoles,
      refreshContextNames: context.refreshContextNames,
      roleFor: config.roleFor,
      sanitizeRoleName: config.sanitizeRoleName,
      fs: config.fs,
      path: config.path
    }),
    memory: createMemoryReadModel({
      cfg: config.cfg,
      STATE_DIR: config.STATE_DIR,
      live: operations.live,
      socialV2: sessions.socialV2,
      state: sessions.state,
      ops: operations.ops,
      contextCfg: context.contextCfg,
      contextStats: context.contextStats,
      contextMetrics: sessions.contextMetrics,
      countContextPendingV2: context.countContextPendingV2,
      longTermStats: context.longTermStats,
      backfillLongTermMemory: context.backfillLongTermMemory,
      journalStats: context.journalStats,
      journalCoverage: context.journalCoverage,
      recallAuditStats: context.recallAuditStats,
      refreshContextNames: context.refreshContextNames,
      loadTokenUsage: context.loadTokenUsage,
      contextDisplayName: context.contextDisplayName,
      sessionFileBytes: context.sessionFileBytes,
      formatMemoryV2: context.formatMemoryV2,
      getSocialV2State: social.getSocialV2State,
      getRecallIndexV2: context.getRecallIndexV2,
      searchMemory: context.searchMemory,
      buildSessionUsageRows,
      sharedMemoryStats: helpers.sharedMemoryStats,
      readBacklogHistory: context.readBacklogHistory
    }),
    access: createAccessReadModel({
      cfg: config.cfg,
      live: operations.live,
      state: sessions.state,
      pending: sessions.pending,
      contextDisplayName: context.contextDisplayName,
      refreshContextNames: context.refreshContextNames
    }),
    agent: createAgentReadModel({
      cfg: config.cfg,
      live: operations.live,
      findMessageMediaAsync: media.findMessageMediaAsync,
      fetchMediaData: media.fetchMediaData,
      modeAllowed: social.modeAllowed,
      log: config.log
    }),
    socialV1: createSocialV1ReadModel({
      ROOT: config.ROOT,
      cfg: config.cfg,
      social: sessions.social,
      socialV2: sessions.socialV2,
      state: sessions.state,
      contextDisplayName: context.contextDisplayName,
      fs: config.fs,
      path: config.path,
      parseChangelogMarkdown: helpers.parseChangelogMarkdown,
      sanitizeDevLogText: helpers.sanitizeDevLogText
    }),
    slang: createSlangReadModel({ live: operations.live, cfg: config.cfg }),
    config: createConfigReadModel({
      CREDENTIAL_ITEMS: config.CREDENTIAL_ITEMS,
      ROOT: config.ROOT,
      STATE_DIR: config.STATE_DIR,
      cfg: config.cfg,
      maskValue: config.maskValue,
      path: config.path,
      readJsonSafe: config.readJsonSafe
    }),
    forward: createForwardReadModel({
      bot: messaging.bot,
      cfg: config.cfg,
      live: operations.live,
      fetchMediaData: media.fetchMediaData,
      formatForwardResponse: messaging.formatForwardResponse,
      getSocialV2State: social.getSocialV2State,
      log: config.log,
      modeAllowed: social.modeAllowed,
      seenForwardIds: sessions.seenForwardIds
    }),
    overview: createOverviewReadModel({
      root: config.ROOT,
      cfg: config.cfg,
      pluginHost: services.plugins?.pluginHost,
      TOOL_FLAGS: config.TOOL_FLAGS,
      groupedToolFlags: services.plugins?.groupedToolFlags,
      toolNamesOf: services.plugins?.toolNamesOf
    })
  };

  const commands = {
    token: createTokenCommands({
      live: operations.live,
      cfg: config.cfg,
      socialV2: sessions.socialV2,
      ops: operations.ops,
      fs: config.fs,
      loadTokenUsage: context.loadTokenUsage,
      refreshTokenUsage: context.refreshTokenUsage,
      buildTokenReport: context.buildTokenReport,
      renderTokenReport: context.renderTokenReport,
      summarizeTokenReport: context.summarizeTokenReport,
      pruneTokenReportCache: context.pruneTokenReportCache,
      onebotSendImageFile: media.onebotSendImageFile,
      appendActivity: operations.appendActivity,
      log: config.log,
      modeAllowed: social.modeAllowed,
      shouldBlockSilentReply: social.shouldBlockSilentReply
    }),
    activity: createActivityCommands({
      live: operations.live,
      socialV2: sessions.socialV2,
      state: sessions.state,
      ops: operations.ops,
      log: config.log,
      atomicWriteJson: config.atomicWriteJson,
      SOCIAL_V2_FILE: config.SOCIAL_V2_FILE,
      KNOWN_AGENT_TOKENS: config.KNOWN_AGENT_TOKENS,
      sessionPromises: sessions.sessionPromises,
      reverse: sessions.reverse,
      collectors: sessions.collectors,
      v2TurnStartAt: sessions.v2TurnStartAt,
      toolCallNames: sessions.toolCallNames,
      pendingSendToolCalls: sessions.pendingSendToolCalls,
      sendToolSucceededSessions: sessions.sendToolSucceededSessions,
      pendingWakeKeys: sessions.pendingWakeKeys,
      wakeConfigUpdatedKeys: sessions.wakeConfigUpdatedKeys,
      markReadCalledKeys: sessions.markReadCalledKeys,
      wakeConfigMissCount: sessions.wakeConfigMissCount,
      seenForwardIds: sessions.seenForwardIds,
      clearAllSocialV2Timers: social.clearAllSocialV2Timers,
      clearAllPendingWakeLeases: social.clearAllPendingWakeLeases,
      drainAllPromptQueues: social.drainAllPromptQueues,
      setupSleepTimerV2: social.setupSleepTimerV2,
      scheduleProactiveCheckV2: social.scheduleProactiveCheckV2,
      saveSocialV2State: social.saveSocialV2State
    }),
    tasks: createTaskCommands({ taskService: services.plugins?.taskService }),
    context: createContextCommands({
      config: {
        cfg: config.cfg,
        ROOT: config.ROOT,
        STATE_DIR: config.STATE_DIR,
        fs: config.fs,
        path: config.path,
        readJsonSafe: config.readJsonSafe,
        atomicWriteJson: config.atomicWriteJson,
        log: config.log,
        SLANG_STATUS: config.SLANG_STATUS,
        KNOWN_AGENT_TOKENS: config.KNOWN_AGENT_TOKENS
      },
      helpers: {
        normalizeSharedMemoryConfig: helpers.normalizeSharedMemoryConfig,
        sharedMemoryStats: helpers.sharedMemoryStats,
        forgetSharedPerson: helpers.forgetSharedPerson,
        clearSharedMemory: helpers.clearSharedMemory,
        normalizeTokenFuseConfig: helpers.normalizeTokenFuseConfig,
        normalizeTokenFuseOverride: helpers.normalizeTokenFuseOverride
      },
      sessions: {
        state: sessions.state,
        socialV2: sessions.socialV2,
        social: sessions.social,
        reverse: sessions.reverse,
        collectors: sessions.collectors,
        v2TurnStartAt: sessions.v2TurnStartAt,
        toolCallNames: sessions.toolCallNames,
        pendingSendToolCalls: sessions.pendingSendToolCalls,
        sendToolSucceededSessions: sessions.sendToolSucceededSessions,
        pendingWakeKeys: sessions.pendingWakeKeys,
        wakeConfigUpdatedKeys: sessions.wakeConfigUpdatedKeys,
        markReadCalledKeys: sessions.markReadCalledKeys,
        wakeConfigMissCount: sessions.wakeConfigMissCount,
        sessionPromises: sessions.sessionPromises,
        pending: sessions.pending,
        queued: sessions.queued,
        queuedHintAt: sessions.queuedHintAt,
        messageMediaStore: sessions.messageMediaStore,
        slangWindows: sessions.slangWindows,
        slangExtractionCooldowns: sessions.slangExtractionCooldowns,
        slangSubmitTimes: sessions.slangSubmitTimes,
        lastSentImage: sessions.lastSentImage,
        seenForwardIds: sessions.seenForwardIds,
        contextMetrics: sessions.contextMetrics,
        saveState: sessions.saveState,
        writeConversationRole: config.writeConversationRole
      },
      social: {
        cancelSocialTimers: social.cancelSocialTimers,
        clearSocialV2Timers: social.clearSocialV2Timers,
        drainPromptQueue: social.drainPromptQueue,
        saveSocialV2State: social.saveSocialV2State
      },
      context: {
        contextDir: context.contextDir,
        contextStats: context.contextStats,
        longTermStats: context.longTermStats,
        backfillLongTermMemory: context.backfillLongTermMemory,
        makeEpisodeNow: context.makeEpisodeNow,
        clearRecallIndex: context.clearRecallIndex
      },
      slang: {
        allowSlangSubmit: config.allowSlangSubmit,
        redactKnownTokensOnly: messaging.redactKnownTokensOnly,
        publicSlangEntry: context.publicSlangEntry,
        mergeEvidence: context.mergeEvidence,
        saveSlangStore: context.saveSlangStore,
        queueSlangTask: context.queueSlangTask,
        runSlangResearch: context.runSlangResearch,
        createSlangEntry: context.createSlangEntry
      },
      operations: {
        live: operations.live,
        ops: operations.ops,
        appendActivity: operations.appendActivity
      }
    }),
    ops: createOpsCommands({
      config: {
        ROOT: config.ROOT,
        STATE_DIR: config.STATE_DIR,
        ACTIVITY_LOG: config.ACTIVITY_LOG,
        KNOWN_AGENT_TOKENS: config.KNOWN_AGENT_TOKENS,
        cfg: config.cfg,
        fs: config.fs,
        path: config.path,
        log: config.log,
        unwrap: operations.unwrap
      },
      sessions: {
        state: sessions.state,
        socialV2: sessions.socialV2,
        social: sessions.social,
        reverse: sessions.reverse,
        collectors: sessions.collectors,
        sendToolSucceededSessions: sessions.sendToolSucceededSessions,
        pendingSendToolCalls: sessions.pendingSendToolCalls,
        v2TurnStartAt: sessions.v2TurnStartAt,
        toolCallNames: sessions.toolCallNames,
        pending: sessions.pending,
        queued: sessions.queued,
        queuedHintAt: sessions.queuedHintAt,
        sessionPromises: sessions.sessionPromises,
        messageMediaStore: sessions.messageMediaStore,
        slangWindows: sessions.slangWindows,
        slangExtractionCooldowns: sessions.slangExtractionCooldowns,
        slangSubmitTimes: sessions.slangSubmitTimes,
        pendingWakeKeys: sessions.pendingWakeKeys,
        wakeConfigUpdatedKeys: sessions.wakeConfigUpdatedKeys,
        markReadCalledKeys: sessions.markReadCalledKeys,
        wakeConfigMissCount: sessions.wakeConfigMissCount,
        seenForwardIds: sessions.seenForwardIds,
        saveState: sessions.saveState
      },
      social: {
        cancelSocialTimers: social.cancelSocialTimers,
        clearSocialV2Timers: social.clearSocialV2Timers,
        drainPromptQueue: social.drainPromptQueue,
        drainAllPromptQueues: social.drainAllPromptQueues,
        cancelAllSocialTimers: social.cancelAllSocialTimers,
        clearAllSocialV2Timers: social.clearAllSocialV2Timers,
        cancelPendingEntry: social.cancelPendingEntry,
        saveSocialV2State: social.saveSocialV2State
      },
      operations: {
        ops: operations.ops,
        api: config.api,
        releaseLock: operations.releaseLock
      }
    }),
    images: createImagesCommands({
      config: {
        cfg: config.cfg,
        ROOT: config.ROOT,
        STATE_DIR: config.STATE_DIR,
        STICKER_CACHE_DIR: config.STICKER_CACHE_DIR,
        MAX_MEDIA_BYTES: config.MAX_MEDIA_BYTES,
        MAX_MEDIA_PIXELS: config.MAX_MEDIA_PIXELS,
        REACTION_EMOJIS: config.REACTION_EMOJIS,
        fs: config.fs,
        path: config.path,
        crypto: config.crypto,
        sleep: config.sleep,
        log: config.log
      },
      operations: {
        live: operations.live,
        ops: operations.ops,
        appendActivity: operations.appendActivity
      },
      sessions: {
        socialV2: sessions.socialV2,
        getSocialV2State: social.getSocialV2State,
        saveSocialV2State: social.saveSocialV2State,
        lastSentImage: sessions.lastSentImage
      },
      media: {
        imageStore: media.imageStore,
        imagesEnabled: media.imagesEnabled,
        sendImageV2: media.sendImageV2,
        archiveImage: media.archiveImage,
        reverseSearcher: media.reverseSearcher,
        findMessageMediaAsync: media.findMessageMediaAsync,
        fetchMediaData: media.fetchMediaData,
        onebotSendImageFile: media.onebotSendImageFile,
        onebotSendVideoFile: media.onebotSendVideoFile,
        getStickerImageData: media.getStickerImageData,
        safeFetchBuffer: media.safeFetchBuffer,
        getImageDimensions: media.getImageDimensions,
        mimeFromBuffer: media.mimeFromBuffer,
        mimeFromUrl: media.mimeFromUrl,
        writeStickerCacheImage: media.writeStickerCacheImage,
        stickerEnabled: media.stickerEnabled,
        refreshImageLib: media.refreshImageLib
      },
      emoji: {
        emojiCatalogIds: media.emojiCatalogIds,
        emojiReactGate: media.emojiReactGate,
        setEmojiLike: media.setEmojiLike,
        validateEmojiId: media.validateEmojiId
      },
      x: { xMonitor: services.plugins?.xMonitor },
      policy: {
        modeAllowed: social.modeAllowed,
        shouldBlockSilentReply: social.shouldBlockSilentReply
      }
    }),
    stickers: createStickersCommands({
      config: {
        cfg: config.cfg,
        STATE_DIR: config.STATE_DIR,
        fs: config.fs,
        path: config.path,
        log: config.log,
        ttsNum: media.ttsNum
      },
      operations: {
        live: operations.live,
        ops: operations.ops,
        appendActivity: operations.appendActivity
      },
      sessions: {
        socialV2: sessions.socialV2,
        getSocialV2State: social.getSocialV2State,
        saveSocialV2State: social.saveSocialV2State,
        gitHubShotTimes: sessions.gitHubShotTimes
      },
      social: { scheduleReplyCheckV2: social.scheduleReplyCheckV2 },
      media: {
        stickerEnabled: media.stickerEnabled,
        applyStickerNoteV2: media.applyStickerNoteV2,
        deleteStickerV2: media.deleteStickerV2,
        setStickerRemarkV2: media.setStickerRemarkV2,
        sendStickerV2: media.sendStickerV2,
        collectStickerV2: media.collectStickerV2,
        syncStickerLibrary: media.syncStickerLibrary,
        saveStickerImage: media.saveStickerImage,
        crawlAigengtu: media.crawlAigengtu,
        crawlUrl: media.crawlUrl,
        isAigengtuUrl: media.isAigengtuUrl,
        onebotSendImageFile: media.onebotSendImageFile,
        onebotSendVoiceFile: media.onebotSendVoiceFile,
        sendToQQ: media.sendToQQ
      },
      messaging: {
        recordSentMessagesV2: messaging.recordSentMessagesV2
      },
      github: {
        parseGitHubUrl: media.parseGitHubUrl,
        extractGitHubUrl: media.extractGitHubUrl,
        screenshotGitHubRepo: media.screenshotGitHubRepo
      },
      reply: {
        isSymbolicReplyRef: messaging.isSymbolicReplyRef,
        resolveReplyTargetV2: messaging.resolveReplyTargetV2
      },
      crawl: { bot: messaging.bot },
      policy: {
        modeAllowed: social.modeAllowed,
        shouldBlockSilentReply: social.shouldBlockSilentReply,
        isOwnerTurn: messaging.isOwnerTurn
      },
      menu: {
        renderFeatureMenu: media.renderFeatureMenu,
        roleFor: config.roleFor
      }
    }),
    wait: createWaitCommands({
      config: {
        cfg: config.cfg,
        FORCE_WRAPUP_HINT: config.FORCE_WRAPUP_HINT,
        WAIT_QUIET_CAP_MS: config.WAIT_QUIET_CAP_MS,
        WAIT_TURN_MAX_COUNT: config.WAIT_TURN_MAX_COUNT,
        WAIT_TURN_MAX_MS: config.WAIT_TURN_MAX_MS,
        WAIT_WINDOW_MAX: config.WAIT_WINDOW_MAX,
        WAIT_WINDOW_MS: config.WAIT_WINDOW_MS,
        TOOL_LOG_FILE: config.TOOL_LOG_FILE,
        FEEDBACK_FILE: config.FEEDBACK_FILE,
        fs: config.fs,
        atomicWriteJson: config.atomicWriteJson,
        log: config.log,
        notifyOwnerOfError: operations.notifyOwnerOfError
      },
      sessions: { socialV2: sessions.socialV2 },
      state: {
        activeWaits: sessions.activeWaits,
        waitTurnStats: sessions.waitTurnStats,
        waitTurnTotals: sessions.waitTurnTotals,
        v2TurnStartAt: sessions.v2TurnStartAt,
        state: sessions.state,
        feedbackTimes: sessions.feedbackTimes
      },
      social: {
        getSocialV2State: social.getSocialV2State,
        saveSocialV2State: social.saveSocialV2State,
        cancelReplyCheckV2: social.cancelReplyCheckV2,
        suggestQuietMsV2: social.suggestQuietMsV2,
        preSleepWaitBlockedV2: social.preSleepWaitBlockedV2
      },
      operations: {
        looksLikeUnfinished: messaging.looksLikeUnfinished,
        sleep: config.sleep,
        appendActivity: operations.appendActivity,
        appendFeedbackEntry: operations.appendFeedbackEntry
      }
    }),
    bili: createBiliCommands({
      config: {
        cfg: config.cfg,
        ROOT: config.ROOT,
        STATE_DIR: config.STATE_DIR,
        DEFAULT_SOVITS_DIR: config.DEFAULT_SOVITS_DIR,
        fs: config.fs,
        path: config.path,
        log: config.log,
        ttsSpeechParams: media.ttsSpeechParams,
        readJsonSafe: config.readJsonSafe,
        atomicWriteJson: config.atomicWriteJson
      },
      operations: {
        live: operations.live,
        appendActivity: operations.appendActivity
      },
      sessions: {
        biliInfoCache: sessions.biliInfoCache,
        socialV2: sessions.socialV2,
        biliBrowseState: sessions.biliBrowseState
      },
      media: {
        searchVideos: media.searchVideos,
        fetchVideoInfo: media.fetchVideoInfo,
        resolveBiliId: media.resolveBiliId,
        watchVideo: media.watchVideo,
        rememberBiliInfo: media.rememberBiliInfo
      },
      social: {
        scheduleBiliBrowse: media.scheduleBiliBrowse,
        runBiliBrowse: media.runBiliBrowse
      },
      cache: {
        collectCacheItems: media.collectCacheItems,
        purgeCache: media.purgeCache,
        humanBytes: config.humanBytes
      }
    }),
    socialRead: createSocialReadCommands({
      config: { cfg: config.cfg, log: config.log },
      sessions: {
        markReadCalledKeys: sessions.markReadCalledKeys,
        wakeConfigUpdatedKeys: sessions.wakeConfigUpdatedKeys,
        wakeConfigMissCount: sessions.wakeConfigMissCount
      },
      social: {
        getSocialV2State: social.getSocialV2State,
        findCallersV2: social.findCallersV2,
        isSleepingConfigV2: social.isSleepingConfigV2,
        preSleepWaitBlockedV2: social.preSleepWaitBlockedV2,
        ensureWakeableV2: social.ensureWakeableV2,
        computeWakeSafetyV2: social.computeWakeSafetyV2,
        saveSocialV2State: social.saveSocialV2State,
        cancelReplyCheckV2: social.cancelReplyCheckV2,
        setupSleepTimerV2: social.setupSleepTimerV2,
        normalizeSpeakerIdsV2: social.normalizeSpeakerIdsV2,
        sendWakePromptV2: social.sendWakePromptV2
      },
      operations: {
        live: operations.live,
        modeAllowed: social.modeAllowed
      }
    }),
    core: createCoreCommands({
      config: {
        ROOT: config.ROOT,
        STATE_DIR: config.STATE_DIR,
        cfg: config.cfg,
        fs: config.fs,
        path: config.path,
        log: config.log,
        readJsonSafe: config.readJsonSafe,
        atomicWriteJson: config.atomicWriteJson,
        atomicWriteText: config.atomicWriteText
      },
      sessions: {
        state: sessions.state,
        socialV2: sessions.socialV2
      },
      social: {
        cleanupSocialForModeChange: social.cleanupSocialForModeChange,
        clearAllSocialV2Timers: social.clearAllSocialV2Timers,
        drainAllPromptQueues: social.drainAllPromptQueues,
        setupSleepTimerV2: social.setupSleepTimerV2,
        scheduleProactiveCheckV2: social.scheduleProactiveCheckV2
      },
      role: {
        readRoleState: config.readRoleState,
        writeRoleState: config.writeRoleState,
        writeConversationRole: config.writeConversationRole,
        sanitizeRoleName: config.sanitizeRoleName,
        roleExists: config.roleExists,
        roleFor: config.roleFor
      },
      operations: { live: operations.live }
    }),
    memory: createMemoryCommands({
      getSocialV2State: social.getSocialV2State,
      appendMemoryV2: context.appendMemoryV2,
      formatMemoryV2: context.formatMemoryV2,
      saveSocialV2State: social.saveSocialV2State,
      redactKnownTokensOnly: messaging.redactKnownTokensOnly
    }),
    access: createAccessCommands({
      config: {
        ROOT: config.ROOT,
        STATE_DIR: config.STATE_DIR,
        cfg: config.cfg,
        crypto: config.crypto,
        fs: config.fs,
        path: config.path,
        log: config.log,
        readJsonSafe: config.readJsonSafe,
        atomicWriteJson: config.atomicWriteJson,
        atomicWriteText: config.atomicWriteText
      },
      live: operations.live,
      SENSITIVE_RE: config.SENSITIVE_RE,
      allowed: sessions.allowed,
      modeAllowed: social.modeAllowed,
      normalizeOwnerQQ: social.normalizeOwnerQQ,
      normalizePrivateMode: social.normalizePrivateMode,
      refreshFriendList: operations.refreshFriendList,
      escapeCqText: messaging.escapeCqText,
      redactKnownTokensOnly: messaging.redactKnownTokensOnly,
      bot: messaging.bot,
      text: config.text,
      recordSentMessage: messaging.recordSentMessage
    }),
    agent: createAgentCommands({
      config: {
        cfg: config.cfg,
        MAX_MEDIA_BYTES: config.MAX_MEDIA_BYTES,
        SENSITIVE_RE: config.SENSITIVE_RE,
        log: config.log
      },
      operations: {
        live: operations.live,
        ops: operations.ops,
        appendActivity: operations.appendActivity
      },
      sessions: {
        socialV2: sessions.socialV2,
        imageSendTimes: sessions.imageSendTimes,
        getSocialV2State: social.getSocialV2State,
        saveSocialV2State: social.saveSocialV2State
      },
      media: {
        imageSendAllowed: media.imageSendAllowed,
        onebotSendImageFile: media.onebotSendImageFile,
        sendToQQ: messaging.sendToQQ,
        sniffImageMime: media.sniffImageMime,
        sendMessagesV2: messaging.sendMessagesV2
      },
      messaging: {
        recordSentMessagesV2: messaging.recordSentMessagesV2,
        stripLeadingMetaMarker: messaging.stripLeadingMetaMarker,
        unquoteJsonString: messaging.unquoteJsonString,
        isSymbolicReplyRef: messaging.isSymbolicReplyRef,
        resolveReplyTargetV2: messaging.resolveReplyTargetV2
      },
      social: {
        scheduleReplyCheckV2: social.scheduleReplyCheckV2,
        shouldBlockSilentReply: social.shouldBlockSilentReply,
        modeAllowed: social.modeAllowed
      }
    }),
    messaging: createMessagingCommands({
      config: { cfg: config.cfg, SENSITIVE_RE: config.SENSITIVE_RE, log: config.log },
      operations: {
        live: operations.live,
        ops: operations.ops,
        appendActivity: operations.appendActivity
      },
      sessions: {
        socialV2: sessions.socialV2,
        getSocialV2State: social.getSocialV2State,
        saveSocialV2State: social.saveSocialV2State
      },
      social: {
        computeGapsV2: social.computeGapsV2,
        scheduleReplyCheckV2: social.scheduleReplyCheckV2,
        shouldBlockSilentReply: social.shouldBlockSilentReply,
        modeAllowed: social.modeAllowed
      },
      messaging: {
        normalizeMessagesInput: messaging.normalizeMessagesInput,
        stripLeadingMetaMarkers: messaging.stripLeadingMetaMarkers,
        sendMessagesV2: messaging.sendMessagesV2,
        recordSentMessagesV2: messaging.recordSentMessagesV2,
        findCjkSpaceWarning: messaging.findCjkSpaceWarning,
        findSplitBoundaryWarning: messaging.findSplitBoundaryWarning,
        resolveReplyTargetV2: messaging.resolveReplyTargetV2,
        isSymbolicReplyRef: messaging.isSymbolicReplyRef,
        resolvePokeTarget: messaging.resolvePokeTarget,
        isSymbolicPokeRef: messaging.isSymbolicPokeRef,
        resolveGroupMemberName: messaging.resolveGroupMemberName,
        bot: messaging.bot
      }
    }),
    socialV1: createSocialV1Commands({
      config: {
        ROOT: config.ROOT,
        cfg: config.cfg,
        fs: config.fs,
        path: config.path,
        log: config.log,
        readJsonSafe: config.readJsonSafe,
        atomicWriteJson: config.atomicWriteJson,
        roleFor: config.roleFor
      },
      operations: {
        live: operations.live,
        appendActivity: operations.appendActivity,
        deliverPrompt: social.deliverPrompt,
        ensureSession: social.ensureSession
      },
      sessions: {
        socialV2: sessions.socialV2,
        state: sessions.state,
        allowed: sessions.allowed,
        social: sessions.social
      },
      social: {
        enterActive: social.enterActive,
        leaveActive: social.leaveActive,
        flushSummaries: social.flushSummaries,
        getSocialV2State: social.getSocialV2State,
        modeAllowed: social.modeAllowed
      }
    }),
    slang: createSlangCommands({
      live: operations.live,
      cfg: config.cfg,
      SLANG_STATUS: config.SLANG_STATUS,
      createSlangEntry: context.createSlangEntry,
      saveSlangStore: context.saveSlangStore,
      log: config.log,
      slangWindows: sessions.slangWindows,
      slangExtractionCooldowns: sessions.slangExtractionCooldowns,
      slangSubmitTimes: sessions.slangSubmitTimes,
      slangResearchingIds: sessions.slangResearchingIds,
      queueSlangTask: context.queueSlangTask,
      runSlangExtraction: context.runSlangExtraction,
      runSlangResearch: context.runSlangResearch,
      invalidateSlangLearnerSession: context.invalidateSlangLearnerSession,
      ROOT: config.ROOT,
      path: config.path,
      readJsonSafe: config.readJsonSafe,
      atomicWriteJson: config.atomicWriteJson,
      isAvailable: () => !!services.plugins?.pluginHost?.capabilities?.get('slang.instance')
    }),
    config: createConfigCommands({
      config: {
        CREDENTIAL_ITEMS: config.CREDENTIAL_ITEMS,
        ROOT: config.ROOT,
        STATE_DIR: config.STATE_DIR,
        TOOL_FLAGS: config.TOOL_FLAGS,
        DEFAULT_AUTO_AT: config.DEFAULT_AUTO_AT,
        DEFAULT_ERROR_MESSAGES: config.DEFAULT_ERROR_MESSAGES,
        TTS_DEFAULT_PROBABILITY: config.TTS_DEFAULT_PROBABILITY,
        cfg: config.cfg,
        log: config.log,
        maskValue: config.maskValue,
        path: config.path,
        readJsonSafe: config.readJsonSafe,
        atomicWriteJson: config.atomicWriteJson
      },
      helpers: { normalizeGapNoticeConfig: helpers.normalizeGapNoticeConfig },
      reverseSearcher: media.reverseSearcher,
      applyPixivAuth: config.applyPixivAuth,
      refreshAllDefaultWakeConfigsV2: social.refreshAllDefaultWakeConfigsV2
    }),
    plugins: createPluginCommands({
      root: config.ROOT,
      cfg: config.cfg,
      pluginHost: services.plugins?.pluginHost,
      fs: config.fs,
      path: config.path,
      log: config.log,
      maskValue: config.maskValue
    })
  };

  return { readModels, commands };
}
