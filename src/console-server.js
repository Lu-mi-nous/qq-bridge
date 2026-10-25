// 本地控制台与 MCP 回调 HTTP 服务。依赖由 bridge.js 显式注入，动态状态经 live 访问。
import {
  normalizeSharedMemoryConfig,
  sharedMemoryStats,
  listSharedPeople,
  forgetSharedPerson,
  clearSharedMemory
} from './shared-memory.js';
import { normalizeTokenFuseConfig, normalizeTokenFuseOverride, effectiveTokenFuseThresholds } from './token-fuse.js';
import { normalizeGapNoticeConfig } from './session-gap.js';

export const AGENT_ALLOWED_PATHS = new Set([
  '/api/authorize/read',
  '/api/images/message',
  '/api/send/group',
  '/api/send/private',
  '/api/send/reply',
  '/api/socialV2/active-members',
  '/api/socialV2/archive-image',
  '/api/socialV2/bili-memory',
  '/api/socialV2/bili-record',
  '/api/socialV2/bili-search',
  '/api/socialV2/bili-watch',
  '/api/socialV2/collect-sticker',
  '/api/socialV2/crawl',
  '/api/socialV2/feedback',
  '/api/socialV2/fetch-x-posts',
  '/api/socialV2/forward-media',
  '/api/socialV2/forward-message',
  '/api/socialV2/github-shot',
  '/api/socialV2/group-file-stats',
  '/api/socialV2/group-files',
  '/api/socialV2/image-preflight',
  '/api/socialV2/image-source',
  '/api/socialV2/mark-read',
  '/api/socialV2/memory',
  '/api/socialV2/memory-append',
  '/api/socialV2/memory-clear',
  '/api/socialV2/memory-remove',
  '/api/socialV2/message-detail',
  '/api/socialV2/my-recent',
  '/api/socialV2/prompt',
  '/api/socialV2/react-message',
  '/api/socialV2/recall',
  '/api/socialV2/recent',
  '/api/socialV2/refresh-image-lib',
  '/api/socialV2/reject-image',
  '/api/socialV2/reverse-search',
  '/api/socialV2/self-image',
  '/api/socialV2/send-burst',
  '/api/socialV2/send-feature-menu',
  '/api/socialV2/send-image',
  '/api/socialV2/send-message',
  '/api/socialV2/send-poke',
  '/api/socialV2/send-sticker',
  '/api/socialV2/send-upscaled',
  '/api/socialV2/send-voice',
  '/api/socialV2/slang/query',
  '/api/socialV2/slang/submit',
  '/api/socialV2/state',
  '/api/socialV2/sticker-delete',
  '/api/socialV2/sticker-image',
  '/api/socialV2/sticker-list',
  '/api/socialV2/sticker-note',
  '/api/socialV2/sticker-remark',
  '/api/socialV2/token-report',
  '/api/socialV2/unread',
  '/api/socialV2/wait',
  '/api/socialV2/wake-config',
  '/api/status'
]);

export function isAgentRouteAllowed(pathname, method = 'GET') {
  if (pathname === '/api/socialV2/feedback' && method === 'GET') return false;
  return AGENT_ALLOWED_PATHS.has(pathname);
}

// 把 token-usage.json 的 sessionId 桶合成为「按 QQ 会话」的两套口径：
//   当前会话 = 映射里的 sessionId 对应的桶；累计 = 该 key 名下全部历史桶 + 摘要器桶。
// 轮换后旧 sessionId 的消耗不会从累计里消失，这是会话级统计的核心需求。
export function buildSessionUsageRows({ usage = {}, currentSessions = {}, displayName = () => '', today = '', scopeDay = '' } = {}) {
  const finish = (v = {}) => {
    const input = Number(v.input) || 0;
    const cacheRead = Number(v.cacheRead) || 0;
    const output = Number(v.output) || 0;
    const totalInput = input + cacheRead;
    return {
      input, cacheRead, output,
      reasoning: Number(v.reasoning) || 0,
      calls: Number(v.calls) || 0,
      totalInput,
      totalTokens: totalInput + output,
      cacheHitRate: totalInput > 0 ? Math.round((cacheRead / totalInput) * 1000) / 10 : 0
    };
  };
  const addInto = (target, source) => {
    target.input += Number(source?.input) || 0;
    target.cacheRead += Number(source?.cacheRead) || 0;
    target.output += Number(source?.output) || 0;
    target.reasoning += Number(source?.reasoning) || 0;
    target.calls += Number(source?.calls) || 0;
  };
  // 按日审阅：scopeDay 非空时，会话表的「当前 / 累计 / 摘要器」都只取那一天；
  // today 仍固定为真实今天（24 号卡的列不受日期下拉影响）。
  const scopeOf = (bucket) => (scopeDay ? (bucket?.days?.[scopeDay] || {}) : bucket);
  const rows = new Map();
  const unowned = [];
  const ensureRow = (key) => {
    let row = rows.get(key);
    if (!row) {
      row = {
        key,
        displayName: displayName(key) || key,
        sessionIds: [],
        current: finish({}),
        cumulative: { input: 0, cacheRead: 0, output: 0, reasoning: 0, calls: 0 },
        summarizer: { input: 0, cacheRead: 0, output: 0, calls: 0 },
        today: { input: 0, cacheRead: 0, output: 0, calls: 0 },
        firstAt: 0,
        lastAt: 0
      };
      rows.set(key, row);
    }
    return row;
  };
  for (const [sessionId, bucket] of Object.entries(usage.sessions || {})) {
    const key = String(bucket?.key || '');
    if (!key) {
      unowned.push({
        sessionId,
        key: null,
        ...finish(scopeOf(bucket)),
        firstAt: Number(bucket?.firstAt) || 0,
        lastAt: Number(bucket?.lastAt) || 0
      });
      continue;
    }
    const row = ensureRow(key);
    row.sessionIds.push(sessionId);
    addInto(row.cumulative, scopeOf(bucket));
    const firstAt = Number(bucket?.firstAt) || 0;
    const lastAt = Number(bucket?.lastAt) || 0;
    if (firstAt && (!row.firstAt || firstAt < row.firstAt)) row.firstAt = firstAt;
    if (lastAt > row.lastAt) row.lastAt = lastAt;
    if (String(currentSessions[key] || '') === sessionId) row.current = finish(scopeOf(bucket));
    const d = today ? bucket?.days?.[today] : null;
    if (d) {
      row.today.input += Number(d.input) || 0;
      row.today.cacheRead += Number(d.cacheRead) || 0;
      row.today.output += Number(d.output) || 0;
      row.today.calls += Number(d.calls) || 0;
    }
  }
  for (const [key, bucket] of Object.entries(usage.summarizer || {})) {
    if (!/^(group|private):\d+$/.test(key)) continue;
    const row = ensureRow(key);
    const scoped = scopeDay ? (bucket?.days?.[scopeDay] || {}) : bucket;
    row.summarizer.input += Number(scoped?.input) || 0;
    row.summarizer.output += Number(scoped?.output) || 0;
    row.summarizer.cacheRead += Number(scoped?.cacheRead) || 0;
    row.summarizer.calls += Number(scoped?.calls) || 0;
    addInto(row.cumulative, scoped);
    const d = today ? bucket?.days?.[today] : null;
    if (d) {
      row.today.input += Number(d.input) || 0;
      row.today.cacheRead += Number(d.cacheRead) || 0;
      row.today.output += Number(d.output) || 0;
      row.today.calls += Number(d.calls) || 0;
    }
  }
  const list = [...rows.values()].map((row) => ({
    ...row,
    sessionCount: row.sessionIds.length,
    currentSessionId: String(currentSessions[row.key] || ''),
    cumulative: finish(row.cumulative),
    today: {
      ...row.today,
      totalInput: row.today.input + row.today.cacheRead,
      totalTokens: row.today.input + row.today.cacheRead + row.today.output
    }
  }));
  list.sort((a, b) => b.cumulative.totalInput - a.cumulative.totalInput);
  unowned.sort((a, b) => b.totalInput - a.totalInput);
  return { rows: list, unowned, scopeDay: scopeDay || 'all' };
}

export function createConsoleServer(deps) {
  const {
    ACTIVITY_LOG,
    CACHE_GROUPS,
    CREDENTIAL_ITEMS,
    DEFAULT_AUTO_AT,
    DEFAULT_ERROR_MESSAGES,
    DEFAULT_SOVITS_DIR,
    FEEDBACK_FILE,
    FORCE_WRAPUP_HINT,
    KNOWN_AGENT_TOKENS,
    MAX_MEDIA_BYTES,
    MAX_MEDIA_PIXELS,
    REACTION_EMOJIS,
    ROOT,
    SENSITIVE_RE,
    SLANG_STATUS,
    SOCIAL_V2_FILE,
    STATE_DIR,
    STICKER_CACHE_DIR,
    TOOL_FLAGS,
    TOOL_LOG_FILE,
    TTS_DEFAULT_PROBABILITY,
    WAIT_QUIET_CAP_MS,
    WAIT_TURN_MAX_COUNT,
    WAIT_TURN_MAX_MS,
    WAIT_WINDOW_MAX,
    WAIT_WINDOW_MS,
    activeWaits,
    allowSlangSubmit,
    allowed,
    api,
    appendActivity,
    appendFeedbackEntry,
    appendMemoryV2,
    applyPixivAuth,
    applyStickerNoteV2,
    archiveImage,
    atomicWriteJson,
    atomicWriteText,
    backfillLongTermMemory,
    biliBrowseState,
    biliInfoCache,
    bot,
    buildSlangContext,
    buildStickerContext,
    buildStickerStrategyHint,
    buildTokenReport,
    cancelAllSocialTimers,
    cancelPendingEntry,
    cancelReplyCheckV2,
    cancelSocialTimers,
    canonicalV2Key,
    cfg,
    cleanupSocialForModeChange,
    clearAllPendingWakeLeases,
    clearAllSocialV2Timers,
    clearSocialV2Timers,
    collectCacheItems,
    collectStickerV2,
    collectors,
    computeGapsV2,
    computeWakeSafetyV2,
    confirmedSlangListV2,
    contextCfg,
    contextDir,
    contextDisplayName,
    contextMetrics,
    contextStats,
    journalCoverage,
    readRecallAudit,
    recallAuditStats,
    readBacklogHistory,
    clearRecallIndex,
    countContextPendingV2,
    crawlAigengtu,
    crawlUrl,
    createSlangEntry,
    crypto,
    currentRoleHint,
    currentRoleHintV2,
    deleteStickerV2,
    deliverPrompt,
    drainAllPromptQueues,
    drainPromptQueue,
    emojiCatalogIds,
    emojiReactGate,
    ensureSession,
    ensureWakeableV2,
    enterActive,
    escapeCqText,
    extractGitHubUrl,
    feedbackTimes,
    fetchMediaData,
    fetchVideoInfo,
    findCallersV2,
    findCjkSpaceWarning,
    findMessageMediaAsync,
    findSplitBoundaryWarning,
    flushSummaries,
    formatForwardResponse,
    formatMemoryV2,
    formatParticipationV2,
    formatStickerList,
    formatSummary,
    fs,
    getImageDimensions,
    getRecallIndexV2,
    getSocialV2State,
    getStickerImageData,
    gitHubShotTimes,
    groupActivityScore,
    groupedToolFlags,
    http,
    humanBytes,
    humanSize,
    imagePreflightV2,
    imageSendAllowed,
    imageSendTimes,
    imageStore,
    imagesEnabled,
    invalidateSlangLearnerSession,
    isAigengtuUrl,
    isConversationBusyV2,
    isOwnerTurn,
    isSessionAllowedInCurrentMode,
    isSleepingConfigV2,
    isSymbolicPokeRef,
    isSymbolicReplyRef,
    joinQueue,
    journalStats,
    lastSentImage,
    leaveActive,
    listRoles,
    loadEpisodes,
    loadLongTermMemory,
    loadOrCreateConsoleToken,
    loadTokenUsage,
    log,
    longTermStats,
    looksLikeUnfinished,
    makeEpisodeNow,
    markReadCalledKeys,
    maskValue,
    mergeEvidence,
    messageMediaStore,
    mimeFromBuffer,
    mimeFromUrl,
    modeAllowed,
    normalizeMessagesInput,
    normalizeOwnerQQ,
    normalizePrivateMode,
    normalizeSourceFilter,
    normalizeSpeakerIdsV2,
    notifyOwnerOfError,
    onebotSendImageFile,
    onebotSendVideoFile,
    onebotSendVoiceFile,
    parseGitHubUrl,
    path,
    pending,
    pendingSendToolCalls,
    pendingWakeKeys,
    preSleepWaitBlockedV2,
    promptQueues,
    pruneTokenReportCache,
    publicSlangEntry,
    purgeCache,
    queueSlangTask,
    queued,
    queuedHintAt,
    readActivityTail,
    readConversationRoles,
    readFeedbackEntries,
    readJsonSafe,
    readRoleState,
    readToolLog,
    recordSentMessage,
    recordSentMessagesV2,
    redactKnownTokensOnly,
    refreshAllDefaultWakeConfigsV2,
    refreshContextNames,
    refreshFriendList,
    refreshImageLib,
    refreshTokenUsage,
    releaseLock,
    rememberBiliInfo,
    renderFeatureMenu,
    renderTokenReport,
    resolveBiliId,
    resolveGroupMemberName,
    resolvePokeTarget,
    resolveReplyInfo,
    resolveReplyTargetV2,
    reverse,
    reverseSearcher,
    roleExists,
    roleFor,
    runBiliBrowse,
    runSlangExtraction,
    runSlangResearch,
    safeFetchBuffer,
    sanitizeRoleName,
    saveSlangStore,
    saveSocialV2State,
    saveState,
    saveStickerImage,
    scheduleBiliBrowse,
    scheduleProactiveCheckV2,
    scheduleReplyCheckV2,
    screenshotGitHubRepo,
    searchGroupFiles,
    searchMemory,
    searchVideos,
    seenForwardIds,
    sendImageV2,
    sendMessagesV2,
    sendStickerV2,
    sendToQQ,
    sendToolSucceededSessions,
    sendWakePromptV2,
    sessionFileBytes,
    sessionPromises,
    setEmojiLike,
    setStickerRemarkV2,
    setupSleepTimerV2,
    shouldBlockSilentReply,
    slangExtractionCooldowns,
    slangResearchingIds,
    slangSubmitTimes,
    slangWindows,
    sleep,
    sniffImageMime,
    social,
    socialV2,
    sourcePageOf,
    state,
    stickerCacheOpts,
    stickerEnabled,
    stripLeadingMetaMarker,
    stripLeadingMetaMarkers,
    suggestQuietMsV2,
    summarizeCache,
    summarizeGroupFiles,
    summarizeTokenReport,
    syncStickerLibrary,
    text,
    toolCallNames,
    toolNamesOf,
    ttsNum,
    ttsSpeechParams,
    unquoteJsonString,
    unwrap,
    v2TurnStartAt,
    validateEmojiId,
    waitTurnStats,
    waitTurnTotals,
    wakeConfigMissCount,
    wakeConfigUpdatedKeys,
    watchVideo,
    writeConversationRole,
    writeRoleState,
    writeStickerCacheImage,
    xMonitor
  } = deps;

    const port = cfg.consolePort ?? 3100;
    // 控制台鉴权：
    //   - `consoleAuth: false` → **不要求令牌**（用户要求：每次刷新都要填太麻烦）。
    //   - 否则：优先用 config.consoleToken，未配置则自动生成并持久化到 state/console-token。
    //
    // 为什么每次刷新都会问：浏览器直接访问 `/` 是普通导航，**没法带自定义请求头**，
    // 所以即便 localStorage 里存着令牌，根路径那一步仍然 401 → 弹 prompt；
    // `?token=` 进来的那次会被前端 replaceState 从地址栏抹掉，于是下次刷新又丢。
    // 关掉鉴权就绕过了这个死循环。
    //
    // 关闭后仍保留两道防线（见下方 CSRF 段）：
    //   ① 只监听 127.0.0.1（外网/局域网访问不到）；
    //   ② 写操作必须是 application/json 且 Origin 为本机页面——
    //      这能挡住「别的网页用表单/图片/跨站 fetch 打 /api/restart 这类破坏性接口」。
    const authDisabled = cfg.consoleAuth === false;
    const configuredToken = String(cfg.consoleToken ?? '').trim();
    const tokenValid = configuredToken.length >= 16 && configuredToken.length <= 128 && /^[A-Za-z0-9_-]+$/.test(configuredToken);
    let consoleToken = authDisabled ? '' : (tokenValid ? configuredToken : loadOrCreateConsoleToken());
    if (authDisabled) log('控制台鉴权已关闭（config.consoleAuth=false）：不校验令牌，仅监听 127.0.0.1 + 写操作校验 Origin');
    else if (!tokenValid && configuredToken) log(`控制台 config.consoleToken 长度/字符不合法，已忽略并回退到自动生成令牌`);
    else if (!configuredToken) log(`控制台未配置 consoleToken，已自动生成：${String(consoleToken).slice(0, 6)}…（完整值保存在 state/console-token）`);
    // 二代会话级隔离：MCP 工具调用时若带 x-agent-token，则必须匹配该会话的 agentToken。
    // 控制台/管理端请求不带此头，仍走 consoleToken 管理通道。
    const agentTokenOk = (key, token) => {
      const canonical = canonicalV2Key(key);
      const st = socialV2.conversations.get(canonical ?? key);
      return !!st && !!st.agentToken && token === st.agentToken;
    };
    // 二代会话工具必须仍命中当前模式的白名单/准入；避免白名单移除后旧 agentToken 继续读状态。
    const v2SessionAllowed = isSessionAllowedInCurrentMode;
    const v2ToolEnabled = (flag) => cfg.socialV2?.tools?.[flag] !== false;
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      const SECURITY_HEADERS = {
        'X-Frame-Options': 'DENY',
        // img-src / media-src / connect-src 需要单独放行 blob:。
        //
        // 为什么（两次都踩到，症状都极隐蔽）：
        //   ① 2026-10-21「生成报表图」：fetch → Blob → createObjectURL → <img>。
        //      `default-src 'self'` 不含 blob:，图被静默拦掉——
        //      img 在、complete 为 true、naturalWidth 却是 0，页面只剩 alt 文字。
        //   ② 2026-10-22「试听一句」：<audio src=blob:...> 同理。
        //      media-src 没放行 → 播放器空白；页面内 fetch(blob:) 也失败
        //      （TypeError: Failed to fetch），因为 connect-src 也没放行。
        //      表面看是"按钮点了没反应"，实际是 CSP 静默拦截。
        // 只放开这三类（分别是图片、音视频、同页 fetch），script-src 仍限 self。
        'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; "
          + "style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; "
          + "media-src 'self' blob: data:; connect-src 'self' blob: data:",
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer'
      };
      const sendJson = (obj, status = 200) => {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...SECURITY_HEADERS });
        res.end(JSON.stringify(obj, null, 2));
      };
      // 请求体读取。默认上限 1MB（控制台/配置类请求都远小于此，
      // 收得紧一些可以挡掉恶意大包），个别需要传图片的路由可以显式放宽。
      //
      // 为什么要能放宽（2026-10-19）：超分回传要 POST 一张 base64 图片，
      // 800×652 的 PNG 就 600KB、编码后 800KB，稍微大一点就撞 413。
      // 但**不放宽全局**——只有白名单里的路由能申请大上限，其余仍受 1MB 约束。
      //
      // 注意这里管的是**第一跳**（MCP → 桥接），不是发到 QQ 的那一跳：
      //   链路是 MCP --base64--> 桥接(:3100) --base64--> OneBot(:3000) --> QQ
      //   第一跳放宽到 8MB 只是让请求进得来；第二跳受 OneBot 自身限制（实测 base64
      //   超过约 2MB 就直接 ECONNRESET，且不返回错误码），那个改不了，只能靠
      //   MCP 侧提前压到 1.3MB 原始字节（≈1.73MB base64）。两者是**并存**的，
      //   不是二选一：只放宽第一跳，图会在第二跳静默失败（实测 6.8MB base64：
      //   第一跳 500「发送失败: fetch failed」= 它成功收到了大图、但转发时被 OneBot 拒绝）。
      const BIG_BODY_ROUTES = new Set(['/api/socialV2/send-upscaled']);
      const readBody = (options = {}) => new Promise((resolve, reject) => {
        // 路由级上限：只允许白名单路由申请，且不得超过 8MB（够放 3~4MB 图片的 base64）。
        const routeWantsBig = BIG_BODY_ROUTES.has(String(options.route ?? ''));
        const MAX_BODY_BYTES = routeWantsBig
          ? Math.min(8_000_000, Number(options.maxBytes) || 8_000_000)
          : 1_000_000;
        const chunks = [];
        let total = 0;
        let settled = false;
        let bodyTimer = null;
        const fail = (status, message) => {
          if (settled) return;
          settled = true;
          if (bodyTimer) clearTimeout(bodyTimer);
          const err = new Error(message);
          err.statusCode = status;
          reject(err);
        };
        const done = (val) => {
          if (settled) return;
          settled = true;
          if (bodyTimer) clearTimeout(bodyTimer);
          resolve(val);
        };
        // 提前按 Content-Length 拒绝超限请求体
        const declared = Number(req.headers['content-length']);
        if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
          fail(413, '请求体过大（超过 1MB）');
          return;
        }
        bodyTimer = setTimeout(() => fail(400, '请求体读取超时'), 30000);
        req.on('data', (c) => {
          if (settled) return;
          const buf = Buffer.isBuffer(c) ? c : Buffer.from(c);
          total += buf.length;
          if (total > MAX_BODY_BYTES) {
            req.pause();
            fail(413, '请求体过大（超过 1MB）');
            return;
          }
          chunks.push(buf);
        });
        req.on('end', () => {
          if (settled) return;
          const data = Buffer.concat(chunks).toString('utf8');
          if (!data.trim()) { done({}); return; }
          let parsed;
          try { parsed = JSON.parse(data); } catch { fail(400, '请求体必须是合法 JSON'); return; }
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            fail(400, '请求体必须是 JSON 对象');
            return;
          }
          done(parsed);
        });
        // 请求体超限/连接异常时也要结束等待，避免 handler 悬挂
        req.on('error', () => fail(400, '请求体读取失败'));
        req.on('aborted', () => fail(400, '请求体读取中断'));
      });
      // 控制台鉴权：所有请求需带 x-console-token 或 ?token=
      // 注意：MCP 工具（AI 侧）调用时**同时**带 x-console-token 和 x-agent-token
      // （见 mcp-snowluma-safe.js 的 agentApi：它会读 state/console-token 补上），
      // 所以这里不需要为 agent 调用开豁免——曾误加过一个 AGENT_CALLABLE 白名单，
      // 既多余（请求本来就带 console token）又危险（会绕开控制台令牌）。
      const suppliedToken = url.searchParams.get('token') ?? req.headers['x-console-token'];
      if (consoleToken && suppliedToken !== consoleToken) {
        if (req.method === 'GET' && url.pathname === '/') {
          res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', ...SECURITY_HEADERS });
          res.end('<!doctype html><meta charset="utf-8"><title>需要令牌</title><script>const t=prompt(\'请输入控制台访问令牌\');if(t)location.href=\'/?token=\'+encodeURIComponent(t);</script>');
        } else {
          sendJson({ ok: false, error: '未授权：请提供控制台访问令牌' }, 401);
        }
        return;
      }
      // CSRF 防护：所有写操作必须是 application/json，且（若带 Origin）必须来自本机页面。
      // 默认未配 consoleToken 时，这可阻止任意网页用表单/跨站请求触发
      // /api/restart、/api/workspace/reset、/api/role 等破坏性接口。
      if (req.method !== 'GET') {
        const ctype = String(req.headers['content-type'] ?? '');
        if (!ctype.toLowerCase().includes('application/json')) {
          sendJson({ ok: false, error: '请求必须是 application/json' }, 415);
          return;
        }
        const origin = req.headers['origin'];
        if (origin) {
          let originHost = '';
          try { originHost = new URL(String(origin)).host; } catch {}
          if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(originHost)) {
            sendJson({ ok: false, error: '跨站请求被拒绝' }, 403);
            return;
          }
        }
      }
      try {
        // 空 agent token 一律拒绝，防止 MCP 传入空字符串时被当作“管理端/无 token”绕过校验
        if (req.headers['x-agent-token'] === '') {
          sendJson({ ok: false, error: 'agent token 不能为空' }, 403);
          return;
        }
        // 暂停二代 AI 时，所有带 agent token 的 v2 工具调用一律拒绝
        if (socialV2.paused && req.headers['x-agent-token'] && (url.pathname.startsWith('/api/socialV2/') || url.pathname.startsWith('/api/send/') || url.pathname.startsWith('/api/images/'))) {
          sendJson({ ok: false, error: 'AI 已暂停，当前不允许执行 v2 工具' }, 403);
          return;
        }
        // 二代模式总开关：关闭后 agent token 调用的 v2 工具全部拒绝（控制台仍可管理）
        if (cfg.socialV2?.enabled === false && req.headers['x-agent-token'] && (url.pathname.startsWith('/api/socialV2/') || url.pathname.startsWith('/api/send/') || url.pathname.startsWith('/api/images/'))) {
          sendJson({ ok: false, error: '二代模式已关闭，当前不允许执行 v2 工具' }, 403);
          return;
        }
        // 模式隔离：带 agent token 的 v2 接口只允许在 reserved2 模式下使用
        if (req.headers['x-agent-token'] && url.pathname.startsWith('/api/socialV2/') && deps.live.currentMode !== 'reserved2') {
          sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403);
          return;
        }
        // Agent 默认拒绝，只允许 MCP 实际需要的显式路由；新增工具必须同步加入允许清单。
        if (req.headers['x-agent-token'] && !isAgentRouteAllowed(url.pathname, req.method)) {
          sendJson({ ok: false, error: '该接口仅控制台可用' }, 403);
          return;
        }
        if (req.method === 'GET' && url.pathname === '/') {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...SECURITY_HEADERS });
          try {
            res.end(fs.readFileSync(path.join(ROOT, 'public', 'console.html'), 'utf8'));
          } catch {
            res.end('控制台页面缺失：qq-bridge/public/console.html');
          }
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/status') {
          const rs = readRoleState();
          sendJson({
            mode: deps.live.currentMode,
            closedAgentPreset: deps.live.closedAgentPreset,
            role: rs.role ?? null,
            roleMode: rs.mode ?? 'active',
            dshReady: deps.live.dshReady,
            ownerQQ: cfg.ownerQQ ?? null,
            allowGroups: cfg.allow?.groups ?? [],
            allowPrivate: cfg.allow?.private ?? [],
            // 私聊准入策略与好友数：控制台状态栏按它显示"好友自动放行/纯黑名单/白名单"
            privateMode: cfg.allow?.privateMode ?? 'list',
            friendCount: deps.live.friendIds.size,
            socialV2Paused: socialV2.paused,
            activity: readActivityTail(100)
          });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/presets') {
          let presets = [];
          try {
            const { presets: list } = unwrap(await api.agentPresets.list({}), 'agentPreset.list');
            presets = list.map((p) => ({ id: p.id, trust: p.trust ?? 'system' }));
          } catch {}
          sendJson({ presets });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/mode') {
          const body = await readBody();
          if (!['chat', 'closed-agent', 'reserved', 'reserved2'].includes(body.mode)) {
            sendJson({ ok: false, error: 'mode 必须是 chat / closed-agent / reserved / reserved2' }, 400);
            return;
          }
          const existing = readJsonSafe(path.join(STATE_DIR, 'mode.json'), {});
          const next = {
            mode: body.mode,
            ...(body.closedAgentPreset ? { closedAgentPreset: String(body.closedAgentPreset) } : { closedAgentPreset: existing.closedAgentPreset ?? 'router-standard' })
          };
          atomicWriteJson(path.join(STATE_DIR, 'mode.json'), next);
          if (next.closedAgentPreset) deps.live.closedAgentPreset = next.closedAgentPreset;
          if (deps.live.currentMode === 'reserved' && body.mode !== 'reserved') {
            cleanupSocialForModeChange();
            log('控制台：模式离开一代仿真模式，清理社交状态');
          }
          if (deps.live.currentMode === 'reserved2' && body.mode !== 'reserved2') {
            clearAllSocialV2Timers();
            drainAllPromptQueues('模式切换，已取消排队中的投递');
            log('控制台：模式离开二代仿真模式，清理 reserved2 定时器与排队投递');
          }
          deps.live.currentMode = body.mode;
          deps.live.lastMode = body.mode;
          if (body.mode === 'reserved2') {
            for (const key of socialV2.conversations.keys()) {
              setupSleepTimerV2(key);
              scheduleProactiveCheckV2(key);
            }
            log('控制台：模式进入二代仿真模式，重建有限睡眠定时器');
          }
          log(`控制台：模式已设置为 ${body.mode}${next.closedAgentPreset ? `（closed-agent preset: ${next.closedAgentPreset}）` : ''}`);
          sendJson({ ok: true, mode: body.mode, closedAgentPreset: next.closedAgentPreset });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/role') {
          const body = await readBody();
          const rs = readRoleState();
          const targetKey = String(body.key ?? '').trim();
          // 带 key = 设置某个群/私聊的 override；不带 key = 设置全局默认（兼容旧调用）。
          if (targetKey) {
            if (!/^(group|private):\d+$/.test(targetKey)) {
              sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400);
              return;
            }
            if (body.role && typeof body.role === 'string') {
              const name = sanitizeRoleName(body.role);
              if (!roleExists(name)) {
                sendJson({ ok: false, error: `角色「${name}」不存在（roles/${name}.md）` }, 400);
                return;
              }
              writeConversationRole(targetKey, name);
              log(`控制台：${targetKey} 人格已设置为 ${name}`);
              sendJson({ ok: true, key: targetKey, role: name, effectiveRole: roleFor(targetKey) });
            } else {
              writeConversationRole(targetKey, null);
              log(`控制台：${targetKey} 人格已清除（回退默认）`);
              sendJson({ ok: true, key: targetKey, role: null, effectiveRole: roleFor(targetKey) });
            }
            return;
          }
          if (body.role && typeof body.role === 'string') {
            const name = sanitizeRoleName(body.role);
            if (!roleExists(name)) {
              sendJson({ ok: false, error: `角色「${name}」不存在（roles/${name}.md）` }, 400);
              return;
            }
            writeRoleState(name, rs.mode);
            log(`控制台：默认角色已设置为 ${name}`);
            sendJson({ ok: true, role: name, defaultRole: name });
          } else {
            writeRoleState(null, rs.mode);
            log('控制台：默认角色已清除');
            sendJson({ ok: true, role: null, defaultRole: null });
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/role-mode') {
          const body = await readBody();
          const rs = readRoleState();
          const mode = body.mode === 'silent' ? 'silent' : 'active';
          writeRoleState(rs.role, mode);
          log(`控制台：静默模式 ${mode === 'silent' ? '开启' : '关闭'}`);
          sendJson({ ok: true, roleMode: mode });
          return;
        }
        // ── 人格管理 ──────────────────────────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/roles') {
          const rs = readRoleState();
          sendJson({ roles: listRoles(), current: rs.role ?? null, defaultRole: rs.role ?? null, overrides: readConversationRoles() });
          return;
        }
        // 控制台「人格」卡片：默认角色 + 每个群的独立人格配置。
        if (req.method === 'GET' && url.pathname === '/api/role-assignments') {
          // 首屏群名缓存可能还没建好：强制拉一次，避免人格卡里全是空群名。之后走 5 分钟缓存。
          try { await refreshContextNames(!deps.live.contextNameCache.at || deps.live.contextNameCache.groups.size === 0); } catch {}
          const rs = readRoleState();
          const overrides = readConversationRoles();
          const keys = new Set();
          for (const gid of (Array.isArray(cfg.allow?.groups) ? cfg.allow.groups : [])) keys.add(`group:${String(gid)}`);
          // 机器人当前所在的群即使还没进白名单/还没会话，也应能单独配人格。
          for (const gid of deps.live.contextNameCache.groups.keys()) keys.add(`group:${String(gid)}`);
          for (const key of socialV2.conversations.keys()) if (String(key).startsWith('group:')) keys.add(String(key));
          for (const key of Object.keys(state.sessions ?? {})) if (String(key).startsWith('group:')) keys.add(String(key));
          for (const key of Object.keys(overrides)) if (String(key).startsWith('group:')) keys.add(String(key));
          const conversations = [...keys].map((key) => {
            const id = key.slice('group:'.length);
            return {
              key,
              kind: 'group',
              id,
              name: deps.live.contextNameCache.groups.get(id) || '',
              inGroupList: deps.live.contextNameCache.groups.has(id),
              overrideRole: overrides[key] || null,
              effectiveRole: roleFor(key),
            };
          }).sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id), 'zh-CN'));
          sendJson({ ok: true, defaultRole: rs.role ?? null, mode: rs.mode ?? 'active', roles: listRoles(), conversations });
          return;
        }
        // 读取单个角色的 Markdown 原文（控制台用来在卡片里渲染人格内容）。
        // 直接读文件而不是维护副本：角色卡是热更新的（改完下次读就生效），
        // 缓存一份反而会出现"控制台看到的和实际用的不一致"。
        if (req.method === 'GET' && url.pathname === '/api/role-content') {
          const name = String(url.searchParams.get('name') ?? '').trim();
          if (!name) { sendJson({ ok: false, error: 'name 不能为空' }, 400); return; }
          // 走与创建/设置同一套名字校验，既防路径穿越（../）也保证与列表口径一致
          const safe = sanitizeRoleName(name);
          if (!safe || safe !== name) { sendJson({ ok: false, error: '角色名不合法' }, 400); return; }
          const roleFile = path.join(ROOT, 'roles', safe + '.md');
          if (!fs.existsSync(roleFile)) { sendJson({ ok: false, error: `角色「${safe}」不存在` }, 404); return; }
          try {
            const content = fs.readFileSync(roleFile, 'utf8');
            sendJson({ ok: true, name: safe, content, bytes: Buffer.byteLength(content, 'utf8') });
          } catch (error) {
            sendJson({ ok: false, error: `读取失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // 控制台直接修改人格卡正文（2026-10-23 用户要求「人格卡不能直接在控制台修改」）。
        // 角色卡是热更新的（currentRoleHint 按 mtime 失效），保存后下一轮对话即生效，不用重启。
        if (req.method === 'POST' && url.pathname === '/api/role-content') {
          const body = await readBody();
          const name = String(body.name ?? '').trim();
          const content = String(body.content ?? '');
          const safe = sanitizeRoleName(name);
          if (!safe || safe !== name) { sendJson({ ok: false, error: '角色名不合法' }, 400); return; }
          if (safe === 'README') { sendJson({ ok: false, error: '该名称被保留' }, 400); return; }
          if (!content.trim()) { sendJson({ ok: false, error: '人格卡内容不能为空' }, 400); return; }
          const bytes = Buffer.byteLength(content, 'utf8');
          if (bytes > 512 * 1024) { sendJson({ ok: false, error: '人格卡过大（上限 512KB）' }, 400); return; }
          const roleFile = path.join(ROOT, 'roles', safe + '.md');
          if (!fs.existsSync(roleFile)) { sendJson({ ok: false, error: `角色「${safe}」不存在` }, 404); return; }
          // 先备份再原子写：手滑删掉整段也能从 roles/.backups 找回（每角色保留最近 20 份）。
          try {
            const backupDir = path.join(ROOT, 'roles', '.backups');
            fs.mkdirSync(backupDir, { recursive: true });
            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            fs.copyFileSync(roleFile, path.join(backupDir, `${safe}.${stamp}.md`));
            const old = fs.readdirSync(backupDir)
              .filter((f) => f.startsWith(safe + '.') && f.endsWith('.md'))
              .sort();
            for (const f of old.slice(0, Math.max(0, old.length - 20))) {
              try { fs.unlinkSync(path.join(backupDir, f)); } catch {}
            }
          } catch (error) {
            log(`控制台：备份人格「${safe}」失败（继续保存）：${error?.message ?? error}`);
          }
          const next = content.endsWith('\n') ? content : content + '\n';
          atomicWriteText(roleFile, next);
          log(`控制台：已修改人格「${safe}」（${bytes} 字节）`);
          sendJson({ ok: true, name: safe, bytes, hintLimit: 12000 });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/roles/create') {
          const body = await readBody();
          const name = sanitizeRoleName(body.name);
          const content = String(body.content ?? '').trim();
          if (!name) { sendJson({ ok: false, error: '角色名不能为空（仅限中文/字母/数字/横线）' }, 400); return; }
          if (!content) { sendJson({ ok: false, error: '角色内容不能为空' }, 400); return; }
          if (name === 'README') { sendJson({ ok: false, error: '该名称被保留' }, 400); return; }
          const roleFile = path.join(ROOT, 'roles', name + '.md');
          if (fs.existsSync(roleFile)) { sendJson({ ok: false, error: `角色「${name}」已存在` }, 400); return; }
          fs.mkdirSync(path.join(ROOT, 'roles'), { recursive: true });
          atomicWriteText(roleFile, content + (content.endsWith('\n') ? '' : '\n'));
          log(`控制台：创建人格「${name}」`);
          sendJson({ ok: true, role: name });
          return;
        }
        // 删除角色卡。控制台原先只能建不能删，测试也只能直接删文件——但测试脚本
        // 与桥接未必在同一个目录（跑在别处的克隆会删错地方、留下永远清不掉的角色）。
        // 路径由 bridge.js 的 deleteRole 解析，调用方在哪儿都一致。
        if (req.method === 'POST' && url.pathname === '/api/roles/delete') {
          const body = await readBody();
          const r = typeof deps.deleteRole === 'function'
            ? deps.deleteRole(body.name)
            : { ok: false, error: '删除未实现' };
          sendJson(r, r.ok ? 200 : (r.missing ? 404 : 400));
          return;
        }
        // ── 黑话库管理 ──────────────────────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/slang') {
          const status = url.searchParams.get('status') || '';
          const list = status ? deps.live.slangEntries.filter((e) => e.status === status) : deps.live.slangEntries;
          sendJson({ entries: list, config: cfg.slang });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/slang') {
          const body = await readBody();
          const content = String(body.content ?? '').trim();
          if (!content) { sendJson({ ok: false, error: '黑话内容不能为空' }, 400); return; }
          if (deps.live.slangEntries.some((e) => e.content === content)) { sendJson({ ok: false, error: `黑话「${content}」已存在` }, 400); return; }
          const entry = createSlangEntry({
            content,
            meaning: String(body.meaning ?? '').trim(),
            usage: String(body.usage ?? '').trim(),
            example: String(body.example ?? '').trim(),
            risk: String(body.risk ?? '').trim(),
            sources: Array.isArray(body.sources) ? body.sources.map(String).filter(Boolean) : [],
            status: body.status === SLANG_STATUS.CANDIDATE ? SLANG_STATUS.CANDIDATE : SLANG_STATUS.CONFIRMED,
            source: 'manual',
            evidence: Array.isArray(body.evidence) ? body.evidence : []
          });
          deps.live.slangEntries.push(entry);
          saveSlangStore();
          log(`控制台：新增黑话「${content}」`);
          sendJson({ ok: true, entry });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/slang/clear') {
          const body = await readBody();
          const status = String(body.status ?? '').trim();
          if (status && ![SLANG_STATUS.CANDIDATE, SLANG_STATUS.CONFIRMED, SLANG_STATUS.REJECTED].includes(status)) {
            sendJson({ ok: false, error: `无效的 status：${status}，仅支持 candidate/confirmed/rejected 或留空全部删除` }, 400);
            return;
          }
          let removedCount = 0;
          if (status) {
            removedCount = deps.live.slangEntries.filter((e) => e.status === status).length;
            deps.live.slangEntries = deps.live.slangEntries.filter((e) => e.status !== status);
          } else {
            removedCount = deps.live.slangEntries.length;
            deps.live.slangEntries = [];
            // 清空所有时同步清掉待提取窗口和冷却，避免“删了又回来”
            slangWindows.clear();
            slangExtractionCooldowns.clear();
            slangSubmitTimes.clear();
            slangResearchingIds.clear();
          }
          saveSlangStore();
          log(`控制台：清空黑话 ${removedCount} 条${status ? `（${status}）` : ''}`);
          sendJson({ ok: true, removedCount });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/slang/batch-delete') {
          const body = await readBody();
          const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : [];
          const status = String(body.status ?? '').trim();
          if (ids.length) {
            const idSet = new Set(ids);
            const before = deps.live.slangEntries.length;
            deps.live.slangEntries = deps.live.slangEntries.filter((e) => !idSet.has(e.id));
            const removedCount = before - deps.live.slangEntries.length;
            if (!removedCount) { sendJson({ ok: false, error: '没有匹配到要删除的黑话' }, 404); return; }
            saveSlangStore();
            log(`控制台：批量删除黑话 ${removedCount} 条`);
            sendJson({ ok: true, removedCount });
            return;
          }
          if (status && ![SLANG_STATUS.CANDIDATE, SLANG_STATUS.CONFIRMED, SLANG_STATUS.REJECTED].includes(status)) {
            sendJson({ ok: false, error: `无效的 status：${status}` }, 400);
            return;
          }
          if (!status) { sendJson({ ok: false, error: '请提供 ids 或 status' }, 400); return; }
          const removedCount = deps.live.slangEntries.filter((e) => e.status === status).length;
          deps.live.slangEntries = deps.live.slangEntries.filter((e) => e.status !== status);
          saveSlangStore();
          log(`控制台：批量删除黑话 ${removedCount} 条（${status}）`);
          sendJson({ ok: true, removedCount });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/slang/batch-confirm') {
          const body = await readBody();
          const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : [];
          if (!ids.length) { sendJson({ ok: false, error: '请选择要确认的黑话' }, 400); return; }
          let confirmedCount = 0;
          let skippedCount = 0;
          const skipped = [];
          for (const id of ids) {
            const idx = deps.live.slangEntries.findIndex((e) => e.id === id);
            if (idx < 0) { skippedCount++; skipped.push({ id, reason: '不存在' }); continue; }
            const entry = deps.live.slangEntries[idx];
            if (entry.status !== SLANG_STATUS.CANDIDATE) { skippedCount++; skipped.push({ id, content: entry.content, reason: '不是候选' }); continue; }
            if (!entry.meaning || !String(entry.meaning).trim()) { skippedCount++; skipped.push({ id, content: entry.content, reason: '缺少含义' }); continue; }
            entry.status = SLANG_STATUS.CONFIRMED;
            entry.updatedAt = new Date().toISOString();
            confirmedCount++;
          }
          if (confirmedCount) saveSlangStore();
          log(`控制台：批量确认黑话 ${confirmedCount} 条，跳过 ${skippedCount} 条`);
          sendJson({ ok: true, confirmedCount, skippedCount, skipped: skipped.slice(0, 20) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/slang/batch-reject') {
          const body = await readBody();
          const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : [];
          if (!ids.length) { sendJson({ ok: false, error: '请选择要拒绝的黑话' }, 400); return; }
          let rejectedCount = 0;
          for (const id of ids) {
            const idx = deps.live.slangEntries.findIndex((e) => e.id === id);
            if (idx < 0) continue;
            const entry = deps.live.slangEntries[idx];
            if (entry.status === SLANG_STATUS.REJECTED) continue;
            entry.status = SLANG_STATUS.REJECTED;
            entry.updatedAt = new Date().toISOString();
            rejectedCount++;
          }
          if (rejectedCount) saveSlangStore();
          log(`控制台：批量拒绝黑话 ${rejectedCount} 条`);
          sendJson({ ok: true, rejectedCount });
          return;
        }
        const slangMatch = url.pathname.match(/^\/api\/slang\/([^/]+)(?:\/(confirm|reject))?$/);
        if (req.method === 'PATCH' && slangMatch && !slangMatch[2]) {
          const id = slangMatch[1];
          const idx = deps.live.slangEntries.findIndex((e) => e.id === id);
          if (idx < 0) { sendJson({ ok: false, error: '黑话不存在' }, 404); return; }
          const body = await readBody();
          const entry = { ...deps.live.slangEntries[idx] };
          if (body.content !== undefined) entry.content = String(body.content ?? '').trim();
          if (body.content !== undefined && deps.live.slangEntries.some((e) => e.id !== id && e.content === entry.content)) {
            sendJson({ ok: false, error: `黑话「${entry.content}」已存在` }, 400);
            return;
          }
          if (body.meaning !== undefined) entry.meaning = String(body.meaning ?? '').trim();
          if (body.usage !== undefined) entry.usage = String(body.usage ?? '').trim();
          if (body.example !== undefined) entry.example = String(body.example ?? '').trim();
          if (body.risk !== undefined) entry.risk = String(body.risk ?? '').trim();
          if (body.sources !== undefined) entry.sources = Array.isArray(body.sources) ? body.sources.map(String).filter(Boolean).slice(0, 10) : [];
          if (body.status !== undefined && [SLANG_STATUS.CANDIDATE, SLANG_STATUS.CONFIRMED, SLANG_STATUS.REJECTED].includes(body.status)) entry.status = body.status;
          if (!entry.content) { sendJson({ ok: false, error: '黑话内容不能为空' }, 400); return; }
          entry.updatedAt = new Date().toISOString();
          deps.live.slangEntries[idx] = entry;
          saveSlangStore();
          log(`控制台：更新黑话「${entry.content}」`);
          sendJson({ ok: true, entry });
          return;
        }
        if (req.method === 'POST' && slangMatch && slangMatch[2] === 'confirm') {
          const id = slangMatch[1];
          const idx = deps.live.slangEntries.findIndex((e) => e.id === id);
          if (idx < 0) { sendJson({ ok: false, error: '黑话不存在' }, 404); return; }
          const body = await readBody();
          const entry = deps.live.slangEntries[idx];
          if (body.meaning !== undefined) entry.meaning = String(body.meaning ?? '').trim();
          if (body.usage !== undefined) entry.usage = String(body.usage ?? '').trim();
          if (body.example !== undefined) entry.example = String(body.example ?? '').trim();
          if (body.risk !== undefined) entry.risk = String(body.risk ?? '').trim();
          if (body.sources !== undefined) entry.sources = Array.isArray(body.sources) ? body.sources.map(String).filter(Boolean).slice(0, 10) : [];
          if (!entry.meaning) {
            sendJson({ ok: false, error: '请先填写含义再确认，否则不会注入 AI 上下文' }, 400);
            return;
          }
          entry.status = SLANG_STATUS.CONFIRMED;
          entry.updatedAt = new Date().toISOString();
          saveSlangStore();
          log(`控制台：确认黑话「${entry.content}」`);
          sendJson({ ok: true, entry });
          return;
        }
        if (req.method === 'POST' && slangMatch && slangMatch[2] === 'reject') {
          const id = slangMatch[1];
          const idx = deps.live.slangEntries.findIndex((e) => e.id === id);
          if (idx < 0) { sendJson({ ok: false, error: '黑话不存在' }, 404); return; }
          const entry = deps.live.slangEntries[idx];
          entry.status = SLANG_STATUS.REJECTED;
          entry.updatedAt = new Date().toISOString();
          saveSlangStore();
          log(`控制台：拒绝黑话「${entry.content}」`);
          sendJson({ ok: true, entry });
          return;
        }
        if (req.method === 'DELETE' && slangMatch && !slangMatch[2]) {
          const id = slangMatch[1];
          const idx = deps.live.slangEntries.findIndex((e) => e.id === id);
          if (idx < 0) { sendJson({ ok: false, error: '黑话不存在' }, 404); return; }
          const [removed] = deps.live.slangEntries.splice(idx, 1);
          saveSlangStore();
          log(`控制台：删除黑话「${removed.content}」`);
          sendJson({ ok: true, removed });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/slang/extract') {
          if (cfg.slang?.enabled === false) { sendJson({ ok: false, error: '黑话学习已关闭（slang.enabled=false）' }, 400); return; }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (key && slangWindows.has(key)) {
            queueSlangTask(() => runSlangExtraction(key));
            sendJson({ ok: true, key });
          } else {
            const firstKey = slangWindows.keys().next().value;
            if (!firstKey) { sendJson({ ok: false, error: '当前没有可学习消息窗口' }, 400); return; }
            queueSlangTask(() => runSlangExtraction(firstKey));
            sendJson({ ok: true, key: firstKey });
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/slang/research') {
          if (cfg.slang?.enabled === false) { sendJson({ ok: false, error: '黑话学习已关闭（slang.enabled=false）' }, 400); return; }
          const body = await readBody();
          const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
          const candidates = ids.length
            ? deps.live.slangEntries.filter((e) => ids.includes(e.id) && e.status === SLANG_STATUS.CANDIDATE)
            : deps.live.slangEntries.filter((e) => e.status === SLANG_STATUS.CANDIDATE);
          if (!candidates.length) { sendJson({ ok: false, error: '没有可研究的候选黑话' }, 400); return; }
          queueSlangTask(() => runSlangResearch(candidates));
          sendJson({ ok: true, count: candidates.length });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/slang/config') {
          const body = await readBody();
          const oldPreset = cfg.slang?.learnerPreset;
          const oldWorkspaceTitle = cfg.slang?.workspaceTitle;
          const configFile = path.join(ROOT, 'config.json');
          const file = readJsonSafe(configFile, null, true);
          const merged = { ...(file.slang ?? {}), ...body };
          if (typeof merged.enabled === 'boolean') merged.enabled = merged.enabled;
          else if (merged.enabled !== undefined) merged.enabled = merged.enabled === true;
          if (merged.extractMinMessages !== undefined) merged.extractMinMessages = Math.max(1, Math.round(Number(merged.extractMinMessages) || 1));
          if (merged.extractCooldownMs !== undefined) merged.extractCooldownMs = Math.max(0, Math.round(Number(merged.extractCooldownMs) || 0));
          if (merged.injectMax !== undefined) merged.injectMax = Math.min(30, Math.max(1, Math.round(Number(merged.injectMax) || 1)));
          if (merged.autoResearch !== undefined) merged.autoResearch = merged.autoResearch === true;
          if (merged.learnerPreset !== undefined) merged.learnerPreset = String(merged.learnerPreset ?? '').trim();
          if (merged.workspaceTitle !== undefined) merged.workspaceTitle = String(merged.workspaceTitle ?? '').trim() || 'QQ 黑话学习';
          if (body.inferenceThresholds !== undefined) {
            const raw = Array.isArray(body.inferenceThresholds)
              ? body.inferenceThresholds
              : String(body.inferenceThresholds).split(/[,，\s]+/);
            merged.inferenceThresholds = [...new Set(raw.map((n) => Math.max(1, Math.round(Number(n) || 1))))].sort((a, b) => a - b);
            if (!merged.inferenceThresholds.length) merged.inferenceThresholds = [2, 4, 8];
          }
          file.slang = merged;
          atomicWriteJson(configFile, file);
          cfg.slang = { ...cfg.slang, ...merged };
          if (body.learnerPreset !== undefined && String(body.learnerPreset ?? '').trim() !== String(oldPreset ?? '')) {
            invalidateSlangLearnerSession();
            log('黑话学习 preset 已变更，已重置学习会话');
          } else if (body.workspaceTitle !== undefined && String(body.workspaceTitle ?? '').trim() !== String(oldWorkspaceTitle ?? '')) {
            invalidateSlangLearnerSession();
            log('黑话学习工作区名已变更，已重置学习会话');
          }
          log('控制台：黑话系统配置已更新');
          sendJson({ ok: true, config: cfg.slang });
          return;
        }
        // ── 会话查看 ──────────────────────────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/sessions') {
          // 带上群名 / QQ 昵称：控制台的会话列表不能只显示号码。
          // 复用上下文卡片的名称缓存（群列表 + 好友列表 + 陌生人资料，5 分钟 TTL）。
          try { await refreshContextNames(false); } catch {}
          const list = [];
          for (const [key, sessionId] of Object.entries(state.sessions)) {
            const [kind, id] = String(key).split(':');
            list.push({
              key,
              sessionId,
              owner: key === `private:${String(cfg.ownerQQ ?? '')}`,
              kind,
              name: contextDisplayName(key) || ''
            });
          }
          sendJson({ sessions: list });
          return;
        }
        // ── 挂起审批 / 提问 ───────────────────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/pending') {
          const list = [];
          for (const [key, p] of pending.entries()) {
            list.push({
              key,
              kind: p.kind,
              sessionId: p.sessionId,
              ...(p.kind === 'approval' ? { toolName: p.toolName, reason: p.reason, approvalId: p.approvalId } : {}),
              ...(p.kind === 'question' ? { questions: p.questions } : {})
            });
          }
          sendJson({ pending: list });
          return;
        }
        // ── 白名单可视化编辑（写 config.json + 热更新内存） ───────────────────
        if (req.method === 'GET' && url.pathname === '/api/whitelist') {
          try { await refreshContextNames(!deps.live.contextNameCache.at || deps.live.contextNameCache.groups.size === 0); } catch {}
          sendJson({
            allow: cfg.allow ?? { private: [], groups: [] },
            deny: cfg.deny ?? { private: [], groups: [] },
            ownerQQ: cfg.ownerQQ ?? null,
            // 私聊准入策略（'list' 白名单 / 'friends' 好友自动放行 / 'all' 纯黑名单）
            privateMode: cfg.allow?.privateMode ?? 'list',
            // 好友数：'friends' 模式下控制台据此提示"当前生效的好友有多少"
            friendCount: deps.live.friendIds.size,
            // 控制台显示用：群名 / QQ 昵称；取不到的号码前端只显示号码
            groupNames: Object.fromEntries(deps.live.contextNameCache.groups),
            privateNames: Object.fromEntries(deps.live.contextNameCache.privates),
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/whitelist') {
          const body = await readBody();
          const toNum = (arr) => Array.isArray(arr) ? [...new Set(arr.map((x) => Number(String(x).trim())).filter((n) => Number.isFinite(n)))] : undefined;
          const configFile = path.join(ROOT, 'config.json');
          // fail-fast：配置文件损坏时直接 500，绝不回写，避免把整个配置清成只剩 allow/deny/ownerQQ
          const file = readJsonSafe(configFile, null, true);
          // 私聊准入策略：可改。缺省沿用原值，非法值回落到 'list'（fail-closed）。
          const privateMode = body.allow?.privateMode !== undefined
            ? normalizePrivateMode(body.allow.privateMode)
            : (file.allow?.privateMode ?? 'list');
          const allow = {
            private: toNum(body.allow?.private) ?? (file.allow?.private ?? []),
            groups: toNum(body.allow?.groups) ?? (file.allow?.groups ?? []),
            privateMode
          };
          const deny = {
            private: toNum(body.deny?.private) ?? (file.deny?.private ?? []),
            groups: toNum(body.deny?.groups) ?? (file.deny?.groups ?? [])
          };
          // 管理员 QQ 可在控制台输入；空值=清除管理员（fail-closed），非法值拒绝写入。
          let ownerQQ = cfg.ownerQQ ?? null;
          if (body.ownerQQ !== undefined) {
            try {
              ownerQQ = normalizeOwnerQQ(body.ownerQQ);
            } catch (error) {
              sendJson({ ok: false, error: error?.message ?? 'ownerQQ 无效' }, 400);
              return;
            }
          }
          file.allow = allow;
          file.deny = deny;
          file.ownerQQ = ownerQQ;
          atomicWriteJson(configFile, file);
          cfg.allow = { private: allow.private, groups: allow.groups, privateMode: allow.privateMode };
          cfg.deny = { private: deny.private, groups: deny.groups };
          cfg.ownerQQ = ownerQQ;
          // 切到 'friends' 时立刻拉一次好友列表（否则要等 5 分钟的定期刷新才生效）
          if (privateMode === 'friends') {
            refreshFriendList({ force: true }).then((ids) => log(`[私聊准入] 好友列表已刷新：${ids.size} 人`)).catch(() => {});
          }
          const modeLabel = { list: '白名单', friends: '好友自动放行', all: '纯黑名单（全放开）' }[allow.privateMode] || allow.privateMode;
          log(`控制台：白名单已更新（群: ${allow.groups.join(',') || '无'}，私聊: ${allow.private.join(',') || '无'}，私聊策略: ${modeLabel}，管理员: ${ownerQQ ?? '未设置'}）`);
          sendJson({ ok: true, allow, deny, ownerQQ, friendCount: deps.live.friendIds.size });
          return;
        }

        // ── 安全拦截通知设置 ─────────────────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/security') {
          sendJson({ security: cfg.security ?? { interceptNotify: true } });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/security') {
          const body = await readBody();
          const configFile = path.join(ROOT, 'config.json');
          const file = readJsonSafe(configFile, null, true);
          const next = { ...(file.security ?? {}), ...body };
          if (typeof next.interceptNotify === 'boolean') next.interceptNotify = next.interceptNotify;
          else if (next.interceptNotify !== undefined) next.interceptNotify = Boolean(next.interceptNotify);
          file.security = next;
          atomicWriteJson(configFile, file);
          cfg.security = { ...(cfg.security ?? {}), ...next };
          log(`控制台：安全拦截通知已更新（interceptNotify=${cfg.security.interceptNotify}）`);
          sendJson({ ok: true, security: cfg.security });
          return;
        }
        // ── 控制台访问令牌（可手动修改/生成随机） ─────────────────────────────
        // GET：只读返回「鉴权是否开启」，供页面显示当前状态。
        // **不回传令牌本身**（控制台页面不需要它，令牌值在 state/console-token 与 config 里）。
        if (req.method === 'GET' && url.pathname === '/api/console/token') {
          sendJson({
            ok: true,
            authEnabled: consoleToken !== '',
            hasToken: consoleToken !== '',
            port,
            hint: consoleToken === ''
              ? '令牌鉴权已关闭（config.consoleAuth=false）：直接访问即可，无需登录'
              : '令牌鉴权已开启：刷新页面时会要求输入令牌'
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/console/token') {
          const body = await readBody();
          let newToken = String(body.token ?? '').trim();
          const generated = !newToken;
          if (generated) {
            newToken = crypto.randomBytes(24).toString('hex');
          }
          if (newToken.length < 16) {
            sendJson({ ok: false, error: '控制台访问令牌至少需要 16 位；留空可生成随机令牌' }, 400);
            return;
          }
          if (newToken.length > 128) {
            sendJson({ ok: false, error: '控制台访问令牌不能超过 128 位' }, 400);
            return;
          }
          if (!/^[A-Za-z0-9_-]+$/.test(newToken)) {
            sendJson({ ok: false, error: '控制台访问令牌只能包含字母、数字、下划线或短横线' }, 400);
            return;
          }
          const configFile = path.join(ROOT, 'config.json');
          const file = readJsonSafe(configFile, null, true);
          // 手动令牌写入 config.json（用户可见、可再改）；随机令牌写入 state/console-token 并清空 config 中的手动值。
          file.consoleToken = generated ? '' : newToken;
          atomicWriteJson(configFile, file);
          cfg.consoleToken = generated ? '' : newToken;
          atomicWriteText(path.join(STATE_DIR, 'console-token'), newToken);
          consoleToken = newToken;
          log(`控制台：访问令牌已${generated ? '重新生成' : '手动修改'}（不记录完整值）`);
          sendJson({ ok: true, token: newToken, generated });
          return;
        }
        // ── 测试发送消息（强制走白名单校验） ───────────────────────────────────
        if (req.method === 'POST' && url.pathname === '/api/test-send') {
          const body = await readBody();
          const kind = body.kind === 'private' ? 'private' : 'group';
          const id = Number(body.id);
          const message = String(body.message ?? '').trim();
          if (!Number.isFinite(id) || id <= 0) { sendJson({ ok: false, error: '目标 id 无效' }, 400); return; }
          if (!message) { sendJson({ ok: false, error: '消息不能为空' }, 400); return; }
          if (SENSITIVE_RE.test(message)) { sendJson({ ok: false, error: '消息含敏感信息，已阻止发送' }, 403); return; }
          if (!allowed(kind, id, cfg)) { sendJson({ ok: false, error: `目标不在白名单内（${kind} ${id}），请先加入白名单` }, 403); return; }
          if (!modeAllowed(`${kind}:${id}`, kind, id, cfg, deps.live.currentMode)) { sendJson({ ok: false, error: `当前模式（${deps.live.currentMode}）不允许向 ${kind}:${id} 发送测试消息` }, 403); return; }
          try {
            const safeMessage = escapeCqText(redactKnownTokensOnly(message));
            const result = kind === 'private'
              ? await bot.sendPrivateMessage(id, text(safeMessage))
              : await bot.sendGroupMessage(id, text(safeMessage));
            recordSentMessage(`${kind}:${id}`, result, safeMessage);
            log(`控制台：测试发送 ${kind}:${id} 成功`);
            sendJson({ ok: true, kind, id, message_id: result?.message_id ?? result });
          } catch (error) {
            sendJson({ ok: false, error: `发送失败: ${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/social/state') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          const phase = body.phase;
          if (phase === 'active') {
            // 手动进入活跃：相当于第四种触发方式，之后按正常活跃流程跑
            enterActive(key);
            log(`控制台：手动将 ${key} 设为活跃`);
            sendJson({ ok: true, key, phase: 'active' });
          } else if (phase === 'idle') {
            leaveActive(key);
            log(`控制台：手动将 ${key} 设为观望`);
            sendJson({ ok: true, key, phase: 'idle' });
          } else {
            sendJson({ ok: false, error: 'phase 必须是 active 或 idle' }, 400);
          }
          return;
        }
        // ── 仿真群友模式（社交引擎）配置 ──────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/social') {
          const stats = {};
          for (const [k, e] of social.pendingSummaries.entries()) stats[k] = e.items.length;
          const states = {};
          const keys = new Set([...social.states.keys(), ...social.recentMessages.keys()]);
          for (const k of keys) {
            const st = social.states.get(k);
            states[k] = { phase: st?.phase ?? 'idle' };
          }
          sendJson({ config: cfg.social, pendingSummaries: stats, states });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/social') {
          const body = await readBody();
          const configFile = path.join(ROOT, 'config.json');
          // fail-fast：配置文件损坏时直接 500，绝不回写，避免把整个配置清成只剩 social
          const file = readJsonSafe(configFile, null, true);
          const merged = { ...(file.social ?? {}), ...body };
          // 新分句逻辑不再使用旧字段：保存时统一清理，避免旧配置残留
          for (const k of ['burstProbability', 'burstMaxMessages', 'followUpEnabled', 'followUpProbability', 'followUpDelayMinMs', 'followUpDelayMaxMs', 'followUpCooldownMs']) {
            delete merged[k];
          }
          for (const k of ['triggerProbability', 'activeCheckMinMs', 'activeCheckMaxMs', 'activeReplyDelayMinMs', 'activeReplyDelayMaxMs', 'activeDurationMinMs', 'activeDurationMaxMs', 'idleWindowMs', 'idleRetryProbability', 'idleRetryWaitMs', 'proactiveIdleThresholdMs', 'proactiveCheckMinMs', 'proactiveCheckMaxMs', 'proactiveProbability', 'maxReplyChars', 'contextWindow', 'burstIntervalMinMs', 'burstIntervalMaxMs', 'longGapMinMs', 'longGapMaxMs']) {
            if (merged[k] !== undefined) {
              const n = Number(merged[k]);
              if (Number.isFinite(n) && n >= 0) merged[k] = n;
            }
          }
          // 分条间隔 clamp 到非负
          for (const k of ['burstIntervalMinMs', 'burstIntervalMaxMs', 'longGapMinMs', 'longGapMaxMs']) {
            if (merged[k] !== undefined) merged[k] = Math.max(0, Number(merged[k]) || 0);
          }
          // 概率字段 clamp 到 0~1
          for (const k of ['triggerProbability', 'idleRetryProbability', 'proactiveProbability', 'skipProbability', 'surrenderProbability', 'longGapProbability']) {
            if (merged[k] !== undefined) merged[k] = Math.min(1, Math.max(0, Number(merged[k])));
          }
          // contextWindow 限制 1~100
          if (merged.contextWindow !== undefined) {
            merged.contextWindow = Math.min(100, Math.max(1, Math.round(Number(merged.contextWindow))));
          }
          // 布尔字段
          for (const k of ['activeDurationEnabled', 'proactiveEnabled', 'burstEnabled']) {
            if (merged[k] !== undefined) merged[k] = Boolean(merged[k]);
          }
          // 范围字段保证 min <= max
          for (const [minK, maxK] of [['activeCheckMinMs', 'activeCheckMaxMs'], ['activeReplyDelayMinMs', 'activeReplyDelayMaxMs'], ['activeDurationMinMs', 'activeDurationMaxMs'], ['proactiveCheckMinMs', 'proactiveCheckMaxMs'], ['burstIntervalMinMs', 'burstIntervalMaxMs'], ['longGapMinMs', 'longGapMaxMs']]) {
            if (merged[minK] !== undefined && merged[maxK] !== undefined && Number(merged[minK]) > Number(merged[maxK])) {
              [merged[minK], merged[maxK]] = [merged[maxK], merged[minK]];
            }
          }
          if (Array.isArray(body.mustReplyKeywords)) merged.mustReplyKeywords = body.mustReplyKeywords.map(String);
          file.social = merged;
          atomicWriteJson(configFile, file);
          cfg.social = { ...cfg.social, ...merged };
          log('控制台：社交配置已更新');
          sendJson({ ok: true, config: cfg.social });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/social/flush') {
          const body = await readBody();
          await flushSummaries(body.key || null);
          sendJson({ ok: true });
          return;
        }
        // ── 后台控制端引导：向指定会话的 DSH agent 投递提醒 ──────────────────
        if (req.method === 'POST' && url.pathname === '/api/console/notify-ai') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const message = String(body.message ?? '').trim();
          if (!key || !message) {
            sendJson({ ok: false, error: 'key 和 message 不能为空' }, 400);
            return;
          }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) {
            sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400);
            return;
          }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0) {
            sendJson({ ok: false, error: 'id 无效' }, 400);
            return;
          }
          if (!modeAllowed(key, kind, id, cfg, deps.live.currentMode)) {
            sendJson({ ok: false, error: `该会话不在当前模式（${deps.live.currentMode}）允许范围内` }, 403);
            return;
          }
          if (!state.sessions[key] && !allowed(kind, id, cfg)) {
            sendJson({ ok: false, error: '该会话不在白名单内，且尚未创建' }, 403);
            return;
          }
          if (!deps.live.dshReady) {
            sendJson({ ok: false, error: 'DSH 当前不可用，请稍后再试' }, 503);
            return;
          }
          const isV2 = deps.live.currentMode === 'reserved2';
          const roleName = roleFor(key);
          const roleLine = roleName ? `【当前角色】${roleName}（完整角色卡请调用 qq_get_prompt 查看）\n\n` : '';
          // 二代必须带会话令牌，否则 AI 调用任何 MCP 状态/发送工具都会被拒。
          let tokenLine = '';
          if (isV2) {
            const stV2 = getSocialV2State(key);
            tokenLine = `【会话令牌】${stV2.agentToken}（调用二代状态/发送工具时请在参数中带上此令牌）\n\n`;
          }
          const promptText = `${roleLine}${tokenLine}【后台控制端提醒】（来自控制台/管理端，不是群友消息）\n${message}\n\n这是后台给你的引导或提醒，请据此调整你的行为。绝对不要复述、转发或原样发送这条后台提醒，也不要发送其中的会话令牌；它只用于你内部调整行为。${isV2 ? '当前是二代仿真模式：你的文本输出不会自动发送到 QQ；如果需要在群里发言，请使用发送工具（qq_send_message / qq_reply）。如果不需要发言，可以 qq_mark_read 或 qq_set_wake_config 收尾。' : '如果不需要在群里发言，请不要输出会发到 QQ 的内容。'}`;
          let sessionId = null;
          let popSilent = null;
          try {
            sessionId = await ensureSession(key);
            const silentId = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
            const arr = social.silentTurns.get(sessionId) ?? [];
            social.silentTurns.set(sessionId, [...arr, { id: silentId, ts: Date.now() }]);
            popSilent = () => {
              const list = social.silentTurns.get(sessionId) ?? [];
              const next = list.filter((x) => x.id !== silentId);
              if (next.length > 0) social.silentTurns.set(sessionId, next);
              else social.silentTurns.delete(sessionId);
            };
            const result = await deliverPrompt(key, promptText, { silent: true });
            if (result.ok) {
              log(`控制台：已向 ${key} 的 DSH 发送后台提醒`);
              appendActivity(`${key} 控制台后台提醒：${message.slice(0, 80)}`);
              sendJson({ ok: true, key, sessionId });
            } else {
              popSilent();
              sendJson({ ok: false, error: result.error || '投递失败' }, 500);
            }
          } catch (error) {
            if (popSilent) popSilent();
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }
        // ── 二代仿真模式（reserved2）内部 Agent API ─────────────────────────
        // ── 待配置项（凭据 / 密钥 / 关键连接配置）────────────────────────────
        //
        // 用户要求（2026-10-20）：把这些项放到控制台、做成密码样式（右侧隐藏/显示）、
        // 旁边配说明文档与保存键，需要重启的标明并提供重启按钮。
        //
        // 安全设计（务必保持）：
        //   ① GET 默认**只回「是否已配置」+ 脱敏预览**，绝不下发完整明文。
        //      用户点「显示」才单条请求（reveal=1），减少明文在页面/内存里的驻留。
        //   ② 写入沿用原始位置（config.json / state/*.json），**不新建集中明文文件**
        //      ——集中一处只会扩大泄露面。
        //   ③ 任何分支都不把这些值写进日志。
        // ── 关于页：版本 / 运行环境 ─────────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/about') {
          let version = '';
          let snowlumaVersion = '';
          try { version = String(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || ''); } catch {}
          try {
            const home = String(cfg.snowluma?.homeDir || '').trim();
            if (home) snowlumaVersion = String(JSON.parse(fs.readFileSync(path.join(home, 'package.json'), 'utf8')).version || '');
          } catch {}
          sendJson({
            ok: true,
            name: 'QQ Bridge',
            version,
            snowlumaVersion,
            node: process.version,
            platform: process.platform,
            arch: process.arch,
            repo: 'https://github.com/群友U/qq-bridge'
          });
          return;
        }
        // Token 用量：控制台读这个拿每日/累计数据。
        //
        // 需求（2026-10-21 用户）：「把 token 记录做成日志，每日更新并且放进控制台」。
        // 这里只读缓存（state/token-usage.json），**不在请求里现算**——
        // 全量扫一遍要 13~15 秒，放在 HTTP 请求里会卡住控制台。
        // 需要立刻重算时用 POST ?refresh=1（后台跑，不阻塞响应）。
        if (req.method === 'GET' && url.pathname === '/api/socialV2/token-usage') {
          const data = deps.live.tokenUsage || loadTokenUsage();
          if (!data) {
            // 还没算过：返回空态 + 提示（前端会显示"正在统计"）
            sendJson({ ok: true, ready: false, days: {}, models: {}, dayModels: {}, turns: 0, calls: 0 });
            return;
          }
          // 口径：DSH 的 inputTokens = 未命中缓存的输入，cacheReadTokens = 命中缓存的输入；
          // 真正的 prompt_tokens = input + cacheRead。控制台必须把两者都摆出来，
          // 否则「输入 129M」会被误读成总消耗（实际总输入是 4B 量级）。
          const derive = (v) => {
            const src = (v && typeof v === 'object') ? v : {};
            const input = Number(src.input) || 0;
            const cacheRead = Number(src.cacheRead) || 0;
            const output = Number(src.output) || 0;
            const totalInput = input + cacheRead;
            return {
              ...src,
              totalInput,
              totalTokens: totalInput + output,
              cacheHitRate: totalInput > 0 ? Math.round((cacheRead / totalInput) * 1000) / 10 : 0
            };
          };
          const dayKeys = Object.keys(data.days || {}).sort().reverse();
          const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
          const tot = Object.values(data.days || {}).reduce((a, v) => ({
            input: a.input + v.input, output: a.output + v.output,
            cacheRead: a.cacheRead + v.cacheRead, reasoning: a.reasoning + v.reasoning,
            calls: a.calls + v.calls
          }), { input: 0, output: 0, cacheRead: 0, reasoning: 0, calls: 0 });

          // 按日审阅（2026-10-21 用户要求）：`?date=YYYY-MM-DD` 时，
          // `models` 换成**那一天**的模型明细；不传或传 `all` 则是全时段汇总。
          // 为什么要服务端过滤而不是前端自己挑：dayModels 是日×模型的联合分布，
          // 全量下发给前端在日期多了以后会明显变大（30 天 × 6 模型），
          // 而且前端拿到的数字必须和后端口径一致，放一处算就不会漂。
          const dateParam = String(url.searchParams.get('date') ?? '').trim();
          const wantAll = !dateParam || dateParam === 'all';
          const wantDate = wantAll ? '' : (/^\d{4}-\d{2}-\d{2}$/.test(dateParam) ? dateParam : '');
          if (!wantAll && !wantDate) {
            sendJson({ ok: false, error: 'date 应为 YYYY-MM-DD 或 all' }, 400);
            return;
          }
          const modelSource = wantAll ? (data.models || {}) : (data.dayModels?.[wantDate] || {});
          const sumModels = (obj) => Object.values(obj || {}).reduce((a, v) => ({
            input: a.input + (Number(v.input) || 0),
            output: a.output + (Number(v.output) || 0),
            cacheRead: a.cacheRead + (Number(v.cacheRead) || 0),
            reasoning: a.reasoning + (Number(v.reasoning) || 0),
            calls: a.calls + (Number(v.calls) || 0)
          }), { input: 0, output: 0, cacheRead: 0, reasoning: 0, calls: 0 });

          const sessionUsage = buildSessionUsageRows({
            usage: data,
            currentSessions: state.sessions || {},
            displayName: contextDisplayName,
            today,
            // 按日审阅对会话表生效：选某天时只看那天，选「总计」看全时段。
            scopeDay: wantAll ? '' : wantDate
          });
          sendJson({
            ok: true,
            ready: true,
            updatedAt: data.updatedAt || 0,
            today,
            // 按 QQ 会话：currentSessionId 非空表示该会话有当前 DSH 会话；
            // cumulative 含轮换前旧 sessionId 与情节摘要器，current 只含当前一个。
            // sessionScope：'all' = 全时段；YYYY-MM-DD = 只统计那一天。
            sessionScope: sessionUsage.scopeDay,
            sessions: sessionUsage.rows,
            unownedSessions: sessionUsage.unowned,
            // 当前"按模型"块对应哪一天：'all' = 全时段，否则是 YYYY-MM-DD。
            // 前端用它在标题上写清楚"这是哪天的数"，避免看错口径。
            modelScope: wantAll ? 'all' : wantDate,
            modelScopeUsage: derive(wantAll ? sumModels(data.models) : sumModels(modelSource)),
            todayUsage: derive(data.days?.[today] || { input: 0, output: 0, cacheRead: 0, calls: 0 }),
            total: derive(tot),
            turns: data.turns || 0,
            calls: data.calls || 0,
            files: data.files || 0,
            // 按日：最近 30 天，新的在前
            days: dayKeys.slice(0, 30).map((d) => ({ date: d, ...derive(data.days[d]) })),
            // 按模型：当前所选日期（或全时段）的明细，按输入量排序
            models: Object.entries(modelSource)
              .map(([model, v]) => ({ model, ...derive(v) }))
              .sort((a, b) => b.input - a.input)
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/token-usage-refresh') {
          // 后台重算，立刻回 202：全量扫描 13~15 秒，不能同步等
          void refreshTokenUsage({ force: url.searchParams.get('force') === '1' }).catch(() => {});
          sendJson({ ok: true, message: '已在后台开始重新统计（约 15 秒）' });
          return;
        }
        // ── Token 用量报表图（2026-10-21 用户要求）──────────────────────────
        //
        // 「让 bot 能够看到 token 消耗日志，能够以图片形式响应群友要求 token 消耗量
        //   相关问题」——所以这个端点是**给模型用的**（MCP 的 qq_token_report 调它），
        // 一次做完「取数 → 渲染 PNG → 发到当前会话」。
        //
        // 为什么由桥接直接发而不是把图 base64 还给模型：模型没有"发送任意图片"的能力
        // （qq_send_image 只认图库里的图），与功能菜单同一个理由。
        //
        // GET，参数：key（会话）、refresh（可选，1=先重算再出图）
        if (req.method === 'GET' && url.pathname === '/api/socialV2/token-report') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          // agent token 必需（与 send-image / send-feature-menu / github-shot 同规则）：
          // 这是个往群里发东西的写操作，不能靠"控制台没设令牌"就放行。
          if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: '发送 Token 报表必须携带 agent token' }, 403); return; }
          if (!agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (!v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (!v2ToolEnabled('tokenReport')) { sendJson({ ok: false, error: '工具未启用：qq_token_report' }, 403); return; }
          if (socialV2.paused) { sendJson({ ok: false, error: 'AI 已暂停，当前不允许发送' }, 403); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, deps.live.currentMode)) {
            sendJson({ ok: false, error: '当前模式不允许向该会话发送' }, 403);
            return;
          }
          if (shouldBlockSilentReply(key)) { sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403); return; }
          try {
            // refresh=1：先同步重算一次（约 7 秒增量 / 15 秒全量）。
            // 群友明确问"今天用了多少"时值得等一下——拿 6 小时前的旧数回答，
            // 数字可能差出一大截。但不做全量强制重算（force 不传）。
            if (url.searchParams.get('refresh') === '1') {
              await refreshTokenUsage({});
            }
            const usage = deps.live.tokenUsage || loadTokenUsage() || { days: {}, models: {}, turns: 0, calls: 0 };
            const report = buildTokenReport(usage);
            const title = String(url.searchParams.get('title') ?? '').trim().slice(0, 40) || 'Token 用量';
            const r = await renderTokenReport(report, { title, log: (m) => log(m) });
            if (!r.ok) { sendJson({ ok: false, error: r.error }, 500); return; }
            await onebotSendImageFile(key, r.file, { label: 'Token 用量报表' });
            // 顺手清理旧报表缓存（每天都会产生新指纹文件，不清理会攒几千张）
            try { pruneTokenReportCache({ maxFiles: 20, maxAgeDays: 14 }); } catch {}
            log(`[Token报表] 已发送到 ${key}（${Math.round(r.bytes / 1024)}KB${r.cached ? '，缓存' : '，新渲染'}）`);
            appendActivity(`${key} [Token报表] 已发送 Token 用量图`);
            sendJson({
              ok: true,
              key,
              cached: r.cached,
              bytes: r.bytes,
              // 把关键数字一并回给模型：它在群友追问时要能回答，且**必须与图上同源**
              // （否则模型会凭印象再编一个数，和刚发出去的图对不上）。
              summary: summarizeTokenReport(report),
              today: { day: report.today.day, input: report.today.input, output: report.today.output, calls: report.today.calls },
              total: { input: report.all.input, output: report.all.output, calls: report.all.calls },
              stale: report.stale,
              ageText: report.ageText
            });
          } catch (error) {
            log(`Token 报表发送失败：${error?.message ?? error}`);
            sendJson({ ok: false, error: `Token 报表发送失败：${error?.message ?? error}` }, 500);
          }
          return;
        }

        // 控制台预览：渲染 Token 报表并以 PNG 返回（**不发群**）。
        //
        // 与 /api/socialV2/token-report 的区别：那个是给模型用的（渲染 + 发到会话），
        // 这个只给控制台看图。分成两个端点而不是加个 flag，是因为权限模型不同：
        // 发群那条必须带 agent token，预览这条走控制台鉴权（本机 + 同源）。
        if (req.method === 'GET' && url.pathname === '/api/socialV2/token-report-image') {
          try {
            if (url.searchParams.get('refresh') === '1') await refreshTokenUsage({});
            const usage = deps.live.tokenUsage || loadTokenUsage() || { days: {}, models: {}, turns: 0, calls: 0 };
            const report = buildTokenReport(usage);
            const title = String(url.searchParams.get('title') ?? '').trim().slice(0, 40) || 'Token 用量';
            const r = await renderTokenReport(report, { title, force: url.searchParams.get('force') === '1', log: (m) => log(m) });
            if (!r.ok) { sendJson({ ok: false, error: r.error }, 500); return; }
            const buf = fs.readFileSync(r.file);
            res.writeHead(200, {
              ...SECURITY_HEADERS,
              'content-type': 'image/png',
              'content-length': String(buf.length),
              // 内容指纹已在文件名里，但浏览器拿不到——用 no-store 保证看到的是新图
              'cache-control': 'no-store'
            });
            res.end(buf);
          } catch (error) {
            sendJson({ ok: false, error: `生成报表失败：${error?.message ?? error}` }, 500);
          }
          return;
        }

        // 工具开关清单（控制台由此渲染，不再硬编码复选框）。
        //
        // 需求（2026-10-20 用户）：「工具开关卡片过于复杂，似乎还有遗漏项目」。
        // 实测确实漏了 10 个、还有 1 个空开关。根因是**清单写在控制台 HTML 里**，
        // 加工具时只改后端不改前端（或反过来）就会漂移。
        // 现在清单唯一来源是 src/tool-flags.js，前端只负责画。
        if (req.method === 'GET' && url.pathname === '/api/socialV2/tool-flags') {
          const tools = cfg.socialV2?.tools ?? {};
          const groups = groupedToolFlags((flag) => tools[flag] !== false);
          sendJson({
            ok: true,
            total: TOOL_FLAGS.length,
            toolCount: toolNamesOf().length,
            enabledCount: TOOL_FLAGS.filter((x) => x.fixed !== true && tools[x.flag] !== false).length,
            groups
          });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/credentials') {
          const reveal = url.searchParams.get('reveal') === '1';
          const only = String(url.searchParams.get('key') ?? '').trim();

          // 读取当前值：config 走点路径，file 走 state 下的 json
          const readValue = (item) => {
            try {
              if (item.where === 'config') {
                const file = readJsonSafe(path.join(ROOT, 'config.json'), null);
                if (!file) return { ok: false, value: '', error: 'config.json 读取失败' };
                let cur = file;
                for (const k of item.path.split('.')) {
                  cur = cur?.[k];
                  if (cur === undefined) break;
                }
                return { ok: true, value: cur == null ? '' : String(cur) };
              }
              const file = readJsonSafe(path.join(STATE_DIR, item.file), null);
              if (!file) return { ok: true, value: '' }; // 文件不存在 = 未配置，不是错误
              const v = file[item.path];
              return { ok: true, value: v == null ? '' : String(v) };
            } catch (error) {
              return { ok: false, value: '', error: String(error?.message ?? error) };
            }
          };

          const items = (only ? CREDENTIAL_ITEMS.filter((it) => it.key === only) : CREDENTIAL_ITEMS)
            .map((item) => {
              const r = readValue(item);
              const configured = !!r.value;
              return {
                key: item.key,
                label: item.label,
                group: item.group,
                kind: item.kind,
                restart: item.restart === true,
                doc: item.doc,
                // 明文下发规则（2026-10-20 用户要求「连接这部分不要脱敏，直接显示明文」）：
                //   - kind='text'（代理地址等**非秘密**）：直接给明文，不然用户没法确认填得对不对。
                //   - kind='secret'（真正的 key / cookie）：默认只给脱敏预览；点眼睛时
                //     （reveal=1 且指定了 key）才给那一条的明文。
                //   整表 reveal 仍然不允许——那会让所有密钥一次性进浏览器内存。
                value: item.kind === 'text'
                  ? (r.ok ? r.value : '')
                  : ((reveal && only) ? (r.ok ? r.value : '') : ''),
                configured,
                // 连接类不需要脱敏预览（前端直接显示明文）
                preview: configured && item.kind !== 'text' ? maskValue(r.value) : '',
                ...(r.ok ? {} : { error: r.error })
              };
            });

          sendJson({ ok: true, items });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/credentials') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const item = CREDENTIAL_ITEMS.find((it) => it.key === key);
          if (!item) { sendJson({ ok: false, error: `未知配置项：${key}` }, 400); return; }
          if (typeof body.value !== 'string') { sendJson({ ok: false, error: 'value 必须是字符串' }, 400); return; }
          // 换行/首尾空白几乎都是复制时带进来的，直接裁掉（这些值里不会含换行）
          const value = String(body.value).replace(/[\r\n]+/g, '').trim();

          // 基本形态校验：宁可在保存时拒绝，也不要存进去后再去排查"为什么连不上"
          if (item.kind === 'secret' && value && value.length < 6) {
            sendJson({ ok: false, error: '这个值太短了，确认没复制错吗？' }, 400);
            return;
          }
          if (item.key === 'imagesProxy' || item.key === 'githubShotProxy' ||
              item.key === 'webSearchProxy' || item.key === 'xMonitorProxy') {
            if (value && !/^https?:\/\/[^\s]+$/i.test(value)) {
              sendJson({ ok: false, error: '代理地址应形如 http://127.0.0.1:7897' }, 400);
              return;
            }
          }
          if (item.key === 'consoleToken' && value && value.length < 16) {
            sendJson({ ok: false, error: '控制台令牌至少 16 位' }, 400);
            return;
          }

          try {
            if (item.where === 'config') {
              const configFile = path.join(ROOT, 'config.json');
              // fail-fast：配置损坏时绝不回写，否则可能把整个 config 清空
              const file = readJsonSafe(configFile, null, true);
              const segs = item.path.split('.');
              let cur = file;
              for (let i = 0; i < segs.length - 1; i++) {
                if (!cur[segs[i]] || typeof cur[segs[i]] !== 'object') cur[segs[i]] = {};
                cur = cur[segs[i]];
              }
              cur[segs[segs.length - 1]] = value;
              atomicWriteJson(configFile, file);
              // 同步内存：改完立即生效的那些项（restart=false）立刻能用
              let mem = cfg;
              for (let i = 0; i < segs.length - 1; i++) {
                mem[segs[i]] = mem[segs[i]] ?? {};
                mem = mem[segs[i]];
              }
              mem[segs[segs.length - 1]] = value;
              // 反查器构造时就把 apiKey 抓进闭包了，改了要重建才生效
              if (item.key === 'reverseSearchApiKey') {
                try { reverseSearcher.setApiKey?.(value); } catch { /* 旧实现没有该方法时忽略 */ }
              }
            } else {
              const file = path.join(STATE_DIR, item.file);
              const obj = readJsonSafe(file, null) ?? {};
              if (value) obj[item.path] = value;
              else delete obj[item.path];
              atomicWriteJson(file, obj);
              // 凭据模块在内存里缓存了 cookie（bili.js / pixiv-auth.js 都是），
              // 存完就地重读一次，用户不必为了试一个值反复重启桥接。
              if (item.file === 'pixiv-auth.json') {
                try { applyPixivAuth('控制台保存'); } catch { /* 重读失败不该让保存算失败 */ }
              }
            }

            log(`[配置] 已更新 ${item.key}${value ? `（${value.length} 字符）` : '（清空）'}${item.restart ? '，需重启生效' : ''}`);
            sendJson({
              ok: true,
              key: item.key,
              configured: !!value,
              preview: value ? maskValue(value) : '',
              restart: item.restart === true,
              // 明确告诉前端"现在生效了没有"，避免用户以为白填了
              applied: item.restart !== true
            });
          } catch (error) {
            log(`[配置] 写入 ${item.key} 失败：${error?.message ?? error}`);
            sendJson({ ok: false, error: `保存失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/config') {
          sendJson({ ok: true, config: cfg.socialV2 ?? {} });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/config') {
          const body = await readBody();
          const configFile = path.join(ROOT, 'config.json');
          const file = readJsonSafe(configFile, null, true);
          const current = file.socialV2 ?? {};
          const merged = { ...current, ...body };
          // 子对象必须是非 null 对象；null/数组/基本类型会覆盖默认值导致工具开关被绕过，这里直接保留当前值。
          for (const sub of ['tools', 'wake', 'send', 'wait', 'proactive', 'sticker', 'feedback', 'context', 'gapNotice', 'tokenFuse', 'sharedMemory']) {
            if (body[sub] !== undefined && (body[sub] === null || typeof body[sub] !== 'object' || Array.isArray(body[sub]))) {
              merged[sub] = current[sub] ?? {};
            }
          }
          if (body.gapNotice && typeof body.gapNotice === 'object' && !Array.isArray(body.gapNotice)) {
            merged.gapNotice = normalizeGapNoticeConfig({ ...(current.gapNotice || {}), ...body.gapNotice });
          }
          if (merged.autoReplyCheckMs !== undefined) {
            const n = Number(merged.autoReplyCheckMs);
            merged.autoReplyCheckMs = Number.isFinite(n) ? Math.max(1000, Math.round(n)) : (current.autoReplyCheckMs ?? 30000);
          }
          // tools：只接受布尔开关
          // 从唯一来源派生（src/tool-flags.js），避免手写清单与真实工具漂移。
          // fixed 项（无条件注册的只读工具）不接受开关，前端也不会提交。
          const toolFlags = TOOL_FLAGS.filter((x) => x.fixed !== true).map((x) => x.flag);
          if (body.tools && typeof body.tools === 'object') {
            merged.tools = { ...(current.tools ?? {}), ...body.tools };
            for (const k of toolFlags) {
              if (typeof merged.tools[k] !== 'boolean') merged.tools[k] = current.tools?.[k] !== false;
            }
          }
          // wake：数值与字符串数组归一化
          if (body.wake && typeof body.wake === 'object') {
            merged.wake = { ...(current.wake ?? {}), ...body.wake };
            for (const k of ['sleepMinMs', 'sleepMaxMs', 'recommendedSleepMinMs', 'recommendedSleepMaxMs', 'recommendedProbability', 'batchWindowMs', 'maxWakePerMinute', 'maxWakePerHour', 'noActionLimit', 'maxWakeConfigReminders', 'preSleepWaitMs', 'preSleepReplyGraceMs']) {
              if (merged.wake[k] !== undefined) {
                const n = Number(merged.wake[k]);
                merged.wake[k] = Number.isFinite(n) ? n : current.wake?.[k] ?? 0;
                // 毫秒/次数类字段统一非负取整；概率字段单独 clamp。
                if (k !== 'recommendedProbability') merged.wake[k] = Math.max(0, Math.round(merged.wake[k]));
              }
            }
            if (merged.wake.recommendedProbability !== undefined) merged.wake.recommendedProbability = Math.min(1, Math.max(0, Number(merged.wake.recommendedProbability) || 0));
            if (merged.wake.preSleepWaitEnabled !== undefined) merged.wake.preSleepWaitEnabled = merged.wake.preSleepWaitEnabled === true;
            if (merged.wake.recommendedDefaultInfinite !== undefined) merged.wake.recommendedDefaultInfinite = merged.wake.recommendedDefaultInfinite === true;
            if (merged.wake.recommendedPoke !== undefined) merged.wake.recommendedPoke = merged.wake.recommendedPoke === true;
            if (merged.wake.recommendedKeywords !== undefined) {
              merged.wake.recommendedKeywords = (Array.isArray(merged.wake.recommendedKeywords) ? merged.wake.recommendedKeywords : String(merged.wake.recommendedKeywords).split(/[,，\s]+/)).map(String).filter(Boolean);
            }
            if (merged.wake.defaultMode !== 'active') merged.wake.defaultMode = 'diving';
            if (merged.wake.recommendedHint !== undefined) merged.wake.recommendedHint = String(merged.wake.recommendedHint ?? '');
          }
          // send：数值归一化
          if (body.send && typeof body.send === 'object') {
            merged.send = { ...(current.send ?? {}), ...body.send };
            for (const k of ['burstMaxMessages', 'burstIntervalMinMs', 'burstIntervalMaxMs', 'longGapProbability', 'longGapMinMs', 'longGapMaxMs', 'maxSendPerMinute', 'maxSendPerHour', 'maxMessageChars', 'maxGapMs', 'gapBaseMs', 'gapPerCharMs']) {
              if (merged.send[k] !== undefined) {
                const n = Number(merged.send[k]);
                merged.send[k] = Number.isFinite(n) ? n : current.send?.[k] ?? 0;
                // 次数/毫秒/字符数统一非负取整；概率字段单独 clamp。
                if (k !== 'longGapProbability') merged.send[k] = Math.max(0, Math.round(merged.send[k]));
              }
            }
            if (merged.send.longGapProbability !== undefined) merged.send.longGapProbability = Math.min(1, Math.max(0, Number(merged.send.longGapProbability) || 0));
            if (merged.send.burstEnabled !== undefined) merged.send.burstEnabled = merged.send.burstEnabled === true;
            if (merged.send.recommendedHint !== undefined) merged.send.recommendedHint = String(merged.send.recommendedHint ?? '');
            // autoAt：概率 0~1，时间/次数非负取整。子对象是浅合并进来的，
            // 不归一化的话控制台传字符串（"0.5"）或负数会直接进判定逻辑。
            if (body.send.autoAt && typeof body.send.autoAt === 'object' && !Array.isArray(body.send.autoAt)) {
              const cur = current.send?.autoAt ?? {};
              const next = { ...cur, ...body.send.autoAt };
              next.enabled = next.enabled === true;
              const prob = Number(next.probability);
              next.probability = Number.isFinite(prob) ? Math.min(1, Math.max(0, prob)) : (cur.probability ?? DEFAULT_AUTO_AT.probability);
              for (const k of ['windowMs', 'cooldownMs', 'maxPerHour']) {
                const n = Number(next[k]);
                next[k] = Number.isFinite(n) ? Math.max(0, Math.round(n)) : (cur[k] ?? DEFAULT_AUTO_AT[k]);
              }
              merged.send.autoAt = next;
            }
          }
          // wait：数值归一化
          if (body.wait && typeof body.wait === 'object') {
            merged.wait = { ...(current.wait ?? {}), ...body.wait };
            for (const k of ['defaultMs', 'minMs', 'maxMs', 'defaultQuietMs', 'minQuietAfterNewMs', 'maxQuietMs', 'turnMaxCount', 'turnMaxMs']) {
              if (merged.wait[k] !== undefined) {
                const n = Number(merged.wait[k]);
                merged.wait[k] = Number.isFinite(n) ? Math.max(0, Math.round(n)) : current.wait?.[k] ?? 5000;
              }
            }
            if (merged.wait.maxQuietMs !== undefined) merged.wait.maxQuietMs = Math.min(15000, Math.max(0, merged.wait.maxQuietMs));
            if (merged.wait.turnMaxCount !== undefined) merged.wait.turnMaxCount = Math.min(20, Math.max(1, merged.wait.turnMaxCount));
            if (merged.wait.turnMaxMs !== undefined) merged.wait.turnMaxMs = Math.min(600000, Math.max(5000, merged.wait.turnMaxMs));
          }
          // tts：语音合成参数（2026-10-22 用户要求「触发概率、每小时上限、模型设置、
          // 字数等设成可变参数并提供修改按钮」）。
          //
          // 这里逐项 clamp，不做"信任前端"那套：
          //   - probability 必须在 0~1（有人会填 5 表示 5%，得救回来）；
          //   - maxPerHour / maxChars 有上下界（0 条 = 禁用；字数太大语速劝退）；
          //   - enabled 只接受布尔，避免 "false" 字符串被当成真值。
          if (body.tts && typeof body.tts === 'object' && !Array.isArray(body.tts)) {
            merged.tts = { ...(current.tts ?? {}), ...body.tts };
            const t = merged.tts;
            const prev = current.tts ?? {};
            if (t.enabled !== undefined) t.enabled = t.enabled === true;
            // 概率：接受 0~1 的小数；也容忍 0~100 的百分数写法（>1 时按百分数折算）
            if (t.probability !== undefined) {
              let p = Number(t.probability);
              if (!Number.isFinite(p)) p = Number(prev.probability ?? TTS_DEFAULT_PROBABILITY);
              if (p > 1) p = p / 100;
              t.probability = Math.min(1, Math.max(0, Math.round(p * 1000) / 1000));
            }
            if (t.maxPerHour !== undefined) {
              const n = Number(t.maxPerHour);
              t.maxPerHour = Number.isFinite(n) ? Math.min(60, Math.max(0, Math.round(n))) : (Number(prev.maxPerHour) || 3);
            }
            if (t.maxChars !== undefined) {
              const n = Number(t.maxChars);
              t.maxChars = Number.isFinite(n) ? Math.min(300, Math.max(10, Math.round(n))) : (Number(prev.maxChars) || 140);
            }
            // 模型设置：路径与音色名只做字符串化 + 去空白；不校验存在性——
            // 路径可能暂时不可达（外接盘没插），不该因此拒绝保存其它参数。
            // voiceId/weightsId/refMode 是音色预设选择（voices.json），
            // 与手写路径二选一；有 voiceId 时以预设为准。
            for (const k of ['dir', 'gptModel', 'sovitsModel', 'refAudio', 'refText', 'refLang', 'voiceName', 'device', 'voiceId', 'weightsId', 'refMode']) {
              if (t[k] !== undefined) t[k] = String(t[k] ?? '').trim();
            }
            if (t.isHalf !== undefined) t.isHalf = t.isHalf !== false;
            if (t.cpuThreads !== undefined) {
              const n = Number(t.cpuThreads);
              t.cpuThreads = Number.isFinite(n) ? Math.min(32, Math.max(1, Math.round(n))) : (Number(prev.cpuThreads) || 8);
            }
            // 韵律/响度参数（2026-10-22 方案 B）：都是请求级参数，改完即时生效。
            // 必须用小数 clamp（ttsNum 会取整，speed 0.95 会被弄成 1）。
            const clampDec = (k, min, max, dflt) => {
              if (t[k] === undefined) return;
              const n = Number(t[k]);
              t[k] = Number.isFinite(n)
                ? Math.min(max, Math.max(min, Math.round(n * 1000) / 1000))
                : dflt;
            };
            clampDec('speed', 0.8, 1.2, 1.0);
            clampDec('fragmentInterval', 0.1, 0.6, 0.3);
            clampDec('temperature', 0.5, 1.2, 0.9);
            clampDec('topK', 5, 30, 15);
            clampDec('topP', 0.7, 1.0, 0.95);
            clampDec('volumeGainDb', -12, 12, 0);
            if (t.textSplitMethod !== undefined) {
              const s = String(t.textSplitMethod ?? '').trim();
              t.textSplitMethod = ['cut1', 'cut5'].includes(s) ? s : 'cut5';
            }
            if (t.punctuate !== undefined) t.punctuate = t.punctuate !== false && t.punctuate !== 'false';
          }
          // proactive：主动机会参数
          if (body.proactive && typeof body.proactive === 'object') {
            merged.proactive = { ...(current.proactive ?? {}), ...body.proactive };
            for (const k of ['checkIntervalMinMs', 'checkIntervalMaxMs', 'idleThresholdMs', 'probability']) {
              if (merged.proactive[k] !== undefined) {
                const n = Number(merged.proactive[k]);
                merged.proactive[k] = Number.isFinite(n) ? n : current.proactive?.[k] ?? 0;
                // 毫秒类字段统一非负取整；概率字段单独 clamp。
                if (k !== 'probability') merged.proactive[k] = Math.max(0, Math.round(merged.proactive[k]));
              }
            }
            if (merged.proactive.enabled !== undefined) merged.proactive.enabled = merged.proactive.enabled === true;
            if (merged.proactive.probability !== undefined) merged.proactive.probability = Math.min(1, Math.max(0, Number(merged.proactive.probability) || 0));
          }
          // sticker：表情包体系参数归一化
          if (body.sticker && typeof body.sticker === 'object') {
            merged.sticker = { ...(current.sticker ?? {}), ...body.sticker };
            if (merged.sticker.enabled !== undefined) merged.sticker.enabled = merged.sticker.enabled === true;
            for (const k of ['syncTtlMs', 'maxListCount', 'promptMaxStickers']) {
              if (merged.sticker[k] !== undefined) {
                const n = Number(merged.sticker[k]);
                merged.sticker[k] = Number.isFinite(n) ? Math.max(0, Math.round(n)) : current.sticker?.[k] ?? 0;
              }
            }
            if (merged.sticker.maxListCount !== undefined) merged.sticker.maxListCount = Math.min(500, Math.max(1, merged.sticker.maxListCount));
            if (merged.sticker.promptMaxStickers !== undefined) merged.sticker.promptMaxStickers = Math.min(30, Math.max(1, merged.sticker.promptMaxStickers));
            if (merged.sticker.includeInPrompt !== undefined) merged.sticker.includeInPrompt = merged.sticker.includeInPrompt === true;
            if (merged.sticker.readLocalCache !== undefined) merged.sticker.readLocalCache = merged.sticker.readLocalCache === true;
            // 主动要求发表情（2026-10-22）：参数来自控制台，这里逐项 clamp。
            // 概率同 TTS 的约定——接受 0~1，也容忍 0~100 的百分数写法。
            if (merged.sticker.autoNudge !== undefined) merged.sticker.autoNudge = merged.sticker.autoNudge === true;
            if (merged.sticker.autoNudgeProbability !== undefined) {
              let p = Number(merged.sticker.autoNudgeProbability);
              if (!Number.isFinite(p)) p = Number(current.sticker?.autoNudgeProbability ?? 0.33);
              if (p > 1) p = p / 100;
              merged.sticker.autoNudgeProbability = Math.min(1, Math.max(0, Math.round(p * 1000) / 1000));
            }
            if (merged.sticker.autoNudgeMinGapMs !== undefined) {
              const n = Number(merged.sticker.autoNudgeMinGapMs);
              merged.sticker.autoNudgeMinGapMs = Number.isFinite(n) ? Math.max(0, Math.round(n)) : (Number(current.sticker?.autoNudgeMinGapMs) || 180000);
            }
            if (merged.sticker.autoNudgeMaxPerHour !== undefined) {
              const n = Number(merged.sticker.autoNudgeMaxPerHour);
              merged.sticker.autoNudgeMaxPerHour = Number.isFinite(n) ? Math.min(60, Math.max(0, Math.round(n))) : (Number(current.sticker?.autoNudgeMaxPerHour) ?? 6);
            }
            if (merged.sticker.autoNudgeCandidates !== undefined) {
              const n = Number(merged.sticker.autoNudgeCandidates);
              merged.sticker.autoNudgeCandidates = Number.isFinite(n) ? Math.min(4, Math.max(1, Math.round(n))) : (Number(current.sticker?.autoNudgeCandidates) || 3);
            }
            if (body.sticker.collect && typeof body.sticker.collect === 'object') {
              merged.sticker.collect = { ...(current.sticker?.collect ?? {}), ...body.sticker.collect };
              if (merged.sticker.collect.enabled !== undefined) merged.sticker.collect.enabled = merged.sticker.collect.enabled === true;
              for (const k of ['maxPerMinute', 'maxPerHour', 'maxRemarkChars']) {
                if (merged.sticker.collect[k] !== undefined) {
                  const n = Number(merged.sticker.collect[k]);
                  merged.sticker.collect[k] = Number.isFinite(n) ? Math.max(0, Math.round(n)) : current.sticker?.collect?.[k] ?? 0;
                }
              }
            }
          }
          // comply：群友点单的照做判定参数归一化
          if (body.comply && typeof body.comply === 'object') {
            merged.comply = { ...(current.comply ?? {}), ...body.comply };
            if (merged.comply.enabled !== undefined) merged.comply.enabled = merged.comply.enabled === true;
            for (const k of ['ttlMs', 'cooldownMs', 'maxPerHour']) {
              if (merged.comply[k] !== undefined) {
                const n = Number(merged.comply[k]);
                merged.comply[k] = Number.isFinite(n) ? Math.max(0, Math.round(n)) : current.comply?.[k] ?? 0;
              }
            }
            if (merged.comply.probability !== undefined) {
              merged.comply.probability = Math.min(1, Math.max(0, Number(merged.comply.probability) || 0));
            }
          } else if (body.comply === undefined && merged.comply === undefined) {
            // 旧配置没有该块时补默认，保证 qq_get_prompt/判定能读到。
            merged.comply = current.comply ?? {};
          }
          // gifFrames：动图抽帧拼图参数归一化
          if (body.gifFrames && typeof body.gifFrames === 'object') {
            merged.gifFrames = { ...(current.gifFrames ?? {}), ...body.gifFrames };
            if (merged.gifFrames.enabled !== undefined) merged.gifFrames.enabled = merged.gifFrames.enabled === true;
            for (const k of ['timeoutMs']) {
              if (merged.gifFrames[k] !== undefined) {
                const n = Number(merged.gifFrames[k]);
                merged.gifFrames[k] = Number.isFinite(n) ? Math.max(0, Math.round(n)) : current.gifFrames?.[k] ?? 0;
              }
            }
            if (merged.gifFrames.maxFrames !== undefined) {
              const n = Number(merged.gifFrames.maxFrames);
              merged.gifFrames.maxFrames = Number.isFinite(n) ? Math.min(20, Math.max(2, Math.round(n))) : (current.gifFrames?.maxFrames ?? 20);
            }
            if (merged.gifFrames.tileWidth !== undefined) {
              const n = Number(merged.gifFrames.tileWidth);
              merged.gifFrames.tileWidth = Number.isFinite(n) ? Math.min(640, Math.max(80, Math.round(n))) : (current.gifFrames?.tileWidth ?? 320);
            }
          }
          // media：单条消息图片总量上限等
          if (body.media && typeof body.media === 'object') {
            merged.media = { ...(current.media ?? {}), ...body.media };
            if (merged.media.maxMessageBytes !== undefined) {
              const n = Number(merged.media.maxMessageBytes);
              // 下限 1MB：再小会让常见表情包都发不出去；上限 64MB：避免把内存打爆。
              merged.media.maxMessageBytes = Number.isFinite(n)
                ? Math.min(64 * 1024 * 1024, Math.max(1024 * 1024, Math.round(n)))
                : (current.media?.maxMessageBytes ?? 8 * 1024 * 1024);
            }
          }
          // errorNotice：上游报错拦截（节流窗口 / 文案 / 是否私聊管理员 / 是否在群里发提示）
          if (body.errorNotice && typeof body.errorNotice === 'object') {
            merged.errorNotice = { ...(current.errorNotice ?? {}), ...body.errorNotice };
            if (merged.errorNotice.windowMs !== undefined) {
              const n = Number(merged.errorNotice.windowMs);
              // 下限 0（每次必发，调试用）；上限 1 小时：再长会让限流提示形同关闭。
              merged.errorNotice.windowMs = Number.isFinite(n)
                ? Math.min(60 * 60 * 1000, Math.max(0, Math.round(n)))
                : (current.errorNotice?.windowMs ?? 3 * 60 * 1000);
            }
            if (Array.isArray(merged.errorNotice.messages)) {
              const msgs = merged.errorNotice.messages.map((m) => String(m ?? '').trim()).filter(Boolean);
              // 空数组会让「随机取一条」无从取值，回退到默认文案
              merged.errorNotice.messages = msgs.length ? msgs : DEFAULT_ERROR_MESSAGES;
            }
            // inGroup 默认 false（报错不进群）。只有显式传 true 才打开群内提示。
            if (merged.errorNotice.inGroup !== undefined) {
              merged.errorNotice.inGroup = merged.errorNotice.inGroup === true;
            }
          }
          // images：图库参数归一化（sources 逐层合并，避免外层 spread 覆盖丢默认）
          if (body.images && typeof body.images === 'object') {
            merged.images = { ...(current.images ?? {}), ...body.images };
            if (merged.images.enabled !== undefined) merged.images.enabled = merged.images.enabled === true;
            if (merged.images.annotateSource !== undefined) merged.images.annotateSource = merged.images.annotateSource === true;
            for (const k of ['maxFiles', 'maxTotalBytes', 'maxBytesPerFile', 'fetchPerRun', 'cooldownMs', 'sendCooldownMs', 'maxSendPerHour']) {
              if (merged.images[k] !== undefined) {
                const n = Number(merged.images[k]);
                merged.images[k] = Number.isFinite(n) ? Math.max(0, Math.round(n)) : current.images?.[k] ?? 0;
              }
            }
            if (merged.images.libDir !== undefined) merged.images.libDir = String(merged.images.libDir ?? '');
            if (body.images.sources && typeof body.images.sources === 'object') {
              const cur = current.images?.sources ?? {};
              merged.images.sources = { ...cur };
              for (const [name, sc] of Object.entries(body.images.sources)) {
                if (!sc || typeof sc !== 'object') continue;
                merged.images.sources[name] = { ...(cur[name] ?? {}), ...sc };
                const one = merged.images.sources[name];
                if (one.enabled !== undefined) one.enabled = one.enabled === true;
                if (one.limit !== undefined) {
                  const n = Number(one.limit);
                  one.limit = Number.isFinite(n) ? Math.min(100, Math.max(1, Math.round(n))) : 20;
                }
                if (one.tags !== undefined) {
                  one.tags = (Array.isArray(one.tags) ? one.tags : String(one.tags).split(/[,，\s]+/)).map(String).filter(Boolean);
                }
              }
            }
          }
          // feedback：数值/布尔归一化
          if (body.feedback && typeof body.feedback === 'object') {
            merged.feedback = { ...(current.feedback ?? {}), ...body.feedback };
            if (merged.feedback.maxLength !== undefined) {
              const n = Number(merged.feedback.maxLength);
              merged.feedback.maxLength = Number.isFinite(n) ? Math.max(1, Math.round(n)) : current.feedback?.maxLength ?? 500;
            }
            if (merged.feedback.notifyOwnerOnError !== undefined) merged.feedback.notifyOwnerOnError = merged.feedback.notifyOwnerOnError === true;
          }
          // context：数值归一化
          if (body.context && typeof body.context === 'object') {
            merged.context = { ...(current.context ?? {}), ...body.context };
            for (const k of ['recentLimit', 'unreadLimit', 'contextWindow']) {
              if (merged.context[k] !== undefined) {
                const n = Number(merged.context[k]);
                merged.context[k] = Number.isFinite(n) ? Math.max(1, Math.round(n)) : current.context?.[k] ?? 20;
              }
            }
          }
          if (merged.enabled !== undefined) merged.enabled = merged.enabled === true;
          if (merged.provideRecommendations !== undefined) merged.provideRecommendations = merged.provideRecommendations === true;
          if (merged.agentPreset !== undefined) merged.agentPreset = String(merged.agentPreset ?? '');
          file.socialV2 = merged;
          atomicWriteJson(configFile, file);
          cfg.socialV2 = { ...(cfg.socialV2 ?? {}), ...merged };
          // 仅当“会影响默认唤醒配置”的字段变化时，才同步到仍使用默认配置的现有会话。
          // 避免只改发送/等待/工具开关时，意外重置正在等待的潜水/唤醒计划。
          const WAKE_DEFAULT_KEYS = [
            'defaultMode', 'recommendedDefaultInfinite',
            'recommendedSleepMinMs', 'recommendedSleepMaxMs',
            'recommendedProbability', 'recommendedKeywords',
            'recommendedAtMention', 'recommendedNameMention', 'recommendedQuestion', 'recommendedPoke',
            'sleepMinMs', 'sleepMaxMs', 'batchWindowMs'
          ];
          const wakeDefaultChanged = body.wake && typeof body.wake === 'object' &&
            WAKE_DEFAULT_KEYS.some((k) => Object.prototype.hasOwnProperty.call(body.wake, k));
          if (wakeDefaultChanged) refreshAllDefaultWakeConfigsV2();
          log('控制台：二代仿真配置已更新');
          sendJson({ ok: true, config: cfg.socialV2 });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/activity') {
          sendJson({ ok: true, paused: socialV2.paused });
          return;
        }
        // 活动日志改版：按“消息”聚合状态，而不是只追加一行文本。
        // 前端每秒拉一次，状态由当前 unread / pending / answeredSeqs 实时推导：
        // 未读 → 处理中/待回复 → 已回复/已读；自己发出的消息显示已发送/语音已发。
        if (req.method === 'GET' && url.pathname === '/api/socialV2/activity-feed') {
          const limit = Math.min(200, Math.max(20, Number(url.searchParams.get('limit')) || 120));
          const rows = [];
          const cleanDisplay = (v, n) => String(v ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
          const keyOfMsg = (m) => (m?.messageId != null && String(m.messageId) !== 'null')
            ? `id:${m.messageId}`
            : `seq:${Number(m?.seq) || 0}`;
          for (const [key, st] of socialV2.conversations.entries()) {
            if (!/^(group|private):\d+$/.test(key)) continue;
            const recent = Array.isArray(st.recentMessages) ? st.recentMessages.slice(-20) : [];
            if (!recent.length) continue;
            const callers = findCallersV2(key, st);
            const pendingKeys = new Set();
            const answeredKeys = new Set();
            for (const m of callers.pending) { pendingKeys.add(keyOfMsg(m)); if (m.seq) pendingKeys.add(`seq:${Number(m.seq)}`); }
            for (const m of callers.answered) { answeredKeys.add(keyOfMsg(m)); if (m.seq) answeredKeys.add(`seq:${Number(m.seq)}`); }
            const unreadSeqs = new Set((Array.isArray(st.unread) ? st.unread : []).map((m) => Number(m?.seq)).filter(Number.isFinite));
            const unreadIds = new Set((Array.isArray(st.unread) ? st.unread : []).map((m) => m?.messageId != null ? String(m.messageId) : '').filter(Boolean));
            const busy = isConversationBusyV2(key, st);
            const displayName = contextDisplayName(key) || '';
            const keyLabel = key.replace(/^group:/, '群 ').replace(/^private:/, '私聊 ');
            for (const m of recent) {
              if (!m) continue;
              const text = cleanDisplay(m.text ?? m.plain ?? '', 240);
              const isSelf = !!m.isSelf;
              const isVoice = !!(m.isVoice || /^\[语音\]/.test(text));
              const mk = keyOfMsg(m);
              const inUnread = !isSelf && ((m.seq && unreadSeqs.has(Number(m.seq)))
                || (m.messageId != null && unreadIds.has(String(m.messageId))));
              let status = 'read';
              let label = '已读';
              if (isSelf) {
                status = isVoice ? 'voice-sent' : 'sent';
                label = isVoice ? '语音已发' : '已发送';
              } else if (pendingKeys.has(mk)) {
                status = busy ? 'processing' : 'pending';
                label = busy ? '处理中' : '待回复';
              } else if (answeredKeys.has(mk)) {
                status = 'replied';
                label = '已回复';
              } else if (inUnread) {
                status = 'unread';
                label = '未读';
              }
              rows.push({
                key,
                session: cleanDisplay(displayName || keyLabel, 80),
                sessionKey: keyLabel,
                time: Number(m.time) || 0,
                sender: isSelf ? '我' : cleanDisplay(m.sender || '未知', 60),
                userId: m.userId != null ? String(m.userId) : '',
                text,
                isSelf,
                isVoice,
                status,
                label,
                seq: Number(m.seq) || 0,
                messageId: m.messageId != null ? String(m.messageId) : ''
              });
            }
          }
          rows.sort((a, b) => b.time - a.time);
          const counts = rows.reduce((acc, r) => {
            acc[r.status] = (acc[r.status] || 0) + 1;
            return acc;
          }, { pending: 0, processing: 0, replied: 0, unread: 0, read: 0, sent: 0, 'voice-sent': 0 });
          sendJson({ ok: true, rows: rows.slice(0, limit), counts, generatedAt: Date.now() });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/activity') {
          const body = await readBody();
          const paused = body.paused === true;
          socialV2.paused = paused;
          if (paused) {
            clearAllSocialV2Timers();
            log('控制台：二代 AI 已暂停（唤醒/等待任务已停止）');
          } else {
            log('控制台：二代 AI 已恢复');
            for (const key of socialV2.conversations.keys()) {
            setupSleepTimerV2(key);
            scheduleProactiveCheckV2(key);
          }
          }
          saveSocialV2State();
          sendJson({ ok: true, paused: socialV2.paused });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/reset') {
          deps.ops.bumpSessionEpoch();
          sessionPromises.clear();
          clearAllSocialV2Timers();
          drainAllPromptQueues('二代状态已重置');
          for (const key of [...socialV2.conversations.keys()]) {
            const sid = state.sessions[key];
            if (sid) {
              deps.ops.recordSessionHistory?.(sid, key, 'reset');
              delete state.sessions[key];
              if (state.sessionMeta) delete state.sessionMeta[key];
              reverse.delete(sid);
              deps.ops.clearSessionTracking(sid);
              collectors.delete(sid);
              v2TurnStartAt.delete(sid);
              toolCallNames.delete(sid);
              pendingSendToolCalls.delete(sid);
              sendToolSucceededSessions.delete(sid);
            }
            const removedV2 = socialV2.conversations.get(key);
            if (removedV2?.agentToken) KNOWN_AGENT_TOKENS.delete(removedV2.agentToken);
            socialV2.conversations.delete(key);
            seenForwardIds.delete(key);
          }
          pendingWakeKeys.clear();
          clearAllPendingWakeLeases();
          wakeConfigUpdatedKeys.clear();
          markReadCalledKeys.clear();
          wakeConfigMissCount.clear();
          socialV2.paused = false;
          try { atomicWriteJson(SOCIAL_V2_FILE, { conversations: {} }); } catch (error) { log('重置二代状态：写空状态文件失败:', error?.message ?? error); }
          log('控制台：二代 AI 状态已重置（会话、定时器、唤醒配置已清空，工具日志保留）');
          sendJson({ ok: true });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/state') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('socialState')) { sendJson({ ok: false, error: '工具未启用：qq_social_state' }, 403); return; }
          const st = getSocialV2State(key);
          sendJson({
            ok: true,
            key,
            wakeConfig: st.wakeConfig,
            wakeSafety: computeWakeSafetyV2(st.wakeConfig),
            unreadCount: st.unread.length,
            recentCount: st.recentMessages.length,
            lastWakeReason: st.lastWakeReason,
            lastAiReplyAt: st.lastAiReplyAt
          });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/prompt') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getPrompt')) { sendJson({ ok: false, error: '工具未启用：qq_get_prompt' }, 403); return; }
          const st = getSocialV2State(key);
          // 让 prompt 里的表情摘要尽量新鲜：按 TTL 同步一次 QQ 收藏表情（失败不阻塞）。
          if (cfg.socialV2?.sticker?.enabled !== false) {
            try { await syncStickerLibrary(false); } catch {}
          }
          const roleName = roleFor(key);
          const toolMap = {
            getPrompt: 'qq_get_prompt',
            getUnread: 'qq_get_unread_messages',
            getRecent: 'qq_get_recent_messages',
            socialState: 'qq_social_state',
            sendGroup: 'qq_send_group_message',
            sendPrivate: 'qq_send_private_message',
            reply: 'qq_reply',
            sendBurst: 'qq_send_burst',
            sendMessage: 'qq_send_message',
            waitMessages: 'qq_wait_for_messages',
            feedback: 'qq_report_feedback',
            getMyRecent: 'qq_get_my_recent_messages',
            getMessageDetail: 'qq_get_message_detail',
            getActiveMembers: 'qq_get_active_members',
            setWakeConfig: 'qq_set_wake_config',
            markRead: 'qq_mark_read',
            memory: 'qq_memory_append / qq_memory_query / qq_memory_remove / qq_memory_clear',
            slangQuery: 'qq_slang_query',
            slangSubmit: 'qq_slang_submit',
            getImages: 'qq_get_message_images',
            getForwardMsg: 'qq_get_forward_msg',
            sendPoke: 'qq_send_poke',
            sendImage: 'qq_send_image',
            checkImage: 'qq_check_image',
            refreshImageLib: 'qq_refresh_image_lib',
            listStickers: 'qq_list_stickers',
            getStickerImage: 'qq_get_sticker_image',
            sendSticker: 'qq_send_sticker',
            setStickerRemark: 'qq_set_sticker_remark',
            deleteSticker: 'qq_delete_sticker',
            stickerNote: 'qq_sticker_note',
            collectSticker: 'qq_collect_sticker',
            getSelfImage: 'qq_get_self_image',
            getFeatureMenu: 'qq_send_feature_menu',
            groupFiles: 'qq_list_group_files',
            reverseSearch: 'qq_reverse_search'
          };
          const tools = cfg.socialV2?.tools ?? {};
          const stickerToolFlags = new Set(['listStickers', 'getStickerImage', 'sendSticker', 'setStickerRemark', 'stickerNote', 'collectSticker', 'deleteSticker']);
          const enabledTools = [];
          for (const [flag, name] of Object.entries(toolMap)) {
            if (tools[flag] !== false && !(stickerToolFlags.has(flag) && !stickerEnabled())) enabledTools.push(name);
          }
          sendJson({
            ok: true,
            key,
            time: new Date().toISOString(),
            role: { name: roleName ?? null, hint: deps.live.currentMode === 'reserved2' ? currentRoleHintV2(key) : currentRoleHint(key) },
            ownerQQ: cfg.ownerQQ ?? null,
            recommended: cfg.socialV2?.provideRecommendations === false ? null : {
              wake: cfg.socialV2?.wake ?? {},
              send: cfg.socialV2?.send ?? {},
              wait: cfg.socialV2?.wait ?? {},
              proactive: cfg.socialV2?.proactive ?? {},
              comply: cfg.socialV2?.comply ?? {}
            },
            enabledTools,
            unreadCount: st.unread.length,
            recentCount: st.recentMessages.length,
            currentWakeConfig: st.wakeConfig,
            wakeSafety: computeWakeSafetyV2(st.wakeConfig),
            memory: formatMemoryV2(st),
            participation: formatParticipationV2(st),
            slang: {
              enabled: cfg.slang?.enabled !== false,
              entries: confirmedSlangListV2(),
              block: buildSlangContext(deps.live.slangEntries, cfg.slang?.injectMax ?? 8)
            },
            stickers: {
              enabled: cfg.socialV2?.sticker?.enabled !== false,
              total: deps.live.stickerEntries.length,
              context: cfg.socialV2?.sticker?.includeInPrompt !== false ? buildStickerContext(deps.live.stickerEntries, cfg.socialV2?.sticker?.promptMaxStickers ?? 8, stickerCacheOpts()) : '',
              strategy: cfg.socialV2?.sticker?.includeInPrompt !== false ? buildStickerStrategyHint() : ''
            }
          });
          return;
        }
        // ── 群文件只读分类（见 group-files.js）──────────────────────────────
        // 只读：列文件、统计、搜索。**不删除/移动/上传/改名** ——
        // 那些写操作 API 确实存在且会真实执行（已实测 delete_group_file），
        // 但群文件里的 docx/pdf 删了不可恢复，不做进工具。
        if (req.method === 'GET' && url.pathname === '/api/socialV2/group-files') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const keyMatch = /^group:(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: '群文件只适用于群会话（key 格式 group:群号）' }, 400); return; }
          if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: '读取群文件必须携带 agent token' }, 403); return; }
          if (!agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (!v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (!v2ToolEnabled('groupFiles')) { sendJson({ ok: false, error: '工具未启用：qq_list_group_files' }, 403); return; }
          const groupId = Number(keyMatch[1]);
          try {
            // 取列表（走 OneBot，与其它只读查询同一通道）
            // 注意：SDK 的 call() 已经解包（returns response.data）且出错会 throw，
            // 所以这里直接读 .files，不要再套一层 .data（那是原始 HTTP 的形状）。
            const raw = await bot.getGroupRootFiles(groupId);
            const files = (raw && raw.files) || [];
            const mode = String(url.searchParams.get('mode') ?? 'summary');
            if (mode === 'search') {
              const q = {
                keyword: url.searchParams.get('keyword') || '',
                category: url.searchParams.get('category') || '',
                ext: url.searchParams.get('ext') || '',
                uploader: url.searchParams.get('uploader') || '',
                minBytes: Number(url.searchParams.get('minBytes')) || 0,
                maxBytes: Number(url.searchParams.get('maxBytes')) || 0,
                limit: Number(url.searchParams.get('limit')) || 20
              };
              const r = searchGroupFiles(files, q);
              sendJson({ ok: true, key, mode, query: q, ...r });
              return;
            }
            const summary = summarizeGroupFiles(files, { recentDays: Number(url.searchParams.get('recentDays')) || 7 });
            sendJson({ ok: true, key, mode: 'summary', summary, text: formatSummary(summary) });
          } catch (error) {
            log(`群文件读取失败 ${key}: ${error?.message ?? error}`);
            sendJson({ ok: false, error: `群文件读取失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/group-file-stats') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const keyMatch = /^group:(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: '群文件只适用于群会话（key 格式 group:群号）' }, 400); return; }
          if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: '读取群文件必须携带 agent token' }, 403); return; }
          if (!agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (!v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (!v2ToolEnabled('groupFiles')) { sendJson({ ok: false, error: '工具未启用：qq_group_file_stats' }, 403); return; }
          try {
            // 容量信息：让模型能回答"群文件满了吗"这类问题
            const info = await bot.getGroupFileSystemInfo(Number(keyMatch[1]));
            const d = info ?? {};   // SDK 已解包
            const used = Number(d.used_space) || 0;
            const total = Number(d.total_space) || 0;
            sendJson({
              ok: true,
              key,
              fileCount: Number(d.file_count) || 0,
              limitCount: Number(d.limit_count) || 0,
              usedSpace: used,
              totalSpace: total,
              usedText: humanSize(used),
              totalText: humanSize(total),
              usedPercent: total > 0 ? Math.round(used / total * 100) : null
            });
          } catch (error) {
            sendJson({ ok: false, error: `容量读取失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/unread') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 30));
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getUnread')) { sendJson({ ok: false, error: '工具未启用：qq_get_unread_messages' }, 403); return; }
          const st = getSocialV2State(key);
          sendJson({ ok: true, key, unreadCount: st.unread.length, messages: st.unread.slice(-limit) });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/recent') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 20));
          const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getRecent')) { sendJson({ ok: false, error: '工具未启用：qq_get_recent_messages' }, 403); return; }
          const st = getSocialV2State(key);
          const start = Math.max(0, st.recentMessages.length - offset - limit);
          const end = Math.max(0, st.recentMessages.length - offset);
          sendJson({ ok: true, key, messages: st.recentMessages.slice(start, end) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/mark-read') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('markRead')) { sendJson({ ok: false, error: '工具未启用：qq_mark_read' }, 403); return; }
          const st = getSocialV2State(key);
          // 硬拦截：未读里有人在叫它（@ 它的任一别名 / 引用它），而它这一轮还没发过言时，
          // 不允许直接已读收尾。实测模型会一边把「@大肥鱼 speak」「@大肥鱼 夸一夸…」当
          // 「没人叫我」忽略掉，一边 wait 完就 mark_read 走人，导致催它的人永远等不到回应
          // （提示词和 preset 都写了「被 @ 必须回」，但它仍会违反，所以必须有桥接侧硬约束）。
          {
            const callerMsgs = findCallersV2(key, st);
            // 只看 pending（还没答过的 @）。answered 是「已经回过的那条 @」——用
            // qq_send_message 不引用回复时它不会被移出未读（只有带 replyToMessageId 的
            // 发送才清理），于是会长期留在列表里。原先判 callerMsgs.length 把这类旧 @
            // 也算成「有人在叫你」，机器人明明已经把话说完了、想收尾时仍被拦下，
            // 只能硬凑一句话。实测 2026-10-12 被逼出这样一条真发进群的：
            //   「这两下 @ 我都应过了，管理员的「在的」、喊口号那个也拒了」
            // —— 只是把自己的调度状态念了一遍。answered 不该构成拦截理由。
            // —— 这里**不能**再叠 `repliedThisTurn`（本轮发过言就放行）。
            // pending 的判定基准是 lastAiReplyAt（最后一次发言时间）：只要 @ 比它晚，
            // 这条 @ 就是没答过的。而 repliedThisTurn 看的是「本轮有没有发过言」，
            // 一个更早的回复也会让它为 true。实测 2026-10-22 20:18:59 的 @ 就是被它
            // 放行的：机器人 20:14:38 发过言（那轮确实发过），20:20:51 wait 结束后
            // mark_read 把这条 @ 一并标读，靠 backfill 4 分钟后才补回，用户以为没理人。
            if (callerMsgs.pending.length) {
              const brief = callerMsgs.pending
                .slice(-3)
                .map((m) => `${String(m.sender || '某人')}：${String(m.text || m.plain || '').slice(0, 30)}`)
                .join('；');
              sendJson({
                ok: false,
                error: `未读里有人在叫你，不能就这样已读收尾：${brief}。请先正面回应（优先用 qq_reply；用 qq_send_message 时带 replyToMessageId，桥接才能确认你回的是哪条）；如果这条你确实办不到，就直接对群友说明办不到的原因——话说给对方听，不要报告自己的处理流程或调度状态。`,
                callers: callerMsgs.pending.length
              }, 400);
              return;
            }
          }
          // 如果当前已经是“潜水”唤醒配置，且最近还有对话/刚被唤醒，不允许用 mark_read 直接回到潜水；
          // 必须先等够沉睡前观察窗口，避免“聊两句又去潜水”。
          if (isSleepingConfigV2(st.wakeConfig) && preSleepWaitBlockedV2(st, key)) {
            const preSleepMs = Math.max(0, Number(cfg.socialV2?.wake?.preSleepWaitMs) || 300000);
            const remaining = Math.max(0, preSleepMs - ((st.lastIncomingAt || 0) ? Date.now() - st.lastIncomingAt : 0));
            const remainMin = Math.ceil(remaining / 60000);
            sendJson({
              ok: false,
              error: `还不能通过 qq_mark_read 直接回到潜水：还需等待约 ${remainMin} 分钟无新消息，或调用 qq_wait_for_messages(timeoutMs=${preSleepMs}) 完成一次沉睡前观察。如果等待期间有人发新消息，请先查看返回的 newMessages；判断不需要你参与就可以直接收尾沉睡，若你参与了则需下次再等观察窗口。`,
              preSleepWaitMs: preSleepMs,
              preSleepWaitRemainingMs: remaining
            }, 400);
            return;
          }
          const markedCount = st.unread.length;
          // 未读清理：**该清的要清干净**，否则会永久滞留并导致重复回答。
          //
          // 历史与两个坑：
          //   1. 原先这里写的是 `filter((m) => !pendingSeqs.has(seq))`——与它自己的注释
          //      （"保留命中排队 seq 的未读"）**正好相反**：它把排队中的消息**删掉**、
          //      留下其余全部。实测后果：11 条未读被反复"保留"，mark_read 每次都报
          //      "已读 0 条，保留 11 条"，于是**每一轮唤醒模型都看到同样那 11 条**，
          //      里面 4 条早前的 @ 被当成待办逐条补答 → 同一条消息被回复 3~4 次。
          //   2. 之所以当初想"保留排队消息"，是为了避免"繁忙期间入队的 @ 被顺手标掉、
          //      补发判定误判成已处理"（确有此事）。但正确做法是**只保留本轮唤醒之后
          //      新到的**——那些才是没被任何回合看过的。
          //
          // 判据用 seq 而不是时间：seq 是本地自增、单调，比时钟可靠。
          // 本轮唤醒后新到的消息 seq 一定大于唤醒时的水位。
          const wakeSeqAt = Number(st.wakeSeqAt) || 0;
          if (wakeSeqAt > 0) {
            st.unread = st.unread.filter((m) => Number(m?.seq) > wakeSeqAt);
          } else {
            // 拿不到水位（老状态/异常）时保守清空：宁可清掉也不让它永久滞留
            // ——滞留的代价是"无限重复回答"，比偶尔漏一条更严重。
            st.unread = [];
          }
          // 水位用掉即清，避免下一轮误用它去清刚到的消息。
          st.wakeSeqAt = 0;
          const keptUnread = st.unread.length;
          st.lastActionAt = Date.now();
          st.wakeConfig.noActionCount = 0;
          // 防止“有限潜水被 timeout 唤醒后 sleepUntil 被清空、又 mark_read 收尾”导致无定时器无触发条件的静默态。
          if (!st.wakeConfig.infinite && !st.wakeConfig.sleepUntil) {
            st.wakeConfig.infinite = true;
          }
          ensureWakeableV2(st, { key });
          st.wakeConfig.confirmedAt = Date.now();
          st.wakeConfig.confirmedBy = 'mark_read';
          markReadCalledKeys.add(key);
          saveSocialV2State();
          log(`[reserved2] 控制台/工具标记 ${key} 未读已读：${markedCount - keptUnread} 条${keptUnread ? `，保留 ${keptUnread} 条待补发唤醒的消息` : ''}，已确认下一次唤醒配置`);
          sendJson({ ok: true, key, markedCount, wakeGuaranteed: computeWakeSafetyV2(st.wakeConfig).guaranteed, wakeSafety: computeWakeSafetyV2(st.wakeConfig), wakeConfig: st.wakeConfig });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/wake-config') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('setWakeConfig')) { sendJson({ ok: false, error: '工具未启用：qq_set_wake_config' }, 403); return; }
          const st = getSocialV2State(key);
          const input = body.config && typeof body.config === 'object' && !Array.isArray(body.config) ? body.config : {};
          const current = st.wakeConfig;
          const inputTriggers = input.triggers && typeof input.triggers === 'object' && !Array.isArray(input.triggers) ? input.triggers : {};
          const normalizeTriggerBool = (name, fallback) => {
            if (name in inputTriggers) return inputTriggers[name] === true;
            return fallback;
          };
          const rawKeywords = inputTriggers.keywords;
          const nextKeywords = rawKeywords !== undefined
            ? (Array.isArray(rawKeywords)
                ? rawKeywords.map((k) => String(k ?? '').trim()).filter(Boolean).slice(0, 50).map((k) => k.slice(0, 100))
                : [])
            : (Array.isArray(current.triggers.keywords) ? current.triggers.keywords.slice(0, 50).map((k) => String(k).slice(0, 100)) : []);
          const next = {
            ...current,
            mode: input.mode === 'active' ? 'active' : input.mode === 'diving' ? 'diving' : current.mode,
            infinite: typeof input.infinite === 'boolean' ? input.infinite : current.infinite,
            sleepUntil: current.sleepUntil,
            triggers: {
              ...current.triggers,
              ...inputTriggers,
              atMention: normalizeTriggerBool('atMention', current.triggers.atMention === true),
              nameMention: normalizeTriggerBool('nameMention', current.triggers.nameMention === true),
              question: normalizeTriggerBool('question', current.triggers.question === true),
              anyMessage: normalizeTriggerBool('anyMessage', current.triggers.anyMessage === true),
              poke: normalizeTriggerBool('poke', current.triggers.poke === true),
              keywords: nextKeywords
            },
            batchWindowMs: Number.isFinite(Number(input.batchWindowMs)) && Number(input.batchWindowMs) >= 1000
              ? Math.min(3600000, Math.round(Number(input.batchWindowMs)))
              : current.batchWindowMs
          };
          // 从 active 切回 diving 时，若 AI 没显式保留 anyMessage，则清除，避免“潜水=每条都唤醒”的语义矛盾。
          if (next.mode === 'diving' && !('anyMessage' in inputTriggers)) {
            next.triggers.anyMessage = false;
          }
          if (next.mode === 'active') {
            next.infinite = true;
            next.sleepUntil = null;
            next.triggers.anyMessage = true;
          }
          if (typeof input.infinite === 'boolean' && next.mode !== 'active') next.infinite = input.infinite;
          if (next.infinite) {
            next.sleepUntil = null;
          } else if (input.sleepUntil) {
            const d = new Date(String(input.sleepUntil));
            if (!Number.isNaN(d.getTime())) next.sleepUntil = d.toISOString();
          } else if (Number.isFinite(Number(input.sleepMs))) {
            let ms = Math.max(0, Math.round(Number(input.sleepMs)));
            const minMs = Math.max(0, Number(cfg.socialV2?.wake?.sleepMinMs) || 0);
            const maxMs = Number(cfg.socialV2?.wake?.sleepMaxMs) || 0;
            if (ms < minMs) ms = minMs;
            if (maxMs > 0 && ms > maxMs) ms = maxMs;
            next.sleepUntil = new Date(Date.now() + ms).toISOString();
          } else if (!next.sleepUntil && !next.infinite) {
            // 既没有无限也没有时间：使用推荐默认有限时长
            const recMin = Number(cfg.socialV2?.wake?.recommendedSleepMinMs) || 300000;
            const recMax = Number(cfg.socialV2?.wake?.recommendedSleepMaxMs) || 7200000;
            const ms = recMin + Math.random() * Math.max(0, recMax - recMin);
            next.sleepUntil = new Date(Date.now() + Math.round(ms)).toISOString();
          }
          // 对有限 sleepUntil 也做 min/max clamp，防止绕过 sleepMaxMs
          if (!next.infinite && next.sleepUntil) {
            const maxMs = Number(cfg.socialV2?.wake?.sleepMaxMs) || 0;
            const minMs = Math.max(0, Number(cfg.socialV2?.wake?.sleepMinMs) || 0);
            let until = Date.parse(next.sleepUntil);
            if (Number.isFinite(until)) {
              if (minMs > 0 && until < Date.now() + minMs) until = Date.now() + minMs;
              if (maxMs > 0 && until > Date.now() + maxMs) until = Date.now() + maxMs;
              next.sleepUntil = new Date(until).toISOString();
            }
          }
          // 归一化概率
          if (next.triggers.probability !== undefined) {
            next.triggers.probability = Math.min(1, Math.max(0, Number(next.triggers.probability) || 0));
          }
          // 归一化拍一拍触发（只接受布尔，防脏字符串被当成 true）
          if (input.triggers && typeof input.triggers === 'object' && 'poke' in input.triggers) {
            next.triggers.poke = input.triggers.poke === true;
          }
          // 归一化“指定成员”触发：只保留正整数 QQ 号，去重，限制数量；
          // null/undefined/非法值统一清空，避免“null”被当成有效唤醒条件绕过防永眠。
          next.triggers.speakerIds = normalizeSpeakerIdsV2(next.triggers.speakerIds);
          // 私聊不适用“指定成员发言醒来”：清除以免误导/脏数据（私聊仍按原有逻辑每次消息都唤醒）。
          if (key.startsWith('private:')) {
            next.triggers.speakerIds = [];
          }
          // 防止 AI 永眠：无限期潜水必须至少有一个可触发条件
          if (next.infinite) {
            const tr = next.triggers ?? {};
            const hasTrigger = tr.atMention || tr.nameMention || tr.poke || (Array.isArray(tr.keywords) && tr.keywords.length > 0) || tr.question || tr.anyMessage || (Number(tr.probability) > 0) || (Array.isArray(tr.speakerIds) && tr.speakerIds.length > 0);
            if (!hasTrigger) {
              sendJson({ ok: false, error: '无限期潜水必须至少保留一个唤醒条件（@/名字/拍一拍/关键词/提问/anyMessage/概率>0），否则 AI 可能永眠' }, 400);
              return;
            }
          }
          // 硬拦截（与 qq_mark_read 同规则）：未读里有人叫它、而本轮还没回应时，
          // 不允许直接设置潜水/下一次唤醒就走人——否则催它的人永远等不到回应。
          // 判据同样只看 pending：已经回过的那条 @ 不构成拦截理由（详见 qq_mark_read 处的说明）。
          if (isSleepingConfigV2(next)) {
            const callerMsgs2 = findCallersV2(key, st);
            // 与 qq_mark_read 同理：pending 已按 lastAiReplyAt 判过，
            // 不能再叠「本轮发过言」——早于新 @ 的回复也会让那个条件成立。
            if (callerMsgs2.pending.length) {
              const brief2 = callerMsgs2.pending
                .slice(-3)
                .map((m) => `${String(m.sender || '某人')}：${String(m.text || m.plain || '').slice(0, 30)}`)
                .join('；');
              sendJson({
                ok: false,
                error: `未读里有人在叫你，不能先潜水走人：${brief2}。请先正面回应（优先用 qq_reply；用 qq_send_message 时带 replyToMessageId，桥接才能确认你回的是哪条），回应后再设置下一次唤醒；如果这条你确实办不到，就直接对群友说明办不到的原因——话说给对方听，不要报告自己的处理流程或调度状态。`,
                callers: callerMsgs2.pending.length
              }, 400);
              return;
            }
          }
          // 沉睡前强制观察窗口：除非对方明确结束、或已经安静/等待足够时间，否则不允许 AI 聊两句就设置潜水。
          if (isSleepingConfigV2(next) && preSleepWaitBlockedV2(st, key)) {
            const preSleepMs = Math.max(0, Number(cfg.socialV2?.wake?.preSleepWaitMs) || 300000);
            const remaining = Math.max(0, preSleepMs - ((st.lastIncomingAt || 0) ? Date.now() - st.lastIncomingAt : 0));
            const remainMin = Math.ceil(remaining / 60000);
            sendJson({
              ok: false,
              error: `还不能立刻设置潜水/下一次唤醒：还需等待约 ${remainMin} 分钟无新消息，或调用 qq_wait_for_messages(timeoutMs=${preSleepMs}) 完成一次沉睡前观察。如果等待期间有人发新消息，请先查看返回的 newMessages；判断不需要你参与就可以直接设置并沉睡，若你参与了则需下次再等观察窗口。`,
              preSleepWaitMs: preSleepMs,
              preSleepWaitRemainingMs: remaining
            }, 400);
            return;
          }
          st.wakeConfig = next;
          st.wakeConfig.lastWakeAt = st.wakeConfig.lastWakeAt || 0;
          st.wakeConfig.wakeCount = st.wakeConfig.wakeCount || 0;
          st.wakeConfig.noActionCount = 0;
          st.wakeConfig.confirmedAt = Date.now();
          st.wakeConfig.confirmedBy = 'set_wake_config';
          st.lastActionAt = Date.now();
          // 已成功设置下一次唤醒：本轮沉睡前观察标记作废，下次想再睡需重新走 5 分钟观察。
          st.preSleepWaitSatisfiedAt = 0;
          st.preSleepWaitObservedAt = 0;
          st.preSleepWaitAccumMs = 0;
          saveSocialV2State();
          wakeConfigUpdatedKeys.add(key);
          wakeConfigMissCount.delete(key);
          if (st.pendingWakeTimer) {
            clearTimeout(st.pendingWakeTimer);
            st.pendingWakeTimer = null;
          }
          cancelReplyCheckV2(key); // AI 已主动设置新的唤醒配置，取消回复检查
          setupSleepTimerV2(key);
          log(`[reserved2] 更新唤醒配置 ${key}: mode=${next.mode} infinite=${next.infinite} sleepUntil=${next.sleepUntil ?? 'null'}`);
          sendJson({ ok: true, key, wakeConfig: next, wakeSafety: computeWakeSafetyV2(next) });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/states') {
          const list = [];
          for (const [key, st] of socialV2.conversations) {
            // 诊断：把 isConversationBusyV2 的四个判据分别透出，便于定位「虚假繁忙」卡在哪一项
            const sid = state.sessions[key];
            const q = promptQueues.get(key);
            list.push({
              key,
              wakeConfig: st.wakeConfig,
              unreadCount: st.unread.length,
              recentCount: st.recentMessages.length,
              lastWakeReason: st.lastWakeReason,
              lastAiReplyAt: st.lastAiReplyAt,
              noActionCount: st.wakeConfig.noActionCount || 0,
              busy: isConversationBusyV2(key, st),
              busyBy: {
                pendingWakeTimer: !!st.pendingWakeTimer,
                pendingWakeKeys: pendingWakeKeys.has(key),
                promptQueue: !!(q && (q.running || q.queue.length > 0)),
                promptQueueRunning: !!(q && q.running),
                promptQueueLen: q?.queue?.length ?? 0,
                v2TurnStartAt: !!(sid && v2TurnStartAt.has(sid)),
                collectors: !!(sid && collectors.has(sid))
              }
            });
          }
          sendJson({ ok: true, conversations: list });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/wake') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const reason = String(body.reason ?? 'admin').trim() || 'admin';
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (deps.live.currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, deps.live.currentMode)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          const st = getSocialV2State(key);
          if (st.pendingWakeTimer) {
            clearTimeout(st.pendingWakeTimer);
            st.pendingWakeTimer = null;
          }
          if (!st.bootstrapSent) st.bootstrapSent = true;
          saveSocialV2State();
          sendWakePromptV2(key, reason, { manual: true });
          log(`控制台：手动唤醒 ${key}（${reason}）`);
          sendJson({ ok: true, key, reason });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/send-burst') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const messages = stripLeadingMetaMarkers(normalizeMessagesInput(body.messages))
            .map((m) => String(m ?? '').trim())
            .filter(Boolean);
          const replyToMessageId = body.replyToMessageId;
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
            sendJson({ ok: false, error: 'qq_send_burst 暂不支持引用，请使用 qq_reply' }, 400);
            return;
          }
          if (!key || !messages.length) {
            sendJson({ ok: false, error: 'key 和 messages 不能为空' }, 400);
            return;
          }
          const sendCfgBurst = cfg.socialV2?.send ?? {};
          if (sendCfgBurst.burstEnabled === false && messages.length > 1) {
            sendJson({ ok: false, error: '已禁用多条发送，请合并为一条消息' }, 403);
            return;
          }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('sendBurst')) { sendJson({ ok: false, error: '工具未启用：qq_send_burst' }, 403); return; }
          if (deps.live.currentMode !== 'reserved2') {
            sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403);
            return;
          }
          if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) {
            sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400);
            return;
          }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, deps.live.currentMode)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          if (shouldBlockSilentReply(key)) {
            sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403);
            return;
          }
          const sendCfg = cfg.socialV2?.send ?? {};
          const maxMsgs = Math.max(1, Number(sendCfg.burstMaxMessages) || 8);
          const maxChars = Math.max(1, Number(sendCfg.maxMessageChars) || 500);
          if (messages.length > maxMsgs) {
            sendJson({ ok: false, error: `最多发送 ${maxMsgs} 条` }, 400);
            return;
          }
          for (const msg of messages) {
            if (msg.length > maxChars) {
              sendJson({ ok: false, error: `单条消息不能超过 ${maxChars} 字` }, 400);
              return;
            }
            if (SENSITIVE_RE.test(msg)) {
              sendJson({ ok: false, error: '消息含敏感信息，已阻止发送' }, 403);
              return;
            }
          }
          try {
            const st = getSocialV2State(key);
            const now = Date.now();
            const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
            const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
            const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
            const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
            if ((maxPerMinute > 0 && recentMinute + messages.length > maxPerMinute) || (maxPerHour > 0 && recentHour + messages.length > maxPerHour)) {
              sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
              return;
            }
            // 先预占发送额度，避免并发绕过限频
            for (let i = 0; i < messages.length; i++) st.sendTimes.push(now);
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            const delays = computeGapsV2(messages, 'auto', undefined, undefined, sendCfg);
            const sentMessages = await sendMessagesV2(key, messages, delays);
            recordSentMessagesV2(key, sentMessages);
            st.lastAiReplyAt = now;
            st.lastActionAt = now;
            st.wakeConfig.noActionCount = 0;
            saveSocialV2State();
            log(`[reserved2] 工具分条发送 ${key}: 成功 ${sentMessages.length}/${messages.length} 条`);
            appendActivity(`${key} [reserved2] 工具分条发送：成功 ${sentMessages.length}/${messages.length} 条`);
            if (sentMessages.length > 0) scheduleReplyCheckV2(key);
            const burstHint = messages.length >= 3 ? '你已经连发了多条，确认是必要的吗？真人很少一口气补完。' : undefined;
            const spaceWarn = findCjkSpaceWarning(messages);
            const splitWarn = findSplitBoundaryWarning(messages);
            sendJson({ ok: true, key, sent: sentMessages.length, failed: messages.length - sentMessages.length, ...(burstHint ? { hint: burstHint } : {}), ...(spaceWarn ? { warn: spaceWarn } : {}), ...(splitWarn ? { splitWarn } : {}) });
          } catch (error) {
            if (error?.sent?.length) {
              recordSentMessagesV2(key, error.sent);
              log(`[reserved2] 工具分条发送部分成功 ${error.sent.length}/${messages.length} 条，已记录已发消息`);
            }
            // 失败/未发出的消息回滚预占的发送额度，避免假 429。
            const sentCount = Array.isArray(error?.sent) ? error.sent.length : 0;
            const failedCount = Math.max(0, messages.length - sentCount);
            for (let i = 0; i < failedCount; i++) {
              const idx = st.sendTimes.indexOf(now);
              if (idx >= 0) st.sendTimes.splice(idx, 1);
            }
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            saveSocialV2State();
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/send-message') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const rawMessages = normalizeMessagesInput(body.messages);
          const isRawString = typeof body.messages === 'string' && rawMessages.length === 1;
          // 剥掉模型误写在开头的元标记（如 `[[这是玩笑]]正文`）。
          // 放在归一化之后：归一化负责把 JSON 数组字符串拆成多条，剥标记针对的是最终的文本。
          const messages = stripLeadingMetaMarkers(rawMessages).map((m) => String(m ?? '').trim()).filter(Boolean);
          const replyToMessageId = body.replyToMessageId;
          const atUserId = body.atUserId ?? null;
          // 二代不再按空格自动分条：字符串就是一条消息；数组模式原样使用调用方间隔。
          const gapMode = (isRawString && messages.length > 1) ? 'auto' : (body.gapMode === 'fixed' || body.gapMode === 'byLength' ? body.gapMode : 'auto');
          const gapMs = Number(body.gapMs);
          const gaps = Array.isArray(body.gaps) ? body.gaps.map(Number) : [];
          if (!key || !messages.length) {
            sendJson({ ok: false, error: 'key 和 messages 不能为空' }, 400);
            return;
          }
          const sendCfgBurst = cfg.socialV2?.send ?? {};
          if (sendCfgBurst.burstEnabled === false && messages.length > 1) {
            sendJson({ ok: false, error: '已禁用多条发送，请合并为一条消息' }, 403);
            return;
          }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('sendMessage')) { sendJson({ ok: false, error: '工具未启用：qq_send_message' }, 403); return; }
          if (deps.live.currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
          if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, deps.live.currentMode)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          if (kind === 'private' && atUserId) {
            sendJson({ ok: false, error: '私聊不需要 @' }, 400);
            return;
          }
          if (shouldBlockSilentReply(key)) {
            sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403);
            return;
          }
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '' && !isSymbolicReplyRef(replyToMessageId) && !/^-?[1-9]\d*$/.test(String(replyToMessageId).trim())) {
            sendJson({ ok: false, error: 'replyToMessageId 必须是非零整数（消息 id 可能为负数），或传 latest/上一条 表示引用最近一条别人的消息' }, 400);
            return;
          }
          const sendCfg = cfg.socialV2?.send ?? {};
          const maxMsgs = Math.max(1, Number(sendCfg.burstMaxMessages) || 8);
          const maxChars = Math.max(1, Number(sendCfg.maxMessageChars) || 500);
          if (messages.length > maxMsgs) {
            sendJson({ ok: false, error: `最多发送 ${maxMsgs} 条` }, 400);
            return;
          }
          for (const msg of messages) {
            if (msg.length > maxChars) {
              sendJson({ ok: false, error: `单条消息不能超过 ${maxChars} 字` }, 400);
              return;
            }
            if (SENSITIVE_RE.test(msg)) {
              sendJson({ ok: false, error: '消息含敏感信息，已阻止发送' }, 403);
              return;
            }
          }
          const delays = computeGapsV2(messages, gapMode, gapMs, gaps, sendCfg);
          // 干跑：只验证引用解析结果，不真发、不占用发送额度。用于排查「引用会引到哪条」，不打扰群。
          if (body.dryRun === true) {
            const stDry = getSocialV2State(key);
            const resolvedDry = (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '')
              ? await resolveReplyTargetV2(stDry, kind, id, String(replyToMessageId).trim())
              : null;
            sendJson({
              ok: !!resolvedDry || replyToMessageId == null || String(replyToMessageId).trim() === '',
              key,
              dryRun: true,
              wouldSend: messages,
              replyToMessageId: resolvedDry ? resolvedDry.messageId : null,
              quoted: resolvedDry ? resolvedDry.info : null
            });
            return;
          }
          // 先做发送频率检查并预占额度，再解析引用目标，避免未限流的引用查询打爆 OneBot。
          const st = getSocialV2State(key);
          const now = Date.now();
          const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
          const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
          const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
          const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
          if ((maxPerMinute > 0 && recentMinute + messages.length > maxPerMinute) || (maxPerHour > 0 && recentHour + messages.length > maxPerHour)) {
            sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
            return;
          }
          // 先预占发送额度，避免并发绕过限频
          for (let i = 0; i < messages.length; i++) st.sendTimes.push(now);
          if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
          let quotedInfo = null;
          let actualReplyToMessageId = replyToMessageId;
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
            const resolved = await resolveReplyTargetV2(st, kind, id, String(replyToMessageId).trim());
            if (!resolved) {
              // 引用解析失败：回滚已预占的发送额度
              for (let i = 0; i < messages.length; i++) {
                const idx = st.sendTimes.indexOf(now);
                if (idx >= 0) st.sendTimes.splice(idx, 1);
              }
              saveSocialV2State();
              sendJson({ ok: false, error: '无法解析被引用消息，请确认 message id 正确且属于当前会话（可用 qq_get_message_detail 查看）' }, 400);
              return;
            }
            quotedInfo = resolved.info;
            actualReplyToMessageId = resolved.messageId;
          }
          try {
            const sentMessages = await sendMessagesV2(key, messages, delays, actualReplyToMessageId, atUserId, { quoted: quotedInfo });
            recordSentMessagesV2(key, sentMessages);
            st.lastAiReplyAt = now;
            st.lastActionAt = now;
            st.wakeConfig.noActionCount = 0;
            // 同 reply 端点：已回复的那条立即移出未读，避免本轮/下一轮重复回答同一条。
            if (sentMessages.length > 0 && quotedInfo?.messageId != null) {
              const before = st.unread.length;
              st.unread = st.unread.filter((m) => String(m?.messageId ?? '') !== String(quotedInfo.messageId));
              if (st.unread.length !== before) {
                log(`[reserved2] ${key} 已回复的消息从未读移除 1 条（余 ${st.unread.length}）`);
              }
            }
            // 记录这次明确引用回复的目标 seq：只有它算“已答”。
            if (sentMessages.length > 0 && quotedInfo?.messageId != null) {
              const targetEntry = st.recentMessages.find((m) => m && String(m.messageId) === String(quotedInfo.messageId));
              const targetSeq = Number(quotedInfo.seq) || Number(targetEntry?.seq) || 0;
              if (targetSeq) {
                const set = new Set((Array.isArray(st.answeredSeqs) ? st.answeredSeqs : []).map(Number).filter(Number.isFinite));
                set.add(targetSeq);
                st.answeredSeqs = [...set].slice(-200);
              }
            }
            saveSocialV2State();
            log(`[reserved2] 工具统一发送 ${key}: 成功 ${sentMessages.length}/${messages.length} 条`);
            appendActivity(`${key} [reserved2] 工具统一发送：成功 ${sentMessages.length}/${messages.length} 条`);
            if (sentMessages.length > 0) scheduleReplyCheckV2(key);
            const burstHint = messages.length >= 3 ? '你已经连发了多条，确认是必要的吗？真人很少一口气补完。' : undefined;
            const spaceWarn = findCjkSpaceWarning(messages);
            const splitWarn = findSplitBoundaryWarning(messages);
            sendJson({ ok: true, key, sent: sentMessages.length, failed: messages.length - sentMessages.length, delays, quoted: quotedInfo, ...(burstHint ? { hint: burstHint } : {}), ...(spaceWarn ? { warn: spaceWarn } : {}), ...(splitWarn ? { splitWarn } : {}) });
          } catch (error) {
            if (error?.sent?.length) {
              recordSentMessagesV2(key, error.sent);
              log(`[reserved2] 工具统一发送部分成功 ${error.sent.length}/${messages.length} 条，已记录已发消息`);
            }
            // 失败/未发出的消息回滚预占的发送额度，避免假 429。
            const sentCount = Array.isArray(error?.sent) ? error.sent.length : 0;
            const failedCount = Math.max(0, messages.length - sentCount);
            for (let i = 0; i < failedCount; i++) {
              const idx = st.sendTimes.indexOf(now);
              if (idx >= 0) st.sendTimes.splice(idx, 1);
            }
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            saveSocialV2State();
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/send-poke') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const targetUserId = String(body.targetUserId ?? body.userId ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (deps.live.currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
          if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'reserved2 模式发送拍一拍必须携带 agent token' }, 403); return; }
          if (!agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (!v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (!v2ToolEnabled('sendPoke')) { sendJson({ ok: false, error: '工具未启用：qq_send_poke' }, 403); return; }
          if (socialV2.paused) { sendJson({ ok: false, error: '二代 AI 已暂停，不能发送拍一拍' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, deps.live.currentMode)) {
            sendJson({ ok: false, error: '当前模式不允许操作该会话' }, 403);
            return;
          }
          if (shouldBlockSilentReply(key)) { sendJson({ ok: false, error: '静默模式已开启，当前不允许拍一拍' }, 403); return; }
          if (kind === 'group' && !targetUserId) {
            sendJson({ ok: false, error: '群聊拍一拍必须指定 targetUserId（QQ 号 / 昵称 / latest）' }, 400);
            return;
          }
          // 目标解析：允许 latest（最近戳我的人）或对方昵称，由桥接在本会话消息里换算成 QQ 号。
          //
          // 为什么必须支持（2026-10-22 事故）：模型被要求"有人戳你就回拍"，但唤醒提示里
          // 只有对方**名字**、没有 QQ 号；它于是复用上下文里残留的旧号，反复拍同一个人，
          // 群里被问「怎么一直戳我」。给它一条不依赖数字的路（同 replyToMessageId: latest 的思路），
          // 比在提示词里反复强调"别填错"可靠得多。
          if (kind === 'group') {
            const peek = getSocialV2State(key);
            const resolved = resolvePokeTarget({
              ref: targetUserId,
              unread: peek.unread,
              recentMessages: peek.recentMessages
            });
            if (!resolved.ok) {
              if (resolved.reason === 'ambiguous') {
                const cands = (resolved.candidates || []).map((c) => `${c.sender}(${c.userId})`).join('、');
                sendJson({ ok: false, error: `昵称「${targetUserId}」在本会话对应多人：${cands}。请直接传 QQ 号` }, 400);
                return;
              }
              if (resolved.reason === 'not-found') {
                sendJson({
                  ok: false,
                  error: isSymbolicPokeRef(targetUserId)
                    ? '最近没有戳你的人，无法用 latest；请传 QQ 号或对方昵称'
                    : `本会话里找不到「${targetUserId}」对应的 QQ 号，请传数字 QQ 号，或传 latest（最近戳你的人）`
                }, 400);
                return;
              }
              sendJson({ ok: false, error: 'targetUserId 不能为空' }, 400);
              return;
            }
            if (resolved.reason !== 'numeric') {
              log(`[拍一拍] ${key} 目标解析：${targetUserId} → ${resolved.userId}${resolved.sender ? `（${resolved.sender}）` : ''}，来源=${resolved.reason}`);
              targetUserId = resolved.userId;
            }
          }
          if (targetUserId && !/^[1-9]\d*$/.test(targetUserId)) {
            sendJson({ ok: false, error: 'targetUserId 必须是正整数 QQ 号' }, 400);
            return;
          }
          const st = getSocialV2State(key);
          const sendCfg = cfg.socialV2?.send ?? {};
          const now = Date.now();
          const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
          const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
          const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
          const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
          if ((maxPerMinute > 0 && recentMinute + 1 > maxPerMinute) || (maxPerHour > 0 && recentHour + 1 > maxPerHour)) {
            sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
            return;
          }
          st.sendTimes.push(now);
          if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
          try {
            if (kind === 'group') {
              await bot.raw('group_poke', { group_id: id, user_id: Number(targetUserId) });
            } else {
              // 私聊拍一拍：send_poke 自动路由到当前私聊对象
              await bot.raw('send_poke', { user_id: id });
            }
            st.lastActionAt = now;
            st.lastAiReplyAt = now;
            st.wakeConfig.noActionCount = 0;
            // 自己的拍一拍记成**名字**并明确「你拍了拍」，不再写裸 QQ 号。
            //
            // 两个原因（2026-10-22 事故）：
            //   ① 裸号会被模型当成"可复用的目标"——上下文里唯一的数字就是它，
            //      下次要拍别人时没有号，就顺手拿这个顶上，反复拍同一个人；
            //   ② 写成「我拍了拍」时模型认不出那是自己的动作，群友问「怎么一直戳我」，
            //      它反而答「戳你的人不是鱼」。
            let targetName = targetUserId;
            if (kind === 'group') {
              try {
                targetName = (await resolveGroupMemberName(id, targetUserId)) || targetUserId;
              } catch { /* 查不到名字就退回号，不影响发送 */ }
            }
            const pokeText = kind === 'group'
              ? `[拍一拍] 你拍了拍 ${targetName}`
              : '[拍一拍] 你拍了拍对方';
            st.recentMessages.push({
              messageId: null,
              sender: '我',
              text: pokeText,
              plain: pokeText,
              tail: pokeText,
              kind: 'poke',
              quoteTargetIsSelf: false,
              isOwner: true,
              ownerLabel: '我',
              isSelf: true,
              media: [],
              hasMedia: false,
              forwardIds: [],
              hasForward: false,
              poke: { targetId: targetUserId || String(id), targetIsSelf: false, groupId: kind === 'group' ? String(id) : null },
              time: Date.now()
            });
            const recentLimit = Number(cfg.socialV2?.context?.recentLimit) || 100;
            if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
            st.preSleepWaitSatisfiedAt = 0;
            st.preSleepWaitObservedAt = 0;
            st.preSleepWaitAccumMs = 0;
            saveSocialV2State();
            log(`[reserved2] 工具拍一拍 ${key}${kind === 'group' ? ' -> ' + targetUserId : ''}`);
            appendActivity(`${key} [reserved2] 工具拍一拍${kind === 'group' ? ' -> ' + targetUserId : ''}`);
            sendJson({ ok: true, key, kind, targetUserId: targetUserId || String(id) });
          } catch (error) {
            const idx = st.sendTimes.indexOf(now);
            if (idx >= 0) st.sendTimes.splice(idx, 1);
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            log(`[reserved2] 工具拍一拍失败 ${key}:`, error?.message ?? error);
            sendJson({ ok: false, error: `拍一拍失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // ── 图库（reserved2）：按需取图发送 ────────────────────────────────
        // 发图预检：毫秒级告知「会立刻发」还是「要现拉等一会儿」。
        // 模型先调这个，就能在要等的时候先回一句「等我找找」再发图，避免闷头等十几秒。
        if (req.method === 'GET' && url.pathname === '/api/socialV2/image-preflight') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('sendImage')) { sendJson({ ok: false, error: '工具未启用：qq_send_image' }, 403); return; }
          const rawTags = url.searchParams.get('tags') ?? '';
          const tags = rawTags ? rawTags.split(/[,，\s]+/).map((t) => t.trim()).filter(Boolean) : [];
          const rawSources = url.searchParams.get('sources') ?? '';
          const pf = imagePreflightV2(tags, rawSources, key);
          const gate = imageSendAllowed(key);
          // 已发图会被定期删除，所以「本地有」= 有**没发过的**图。
          // 这里把 TTL 说清楚，避免模型以为"本地永远有"而误判等待时间。
          const ttlMin = Math.round((Number(cfg.socialV2?.images?.sentTtlMs) || 0) / 60000);
          const srcFilter = normalizeSourceFilter(rawSources);
          sendJson({
            ok: true,
            key,
            tags,
            ...(srcFilter.requested ? { sources: srcFilter.valid } : {}),
            // 说明这个源限制是哪来的：模型自己传的，还是桥接从群主的话里识别的。
            // 后者要告诉模型，免得它以为"怎么只有一个站的图"。
            ...(srcFilter.requested && !normalizeSourceFilter(rawSources).requested
              ? { sourcesNote: `图源限制来自群主的话（${srcFilter.valid.join('/') || srcFilter.unavailable.join('/')}），桥接已自动应用，发图时不用重复传 sources。` }
              : {}),
            ...pf,
            sendAllowed: gate.ok,
            ...(gate.ok ? {} : { sendBlockedReason: gate.error }),
            ...(ttlMin > 0 ? { sentTtlMinutes: ttlMin } : {}),
            // 指定的源不可用时要说清楚，否则模型/群主不明白为什么查不到
            ...(srcFilter.unavailable.length ? { unavailableSources: srcFilter.unavailable } : {}),
            advice: srcFilter.requested && !srcFilter.valid.length
              ? `群主要求的图源（${srcFilter.unavailable.join('/')}）当前不可用，所以查不到任何图（也不会退回其他站点，因为那不符合要求）。可用图源：${Object.entries(cfg.socialV2?.images?.sources ?? {}).filter(([, v]) => v?.enabled === true).map(([k]) => k).join('/') || '无'}。请告诉群主这个站点目前用不了。`
              : pf.willWait
                ? `本地没有匹配的图（发过的图会在 ${ttlMin > 0 ? `${ttlMin} 分钟后被清理` : '下次清理时移除'}，所以库里主要是不重复的新图），这次发图需要现去图站拉取（可能 5~30 秒）${srcFilter.valid.length ? `，且只会在 ${srcFilter.valid.join('/')} 上找` : ''}。建议先用 qq_send_message 回一句（例如「等我找找」）再调用 qq_send_image，这样不会让对方干等；拉取期间你无法回应新消息。`
                : `本地有 ${pf.count} 张匹配的图${srcFilter.valid.length ? `（仅统计 ${srcFilter.valid.join('/')}）` : ''}，会立刻发出（约 0.1 秒），可以直接调用 qq_send_image。`
          });
          return;
        }
        // ── 按需拉取 X（Twitter）帖子并直接发到当前会话 ─────────────────────
        // 由 MCP 工具 qq_fetch_x_posts 调用：群友点名要看某个 X 账号的帖子时触发。
        // 参数：handle（账号，可带 @）、count（条数）、date（YYYY-MM-DD 指定某天）、
        //       lastHours（最近 N 小时）。拉取 → 翻译 → 渲染成卡片 → 发图。
        // X 登录凭据自检：查 state/x-auth.json 是否可用、能否连上 X（不泄露凭据值）。
        // 凭据会因改密码/登出而失效，出问题时先打这个端点定位。
        if (req.method === 'POST' && url.pathname === '/api/socialV2/x-auth-check') {
          if (req.headers['x-agent-token']) { sendJson({ ok: false, error: '该接口仅控制台可用' }, 403); return; }
          const st = xMonitor.describeAuth();
          if (!st.available) { sendJson({ ok: false, ...st, hint: '按记忆 x-monitor 登录态的说明取 auth_token/ct0 写入 state/x-auth.json' }); return; }
          // 真的发一次请求验证（凭据存在≠有效）
          try {
            const probe = await xMonitor.verifyAuth();
            sendJson({ ok: probe.ok, ...st, ...probe });
          } catch (e) {
            sendJson({ ok: false, ...st, error: `自检失败：${e?.message ?? e}` });
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/fetch-x-posts') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const handleRaw = String(body.handle ?? '').trim();
          if (!key || !handleRaw) { sendJson({ ok: false, error: 'key 和 handle 不能为空' }, 400); return; }
          if (!/^(group|private):\d+$/.test(key)) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }

          const account = handleRaw.replace(/^@/, '').trim();
          if (!/^[A-Za-z0-9_]{1,15}$/.test(account)) {
            sendJson({ ok: false, error: `账号名不合法：${handleRaw}（X 账号只能含字母/数字/下划线，最多 15 位）` }, 400);
            return;
          }

          const count = Math.max(1, Math.min(5, Number(body.count) || 1));
          // 时间条件三选一：date（某一天）/ lastHours（最近 N 小时）/ 默认（最新几条）
          let sinceMs = 0;
          let untilMs = 0;
          let rangeNote = '';
          if (body.date) {
            const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(body.date).trim());
            if (!m) { sendJson({ ok: false, error: 'date 格式应为 YYYY-MM-DD' }, 400); return; }
            const start = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0);
            const end = new Date(start.getTime() + 24 * 3600 * 1000);
            sinceMs = start.getTime();
            untilMs = end.getTime();
            rangeNote = `${m[1]}-${m[2]}-${m[3]} 当天`;
          } else if (Number(body.lastHours) > 0) {
            const h = Math.min(24 * 30, Number(body.lastHours));
            sinceMs = Date.now() - h * 3600 * 1000;
            rangeNote = `最近 ${h} 小时`;
          }
          // 未来日期：直接拒绝（避免空转一圈）
          if (sinceMs && sinceMs > Date.now()) {
            sendJson({ ok: false, error: `指定的时间还没到（${String(body.date ?? '')}），换个日期或说“最新”` }, 400);
            return;
          }

          log(`[x-monitor] 按需拉取 @${account}（${rangeNote || '最新'}，${count} 条）→ ${key}${body.dryRun === true ? '（干跑）' : ''}`);
          let result;
          try {
            result = await xMonitor.fetchAndRender(account, { count, sinceMs, untilMs });
          } catch (e) {
            sendJson({ ok: false, error: `拉取失败：${e?.message ?? e}` }, 500);
            return;
          }

          if (!result.ok) {
            // 400 而非 404：「那天没发帖 / 翻不到那么远」是查询条件没有结果，
            // 不是接口不存在。404 会让调用方误以为是路由问题。
            sendJson({
              ok: false,
              error: result.errors.join('；') || '没有拉到帖子',
              user: result.user,
              fetched: 0,
              oldestMs: result.oldestMs || 0
            }, 400);
            return;
          }

          // 发图（每张一条消息，与真人发图节奏一致）
          // dryRun：只拉取+渲染、不发送。排障时用，避免测试消息打扰群（踩过：以为传 send:false
          // 能拦住，实际端点不认这个参数，结果真发到群里了）。
          const dryRun = body.dryRun === true;
          let sentCount = 0;
          let sentVideos = 0;
          const sendErrors = [];
          for (const item of result.posts) {
            if (dryRun) break;
            try {
              const dir = path.join(STATE_DIR, 'x-monitor');
              fs.mkdirSync(dir, { recursive: true });
              const file = path.join(dir, `x-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.png`);
              fs.writeFileSync(file, item.image.buffer);
              try {
                await onebotSendImageFile(key, file, { post: item.post });
              } finally {
                setTimeout(() => { try { fs.unlinkSync(file); } catch {} }, 60000).unref?.();
              }
              sentCount += 1;
              await sleep(700);   // 多条之间留点间隔，避免像刷屏
            } catch (e) {
              sendErrors.push(`${item.post.id}: ${e?.message ?? e}`);
            }
            // 视频必须**单独一条消息**发（SnowLuma 的 assertVideoSendPolicy：
            // video 段必须唯一且是消息里唯一的段），所以放在卡片之后另发，不与文字/图片同条。
            if (item.video?.file) {
              try {
                await sleep(500);
                await onebotSendVideoFile(key, item.video.file, { post: item.post });
                sentVideos += 1;
                await sleep(700);
              } catch (e) {
                sendErrors.push(`${item.post.id} 视频: ${e?.message ?? e}`);
              }
            }
          }

          const skippedNote = result.videoSkipped?.length
            ? `；跳过 ${result.videoSkipped.length} 个超限视频（${result.videoSkipped.map((v) => v.reason).join('；')}）`
            : '';
          log(`[x-monitor] @${account} 拉取完成：${dryRun ? `干跑（未发送）${result.posts.length} 条` : `发出 ${sentCount}/${result.posts.length} 张图、${sentVideos} 个视频`}${skippedNote}${sendErrors.length ? `，失败 ${sendErrors.length}` : ''}`);
          sendJson({
            ok: dryRun ? result.posts.length > 0 : sentCount > 0,
            dryRun: dryRun || undefined,
            user: result.user,
            fetched: result.posts.length,
            sent: sentCount,
            sentVideos,
            videoSkipped: result.videoSkipped ?? [],
            posts: result.posts.map((p) => ({
              id: p.post.id,
              url: p.post.url,
              createdAt: p.post.createdAt,
              createdAtMs: p.post.createdAtMs,
              pinnedSkipped: result.pinnedSkipped,
              hasVideo: !!p.video,
              videoBytes: p.video?.bytes ?? 0,
              videoSize: p.video ? `${p.video.width}x${p.video.height}` : '',
              videoDurationMs: p.video?.durationMs ?? 0,
              summary: String(p.post.text || '').replace(/\s+/g, ' ').slice(0, 120)
            })),
            errors: [...result.errors, ...sendErrors].slice(0, 5)
          });
          return;
        }

        if (req.method === 'POST' && url.pathname === '/api/socialV2/send-image') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (deps.live.currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
          if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'reserved2 模式发图必须携带 agent token' }, 403); return; }
          if (!agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (!v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (!v2ToolEnabled('sendImage')) { sendJson({ ok: false, error: '工具未启用：qq_send_image' }, 403); return; }
          if (socialV2.paused) { sendJson({ ok: false, error: '二代 AI 已暂停，不能发图' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, deps.live.currentMode)) {
            sendJson({ ok: false, error: '当前模式不允许操作该会话' }, 403);
            return;
          }
          if (shouldBlockSilentReply(key)) { sendJson({ ok: false, error: '静默模式已开启，当前不允许发图' }, 403); return; }
          const tags = Array.isArray(body.tags) ? body.tags.map(String) : (body.tags ? String(body.tags).split(/[,，\s]+/) : []);
          // mode → 排序与时间窗。「日榜」用 age:<2day + order:score 近似
          // （图站没有真正的 pixiv 式日榜；近两日按热度是最接近的语义）。
          const modeMap = {
            hot: { order: 'score', maxAgeDays: 0 },
            daily: { order: 'score', maxAgeDays: 2 },
            new: { order: 'new', maxAgeDays: 0 },
            random: { order: 'random', maxAgeDays: 0 }
          };
          const mode = modeMap[String(body.mode ?? 'hot')] ?? modeMap.hot;
          try {
            const r = await sendImageV2(key, { tags, replyToMessageId: body.replyToMessageId, sources: body.sources, ...mode });
            const st = getSocialV2State(key);
            // 记入会话时间线，让 AI 与后续上下文知道「我刚发了张图」
            st.recentMessages.push({
              messageId: null,
              sender: '我',
              text: `[图片] 已发送一张图（${r.entry.source}${r.entry.artist ? ' / ' + r.entry.artist : ''}）`,
              plain: '[图片]',
              tail: '[图片]',
              quoteTargetIsSelf: false,
              isOwner: true,
              ownerLabel: '我',
              isSelf: true,
              media: [],
              hasMedia: false,
              forwardIds: [],
              hasForward: false,
              time: Date.now()
            });
            const recentLimit = Number(cfg.socialV2?.context?.recentLimit) || 100;
            if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
            st.lastAiReplyAt = Date.now();
            st.lastActionAt = Date.now();
            st.wakeConfig.noActionCount = 0;
            saveSocialV2State();
            log(`[图库] 工具发图 ${key}：${r.entry.id}`);
            appendActivity(`${key} [图库] 已发送图片（${r.entry.source}）`);
            // tagCorrections：告知调用方「你要的词被换成了别的标签」。
            // 模型据此自查：若换后的标签跨了作品/角色，应主动说明或更正，别当查到了就完事。
            sendJson({
              ok: true,
              key,
              source: r.entry.source,
              artist: r.entry.artist,
              page: r.entry.page,
              annotation: r.annotation,
              ...(r.tagCorrections?.length
                ? {
                    tagCorrections: r.tagCorrections.map((c) => `${c.from} → ${c.to}（${c.postCount} 张）`),
                    notice: `注意：你给的标签「${r.tagCorrections.map((c) => c.from).join('、')}」在上游不存在，已自动改用「${r.tagCorrections.map((c) => c.to).join('、')}」。如果这与你想要的角色/作品不符（例如名字相近但是不同作品），请告诉群友你实际发的是什么，别默认它就是要的那张。`
                  }
                : {})
            });
          } catch (error) {
            log(`[图库] 工具发图失败 ${key}: ${error?.message ?? error}`);
            sendJson({ ok: false, error: `${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/archive-image') {
          const body = await readBody();
          // 同 refresh-image-lib 的鉴权：管理员可直接调，AI 必须带合法 agent token。
          let allowed = !req.headers['x-agent-token'];
          let vkey = '';
          if (req.headers['x-agent-token']) {
            vkey = String(body.key ?? '').trim();
            allowed = !!vkey && agentTokenOk(vkey, req.headers['x-agent-token']) && v2SessionAllowed(vkey) && v2ToolEnabled('archiveImage');
          }
          if (!allowed) { sendJson({ ok: false, error: '无权收藏图片' }, 403); return; }
          if (!imagesEnabled()) { sendJson({ ok: false, error: '图库未启用' }, 403); return; }
          // 目标：显式 id，或本会话「最近发出的那张」
          let entry = null;
          const wantId = String(body.id ?? '').trim();
          if (wantId) entry = imageStore.getById(wantId);
          if (!entry && vkey) {
            const last = lastSentImage.get(vkey);
            if (last) entry = imageStore.getById(last.id) ?? last.entry ?? null;
          }
          if (!entry) { sendJson({ ok: false, error: wantId ? `图库中没有 ${wantId}` : '未指定 id，且本会话最近没发过图' }, 404); return; }
          try {
            const r = await archiveImage(entry);
            log(`[图库] 已收藏原图 ${entry.id} → ${r.path}（${(r.bytes / 1024).toFixed(0)}KB${r.skipped ? '，此前已存过' : ''}）`);
            appendActivity(`${vkey || 'admin'} [图库] 收藏原图 ${entry.id}（${(r.bytes / 1024).toFixed(0)}KB）`);
            sendJson({
              ok: true,
              id: entry.id,
              path: r.path,
              originalUrl: r.url,
              bytes: r.bytes,
              alreadySaved: !!r.skipped,
              note: r.skipped
                ? `此前已收藏过，文件在 ${r.path}`
                : `已把原图保存到 ${r.path}（${(r.bytes / 1024).toFixed(0)}KB）`
            });
          } catch (error) {
            log(`[图库] 收藏原图失败 ${entry.id}: ${error?.message ?? error}`);
            sendJson({ ok: false, id: entry.id, error: `收藏失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // 反向搜图（以图搜图）：拿一张图去 SauceNAO 反查出处（谁画的、来自哪个站）。
        // 参数：messageId（群友发的那条消息，取其图）或 id（图库里某张）；两者都没有则用
        // 本会话「最近发出的那张」。与 /image-source 的区别：那个只查**图库已有条目**的元数据，
        // 这个能对**任意一张图**做全站反查（含群友发的外来图）。
        if (req.method === 'GET' && url.pathname === '/api/socialV2/reverse-search') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          if (key && req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (key && req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (key && req.headers['x-agent-token'] && !v2ToolEnabled('reverseSearch')) { sendJson({ ok: false, error: '工具未启用：qq_reverse_search' }, 403); return; }
          if (cfg.imageReverseSearch?.enabled === false) { sendJson({ ok: false, error: '反向搜图已关闭（imageReverseSearch.enabled）' }, 403); return; }
          const avail = reverseSearcher.available();
          if (!avail.ok) { sendJson({ ok: false, error: avail.reason, needKey: true }, 400); return; }

          const wantMsgId = String(url.searchParams.get('messageId') ?? '').trim();
          const wantId = String(url.searchParams.get('id') ?? '').trim();
          let buffer = null;
          let from = '';
          if (wantMsgId && key) {
            const media = await findMessageMediaAsync(key, wantMsgId);
            if (!media.length) { sendJson({ ok: false, error: '这条消息里没有图片/表情' }, 404); return; }
            const imgs = await fetchMediaData(media.slice(0, 1));
            const first = imgs.find((x) => x?.data);
            if (!first) { sendJson({ ok: false, error: '图片读取失败（可能已过期或取不到原图）' }, 404); return; }
            buffer = Buffer.from(first.data, 'base64');
            from = `消息 ${wantMsgId}`;
          } else {
            let entry = wantId ? imageStore.getById(wantId) : null;
            if (!entry && key) {
              const last = lastSentImage.get(key);
              if (last) entry = imageStore.getById(last.id) ?? last.entry ?? null;
            }
            if (!entry) { sendJson({ ok: false, error: wantId ? `图库中没有 ${wantId}` : '请给 messageId（群友发的图）或 id（图库图）' }, 404); return; }
            buffer = imageStore.readBuffer(entry);
            if (!buffer) { sendJson({ ok: false, error: '图库文件读取失败' }, 500); return; }
            from = `图库 ${entry.id}`;
          }

          const r = await reverseSearcher.search(buffer, {
            db: Number(cfg.imageReverseSearch?.db) || 999,
            minsim: Number(cfg.imageReverseSearch?.minsim) || 50,
            numres: Number(cfg.imageReverseSearch?.numres) || 5
          });
          if (!r.ok) { sendJson({ ok: false, error: r.error }, r.quota ? 429 : 502); return; }
          const top = r.results?.[0];
          sendJson({
            ok: true,
            from,
            cached: !!r.cached,
            count: r.results.length,
            results: r.results,
            note: top
              ? `最匹配：${top.site || '未知站点'}（相似度 ${top.similarity.toFixed(1)}%）`
                + (top.creator ? `，作者 ${top.creator}` : '')
                + (top.urls?.length ? `，出处 ${top.urls[0]}` : '')
              : '没找到相似度足够高的来源（可能是原创/改图/冷门作品）',
            stats: reverseSearcher.stats()
          });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/image-source') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          if (key && req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (key && req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (key && req.headers['x-agent-token'] && !v2ToolEnabled('imageSource')) { sendJson({ ok: false, error: '工具未启用：qq_image_source' }, 403); return; }
          // 目标：显式给 id，或用本会话「最近发出的那张」（模型通常不知道图库 id）
          let entry = null;
          const wantId = String(url.searchParams.get('id') ?? '').trim();
          if (wantId) entry = imageStore.getById(wantId);
          if (!entry && key) {
            const last = lastSentImage.get(key);
            if (last) entry = imageStore.getById(last.id) ?? last.entry ?? null;
          }
          if (!entry) {
            sendJson({ ok: false, error: wantId ? `图库中没有 ${wantId}` : '本会话最近没有发出过图，也请传 id' }, 404);
            return;
          }
          const sp = sourcePageOf(entry);
          sendJson({
            ok: true,
            id: entry.id,
            source: entry.source || '',
            artist: entry.artist || '',
            artistId: entry.artistId || '',
            // originUrl：画师原始发布处；sourcePage：图源站条目页
            originUrl: entry.page || '',
            sourcePage: sp,
            tags: Array.isArray(entry.tags) ? entry.tags.slice(0, 40) : [],
            rating: entry.rating || '',
            width: entry.width || 0,
            height: entry.height || 0,
            note: sp
              ? `这是在 ${entry.source} 上查这张图的页面：${sp}${entry.page && entry.page !== sp ? `；画师原始发布处：${entry.page}` : ''}`
              : '该图没有可推导的图源站点页面'
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/react-message') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          // 鉴权同 send-image：reserved2 下 AI 必须带 agent token
          if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'reserved2 模式贴表情必须携带 agent token' }, 403); return; }
          if (!agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (!v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (!v2ToolEnabled('reactMessage')) { sendJson({ ok: false, error: '工具未启用：qq_react_message' }, 403); return; }
          if (cfg.socialV2?.emojiReact?.enabled === false) { sendJson({ ok: false, error: '贴表情功能已关闭（socialV2.emojiReact.enabled）' }, 403); return; }
          if (socialV2.paused) { sendJson({ ok: false, error: '二代 AI 已暂停，不能贴表情' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const convId = Number(keyMatch[2]);
          if (!Number.isFinite(convId) || convId <= 0 || !modeAllowed(key, kind, convId, cfg, deps.live.currentMode)) {
            sendJson({ ok: false, error: '当前模式不允许操作该会话' }, 403);
            return;
          }
          // QQ 的表情回应**只支持群聊**（实测私聊报 "emoji reactions are not supported
          // on private messages"）。提前拦掉并说清原因，别让模型以为是自己参数错了。
          if (kind !== 'group') {
            sendJson({ ok: false, error: 'QQ 的表情回应只支持群消息，私聊不支持（这不是参数问题，无需重试）' }, 400);
            return;
          }
          const rawId = String(body.messageId ?? body.id ?? '').trim();
          if (!rawId) { sendJson({ ok: false, error: 'messageId 不能为空（用 qq_get_unread_messages 里的 messageId）' }, 400); return; }
          const emojiId = String(body.emojiId ?? '').trim();
          const v = validateEmojiId(emojiId, emojiCatalogIds());
          if (!v.ok) {
            sendJson({ ok: false, error: v.reason, ...(v.hint ? { hint: v.hint } : {}) }, 400);
            return;
          }
          const set = body.set !== false; // 默认贴；传 set:false 撤销
          // 限流：模型可能一时兴起连贴一串。撤销不计入限流（那是修正行为）。
          if (set) {
            const gate = emojiReactGate.check(key);
            if (!gate.allow) { sendJson({ ok: false, error: gate.reason, rateLimited: true }, 429); return; }
          }
          const ok = await setEmojiLike(convId, rawId, emojiId, set);
          if (!ok) {
            sendJson({ ok: false, error: '贴表情失败（消息可能太旧、已不在 QQ 消息缓存里；请对较新的消息贴）' }, 502);
            return;
          }
          const named = REACTION_EMOJIS.find((e) => String(e.id) === emojiId);
          log(`[表情] ${key} ${set ? '贴了' : '撤销了'}「${named?.name || emojiId}」（msg ${rawId}）`);
          appendActivity(`${key} [表情] ${set ? '贴' : '撤销'}${named?.name || emojiId}`);
          sendJson({ ok: true, key, messageId: rawId, emojiId, emojiName: named?.name || '', set });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/reject-image') {
          const body = await readBody();
          // 同 refresh-image-lib 的鉴权：管理员可直接调，AI 必须带合法 agent token。
          let allowed = !req.headers['x-agent-token'];
          let vkey = '';
          if (req.headers['x-agent-token']) {
            vkey = String(body.key ?? '').trim();
            allowed = !!vkey && agentTokenOk(vkey, req.headers['x-agent-token']) && v2SessionAllowed(vkey) && v2ToolEnabled('rejectImage');
          }
          if (!allowed) { sendJson({ ok: false, error: '无权删除图库图片' }, 403); return; }
          if (!imagesEnabled()) { sendJson({ ok: false, error: '图库未启用' }, 403); return; }
          // 目标：显式给 id；不传则用本会话「最近发出的那张」（AI 通常不知道图库 id）
          let targetId = String(body.id ?? '').trim();
          if (!targetId && vkey) targetId = lastSentImage.get(vkey)?.id ?? '';
          if (!targetId) { sendJson({ ok: false, error: '没有可删除的目标（未指定 id，且本会话最近没发过图）' }, 400); return; }
          const r = imageStore.reject(targetId, { reason: String(body.reason ?? 'AI 判定不合适') });
          if (vkey && lastSentImage.get(vkey)?.id === targetId) lastSentImage.delete(vkey);
          log(`[图库] 删除并拒绝 ${targetId}（${r.existed ? '已从库中移除' : '条目原本不在库'}，原因：${body.reason ?? '未说明'}）`);
          appendActivity(`${vkey || 'admin'} [图库] 删除图 ${targetId}（${String(body.reason ?? '').slice(0, 30)}）`);
          sendJson({ ok: true, id: targetId, removed: r.existed, freedBytes: r.freedBytes ?? 0, note: '该图已加入拒绝名单，之后不会再被拉取或发出' });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/image-stats') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          if (key && req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          sendJson({
            ok: true,
            enabled: imagesEnabled(),
            libDir: imageStore.libDir,
            ...imageStore.stats(),
            fetchedAt: deps.live.imageFetchedAt || null,
            sources: Object.fromEntries(
              Object.entries(cfg.socialV2?.images?.sources ?? {}).map(([n, c]) => [n, { enabled: c?.enabled === true, limit: c?.limit ?? 20 }])
            )
          });
          return;
        }
        // ── 取图额度总览（控制台「12c 取图额度」卡片）──────────────────────
        //
        // 用户要求（2026-10-20）：「取图 API 额度能不能在控制台中加一个显示」。
        //
        // 这里把**三类互相独立的上限**放在一起，因为它们都会以"取不到图"的形式
        // 表现，但原因完全不同，混在一起排查会走错方向：
        //   ① 图库容量（maxFiles / maxTotalBytes）——满了会淘汰旧图，不代表不能用
        //   ② 拉取冷却（cooldownMs）——两次"补货"之间的最小间隔，冷却中预检会 willWait
        //   ③ SauceNAO 反查额度（每天 100 次 / 30 秒 1 次）——**真正的上游免费额度**，
        //      用完了当天就没法反查（这是唯一"会真的用完"的）
        // 另外附各图源的启用状态，因为"某个源没开"也会被误当成额度问题。
        if (req.method === 'GET' && url.pathname === '/api/socialV2/image-quota') {
          const ic = cfg.socialV2?.images ?? {};
          const now = Date.now();
          const enabled = imagesEnabled();

          // 图库容量
          let lib = null;
          try { lib = imageStore.stats(); } catch { lib = null; }

          // 拉取冷却：imageFetchedAt 是"上次成功拉取"的时刻
          const cooldownMs = Math.max(0, Number(ic.cooldownMs) || 0);
          const sinceFetch = deps.live.imageFetchedAt ? now - deps.live.imageFetchedAt : Infinity;
          const cooling = cooldownMs > 0 && deps.live.imageFetchedAt > 0 && sinceFetch < cooldownMs;

          // 反查额度（唯一真正的"API 额度"）
          const rs = reverseSearcher.stats();

          // 各图源开关：pixiv/yandere 默认关，容易和"额度用完"混淆
          const srcCfg = ic.sources ?? {};
          const sources = Object.keys(srcCfg).map((name) => ({
            name,
            enabled: srcCfg[name]?.enabled === true,
            limit: Number(srcCfg[name]?.limit) || 0,
            hasProxy: !!String(srcCfg[name]?.proxy || ic.proxy || '').trim()
          }));

          // 每会话发送限频（同会话冷却 / 每小时上限）——也不是"额度"，但会拦发图
          sendJson({
            ok: true,
            enabled,
            library: lib,
            fetch: {
              cooldownMs,
              lastFetchedAt: deps.live.imageFetchedAt || 0,
              cooling,
              remainMs: cooling ? Math.max(0, cooldownMs - sinceFetch) : 0,
              fetching: !!deps.live.imageFetching,
              fetchPerRun: Math.max(1, Number(ic.fetchPerRun) || 20)
            },
            reverseSearch: {
              hasKey: rs.hasKey,
              usedToday: rs.usedToday,
              dailyMax: rs.dailyMax,
              remainingToday: rs.remainingToday,
              windowMax: rs.windowMax,
              windowUsed: rs.windowUsed,
              windowResetMs: rs.windowResetMs,
              cached: rs.cached
            },
            send: {
              cooldownMs: Math.max(0, Number(ic.sendCooldownMs) || 0),
              maxSendPerHour: Math.max(0, Number(ic.maxSendPerHour) || 0)
            },
            sources
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/refresh-image-lib') {
          const body = await readBody();
          // 管理员可直接刷；AI 必须带合法 agent token（允许它自己按需补图，但受限频）。
          let allowed = !req.headers['x-agent-token'];
          if (req.headers['x-agent-token']) {
            const key = String(body.key ?? '').trim();
            allowed = !!key && agentTokenOk(key, req.headers['x-agent-token']) && v2SessionAllowed(key) && v2ToolEnabled('refreshImageLib');
          }
          if (!allowed) { sendJson({ ok: false, error: '无权刷新图库' }, 403); return; }
          if (!imagesEnabled()) { sendJson({ ok: false, error: '图库未启用：请在 config.json 设置 socialV2.images.enabled=true' }, 403); return; }
          try {
            const r = await refreshImageLib({
              force: body.force === true && !req.headers['x-agent-token'],
              tags: Array.isArray(body.tags) ? body.tags.map(String) : undefined,
              order: body.order,
              maxAgeDays: body.maxAgeDays,
              limit: body.limit,
              sources: Array.isArray(body.sources) ? body.sources.map(String) : undefined
            });
            if (r.cooled) {
              sendJson({ ok: true, cooled: true, remainMs: r.remainMs, total: imageStore.count() });
            } else {
              sendJson({ ok: true, added: r.added, skipped: r.skipped, total: r.total, errors: (r.errors ?? []).slice(0, 5) });
            }
          } catch (error) {
            sendJson({ ok: false, error: `${error?.message ?? error}` }, 500);
          }
          return;
        }
        // ── 表情包体系（reserved2） ──────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/socialV2/sticker-image') {
          if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const key = String(url.searchParams.get('key') ?? '').trim();
          const stickerId = String(url.searchParams.get('stickerId') ?? '').trim();
          if (!key || !stickerId) { sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getStickerImage')) { sendJson({ ok: false, error: '工具未启用：qq_get_sticker_image' }, 403); return; }
          try {
            const entry = await getStickerImageData(stickerId);
            const fetched = await safeFetchBuffer(entry.url, MAX_MEDIA_BYTES);
            const dims = getImageDimensions(fetched.buffer);
            if (dims && dims.width * dims.height > MAX_MEDIA_PIXELS) {
              sendJson({ ok: false, error: `表情图片像素超限（${dims.width}x${dims.height}），已拒绝` }, 400);
              return;
            }
            const mimeType = mimeFromBuffer(fetched.buffer) || mimeFromUrl(entry.url);
            try { writeStickerCacheImage(STICKER_CACHE_DIR, entry, fetched.buffer, { mimeType, width: dims?.width, height: dims?.height }); } catch { /* 图片缓存失败不影响看图 */ }
            sendJson({
              ok: true,
              key,
              sticker: {
                id: entry.id,
                desc: entry.desc || '',
                localNote: entry.localNote || '',
                tags: entry.tags || [],
                url: entry.url,
                md5: entry.md5
              },
              image: { mimeType, data: fetched.buffer.toString('base64') }
            });
          } catch (error) {
            sendJson({ ok: false, error: `获取表情图片失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if ((req.method === 'GET' || req.method === 'POST') && url.pathname === '/api/socialV2/self-image') {
          if (req.method === 'GET' && url.searchParams.has('publish')) {
            sendJson({ ok: false, error: 'GET 仅用于预览；发布形象图必须使用 POST' }, 405);
            return;
          }
          const body = req.method === 'POST' ? await readBody() : {};
          const key = String(req.method === 'POST' ? body.key : url.searchParams.get('key') ?? '').trim();
          if (!/^(group|private):\d+$/.test(key)) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const agentToken = req.headers['x-agent-token'];
          if (req.method === 'POST' && !agentToken) { sendJson({ ok: false, error: '发布形象图必须携带 agent token' }, 403); return; }
          if (agentToken && !agentTokenOk(key, agentToken)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (agentToken && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (agentToken && !v2ToolEnabled('getSelfImage')) { sendJson({ ok: false, error: '工具未启用：qq_get_self_image' }, 403); return; }
          // publish：**顺便把形象图发到当前会话**（用户要求「别人问及自拍时把自拍图片一并发出去」）。
          //
          // 为什么由桥接发、而不是让模型再调一次 qq_send_image：
          //   qq_send_image 只会从图库里挑图，拿不到这张本地形象图；
          //   而且分两步会让模型「看了图却忘了发」，或被问「发张自拍」时只描述长相。
          //   一次做完「放进视觉上下文 + 发到群里」才是能用的语义。
          const publish = req.method === 'POST' && body.publish !== false;
          const selfPath = path.join(ROOT, 'assets', 'deepseek娘.png');
          try {
            if (!fs.existsSync(selfPath)) { sendJson({ ok: false, error: '未找到 AI 形象图片 assets/deepseek娘.png' }, 404); return; }
            const buf = fs.readFileSync(selfPath);
            const mimeType = mimeFromBuffer(buf) || 'image/png';
            const image = { mimeType, data: buf.toString('base64') };

            // 发图前照例过一遍准入与静默：不能因为「是自拍」就绕过暂停/静默/模式限制
            let sent = null;
            let sendError = '';
            if (publish) {
              if (deps.live.currentMode !== 'reserved2') {
                sendError = '该接口仅 reserved2 模式可用';
              } else if (cfg.socialV2?.enabled === false) {
                sendError = '二代模式已关闭，不能发图';
              } else if (socialV2.paused) {
                sendError = '二代 AI 已暂停，不能发图';
              } else if (shouldBlockSilentReply(key)) {
                sendError = '静默模式已开启，当前不允许发图';
              } else {
                try {
                  const r = await onebotSendImageFile(key, buf, { label: '［自拍］' });
                  sent = r?.message_id ?? true;
                  // 记进会话时间线：模型与后续上下文要知道"我刚发了张自拍"
                  const st = getSocialV2State(key);
                  st.recentMessages.push({
                    messageId: null,
                    sender: '我',
                    text: '[图片] 发了张自己的形象图',
                    plain: '[图片]',
                    tail: '[图片]',
                    quoteTargetIsSelf: false,
                    isOwner: true,
                    ownerLabel: '我',
                    isSelf: true,
                    media: [],
                    hasMedia: false,
                    forwardIds: [],
                    hasForward: false,
                    time: Date.now()
                  });
                  const recentLimit = Number(cfg.socialV2?.context?.recentLimit) || 100;
                  if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
                  st.lastAiReplyAt = Date.now();
                  st.lastActionAt = Date.now();
                  st.wakeConfig.noActionCount = 0;
                  saveSocialV2State();
                  appendActivity(`${key} [自拍] 已发送形象图`);
                  log(`[自拍] 已发送形象图 → ${key}`);
                } catch (error) {
                  // 发失败不算致命：图仍然给模型（它至少能照着描述），但要如实告知
                  sendError = String(error?.message ?? error);
                  log(`[自拍] 发送失败 ${key}：${sendError}`);
                }
              }
            }

            sendJson({
              ok: true,
              key,
              image,
              published: publish,
              sent: sent || undefined,
              // 没发出去时给模型一句可转述的话，避免它以为已经发了
              sendError: sendError || undefined
            });
          } catch (error) {
            sendJson({ ok: false, error: `读取 AI 形象图片失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // 功能菜单图：群友问「你会啥/能干嘛」时，渲染并**直接发到当前会话**。
        //
        // 为什么由桥接发而不是把 base64 还给模型：模型没有"发送任意图片"的能力
        // （qq_send_image 只认图库里的图，拿不到这张实时渲染的菜单），
        // 让工具一次做完"渲染 + 发送"才符合模型能用得上的语义。
        //
        // 渲染走 Chrome 无头截图（见 feature-menu-render.js），按内容指纹缓存，
        // 反复问只渲染一次。失败时如实报错，不退回让模型自己编功能清单。
        if (req.method === 'GET' && url.pathname === '/api/socialV2/send-feature-menu') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          // agent token 是**必需**的，不是可选（与 send-image 同规则）。
          // 早期写法是 `if (agentToken && !agentTokenOk(...))`，那样空 token 会跳过所有校验：
          // 因为控制台鉴权在 consoleToken 留空时不拦，任何能访问 3100 的人都能触发发群。
          if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: '发送功能菜单必须携带 agent token' }, 403); return; }
          if (!agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (!v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (!v2ToolEnabled('getFeatureMenu')) { sendJson({ ok: false, error: '工具未启用：qq_send_feature_menu' }, 403); return; }
          if (socialV2.paused) { sendJson({ ok: false, error: 'AI 已暂停，当前不允许发送' }, 403); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, deps.live.currentMode)) {
            sendJson({ ok: false, error: '当前模式不允许向该会话发送' }, 403);
            return;
          }
          if (shouldBlockSilentReply(key)) { sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403); return; }
          try {
            const force = url.searchParams.get('refresh') === '1';
            const r = await renderFeatureMenu({ force, config: cfg, roleName: roleFor(key) || '', log: (m) => log(m) });
            if (!r.ok) { sendJson({ ok: false, error: r.error }, 500); return; }
            // 图库目录下不碰：菜单是桥接自有产物，放 state/feature-menu 缓存目录里直接发
            await onebotSendImageFile(key, r.file, { label: '群友功能菜单' });
            log(`[功能菜单] 已发送到 ${key}（${Math.round(r.bytes / 1024)}KB${r.cached ? '，缓存' : '，新渲染'}）`);
            appendActivity(`${key} [功能菜单] 已发送功能菜单图`);
            sendJson({ ok: true, key, cached: r.cached, bytes: r.bytes });
          } catch (error) {
            log(`功能菜单发送失败：${error?.message ?? error}`);
            sendJson({ ok: false, error: `功能菜单发送失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // ── GitHub 仓库首页截图（2026-10-20 用户要求）─────────────────────────
        //
        // 「解析 GitHub 链接并把仓库首页整个截图并发送」。
        //
        // 为什么自己截图而不是抓 API：群友要的是**看到页面长什么样**（Star 数、
        // 文件列表、README 排版、语言占比条），这些只有渲染后的页面有。
        // GitHub API 只给元数据，画不出首页。
        //
        // 为什么分段发：实测首页整页约 15400px，一张 1400×15400 的图在 QQ 里
        // 会被等比压成灰色细线（文字 1~2 像素高，完全看不清）。按 2400px 切段，
        // 每段仍是 1400 宽、文字清晰，按顺序看就是完整页面。
        //
        // 网络：实测直连 github.com 会 ECONNRESET，必须走代理（见下面 proxy 取值）。
        if (req.method === 'POST' && url.pathname === '/api/socialV2/github-shot') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const raw = String(body.url ?? body.text ?? '').trim();
          const gs = cfg.socialV2?.githubShot ?? {};
          if (gs.enabled === false) { sendJson({ ok: false, error: 'GitHub 截图功能已关闭（socialV2.githubShot.enabled）' }, 400); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          // agent token 必需（与 send-image / send-feature-menu 同规则）：
          // 这是个会往群里发东西的写操作，不能靠"控制台没设令牌"就放行。
          if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'GitHub 截图必须携带 agent token' }, 403); return; }
          if (!agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (!v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (!v2ToolEnabled('githubShot')) { sendJson({ ok: false, error: '工具未启用：qq_github_shot' }, 403); return; }
          if (socialV2.paused) { sendJson({ ok: false, error: 'AI 已暂停，当前不允许发送' }, 403); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, deps.live.currentMode)) {
            sendJson({ ok: false, error: '当前模式不允许向该会话发送' }, 403);
            return;
          }
          if (shouldBlockSilentReply(key)) { sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403); return; }

          // 解析：允许直接贴链接，也允许贴一段含链接的消息文本
          const candidate = parseGitHubUrl(raw) ? raw : (extractGitHubUrl(raw) || raw);
          const info = parseGitHubUrl(candidate);
          if (!info) {
            sendJson({ ok: false, error: '识别不出 GitHub 仓库（支持 https://github.com/owner/repo、owner/repo；不支持 /issues、/tree 等子页面，会归到仓库首页）' }, 400);
            return;
          }

          // 同一仓库同一会话 30 秒内不重复截（群友常连发两次链接）
          const shotKey = `${key}|${info.url}`;
          const lastAt = gitHubShotTimes.get(shotKey) || 0;
          if (Date.now() - lastAt < 30000) {
            sendJson({ ok: false, error: '刚截过这个仓库，30 秒内不重复发（避免刷屏）' }, 429);
            return;
          }

          try {
            const proxy = String(gs.proxy || cfg.socialV2?.images?.proxy || '').trim();
            const shot = await screenshotGitHubRepo(info, {
              proxy,
              width: 1400,
              sliceHeight: Math.max(0, Number(gs.sliceHeight) || 2400),
              maxHeight: Math.max(1000, Number(gs.maxHeight) || 12000),
              waitMs: Math.max(0, Number(gs.waitMs) || 3500),
              timeoutMs: Math.max(10000, Number(gs.timeoutMs) || 90000)
            });

            const slices = Array.isArray(shot.slices) && shot.slices.length
              ? shot.slices
              : [{ buffer: shot.buffer, mimeType: shot.mimeType, height: shot.height, fromY: 0 }];

            // 先发一句说明（含页数），群友知道后面还有几张
            const label = info.repo ? `${info.owner}/${info.repo}` : info.owner;
            const note = slices.length > 1
              ? `GitHub ${label} 首页（整页 ${Math.round(shot.height)}px，分 ${slices.length} 张发）`
              : `GitHub ${label} 首页`;
            try { await sendToQQ(key, note); } catch { /* 说明发失败不影响截图 */ }

            let sentCount = 0;
            for (const s of slices) {
              try {
                await onebotSendImageFile(key, s.buffer, { label: `［GitHub］${label}` });
                sentCount += 1;
              } catch (error) {
                log(`[GitHub] 第 ${sentCount + 1} 张发送失败：${error?.message ?? error}`);
                break; // 后面几张大概率也会失败（限频/断线），别硬刷
              }
            }
            if (!sentCount) throw new Error('截图已生成但一张都没发出去');

            gitHubShotTimes.set(shotKey, Date.now());
            // 只留最近 200 条，避免无限增长
            while (gitHubShotTimes.size > 200) {
              const oldest = gitHubShotTimes.keys().next().value;
              if (oldest === undefined) break;
              gitHubShotTimes.delete(oldest);
            }

            // 记进会话时间线：后续上下文要知道"我刚发过这个仓库的截图"
            const st = getSocialV2State(key);
            st.recentMessages.push({
              messageId: null,
              sender: '我',
              text: `[图片] 发了 GitHub ${label} 首页截图（${sentCount} 张）`,
              plain: '[图片]',
              tail: '[图片]',
              quoteTargetIsSelf: false,
              isOwner: true,
              ownerLabel: '我',
              isSelf: true,
              media: [],
              hasMedia: false,
              forwardIds: [],
              hasForward: false,
              time: Date.now()
            });
            const recentLimit = Number(cfg.socialV2?.context?.recentLimit) || 100;
            if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
            st.lastAiReplyAt = Date.now();
            st.lastActionAt = Date.now();
            saveSocialV2State();

            log(`[GitHub] 已发送 ${label} 首页截图 ${sentCount}/${slices.length} 张（整页 ${shot.height}px${shot.truncated ? '，已截断' : ''}）`);
            appendActivity(`${key} [GitHub] 已发送 ${label} 首页截图 ${sentCount} 张`);
            sendJson({
              ok: true,
              repo: label,
              url: info.url,
              sent: sentCount,
              slices: slices.length,
              height: shot.height,
              contentHeight: shot.contentHeight,
              truncated: shot.truncated,
              // 让模型知道"还差最后一张没发"之类的情况
              note: sentCount < slices.length ? `只发出 ${sentCount}/${slices.length} 张（后面的发送失败）` : undefined
            });
          } catch (error) {
            const msg = String(error?.message ?? error);
            log(`[GitHub] 截图失败 ${info.url}：${msg}`);
            // 直连失败是最常见的原因，直接点明，省得模型瞎猜
            const hint = /ECONNRESET|ECONNREFUSED|ETIMEDOUT|net::ERR/i.test(msg)
              ? '（GitHub 在本机直连不通，需要在 config.json 的 socialV2.githubShot.proxy 或 socialV2.images.proxy 配置代理）'
              : '';
            sendJson({ ok: false, error: `截图失败：${msg}${hint}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/sticker-note') {
          if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const stickerId = String(body.stickerId ?? '').trim();
          if (!key || !stickerId) { sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('stickerNote')) { sendJson({ ok: false, error: '工具未启用：qq_sticker_note' }, 403); return; }
          const note = body.note !== undefined && body.note !== null ? String(body.note).trim().slice(0, 200) : undefined;
          const tags = body.tags !== undefined && body.tags !== null ? (Array.isArray(body.tags) ? body.tags.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 20) : []) : undefined;
          const usage = body.usage !== undefined && body.usage !== null ? String(body.usage).trim().slice(0, 200) : undefined;
          const entry = applyStickerNoteV2(stickerId, note, tags, usage);
          if (!entry) { sendJson({ ok: false, error: `找不到表情 ${stickerId}` }, 404); return; }
          log(`[sticker] 更新表情本地认知 ${key}: ${entry.id}`);
          sendJson({ ok: true, key, sticker: entry });
          return;
        }
        // 删除收藏表情（写操作，默认关闭 —— 与 set-sticker-remark 同级）。
        // 之所以默认关：上游 delete_custom_face 不校验 emoji_id，
        // 开放后模型一旦传错就会静默删掉别的表情（详见 deleteStickerV2 注释）。
        // 开启方式：config.json 的 socialV2.tools.deleteSticker = true。
        if (req.method === 'POST' && url.pathname === '/api/socialV2/sticker-delete') {
          if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const stickerId = String(body.stickerId ?? '').trim();
          if (!key || !stickerId) { sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('deleteSticker')) { sendJson({ ok: false, error: '工具未启用：qq_delete_sticker' }, 403); return; }
          if (socialV2.paused) { sendJson({ ok: false, error: 'AI 已暂停，当前不允许执行写操作' }, 403); return; }
          // **仅管理员可用**（2026-10-15 用户要求）：群里群友和管理员共用一个会话，
          // 上面的 v2SessionAllowed 只验证"这个会话在白名单里"，不能说明"刚说话的是管理员"。
          // 所以还要按最近一条入站消息的发送者判定，非管理员直接拒绝。
          if (!isOwnerTurn(key)) {
            log(`[sticker] 拒绝删除表情：请求者不是管理员（${key}）`);
            sendJson({ ok: false, error: '删除收藏表情仅管理员可用。如果确实需要删，请让管理员来说。' }, 403);
            return;
          }
          try {
            const r = await deleteStickerV2(stickerId);
            log(`[sticker] 删除收藏表情 ${key}: ${r.id}（${r.desc}）回读确认=${r.verifiedGone ? '已消失' : '未确认'}`);
            appendActivity(`${key} [表情] 已删除收藏表情${r.desc ? `「${r.desc}」` : ''}`);
            sendJson({ ok: true, key, deleted: { id: r.id, md5: r.md5, desc: r.desc }, verifiedGone: r.verifiedGone });
          } catch (error) {
            sendJson({ ok: false, error: `删除表情失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/sticker-remark') {
          if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const stickerId = String(body.stickerId ?? '').trim();
          if (!key || !stickerId) { sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('setStickerRemark')) { sendJson({ ok: false, error: '工具未启用：qq_set_sticker_remark' }, 403); return; }
          // 与删除同理：改的是 QQ 账号上的官方备注，**仅管理员可用**。
          if (!isOwnerTurn(key)) {
            log(`[sticker] 拒绝改备注：请求者不是管理员（${key}）`);
            sendJson({ ok: false, error: '修改收藏表情备注仅管理员可用。' }, 403);
            return;
          }
          try {
            const entry = await setStickerRemarkV2(stickerId, String(body.remark ?? ''));
            log(`[sticker] 修改 QQ 收藏表情备注 ${key}: ${entry.id} -> ${entry.desc}`);
            sendJson({ ok: true, key, sticker: entry });
          } catch (error) {
            sendJson({ ok: false, error: `修改备注失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // 语音消息（GPT-SoVITS）：模型主动发一条语音。
        //
        // 用户反馈（2026-10-22）：群友说「你发个语音」，机器人回「语音我发不出来呀」。
        // 原因是之前只有"桥接按概率把普通回复换成语音"，**模型无从得知、也无法主动调用**。
        // 这个端点让 qq_send_voice 真正能发。
        //
        // 与"概率语音"共用一个引擎与缓存；区别是这里**不受概率限制**——
        // 群友明确要听，就该发。但仍受每小时上限约束（防止一次要十句）。
        if (req.method === 'POST' && url.pathname === '/api/socialV2/send-voice') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const text = String(body.text ?? '').trim();
          if (!key || !text) { sendJson({ ok: false, error: 'key 和 text 不能为空' }, 400); return; }
          if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: '发送语音必须携带 agent token' }, 403); return; }
          if (!agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (!v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (!v2ToolEnabled('sendVoice')) { sendJson({ ok: false, error: '工具未启用：qq_send_voice' }, 403); return; }
          if (deps.live.currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
          if (!deps.live.ttsEngine || !deps.live.ttsEngine.available()) {
            sendJson({ ok: false, error: '语音合成不可用（未启用、未加载完成或探测失败；见控制台「17b 语音合成」）' }, 503);
            return;
          }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, deps.live.currentMode)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          if (shouldBlockSilentReply(key)) { sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403); return; }
          const limitChars = Math.max(20, Number(cfg.socialV2?.tts?.maxChars) || 140);
          if (text.length > limitChars) {
            sendJson({ ok: false, error: `语音最多 ${limitChars} 字（念太长没人听）；这句有 ${text.length} 字，请精简或改用文字` }, 400);
            return;
          }
          // 念出来没有意义的内容直接挡掉（与概率语音同一套规则）
          if (/https?:\/\/|www\.|```/.test(text)) {
            sendJson({ ok: false, error: '这条内容含链接或代码，念出来没用；请改用文字发送' }, 400);
            return;
          }
          const st = getSocialV2State(key);
          const now = Date.now();
          const hist = (Array.isArray(st.ttsTimes) ? st.ttsTimes : []).filter((x) => now - Number(x) < 3600000);
          const maxPerHour = ttsNum(cfg.socialV2?.tts?.maxPerHour, 3, 0, 60);
          if (maxPerHour > 0 && hist.length >= maxPerHour) {
            sendJson({ ok: false, error: `这个会话一小时最多 ${maxPerHour} 条语音，已经发完了；这条先用文字吧` }, 429);
            return;
          }
          try {
            const r = await deps.live.ttsEngine.speak(text);
            if (!r.ok) { sendJson({ ok: false, error: `合成失败：${r.error}` }, 500); return; }
            await onebotSendVoiceFile(key, r.file, { text });
            st.ttsTimes = [...hist, Date.now()].slice(-200);
            st.lastTtsAt = Date.now();
            // 主动语音也是一次真实发言：更新回复时间，并把 [语音] 标记写回
            // recentMessages/journal，避免模型下一轮不知道刚才发的是语音。
            st.lastAiReplyAt = Date.now();
            st.lastActionAt = st.lastAiReplyAt;
            st.wakeConfig.noActionCount = 0;
            recordSentMessagesV2(key, [{ text, isVoice: true }]);
            saveSocialV2State();
            log(`[TTS] 主动发语音（${r.cached ? '缓存' : `${r.synthSec ?? '?'}s 合成`}，${r.durSec}s，${text.length} 字）→ ${key}`);
            appendActivity(`${key} [TTS] 主动发了一条语音（${r.durSec}s）`);
            sendJson({ ok: true, key, durSec: r.durSec, cached: !!r.cached, chars: text.length });
          } catch (error) {
            log(`[TTS] 主动发语音失败：${error?.message ?? error}`);
            sendJson({ ok: false, error: `发送失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/send-sticker') {
          if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const stickerId = String(body.stickerId ?? '').trim();
          const caption = String(body.message ?? body.caption ?? '').trim();
          const replyToMessageId = body.replyToMessageId;
          const atUserId = body.atUserId ?? null;
          if (!key || !stickerId) { sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400); return; }
          // 仿真常识：表情消息只能是一张表情，不能在同一气泡里附带文字说明。
          if (caption) {
            sendJson({ ok: false, error: '表情消息不能附带文字；请先用 qq_send_message / qq_reply 把想说的话作为单独气泡发送，再单独 qq_send_sticker 发表情' }, 400);
            return;
          }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('sendSticker')) { sendJson({ ok: false, error: '工具未启用：qq_send_sticker' }, 403); return; }
          if (deps.live.currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
          if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, deps.live.currentMode)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          if (kind === 'private' && atUserId) { sendJson({ ok: false, error: '私聊不需要 @' }, 400); return; }
          if (shouldBlockSilentReply(key)) { sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403); return; }
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '' && !isSymbolicReplyRef(replyToMessageId) && !/^-?[1-9]\d*$/.test(String(replyToMessageId).trim())) {
            sendJson({ ok: false, error: 'replyToMessageId 必须是非零整数（消息 id 可能为负数），或传 latest/上一条 表示引用最近一条别人的消息' }, 400);
            return;
          }
          let quotedInfo = null;
          let actualReplyToMessageId = replyToMessageId;
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
            const stForReply = getSocialV2State(key);
            const resolved = await resolveReplyTargetV2(stForReply, kind, id, String(replyToMessageId).trim());
            if (!resolved) {
              sendJson({ ok: false, error: '无法解析被引用消息，请确认 message id 正确且属于当前会话（可用 qq_get_message_detail 查看）' }, 400);
              return;
            }
            quotedInfo = resolved.info;
            actualReplyToMessageId = resolved.messageId;
          }
          const sendCfg = cfg.socialV2?.send ?? {};
          const now = Date.now();
          try {
            const st = getSocialV2State(key);
            const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
            const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
            const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
            const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
            if ((maxPerMinute > 0 && recentMinute + 1 > maxPerMinute) || (maxPerHour > 0 && recentHour + 1 > maxPerHour)) {
              sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
              return;
            }
            st.sendTimes.push(now);
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            const sent = await sendStickerV2(key, stickerId, {
              replyToMessageId: actualReplyToMessageId,
              atUserId
            });
            // 记录到二代会话的 recentMessages，让 AI 知道自己发过这个表情
            const label = sent.entry?.desc || sent.entry?.localNote || '表情包';
            const text = `[表情包:${label}]`;
            st.recentMessages.push({
              messageId: sent.messageId ? String(sent.messageId) : null,
              sender: '我',
              text: text.slice(0, 200),
              plain: text.slice(0, 200),
              quoteTargetIsSelf: false,
              isOwner: true,
              ownerLabel: '我',
              isSelf: true,
              media: [],
              hasMedia: false,
              forwardIds: [],
              hasForward: false,
              sticker: { id: sent.entry?.id || stickerId, desc: sent.entry?.desc || '', localNote: sent.entry?.localNote || '' },
              time: Date.now()
            });
            const recentLimit = Number(cfg.socialV2?.context?.recentLimit) || 100;
            if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
            // 表情频率控制用：记下"真发过"的时间与最近发过的 id。
            // 注意与 stickerNudgeTimes（"要求过"的次数）是两笔账——
            // 掷中但模型选择"跳过"时，不该算进"发过"，否则下次会被间隔误挡。
            st.lastStickerAt = now;
            st.recentStickers = [...(Array.isArray(st.recentStickers) ? st.recentStickers : []),
              String(sent.entry?.md5 || sent.entry?.id || stickerId)].slice(-10);
            st.lastAiReplyAt = now;
            st.lastActionAt = now;
            st.wakeConfig.noActionCount = 0;
            st.preSleepWaitSatisfiedAt = 0;
            st.preSleepWaitObservedAt = 0;
            st.preSleepWaitAccumMs = 0;
            saveSocialV2State();
            scheduleReplyCheckV2(key);
            log(`[sticker] 工具发送表情 ${key}: ${sent.entry?.id || stickerId}`);
            appendActivity(`${key} [sticker] 工具发送表情：${label}`);
            sendJson({ ok: true, key, sticker: sent.entry, sent: 1, failed: 0, quoted: quotedInfo });
          } catch (error) {
            const st = getSocialV2State(key);
            const idx = st.sendTimes.indexOf(now);
            if (idx >= 0) st.sendTimes.splice(idx, 1);
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            saveSocialV2State();
            log(`[sticker] 工具发送表情失败 ${key}: ${error?.message ?? error}`);
            sendJson({ ok: false, error: `发送表情失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/collect-sticker') {
          if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const messageRef = String(body.messageId ?? body.seq ?? '').trim();
          const remark = String(body.remark ?? '').trim();
          if (!key || !messageRef) { sendJson({ ok: false, error: 'key 和 messageId/seq 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('collectSticker')) { sendJson({ ok: false, error: '工具未启用：qq_collect_sticker' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const st = getSocialV2State(key);
          const collectCfg = cfg.socialV2?.sticker?.collect ?? {};
          if (collectCfg.enabled === false) { sendJson({ ok: false, error: 'AI 收藏表情功能已关闭' }, 403); return; }
          const now = Date.now();
          const maxPerMinute = Math.max(0, Number(collectCfg.maxPerMinute) || 0);
          const maxPerHour = Math.max(0, Number(collectCfg.maxPerHour) || 0);
          const recentMinute = (st.stickerCollectTimes || []).filter((t) => now - t < 60000).length;
          const recentHour = (st.stickerCollectTimes || []).filter((t) => now - t < 3600000).length;
          if ((maxPerMinute > 0 && recentMinute + 1 > maxPerMinute) || (maxPerHour > 0 && recentHour + 1 > maxPerHour)) {
            sendJson({ ok: false, error: '收藏表情太频繁了，请过一会儿再偷图' }, 429);
            return;
          }
          // 先预占收藏次数，避免并发调用绕过限频；失败时回滚。
          st.stickerCollectTimes = st.stickerCollectTimes || [];
          st.stickerCollectTimes.push(now);
          if (st.stickerCollectTimes.length > 500) st.stickerCollectTimes = st.stickerCollectTimes.slice(-500);
          try {
            const result = await collectStickerV2(key, messageRef, remark);
            saveSocialV2State();
            log(`[sticker] AI 收藏表情 ${key}: ${result.emojiId}${result.remark ? '（备注：' + result.remark + '）' : ''}`);
            appendActivity(`${key} [sticker] AI 收藏表情：${result.remark || result.emojiId}`);
            sendJson({ ok: true, key, sticker: result.entry, emojiId: result.emojiId, remark: result.remark });
          } catch (error) {
            const idx = st.stickerCollectTimes.indexOf(now);
            if (idx >= 0) st.stickerCollectTimes.splice(idx, 1);
            if (st.stickerCollectTimes.length > 500) st.stickerCollectTimes = st.stickerCollectTimes.slice(-500);
            saveSocialV2State();
            log(`[sticker] AI 收藏表情失败 ${key}: ${error?.message ?? error}`);
            sendJson({ ok: false, error: `收藏表情失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // ── 按需抓网页 / 找图 / 把图片存成 QQ 收藏表情 ────────────────────
        // 模型侧工具：qq_crawl_web。所有抓取走 safe-fetch（禁内网、逐跳校验重定向），
        // 不绕过登录/验证码；图片入库用 SnowLuma 的 add_custom_face。
        if (req.method === 'POST' && url.pathname === '/api/socialV2/crawl') {
          const ccfg = { ...(cfg.socialV2?.crawl ?? {}) };
          if (ccfg.enabled === false) { sendJson({ ok: false, error: '爬虫功能已关闭' }, 403); return; }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('crawl')) { sendJson({ ok: false, error: '工具未启用：qq_crawl_web' }, 403); return; }
          if (!/^(group|private):\d+$/.test(key)) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }

          const st = getSocialV2State(key);
          const now = Date.now();
          const maxPerHour = Math.max(0, Number(ccfg.maxPerHour) || 0);
          const crawlTimes = (Array.isArray(st.crawlTimes) ? st.crawlTimes : []).filter((t) => now - Number(t) < 3600000);
          if (maxPerHour > 0 && crawlTimes.length >= maxPerHour) {
            sendJson({ ok: false, error: `爬取太频繁了：每小时最多 ${maxPerHour} 次` }, 429);
            return;
          }
          st.crawlTimes = [...crawlTimes, now].slice(-200);
          saveSocialV2State();

          const mode = ['text', 'images', 'stickers'].includes(String(body.mode))
            ? String(body.mode)
            : (body.saveStickers === true ? 'stickers' : 'auto');
          const saveStickers = body.saveStickers === true || mode === 'stickers';
          const dryRun = body.dryRun === true;
          const maxStickersPerCall = Math.max(1, Math.min(5, Number(ccfg.maxStickersPerCall) || 3));
          const maxImages = Math.max(1, Math.min(30, Number(ccfg.maxImages) || 10));
          const limit = Math.max(1, Math.min(saveStickers ? maxStickersPerCall : maxImages, Number(body.limit) || (saveStickers ? maxStickersPerCall : maxImages)));
          const query = String(body.query ?? '').trim();
          const category = String(body.category ?? '').trim();
          const targetUrl = String(body.url ?? '').trim();

          try {
            let result;
            if (!targetUrl || isAigengtuUrl(targetUrl)) {
              result = await crawlAigengtu({ query, category, limit });
            } else {
              result = await crawlUrl(targetUrl, { query, limit, maxText: 4000 });
            }

            if (!saveStickers) {
              const blocked = !!result.needsLogin;
              sendJson({
                ok: !blocked,
                kind: result.kind,
                url: result.url,
                title: result.title,
                text: result.text,
                images: (result.images || []).slice(0, limit),
                needsLogin: blocked,
                error: blocked ? '页面需要登录/验证或已经失效，无法读取内容' : undefined,
                note: blocked
                  ? '不要编造内容；如实告诉群友这个链接打不开（需要登录/验证或已失效）。'
                  : (mode === 'images' ? '只返回了图片地址；需要变成 QQ 收藏表情时用 mode=stickers。' : '')
              });
              return;
            }

            if (cfg.socialV2?.sticker?.enabled === false) {
              sendJson({ ok: false, error: '表情包体系已关闭，不能存表情' }, 403);
              return;
            }
            const candidates = (result.images || []).slice(0, limit);
            if (!candidates.length) {
              sendJson({ ok: false, error: '没有找到可用图片', needsLogin: !!result.needsLogin }, 404);
              return;
            }

            const maxPerDay = Math.max(0, Number(ccfg.stickerMaxPerDay) || 0);
            const addTimes = (Array.isArray(st.stickerAddTimes) ? st.stickerAddTimes : []).filter((t) => now - Number(t) < 86400000);
            if (maxPerDay > 0 && addTimes.length >= maxPerDay) {
              sendJson({ ok: false, error: `今天存的表情太多了：每天最多 ${maxPerDay} 张` }, 429);
              return;
            }

            const synced = await syncStickerLibrary(false);
            const existingMd5 = new Set(
              (synced?.entries ?? deps.live.stickerEntries ?? [])
                .map((e) => String(e?.md5 || '').trim().toLowerCase())
                .filter(Boolean)
            );
            const cacheDir = path.join(STATE_DIR, 'sticker-cache');
            const referer = result.kind === 'aigengtu' ? 'https://aigengtu.com/' : (result.url || targetUrl || '');
            const maxBytes = Math.max(256 * 1024, Number(ccfg.maxBytes) || 5 * 1024 * 1024);
            const added = [];
            const skipped = [];
            const errors = [];

            for (const c of candidates) {
              let tmp = null;
              try {
                tmp = await saveStickerImage(c.url, { dir: cacheDir, maxBytes, headers: referer ? { referer } : {} });
                if (existingMd5.has(String(tmp.md5).toLowerCase())) {
                  skipped.push({ url: c.url, md5: tmp.md5, name: c.name, reason: '已经收藏过' });
                  continue;
                }
                if (dryRun) {
                  added.push({ url: c.url, md5: tmp.md5, ext: tmp.ext, bytes: tmp.bytes, name: c.name, dryRun: true });
                  continue;
                }
                const resp = await bot.request('add_custom_face', { file: tmp.path });
                if (!resp || resp.status !== 'ok' || resp.retcode !== 0) {
                  throw new Error(resp?.wording || resp?.message || `add_custom_face retcode=${resp?.retcode}`);
                }
                const emojiId = String(resp.data?.emoji_id || '');
                if (!emojiId) throw new Error('add_custom_face 没返回 emoji_id');
                if (c.name) {
                  try {
                    await bot.request('modify_custom_face', { emoji_id: emojiId, desc: String(c.name).slice(0, 20) });
                  } catch { /* 备注失败不影响已入库 */ }
                }
                existingMd5.add(String(tmp.md5).toLowerCase());
                st.stickerAddTimes = [...(Array.isArray(st.stickerAddTimes) ? st.stickerAddTimes : []).filter((t) => now - Number(t) < 86400000), Date.now()].slice(-200);
                added.push({ url: c.url, md5: tmp.md5, ext: tmp.ext, bytes: tmp.bytes, name: c.name, emojiId });
              } catch (error) {
                errors.push({ url: c.url, name: c.name, error: String(error?.message ?? error) });
              } finally {
                if (tmp?.path) { try { fs.rmSync(tmp.path, { force: true }); } catch { /* 忽略 */ } }
              }
            }

            if (added.length && !dryRun) {
              try { await syncStickerLibrary(true); } catch { /* 同步失败不影响已入库 */ }
            }
            saveSocialV2State();
            log(`[crawl] ${key} ${dryRun ? '试运行' : '存表情'}：新增 ${added.length}，跳过 ${skipped.length}，失败 ${errors.length}`);
            appendActivity(`${key} [crawl] ${dryRun ? '试运行' : '存表情'}：${added.map((x) => x.name || x.emojiId).join('、').slice(0, 60) || '无新增'}`);
            sendJson({
              ok: added.length > 0 || skipped.length > 0,
              kind: 'stickers',
              dryRun,
              added,
              skipped,
              errors,
              text: result.text || '',
              needsLogin: !!result.needsLogin,
              note: dryRun ? '试运行：只下载和校验，没有写入 QQ 收藏表情。' : ''
            });
          } catch (error) {
            log(`[crawl] ${key} 抓取失败：${error?.message ?? error}`);
            sendJson({ ok: false, error: `抓取失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/sticker-list') {
          if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const key = String(url.searchParams.get('key') ?? '').trim();
          const query = String(url.searchParams.get('query') ?? '').trim();
          const maxCount = Math.max(1, Number(cfg.socialV2?.sticker?.maxListCount) || 100);
          const count = Math.min(500, Math.max(1, Math.min(Number(url.searchParams.get('count')) || 48, maxCount)));
          let force = url.searchParams.get('refresh') === '1' || url.searchParams.get('refresh') === 'true';
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('listStickers')) { sendJson({ ok: false, error: '工具未启用：qq_list_stickers' }, 403); return; }
          // AI 强制刷新加最小间隔，避免反复调用 OneBot 表情接口造成限频/负载。
          if (req.headers['x-agent-token'] && force) {
            const now = Date.now();
            if (now - deps.live.lastForcedAgentStickerSync < 10000) force = false;
            else deps.live.lastForcedAgentStickerSync = now;
          }
          try {
            const synced = await syncStickerLibrary(force);
            const list = formatStickerList(synced?.entries ?? deps.live.stickerEntries, query, count, stickerCacheOpts());
            sendJson({ ok: true, key, ...list, syncedAt: synced?.syncedAt ?? deps.live.stickerSyncedAt, fromCache: synced?.fromCache ?? false });
          } catch (error) {
            sendJson({ ok: false, error: `获取表情列表失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // 管理端表情库接口（控制台）
        if (req.method === 'GET' && url.pathname === '/api/stickers') {
          const query = String(url.searchParams.get('query') ?? '').trim();
          const maxCount = Math.max(1, Number(cfg.socialV2?.sticker?.maxListCount) || 100);
          const count = Math.min(500, Math.max(1, Math.min(Number(url.searchParams.get('count')) || 48, maxCount)));
          const force = url.searchParams.get('refresh') === '1' || url.searchParams.get('refresh') === 'true';
          try {
            const synced = await syncStickerLibrary(force);
            const list = formatStickerList(synced?.entries ?? deps.live.stickerEntries, query, count, stickerCacheOpts());
            sendJson({ ok: true, ...list, syncedAt: synced?.syncedAt ?? deps.live.stickerSyncedAt, fromCache: synced?.fromCache ?? false });
          } catch (error) {
            sendJson({ ok: false, error: `获取表情失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/stickers/sync') {
          try {
            const synced = await syncStickerLibrary(true);
            sendJson({ ok: true, total: synced?.entries?.length ?? deps.live.stickerEntries.length, syncedAt: synced?.syncedAt ?? deps.live.stickerSyncedAt });
          } catch (error) {
            sendJson({ ok: false, error: `同步表情失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/stickers/note') {
          const body = await readBody();
          const stickerId = String(body.stickerId ?? '').trim();
          const note = body.note !== undefined && body.note !== null ? String(body.note).trim().slice(0, 200) : undefined;
          const tags = body.tags !== undefined && body.tags !== null ? (Array.isArray(body.tags) ? body.tags.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 20) : []) : undefined;
          const usage = body.usage !== undefined && body.usage !== null ? String(body.usage).trim().slice(0, 200) : undefined;
          if (!stickerId) { sendJson({ ok: false, error: 'stickerId 不能为空' }, 400); return; }
          const entry = applyStickerNoteV2(stickerId, note, tags, usage);
          if (!entry) { sendJson({ ok: false, error: `找不到表情 ${stickerId}` }, 404); return; }
          sendJson({ ok: true, sticker: entry });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/stickers/remark') {
          const body = await readBody();
          const stickerId = String(body.stickerId ?? '').trim();
          if (!stickerId) { sendJson({ ok: false, error: 'stickerId 不能为空' }, 400); return; }
          try {
            const entry = await setStickerRemarkV2(stickerId, String(body.remark ?? ''));
            sendJson({ ok: true, sticker: entry });
          } catch (error) {
            sendJson({ ok: false, error: `修改备注失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/wait') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('waitMessages')) { sendJson({ ok: false, error: '工具未启用：qq_wait_for_messages' }, 403); return; }
          if (socialV2.paused) {
            const st = getSocialV2State(key);
            sendJson({ ok: true, key, paused: true, arrived: false, timeout: false, waitedMs: 0, newMessages: [], unreadCount: st.unread.length });
            return;
          }
          const waitCfg = cfg.socialV2?.wait ?? {};
          const minNew = Math.max(1, Math.round(Number(body.minNewMessages) || 1));
          const defaultMs = Number(waitCfg.defaultMs) || 30000;
          const minMs = Math.max(100, Number(waitCfg.minMs) || 5000);
          const maxMs = Math.max(minMs, Number(waitCfg.maxMs) || 600000);
          const timeoutMs = Math.min(maxMs, Math.max(minMs, Math.round(Number(body.timeoutMs) || defaultMs)));
          const waitTurnMaxCount = Math.max(1, Math.min(20, Math.round(Number(waitCfg.turnMaxCount) || WAIT_TURN_MAX_COUNT)));
          const waitTurnMaxMs = Math.max(5000, Math.min(600000, Math.round(Number(waitCfg.turnMaxMs) || WAIT_TURN_MAX_MS)));
          const st = getSocialV2State(key);
          const sendWaitWrapUp = (why) => {
            log(`[reserved2] wait 强制收尾 ${key}（${why}），要求模型立即结束回合`);
            sendJson({
              ok: true,
              key,
              arrived: false,
              quiet: true,
              quietMs: 0,
              suggestedQuietMs: 0,
              speakerLikelyDone: true,
              lastMessageUnfinished: false,
              timeout: true,
              waitedMs: 0,
              preSleepWaitSatisfied: false,
              preSleepWaitObserved: false,
              preSleepWaitMs: 0,
              preSleepWaitRemainingMs: 0,
              newMessages: [],
              unreadCount: st.unread.length,
              forceWrapUp: true,
              wrapUpHint: `${FORCE_WRAPUP_HINT}（触发原因：${why}）`
            });
          };
          // ── 单回合硬上限（优先于滑动窗口）──────────────────────────────
          // 旧版只有 12 分钟/8 次的跨回合窗口：单回合 6 次、跨度 24 分钟，早期记录
          // 过期后窗口永远凑不满 8 次。这里按 DSH turn 计时，最多 2 次/120s。
          let waitTurnStat = null;
          {
            const sid = state.sessions[key];
            const turnStart = sid ? (Number(v2TurnStartAt.get(sid)) || 0) : 0;
            if (sid && turnStart) {
              let stat = waitTurnTotals.get(sid);
              if (!stat || stat.turnStart !== turnStart) {
                stat = { turnStart, count: 0, totalMs: 0 };
                waitTurnTotals.set(sid, stat);
              }
              if (stat.count >= waitTurnMaxCount || stat.totalMs >= waitTurnMaxMs) {
                const why = stat.totalMs >= waitTurnMaxMs
                  ? `本回合等待累计 ${Math.round(stat.totalMs / 1000)}s`
                  : `本回合已等待 ${stat.count} 次`;
                waitTurnTotals.delete(sid);
                sendWaitWrapUp(why);
                return;
              }
              stat.count += 1;
              waitTurnStat = stat;
            }
            // 有界清理：避免长进程里 Map 无限增长
            if (waitTurnTotals.size > 200) {
              const nowTs = Date.now();
              for (const [sid2, stat2] of waitTurnTotals) {
                if (!stat2 || nowTs - Number(stat2.turnStart) > 30 * 60 * 1000) waitTurnTotals.delete(sid2);
              }
            }
          }
          // ── 值班循环硬上限（跨回合滑动窗口）───────────────────────────
          // 起初按「单回合内 wait 次数」计数，但活跃群里的循环形态是
          // 「唤醒→wait 60s→收尾结束回合→又被新消息唤醒→再 wait …」，
          // 每个回合都正常 completed，单回合计数每回合重置，永远到不了上限——
          // 表现为群里有人不停催（speak/戳），机器人却一直在「观察→收尾」，消息全排队。
          // 因此改为滑动窗口：不管跨多少个回合，只要「最近 WINDOW 内 wait 满 MAX 次」
          // 就强制收尾，让模型立即结束回合（配 wakeConfig 的潜水设置去过一会儿再看）。
          {
            const nowTs = Date.now();
            const hist = (waitTurnStats.get(key) ?? []).filter((t) => nowTs - t < WAIT_WINDOW_MS);
            hist.push(nowTs);
            waitTurnStats.set(key, hist);
            // 顺带清理过期条目，防止 Map 无限增长
            if (waitTurnStats.size > 200) {
              for (const [k, arr] of waitTurnStats) {
                if (!arr.some((t) => nowTs - t < WAIT_WINDOW_MS)) waitTurnStats.delete(k);
              }
            }
            if (hist.length > WAIT_WINDOW_MAX) {
              const why = `最近 ${Math.round(WAIT_WINDOW_MS / 60000)} 分钟内已等待 ${hist.length - 1} 次`;
              // 重置窗口：给下一轮一个干净起点，避免刚结束就再次触发
              waitTurnStats.set(key, []);
              sendWaitWrapUp(why);
              return;
            }
          }
          // 同一会话只允许一个长轮询等待，避免并发挂起耗尽 HTTP handler。
          if (activeWaits.has(key)) {
            sendJson({ ok: false, error: '该会话已有一个等待中的 qq_wait_for_messages，请等待它结束' }, 429);
            return;
          }
          activeWaits.add(key);
          // 占位标记必须用 finally 兜底释放：曾只挂在 req 'close' + 正常返回路径上，
          // 一旦等待循环中途抛异常（消息处理/状态读写出错），标记就永久残留——
          // 之后该会话所有 qq_wait_for_messages 都返回 429「已有一个等待中」，
          // 模型反复重试全失败，表现为「机器人不理人」（实测私聊遇到）。
          // keep-alive 连接下 req 'close' 也可能迟迟不触发，不能只依赖它。
          let finishWait = () => activeWaits.delete(key);
          req.on('close', () => finishWait());
          try {
          const minQuietAfterNewMs = Number.isFinite(Number(waitCfg.minQuietAfterNewMs)) ? Math.max(0, Number(waitCfg.minQuietAfterNewMs)) : 10000;
          const suggestedQuietMs = Math.max(suggestQuietMsV2(st), minQuietAfterNewMs);
          const rawQuietMs = body.quietMs != null ? Number(body.quietMs) : suggestedQuietMs;
          // 收到新消息后至少再等 minQuietAfterNewMs（默认 10 秒），防止抢话；
          // 即使 AI 传了 quietMs=0，也会被抬升到最小静默窗口。
          // quietMs 单独封顶（默认 15s），不能拿 wait.maxMs 当静默上限——
          // 旧实现让 timeout=120s + quietMs=75s 实际跑出 245s 的单次等待。
          const configuredQuietCap = Number.isFinite(Number(waitCfg.maxQuietMs))
            ? Math.max(0, Number(waitCfg.maxQuietMs))
            : WAIT_QUIET_CAP_MS;
          const maxQuietMs = Math.max(minQuietAfterNewMs, Math.min(WAIT_QUIET_CAP_MS, configuredQuietCap || WAIT_QUIET_CAP_MS));
          const quietMs = Math.min(maxQuietMs, Math.max(minQuietAfterNewMs, Math.round(rawQuietMs) || 0));
          if (st.pendingWakeTimer) {
            clearTimeout(st.pendingWakeTimer);
            st.pendingWakeTimer = null;
          }
          cancelReplyCheckV2(key); // AI 正在主动等待，取消回复检查定时器避免重复唤醒
          const baseline = st.lastUnreadSeq || 0;
          const start = Date.now();
          let arrived = false;
          let lastNewAt = 0;
          let aborted = false;
          req.on('close', () => { aborted = true; });
          // 绝对截止：timeout + 一次 quiet 窗口（+1s 余量）。
          // 旧实现允许 timeout + maxQuietMs + 5s，且每次新消息都重置 lastNewAt，
          // 活跃群里单次 wait 可无限逼近 245s。
          const waitDeadline = start + timeoutMs + quietMs + 1000;
          while (Date.now() - start < timeoutMs && !aborted) {
            let nowSeq = st.lastUnreadSeq || 0;
            if (nowSeq - baseline >= minNew) {
              arrived = true;
              lastNewAt = Date.now();
              // 已等到新消息：继续等到“最后一条新消息之后 quietMs 内不再有新消息”再返回。
              // 但总时长绝不超过 waitDeadline，防止活跃群把 handler 无限挂起。
              while (Date.now() - lastNewAt < quietMs && Date.now() < waitDeadline && !aborted) {
                if ((st.lastUnreadSeq || 0) > nowSeq) {
                  nowSeq = st.lastUnreadSeq || 0;
                  lastNewAt = Date.now();
                }
                await sleep(200);
              }
              break;
            }
            await sleep(300);
          }
          const waitedMs = Date.now() - start;
          if (waitTurnStat) waitTurnStat.totalMs += waitedMs;
          const preSleepWaitMs = Math.max(0, Number(cfg.socialV2?.wake?.preSleepWaitMs) || 300000);
          const preSleepRemainingMs = preSleepWaitBlockedV2(st, key)
            ? Math.max(0, preSleepWaitMs - ((st.lastIncomingAt || 0) ? Date.now() - st.lastIncomingAt : 0))
            : 0;
          const quiet = arrived && quietMs > 0 && (Date.now() - lastNewAt >= quietMs);
          // 判断这次等待是否是“沉睡前观察尝试”：AI 明确请求等满观察窗口（默认 5 分钟）。
          // 只有这种尝试里等到新消息，才会把“已观察并看到新消息”标记下来，允许 AI 看过新消息后直接决定不参与并沉睡。
          const preSleepAttempt = timeoutMs >= preSleepWaitMs;
          // 只有“没等到新消息且总时长达到观察窗口”或“最后一条新消息之后安静满了观察窗口”才算满足沉睡前等待；
          // 不能因为总时长到了但最后一条消息才刚过 10 秒就误判满足。
          const preSleepSatisfiedNow = !arrived
            ? waitedMs >= preSleepWaitMs
            : (quiet && (Date.now() - lastNewAt) >= preSleepWaitMs);
          if (preSleepSatisfiedNow) {
            st.preSleepWaitSatisfiedAt = Date.now();
            st.preSleepWaitObservedAt = 0;
            st.preSleepWaitAccumMs = 0;
          } else if (!arrived) {
            // 短等待不累计：必须单次等满观察窗口（或实际安静时间已足够时由 preSleepWaitBlockedV2 放行）
            st.preSleepWaitAccumMs = 0;
          } else {
            // 等待期间有新消息：
            // - 如果这是一次 5 分钟沉睡前观察尝试，则标记“已观察”，AI 看过 newMessages 后可自行决定是否参与；
            // - 否则只清空累计，不算完成沉睡前观察。
            if (preSleepAttempt) {
              st.preSleepWaitObservedAt = Date.now();
            }
            st.preSleepWaitAccumMs = 0;
          }
          saveSocialV2State();
          const newMessages = arrived ? (Array.isArray(st.recentMessages) ? st.recentMessages : []).filter((m) => m && !m.isSelf && (m.seq || 0) > baseline) : [];
          const lastNew = newMessages.length ? newMessages[newMessages.length - 1] : null;
          const lastMessageUnfinished = lastNew ? looksLikeUnfinished(String(lastNew.tail || lastNew.plain || lastNew.text || '')) : false;
          finishWait();
          sendJson({
            ok: true,
            key,
            arrived,
            quiet,
            quietMs,
            suggestedQuietMs,
            speakerLikelyDone: quiet,
            lastMessageUnfinished,
            timeout: !arrived || (quietMs > 0 && !quiet && Date.now() - start >= timeoutMs),
            waitedMs,
            preSleepWaitSatisfied: preSleepSatisfiedNow,
            preSleepWaitObserved: !!st.preSleepWaitObservedAt,
            preSleepWaitMs,
            preSleepWaitRemainingMs: preSleepRemainingMs,
            newMessages,
            unreadCount: st.unread.length
          });
          } catch (error) {
            // 等待途中异常：释放占位标记后再回错，避免该会话永久无法再 wait
            log(`qq_wait_for_messages 异常 ${key}: ${error?.message ?? error}`);
            sendJson({ ok: false, error: `等待消息失败：${error?.message ?? error}` }, 500);
          } finally {
            finishWait();
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/check-send') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const tool = String(body.tool ?? '').trim();
          const token = String(body.token ?? '').trim();
          if (!key || !tool || !token) {
            sendJson({ ok: false, error: 'key/tool/token 不能为空' }, 400);
            return;
          }
          if (!agentTokenOk(key, token)) {
            sendJson({ ok: false, error: 'agent token 无效' }, 403);
            return;
          }
          if (!v2SessionAllowed(key)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          const flagMap = { sendGroup: 'sendGroup', sendPrivate: 'sendPrivate', reply: 'reply' };
          const flag = flagMap[tool];
          if (!flag) {
            sendJson({ ok: false, error: 'tool 必须是 sendGroup/sendPrivate/reply' }, 400);
            return;
          }
          if (!v2ToolEnabled(flag)) {
            sendJson({ ok: false, error: `工具未启用：qq_${tool === 'sendGroup' ? 'send_group_message' : tool === 'sendPrivate' ? 'send_private_message' : 'reply'}` }, 403);
            return;
          }
          sendJson({ ok: true, key, tool });
          return;
        }
        // ── 工具调用日志 ─────────────────────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/socialV2/tool-log') {
          const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 200));
          sendJson({ ok: true, entries: readToolLog(limit) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/tool-log/clear') {
          if (req.headers['x-agent-token']) { sendJson({ ok: false, error: '该接口仅控制台可用' }, 403); return; }
          try { fs.writeFileSync(TOOL_LOG_FILE, '', 'utf8'); } catch {}
          log('控制台：工具调用日志已清空');
          sendJson({ ok: true });
          return;
        }
        // ── 反馈 / 自己消息 / 消息详情 / 活跃成员 ────────────────────────────
        // 自检：在**运行中的桥接进程里**真实跑一次报错通知，验证「群里零消息 + 管理员收到私聊」。
        // 用控制台令牌鉴权（不是 agent 令牌），只发私聊给 owner，不会打扰任何群。
        // 排障用法：curl -H "x-console-token: <token>" "http://127.0.0.1:3100/api/socialV2/error-notify-selftest?key=group:123"
        if (req.method === 'POST' && url.pathname === '/api/socialV2/error-notify-selftest') {
          if (req.headers['x-agent-token']) { sendJson({ ok: false, error: '该接口仅控制台可用' }, 403); return; }
          const body = await readBody();
          const key = String(body.key ?? '').trim() || 'group:0';
          const title = String(body.title ?? '自检报错（可忽略）');
          const detail = String(body.detail ?? '这是一条由控制台触发的自检通知，用于确认「报错只私聊管理员、不进群」的通道正常。');
          const en = cfg.socialV2?.errorNotice ?? {};
          const base = cfg.errorNotify ?? {};
          const ownerQQ = String(cfg.ownerQQ ?? '').trim();
          if (!ownerQQ) { sendJson({ ok: false, error: 'config.ownerQQ 为空，无法通知管理员' }, 400); return; }
          if (en.notifyOwner === false || base.notifyOwner === false) {
            sendJson({ ok: false, error: '管理员报错通知当前被关闭（socialV2.errorNotice.notifyOwner / errorNotify.notifyOwner）' }, 400);
            return;
          }
          notifyOwnerOfError(key, title, detail, { 来源: '控制台自检' });
          sendJson({
            ok: true,
            key,
            sentTo: `private:${ownerQQ}`,
            groupMessagesSent: 0,
            config: { inGroup: en.inGroup === true, notifyOwner: true, windowMs: Number(base.windowMs) || 0 }
          });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/feedback') {
          sendJson({ ok: true, entries: readFeedbackEntries() });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/feedback-clear') {
          if (req.headers['x-agent-token']) { sendJson({ ok: false, error: '该接口仅控制台可用' }, 403); return; }
          atomicWriteJson(FEEDBACK_FILE, []);
          log('控制台：清空 AI 反馈');
          sendJson({ ok: true });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/feedback') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const level = body.level === 'warning' || body.level === 'error' ? body.level : 'info';
          const rawMessage = String(body.message ?? '').trim();
          if (!key || !rawMessage) { sendJson({ ok: false, error: 'key 和 message 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('feedback')) { sendJson({ ok: false, error: '工具未启用：qq_report_feedback' }, 403); return; }
          // 反馈限频：防止持有会话 token 的调用方刷磁盘/日志。
          const fNow = Date.now();
          const fTimes = feedbackTimes.get(key) || [];
          const fRecentMinute = fTimes.filter((t) => fNow - t < 60000).length;
          const fRecentHour = fTimes.filter((t) => fNow - t < 3600000).length;
          if (fRecentMinute >= 5 || fRecentHour >= 20) {
            sendJson({ ok: false, error: '反馈过于频繁，请稍后再试' }, 429);
            return;
          }
          fTimes.push(fNow);
          feedbackTimes.set(key, fTimes.slice(-100));
          const maxLength = Math.max(1, Number(cfg.socialV2?.feedback?.maxLength) || 500);
          const message = rawMessage.slice(0, maxLength);
          appendFeedbackEntry({ id: Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8), key, level, message, time: new Date().toISOString() });
          log(`[reserved2] AI 反馈 (${key}) [${level}]: ${message.slice(0, 80)}`);
          appendActivity(`${key} [reserved2] AI 反馈 [${level}]：${message.slice(0, 80)}`);
          if (cfg.socialV2?.feedback?.notifyOwnerOnError && level === 'error' && cfg.ownerQQ) {
            log(`[reserved2] 错误级反馈，可通知 owner ${cfg.ownerQQ}（当前仅记录日志）`);
          }
          sendJson({ ok: true, key, level, message });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/my-recent') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 10));
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getMyRecent')) { sendJson({ ok: false, error: '工具未启用：qq_get_my_recent_messages' }, 403); return; }
          const st = getSocialV2State(key);
          const mine = st.recentMessages.filter((m) => m.isSelf).slice(-limit);
          sendJson({ ok: true, key, messages: mine });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/record-sent') {
          // 内部接口不对外开放：防止持有会话 token 的调用方伪造“我说过…”的历史记录。
          sendJson({ ok: false, error: '该接口仅桥接内部使用，不接受外部调用' }, 403);
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/message-detail') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const messageId = String(url.searchParams.get('messageId') ?? '').trim();
          if (!key || !messageId) { sendJson({ ok: false, error: 'key 和 messageId 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getMessageDetail')) { sendJson({ ok: false, error: '工具未启用：qq_get_message_detail' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          try {
            const st = getSocialV2State(key);
            const found = (st.recentMessages || []).find((m) => m && (String(m.seq) === messageId || (m.messageId && String(m.messageId) === messageId)));
            const forwardFields = found ? {
              forwardIds: Array.isArray(found.forwardIds) ? found.forwardIds : [],
              hasForward: !!found.hasForward
            } : {};
            let info = null;
            // 如果入参命中本地 seq 且本地存有真实 messageId，优先按 seq 展示，避免与真实 id 冲突。
            if (found && found.messageId && String(found.messageId) !== messageId) {
              info = {
                sender: String(found.sender || ''),
                text: String(found.text || found.plain || '').slice(0, 200),
                userId: found.userId ? String(found.userId) : null,
                messageId: String(found.messageId),
                seq: found.seq
              };
            } else {
              info = await resolveReplyInfo(kind, id, messageId);
              if (!info && found) {
                info = {
                  sender: String(found.sender || ''),
                  text: String(found.text || found.plain || '').slice(0, 200),
                  userId: found.userId ? String(found.userId) : null,
                  messageId: found.messageId ? String(found.messageId) : null,
                  seq: found.seq
                };
              }
            }
            // 无论 info 来自本地还是 OneBot，只要本地有 found 就补充转发字段，避免提示词与实现不一致。
            if (info && found) Object.assign(info, forwardFields);
            sendJson({ ok: true, key, messageId, info });
          } catch (error) {
            sendJson({ ok: false, error: `获取消息详情失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // ── 合并转发消息查询端点（MCP qq_get_forward_msg 走这里） ────────────
        if (req.method === 'GET' && url.pathname === '/api/socialV2/forward-message') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const id = String(url.searchParams.get('id') ?? '').trim();
          const agentToken = String(req.headers['x-agent-token'] ?? '').trim();
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          if (!id) { sendJson({ ok: false, error: 'id 不能为空' }, 400); return; }
          if (deps.live.currentMode !== 'reserved2') {
            sendJson({ ok: false, error: '合并转发查看仅 reserved2 模式可用' }, 403);
            return;
          }
          if (!agentToken) {
            sendJson({ ok: false, error: 'reserved2 模式读取合并转发必须携带 agent token' }, 403);
            return;
          }
          if (!agentTokenOk(key, agentToken)) {
            sendJson({ ok: false, error: 'agent token 无效' }, 403);
            return;
          }
          const kind = keyMatch[1];
          const num = Number(keyMatch[2]);
          if (!Number.isFinite(num) || num <= 0 || !modeAllowed(key, kind, num, cfg, deps.live.currentMode)) {
            sendJson({ ok: false, error: '当前模式不允许读取该会话' }, 403);
            return;
          }
          if (!v2ToolEnabled('getForwardMsg')) {
            sendJson({ ok: false, error: '工具未启用：qq_get_forward_msg' }, 403);
            return;
          }
          // 安全边界：只允许读取本会话确实收到过的 forward id，防止 AI 任意探测/跨会话读取
          const st = getSocialV2State(key);
          const seenInRecent = (st?.recentMessages || []).some((m) => Array.isArray(m?.forwardIds) && m.forwardIds.includes(id));
          const seenInUnread = (st?.unread || []).some((m) => Array.isArray(m?.forwardIds) && m.forwardIds.includes(id));
          const seenInMemory = seenForwardIds.get(key)?.has(id) === true;
          if (!seenInRecent && !seenInUnread && !seenInMemory) {
            sendJson({ ok: false, error: '该转发消息 id 不在当前会话可见范围内，拒绝读取' }, 404);
            return;
          }
          try {
            const data = await bot.raw('get_forward_msg', { id });
            const formatted = formatForwardResponse(data);
            const remember = (fid) => {
              if (!fid) return;
              let set = seenForwardIds.get(key);
              if (!set) {
                set = new Set();
                seenForwardIds.set(key, set);
              }
              set.add(fid);
              if (set.size > 1000) {
                for (const old of set) {
                  set.delete(old);
                  if (set.size <= 1000) break;
                }
              }
            };
            // 把本层出现的嵌套 forward id 登记为“本会话已见过”，AI 后续可直接再次读取。
            for (const m of formatted.messages || []) {
              for (const fid of m.nestedForwardIds || []) remember(fid);
            }
            // 抓取嵌套转发的前几条作为预览，让 AI 不需要二次调用也能先看到内容。
            const nestedPreviews = [];
            const nestedIds = [];
            const seenNested = new Set();
            for (const m of formatted.messages || []) {
              for (const fid of m.nestedForwardIds || []) {
                if (!seenNested.has(fid) && nestedIds.length < 5) {
                  seenNested.add(fid);
                  nestedIds.push(fid);
                }
              }
            }
            for (const fid of nestedIds) {
              try {
                const ndata = await bot.raw('get_forward_msg', { id: fid });
                const nfmt = formatForwardResponse(ndata, { maxMessages: 3, maxCharsPerMessage: 120 });
                for (const nm of nfmt.messages || []) {
                  for (const nfid of nm.nestedForwardIds || []) remember(nfid);
                }
                nestedPreviews.push({ id: fid, ...nfmt });
              } catch (error) {
                log(`嵌套转发预览失败 ${key} ${fid}:`, error?.message ?? error);
                nestedPreviews.push({ id: fid, error: error?.message ?? '嵌套转发读取失败' });
              }
            }
            sendJson({ ok: true, key, id, ...formatted, nestedPreviews });
          } catch (error) {
            log(`合并转发查询失败 ${key} ${id}: ${error?.message ?? error}`);
            sendJson({ ok: false, error: `合并转发查询失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/forward-media') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const media = Array.isArray(body.media) ? body.media : [];
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getForwardMsg')) { sendJson({ ok: false, error: '工具未启用：qq_get_forward_msg' }, 403); return; }
          if (deps.live.currentMode !== 'reserved2') { sendJson({ ok: false, error: '转发媒体读取仅 reserved2 模式可用' }, 403); return; }
          if (!media.length) { sendJson({ ok: true, key, media: [], images: [] }); return; }
          try {
            const images = await fetchMediaData(media);
            sendJson({ ok: true, key, media, images });
          } catch (error) {
            log(`转发媒体读取失败 ${key}:`, error?.message ?? error);
            sendJson({ ok: false, error: `转发媒体读取失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/active-members') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const limit = Math.min(20, Math.max(1, Number(url.searchParams.get('limit')) || 10));
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getActiveMembers')) { sendJson({ ok: false, error: '工具未启用：qq_get_active_members' }, 403); return; }
          const st = getSocialV2State(key);
          const map = new Map();
          for (const m of st.recentMessages) {
            if (!m || m.isSelf) continue;
            const uid = m.userId ? String(m.userId) : '';
            const key2 = uid || String(m.sender || '未知');
            const cur = map.get(key2) || { sender: m.sender || key2, userId: uid || undefined, count: 0, lastTime: 0, isOwner: !!m.isOwner };
            if (!cur.userId && uid) cur.userId = uid;
            cur.count += 1;
            if (m.time > cur.lastTime) cur.lastTime = m.time;
            if (m.isOwner) cur.isOwner = true;
            map.set(key2, cur);
          }
          const members = [...map.values()].sort((a, b) => b.count - a.count || b.lastTime - a.lastTime).slice(0, limit);
          sendJson({ ok: true, key, members });
          return;
        }
        // ── B 站：观看记录与记忆（全局，跨群共用）────────────────────────────
        //
        // 为什么是全局而不是挂 key：现有 activeTopic/memberImpression 是**群聊上下文**，
        // 本就该按群隔离；而"我喜欢看什么视频"是机器人自己的偏好，与群无关。
        // 在 A 群看过的视频，B 群聊到时也该记得（2026-10-19 用户选定）。
        if (req.method === 'POST' && url.pathname === '/api/socialV2/bili-record') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const token = String(body.token ?? '').trim();
          if (!deps.live.biliMem) { sendJson({ ok: false, error: 'B 站功能未启用' }, 400); return; }
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (token && !agentTokenOk(key, token)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (token && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          // bvid 解析：**优先用"最近看完的那条"**，而不是信模型传的值。
          //
          // 为什么（2026-10-19 实测）：模型记不住 10 位随机 bvid，会**瞎编一个**——
          // 日志里 12:47:12 缓存的是 BV14cnn6REvX，12:47:39 它记录时传的是 BV1qh411c7mR，
          // 于是缓存查不到、记忆里存成两条不同的视频、简介也丢了。
          // 模型只该负责"喜不喜欢"，标识由桥接给。
          let bvid = String(body.bvid ?? '').trim();
          const recent = deps.live.lastBiliWatch?.ok ? String(deps.live.lastBiliWatch.bvid || '').trim() : '';
          if (recent && bvid !== recent) {
            log(`[B站] 模型传的 bvid=${bvid || '(空)'} 与刚看完的 ${recent} 不符，改用后者`);
            bvid = recent;
          }
          if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) {
            sendJson({ ok: false, error: '没有可记录的 bvid（最近没有看完的视频）' }, 400);
            return;
          }
          // 用缓存补全元信息（简介、标题等模型看不到的字段）
          const cached = biliInfoCache.get(bvid);
          if (cached) {
            body.desc = body.desc || cached.desc;
            body.title = body.title || cached.title;
            body.owner = body.owner || cached.owner;
            body.category = body.category || cached.category;
            body.durationSec = body.durationSec || cached.durationSec;
            body.biliTags = cached.biliTags || undefined;
          } else {
            log(`[B站] 记录 ${bvid}: 元信息缓存未命中（可能重启过），标题/简介可能缺失`);
          }
        const rec = deps.live.biliMem.record({
            bvid,
            title: body.title,
            owner: body.owner,
            category: body.category,
            durationSec: body.durationSec,
            // 简介：模型不必自己传，桥接在"自己刷"时会带；工具调用没传就沿用已有的
            desc: body.desc,
            // B 站给的原生标签（简介为空时的主要线索），与模型自己打的 tags 分开存
            biliTags: Array.isArray(body.biliTags) ? body.biliTags : undefined,
            // 字幕片段：桥接看过时缓存，模型不必自己传（它记不住上千字原话）
            subtitle: body.subtitle || undefined,
            tags: Array.isArray(body.tags) ? body.tags : undefined,
            liked: body.liked === true ? true : (body.liked === false ? false : null),
            interest: body.interest,
            watchedFrames: body.watchedFrames,
            watchedSeconds: body.watchedSeconds,
            source: body.source,
            notes: body.notes
          });
          log(`[B站] 记录 ${bvid} liked=${rec?.liked} interest=${rec?.interest} tags=${(rec?.tags || []).join('/')}`);
          sendJson({ ok: true, video: rec, taste: deps.live.biliMem.taste(5), stats: deps.live.biliMem.stats() });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/bili-memory') {
          if (!deps.live.biliMem) { sendJson({ ok: false, error: 'B 站功能未启用' }, 400); return; }
          const key = String(url.searchParams.get('key') ?? '').trim();
          const token = String(req.headers['x-agent-token'] ?? '').trim();
          if (token && key && !agentTokenOk(key, token)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 10));
          const likedOnly = url.searchParams.get('liked') === '1';
          const query = String(url.searchParams.get('q') ?? '').trim();
          let list = deps.live.biliMem.recent(limit, { likedOnly });
          if (query) {
            const q = query.toLowerCase();
            list = list.filter((v) =>
              String(v.title).toLowerCase().includes(q)
              || String(v.owner).toLowerCase().includes(q)
              || (v.tags || []).some((t) => String(t).toLowerCase().includes(q)));
          }
          sendJson({ ok: true, videos: list, taste: deps.live.biliMem.taste(), stats: deps.live.biliMem.stats() });
          return;
        }
        // ── 现场搜索（模型工具 qq_bili_search 用它）──────────────────────────
        //
        // 需求（2026-10-19 用户反馈「为什么没有新增的视频，都是之前说过了的」）：
        // 群友问"推荐点视频"时，模型原来只能翻记忆里的旧视频（因为只有查询工具、
        // 没有搜索工具），还会临时编没有链接的内容。这个端点补上"实时搜索"。
        if (req.method === 'POST' && url.pathname === '/api/socialV2/bili-search') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const token = String(body.token ?? '').trim();
          if (!cfg.socialV2?.bili?.enabled) { sendJson({ ok: false, error: 'B 站功能未启用' }, 400); return; }
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (token && !agentTokenOk(key, token)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (token && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          const query = String(body.query ?? '').trim().slice(0, 60);
          if (!query) { sendJson({ ok: false, error: 'query 不能为空' }, 400); return; }
          try {
            const count = Math.min(20, Math.max(1, Number(body.count) || 8));
            const order = ['totalrank', 'pubdate', 'click'].includes(body.order) ? body.order : 'totalrank';
            const videos = await searchVideos(query, deps.live.biliAuth, { count, order });
            // 过滤掉已经看过/记录过的（推荐"新的"才有意义）
            const fresh = videos.filter((v) => !deps.live.biliMem?.get(v.bvid));
            sendJson({
              ok: true,
              query,
              engineNote: deps.live.biliAuth.loaded && deps.live.biliAuth.hasSessdata ? '登录态搜索' : '匿名搜索',
              videos: fresh.length ? fresh : videos,
              // 若过滤后为空说明全都看过，明确告知（模型据此换关键词）
              allSeen: fresh.length === 0 && videos.length > 0
            });
          } catch (error) {
            log(`[B站] 搜索失败 ${query}：${error?.message ?? error}`);
            sendJson({ ok: false, error: `搜索失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // 手动看一条（群友发链接时也可以走这里；模型工具 qq_watch_bili 用它）
        if (req.method === 'POST' && url.pathname === '/api/socialV2/bili-watch') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const token = String(body.token ?? '').trim();
          if (!cfg.socialV2?.bili?.enabled) { sendJson({ ok: false, error: 'B 站功能未启用' }, 400); return; }
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (token && !agentTokenOk(key, token)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (token && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          try {
            // 支持 b23.tv 短链：群友分享卡片给的常是短链
            const id = await resolveBiliId(String(body.url ?? body.bvid ?? ''));
            if (!id) { sendJson({ ok: false, error: '识别不出 B 站视频（支持 BV号 / 完整链接 / b23.tv 短链）' }, 400); return; }
            const info = id.bvid ? await fetchVideoInfo(id.bvid) : await fetchVideoInfo({ aid: id.aid });
            const wc = cfg.socialV2?.bili?.watchShared ?? {};
            const depth = {
              seconds: Math.max(1, Number(body.seconds) || Number(wc.seconds) || 10),
              frames: Math.max(1, Number(body.frames) || Number(wc.frames) || 12)
            };
            const w = await watchVideo(info.bvid, {
              ...depth,
              info,
              // 群友发的视频同样需要"听见"：字幕拿不到时走 ASR
              asr: deps.live.asrEngine,
              asrEnabled: !!deps.live.asrEngine,
              asrTimeoutMs: 120000
            });
            if (!w.ok) { sendJson({ ok: false, error: w.error || '观看失败' }, 500); return; }
            rememberBiliInfo(w.info, w.grid);
            // 群友发的链接**不计入**每日"自己刷"额度（那是应要求观看，用户明确区分）
            // 分页拼图：帧多时会被切成多张图，按时间顺序全部返回（模型能一次收多张）
            const sheets = Array.isArray(w.grid.sheets) && w.grid.sheets.length
              ? w.grid.sheets
              : [{ buffer: w.grid.buffer, mimeType: w.grid.mimeType || 'image/png' }];
            sendJson({
              ok: true,
              info: w.info,
              hint: w.hint,
              grid: sheets[0].buffer.toString('base64'),
              mimeType: sheets[0].mimeType || 'image/png',
              images: sheets.map((s) => ({
                data: s.buffer.toString('base64'),
                mimeType: s.mimeType || 'image/png'
              }))
            });
          } catch (error) {
            log(`[B站] 观看失败：${error?.message ?? error}`);
            sendJson({ ok: false, error: `观看失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // ── 暂停 / 恢复「自主刷」（控制台按钮）──────────────────────────────
        //
        // 语义：只停"它自己想看视频"这件事，**不影响**群友发链接时的 qq_watch_bili
        //（那条路走 /bili-watch，只检查 b.enabled）。
        //
        // 为什么直接复用 `selfBrowsing.enabled` 而不是新开一个 paused 字段：
        //   这个字段本来就是"自主刷开关"，`scheduleBiliBrowse` / `runBiliBrowse` 都已检查它。
        //   再开一个 paused 会变成两个真相源——配置里写 enabled:false 而 paused:false 时
        //   到底算不算暂停？迟早对不上。
        //
        // 必须落盘：只改内存的话重启就自己恢复刷视频了，用户会以为按钮没生效。
        if (req.method === 'POST' && url.pathname === '/api/socialV2/bili-pause') {
          const body = await readBody();
          const paused = body.paused === true;
          const configFile = path.join(ROOT, 'config.json');
          // fail-fast：配置损坏时绝不回写，否则可能把整个 config 清成只剩 bili 段
          const file = readJsonSafe(configFile, null, true);
          file.socialV2 = file.socialV2 ?? {};
          file.socialV2.bili = file.socialV2.bili ?? {};
          file.socialV2.bili.selfBrowsing = file.socialV2.bili.selfBrowsing ?? {};
          file.socialV2.bili.selfBrowsing.enabled = !paused;
          try {
            atomicWriteJson(configFile, file);
          } catch (error) {
            // 写盘失败不改内存：否则进程内看似生效、重启即丢，症状比报错更迷惑
            log(`[B站] 暂停状态写入失败：${error?.message ?? error}`);
            sendJson({ ok: false, error: `配置写入失败：${error?.message ?? error}` }, 500);
            return;
          }
          // 同步内存（cfg.socialV2 是启动时读进来的副本）
          cfg.socialV2 = cfg.socialV2 ?? {};
          cfg.socialV2.bili = cfg.socialV2.bili ?? {};
          cfg.socialV2.bili.selfBrowsing = cfg.socialV2.bili.selfBrowsing ?? {};
          cfg.socialV2.bili.selfBrowsing.enabled = !paused;

          if (paused) {
            // 清掉已排的定时器：否则"暂停"后它还会按原计划再刷一次
            if (deps.live.biliTimer) { clearTimeout(deps.live.biliTimer); deps.live.biliTimer = null; }
            deps.live.biliScheduledAt = 0;
            deps.live.biliNextDelay = 0;
            log(`[B站] 自主刷已暂停${deps.live.biliBrowsing ? '（当前这一条会看完，之后不再排期）' : ''}`);
          } else {
            log('[B站] 自主刷已恢复');
            scheduleBiliBrowse();
          }
          sendJson({
            ok: true,
            paused,
            // 附带实时状态，前端不必再请求一次
            selfBrowsingEnabled: !paused,
            browsing: deps.live.biliBrowsing
              ? { active: true, phase: biliBrowseState.phase || 'starting' }
              : { active: false }
          });
          return;
        }

        // 「自己刷」状态：剩余额度、上次时间
        // ── 手动触发一次"自己刷"（控制台按钮 / 调试用）──────────────────────
        // 与自动刷的区别只有两点：跳过"距上次太近"的间隔限制、**等结果再回响应**
        // （自动刷是 fire-and-forget，手动点按钮需要知道"到底刷没刷、刷了什么"）。
        //
        // 为什么必须等结果（2026-10-19 踩的坑）：先前这里先 `sendJson({ok:true})` 再把
        // runBiliBrowse 当异步任务跑，两个问题——
        //   ① 用户在控制台只看到"已触发"，实际被间隔限制拦掉，什么都没发生；
        //   ② promise 的 then 里又调 sendJson，导致 "Cannot write headers after they are sent"。
        if (req.method === 'POST' && url.pathname === '/api/socialV2/bili-browse-now') {
          if (!deps.live.biliMem) { sendJson({ ok: false, error: 'B 站功能未启用' }, 400); return; }
          if (deps.live.biliBrowsing) { sendJson({ ok: false, error: '正在刷，等这次结束' }, 409); return; }
          if (deps.live.biliTimer) { clearTimeout(deps.live.biliTimer); deps.live.biliTimer = null; }
          try {
            const r = await runBiliBrowse({ manual: true });
            sendJson(r);
          } catch (e) {
            log(`[B站] 手动刷失败：${e?.message ?? e}`);
            sendJson({ ok: false, error: String(e?.message ?? e) }, 500);
          }
          return;
        }

        // 加好友/入群邀请的待决列表（控制台可见；也方便管理员在外网侧查）
        if (req.method === 'GET' && url.pathname === '/api/socialV2/join-requests') {
          const jr = cfg.socialV2?.joinRequest ?? {};
          sendJson({
            ok: true,
            enabled: jr.enabled !== false,
            autoApprove: jr.autoApprove === true,
            ttlMs: joinQueue.ttlMs,
            ownerConfigured: !!String(cfg.ownerQQ ?? '').trim(),
            pending: joinQueue.list().map((it) => ({
              n: it.n,
              requestType: it.requestType,
              subType: it.subType,
              userId: it.userId,
              nickname: it.nickname || '',
              groupId: it.groupId,
              groupName: it.groupName || '',
              comment: it.comment || '',
              at: it.at,
              remainMs: Math.max(0, joinQueue.ttlMs - (Date.now() - Number(it.at || 0)))
            }))
          });
          return;
        }

        // 控制台试听：合成一句并**以音频返回**（不发群）。
        // 与 /tts-status 分开：这个是 POST + 可能耗时数秒，不该被轮询碰到。
        if (req.method === 'POST' && url.pathname === '/api/socialV2/tts-say') {
          if (!deps.live.ttsEngine || !deps.live.ttsEngine.available()) {
            sendJson({ ok: false, error: '语音合成未启用或不可用（见控制台 17b 卡片）' }, 400);
            return;
          }
          const body = await readBody();
          const text = String(body.text ?? '').trim() || '你好呀，我是达妮娅。';
          try {
            // refId/mood 可选：控制台试听时可以把当前选定的情绪参考也带上
            const r = await deps.live.ttsEngine.speak(text.slice(0, 200), {
              refId: body.refId,
              mood: body.mood,
              params: ttsSpeechParams()
            });
            if (!r.ok) { sendJson({ ok: false, error: r.error }, 500); return; }
            const buf = fs.readFileSync(r.file);
            res.writeHead(200, {
              ...SECURITY_HEADERS,
              'content-type': 'audio/wav',
              'content-length': String(buf.length),
              'cache-control': 'no-store',
              // 诊断用：这次实际用了哪条参考（同源 fetch 可直接读，不需要 CORS）
              'x-tts-ref': String(r.refId || ''),
              'x-tts-mood': String(r.refMood || '')
            });
            res.end(buf);
          } catch (error) {
            sendJson({ ok: false, error: `合成失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // 控制台「选择文件/文件夹」：在**运行桥接的这台电脑**上弹原生对话框。
        //
        // 为什么不在页面里用 <input type=file>：浏览器出于安全限制不会把选中文件的
        // 绝对路径交给 JS，而 TTS 引擎要的正是本机绝对路径（权重/引擎目录）。
        // 所以由桥接起一个 PowerShell（-STA 才能弹 WinForms 对话框），选完把路径
        // 写到临时文件（UTF-8 无 BOM），Node 再读回——避免中文路径经过管道被按
        // GBK 解码（这个坑在 TTS 试听上已经踩过一次）。
        // 脚本是固定文本，只通过环境变量传模式/标题，不接受任何拼接执行的内容。
        if (req.method === 'POST' && url.pathname === '/api/socialV2/tts/pick-path') {
          const body = await readBody();
          const kind = body.kind === 'dir' ? 'dir' : 'file';
          if (process.platform !== 'win32') {
            sendJson({ ok: false, error: '原生文件选择目前只支持 Windows' }, 400);
            return;
          }
          if (deps.live.pickPathBusy) {
            sendJson({ ok: false, error: '已经有一个选择窗口打开了，请先处理它' }, 429);
            return;
          }
          deps.live.pickPathBusy = true;
          const outFile = path.join(STATE_DIR, `pick-path-${process.pid}-${Date.now()}.txt`);
          const script = [
            'Add-Type -AssemblyName System.Windows.Forms',
            'Add-Type -AssemblyName System.Drawing',
            '$owner = New-Object System.Windows.Forms.Form',
            '$owner.TopMost = $true',
            '$owner.ShowInTaskbar = $false',
            '$owner.FormBorderStyle = "None"',
            '$owner.StartPosition = "CenterScreen"',
            '$owner.Size = New-Object System.Drawing.Size(1,1)',
            '$owner.Opacity = 0',
            '$owner.Show()',
            'try {',
            '  if ($env:QQB_PICK_KIND -eq "dir") {',
            '    $d = New-Object System.Windows.Forms.FolderBrowserDialog',
            '    $d.Description = $env:QQB_PICK_TITLE',
            '    $d.ShowNewFolderButton = $false',
            '    if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {',
            '      [System.IO.File]::WriteAllText($env:QQB_PICK_OUT, $d.SelectedPath, (New-Object System.Text.UTF8Encoding($false)))',
            '    }',
            '  } else {',
            '    $f = New-Object System.Windows.Forms.OpenFileDialog',
            '    $f.Title = $env:QQB_PICK_TITLE',
            '    $f.Filter = "权重文件 (*.ckpt;*.pth;*.pt;*.safetensors)|*.ckpt;*.pth;*.pt;*.safetensors|所有文件 (*.*)|*.*"',
            '    $f.CheckFileExists = $true',
            '    if ($f.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {',
            '      [System.IO.File]::WriteAllText($env:QQB_PICK_OUT, $f.FileName, (New-Object System.Text.UTF8Encoding($false)))',
            '    }',
            '  }',
            '} finally { $owner.Close() }'
          ].join('\r\n');
          try {
            const { execFile } = await import('node:child_process');
            await new Promise((resolve, reject) => {
              execFile('powershell.exe',
                ['-NoProfile', '-STA', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-Command', script],
                {
                  timeout: 120000,
                  windowsHide: true,
                  maxBuffer: 1024 * 1024,
                  env: {
                    ...process.env,
                    QQB_PICK_KIND: kind,
                    QQB_PICK_TITLE: kind === 'dir' ? '选择 GPT-SoVITS 引擎目录' : '选择模型权重文件',
                    QQB_PICK_OUT: outFile
                  }
                },
                (error) => (error ? reject(error) : resolve())
              );
            });
            let picked = '';
            try {
              picked = fs.readFileSync(outFile, 'utf8').replace(/^\uFEFF/, '').trim();
            } catch { /* 用户取消：没有输出文件 */ }
            sendJson({ ok: true, path: picked, cancelled: !picked });
          } catch (error) {
            const msg = error?.killed ? '等待选择超时（120 秒）' : (error?.message ?? String(error));
            log(`[TTS] 原生路径选择失败：${msg}`);
            sendJson({ ok: false, error: `打开文件选择框失败：${msg}` }, 500);
          } finally {
            deps.live.pickPathBusy = false;
            try { fs.unlinkSync(outFile); } catch { /* 没生成就忽略 */ }
          }
          return;
        }

        // ── 缓存盘点与清理（2026-10-22 用户要求）──────────────────────────
        //
        // 「注意清理 C 盘缓存，并且控制台中给出对应功能卡片」。
        // GET 只盘点（算体积）；POST 才真删，且只删 kind='safe' 的项
        // （语音模型/图库/观看记忆一律不动，见 cache-manager.js 顶部说明）。
        if (req.method === 'GET' && url.pathname === '/api/socialV2/cache') {
          try {
            const items = collectCacheItems({
              root: ROOT,
              ttsDir: cfg.socialV2?.tts?.enabled === true ? (cfg.socialV2.tts.dir || DEFAULT_SOVITS_DIR) : '',
              // 收藏目录可被配置覆盖；不传则用 <项目>/collected
              collectedDir: cfg.socialV2?.images?.archiveDir || ''
            });
            sendJson({ ok: true, items, groups: CACHE_GROUPS, summary: summarizeCache(items) });
          } catch (error) {
            sendJson({ ok: false, error: `盘点失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/cache-purge') {
          const body = await readBody();
          try {
            const items = collectCacheItems({
              root: ROOT,
              ttsDir: cfg.socialV2?.tts?.enabled === true ? (cfg.socialV2.tts.dir || DEFAULT_SOVITS_DIR) : '',
              collectedDir: cfg.socialV2?.images?.archiveDir || ''
            });
            const r = purgeCache(items, {
              keys: Array.isArray(body.keys) ? body.keys.map(String) : [],
              dryRun: body.dryRun === true
            });
            const human = humanBytes(r.freedBytes);
            if (!r.dryRun) {
              log(`[缓存] 清理完成：释放 ${human}（${r.removed} 个文件）`);
              appendActivity(`[缓存] 清理释放 ${human}`);
            }
            sendJson({
              ok: true,
              freedBytes: r.freedBytes,
              freedHuman: human,
              removed: r.removed,
              details: r.details,
              dryRun: r.dryRun
            });
          } catch (error) {
            log(`[缓存] 清理失败：${error?.message ?? error}`);
            sendJson({ ok: false, error: `清理失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // 语音合成（TTS）状态：给控制台显示"能不能发语音、什么音色、什么概率"。
        // 与 bili-status 分开成独立端点：TTS 是全局能力，不属于 B 站。
        if (req.method === 'GET' && url.pathname === '/api/socialV2/tts-status') {
          const t = cfg.socialV2?.tts ?? {};
          const st = deps.live.ttsEngine ? deps.live.ttsEngine.status() : null;
          const probe = deps.live.ttsEngine ? deps.live.ttsEngine.probe() : null;
          // 请求级韵律参数：控制台回填/保存用（改完即时生效）
          const speech = ttsSpeechParams();
          sendJson({
            ok: true,
            enabled: t.enabled === true,
            // 可插拔的三种可见状态：未启用 / 已启用但不可用 / 可用
            usable: !!(st && st.available && st.enabled),
            state: st ? st.state : (t.enabled === true ? 'unavailable' : 'disabled'),
            voice: st?.voice || t.voiceName || '达妮娅',
            dir: st?.dir || t.dir || DEFAULT_SOVITS_DIR,
            device: st?.device || t.device || 'cuda',
            // 实际加载的权重/版本：引擎就绪时以引擎回报为准。
            // 之前控制台只显示配置项，出现过「显示爱弥斯、实际跑 dania」的误导。
            gptModel: st?.gptModel || (t.gptModel ? path.basename(String(t.gptModel)) : ''),
            sovitsModel: st?.sovitsModel || (t.sovitsModel ? path.basename(String(t.sovitsModel)) : ''),
            modelVersion: st?.version || '',
            loadSec: st?.loadSec ?? null,
            warmed: st?.warmed ?? null,
            // 只有真正不可用时才回显 error；可用时若还带着"未初始化"这类
            // 初始化期的残留文案，会和"可用"状态自相矛盾（实测 UI 上出现过
            // 「可用」+「原因：未初始化」并列）。
            error: (st && st.available && st.state === 'ready') ? null : (st?.error ?? (t.enabled === true ? '未初始化' : null)),
            retryInSec: st?.retryInMs ? Math.round(st.retryInMs / 1000) : 0,
            probability: Math.max(0, Math.min(1, Number(t.probability ?? TTS_DEFAULT_PROBABILITY))),
            maxPerHour: ttsNum(t.maxPerHour, 3, 0, 60),
            maxChars: ttsNum(t.maxChars, 140, 20, 300),
            refText: probe?.refText ? String(probe.refText).slice(0, 80) : '',
            // ── 音色预设（voices.json）──────────────────────────────────
            // 归档里的音色/权重版本/按情绪分好的参考音频。控制台据此渲染下拉；
            // refs 只回 id/mood/label，不回绝对路径。
            voiceId: st?.voiceId || t.voiceId || '',
            weightsId: st?.weightsId || t.weightsId || '',
            weightsLabel: st?.weightsLabel || '',
            refs: st?.refs || [],
            defaultRefId: st?.defaultRefId || '',
            refMode: st?.refMode || t.refMode || 'auto',
            voices: probe?.voices || [],
            manifestPath: probe?.manifestPath || '',
            manifestError: probe?.manifestError || '',
            // 韵律/响度（请求级，保存即生效）
            speech,
            // ── 可编辑参数（2026-10-22 用户要求「设成可变参数并提供修改按钮」）──
            // 分两类，因为生效时机不同：
            //   ① 即时生效：概率/上限/字数——planTtsV2 与端点每次都现读 cfg；
            //   ② 需重启：dir/模型路径/device/线程——它们在启动时传给引擎并进了闭包。
            // 前端据此把第二类标「需重启」，避免用户改完以为没生效。
            editable: {
              probability: Math.max(0, Math.min(1, Number(t.probability ?? TTS_DEFAULT_PROBABILITY))),
              maxPerHour: ttsNum(t.maxPerHour, 3, 0, 60),
              maxChars: ttsNum(t.maxChars, 140, 20, 300),
              dir: String(t.dir || DEFAULT_SOVITS_DIR),
              gptModel: String(t.gptModel || 'GPT_SoVITS/dania-e15.ckpt'),
              sovitsModel: String(t.sovitsModel || 'GPT_SoVITS/dania_e16_s2192.pth'),
              device: String(t.device || 'cuda'),
              cpuThreads: Math.max(1, Number(t.cpuThreads) || 8),
              voiceName: String(t.voiceName || '达妮娅'),
              voiceId: String(t.voiceId || ''),
              weightsId: String(t.weightsId || ''),
              refMode: String(t.refMode || 'auto'),
              // 韵律/响度：请求级参数，保存后下一次合成即生效
              ...speech
            },
            summary: (() => {
              if (t.enabled !== true) return '未启用：只发文字';
              if (!st || !st.available) return `已启用但不可用：${st?.error || (probe ? '探测失败' : '未初始化')}`;
              if (st.state === 'ready') {
                return `可用（${st.voice}）· ${Math.round(Math.max(0, Math.min(1, Number(t.probability ?? TTS_DEFAULT_PROBABILITY))) * 100)}% 概率发语音`
                  + ` · 每小时最多 ${ttsNum(t.maxPerHour, 3, 0, 60)} 条`;
              }
              if (st.state === 'failed') return `已启用但启动失败：${st.error}（稍后自动重试）`;
              return '已启用，等待首次加载（约 10~25 秒，不阻塞文字）';
            })()
          });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/bili-status') {
          const b = cfg.socialV2?.bili ?? {};
          const sb = b.selfBrowsing ?? {};
          const today = deps.live.biliMem ? deps.live.biliMem.todayUsage() : { seconds: 0, videos: 0 };
          const budget = Math.max(0, Number(sb.dailyBudgetSec) || 0);
          // 控制台要能看到"此刻是不是在刷"以及"刷到哪一步了"。
          // 这些是进程内的瞬时状态，不落盘：重启后自然归零。
          const now = Date.now();
          const browsing = deps.live.biliBrowsing
            ? {
                active: true,
                phase: biliBrowseState.phase || 'starting',
                since: biliBrowseState.startedAt || now,
                video: biliBrowseState.video || null,
                key: biliBrowseState.key || '',
                elapsedSec: Math.round((now - (biliBrowseState.startedAt || now)) / 1000)
              }
            : { active: false };
          sendJson({
            ok: true,
            enabled: b.enabled !== false,
            selfBrowsing: {
              enabled: sb.enabled !== false,
              // 控制台按钮据此显示"已暂停 / 恢复自主刷"
              paused: sb.enabled === false,
              dailyBudgetSec: budget,
              usedSec: today.seconds,
              remainingSec: Math.max(0, budget - today.seconds),
              videosToday: today.videos,
              lastBrowseAt: deps.live.lastBiliBrowseAt || 0,
              // 下次自己刷还有多久：以**本次调度的起点** + 随机间隔计算。
              // 用 lastBiliBrowseAt 会算错——那个是"上次真的看了"的时间，
              // 而调度可能在它之后才设定（比如跳过某一轮后重新排期）。
              nextInSec: deps.live.biliTimer && deps.live.biliScheduledAt
                ? Math.max(0, Math.round((deps.live.biliScheduledAt + (deps.live.biliNextDelay || 0) - now) / 1000))
                : 0,
              // 当前是否在刷（控制台用这个显示"刷视频中…"）
              browsing,
              // 最近一次刷的结果，方便回看"它刚才看了啥"
              lastVideo: deps.live.lastBiliWatch || null,
              // 分区偏好（让控制台能说明"为什么总刷这类"）
              categoryWeights: sb.categoryWeights || null,
              // 主动搜索：开关、上次搜的关键词、凭据状态（**只报状态，不暴露 cookie**）
              search: {
                enabled: sb.search?.enabled !== false,
                lastKeyword: deps.live.lastBiliSearchKeyword || '',
                auth: deps.live.biliAuth.loaded
                  ? { loaded: true, hasLogin: !!deps.live.biliAuth.hasSessdata }
                  : { loaded: false, reason: deps.live.biliAuth.reason }
              },
              // 声音内容（听觉）：字幕优先、ASR 兜底（2026-10-21 用户要求）
              audio: (() => {
                const asr = deps.live.asrEngine ? deps.live.asrEngine.status() : null;
                const cfgAsr = b.asr ?? {};
                return {
                  // 字幕需要登录态；没登录时 B 站返回空数组（且 code 仍是 0），
                  // 所以这里明确告诉控制台"字幕能不能用"
                  subtitleAvailable: !!deps.live.biliAuth.hasSessdata,
                  subtitleReason: deps.live.biliAuth.hasSessdata ? '' : (deps.live.biliAuth.loaded ? '凭据已加载但无登录态' : '未配置 B 站凭据'),
                  asrEnabled: cfgAsr.enabled !== false,
                  asrConfigured: !!asr,
                  asrState: asr?.state ?? 'disabled',
                  asrModel: asr?.model ?? '',
                  asrModelPath: asr?.modelPath ?? '',
                  asrModelKind: asr?.modelKind ?? '',
                  asrThreads: asr?.cpuThreads ?? null,
                  asrLoadSec: asr?.loadSec ?? null,
                  asrError: asr?.error ?? null,
                  asrRetryInSec: asr?.retryInMs ? Math.round(asr.retryInMs / 1000) : 0,
                  // 一句话结论，控制台直接显示
                  summary: asr?.state === 'ready'
                    ? (deps.live.biliAuth.hasSessdata
                      ? '字幕优先，字幕缺失时用本地语音识别补'
                      : '未登录 B 站：全部走本地语音识别')
                    : (asr?.state === 'failed'
                      ? `语音识别不可用（${asr.error || '未知原因'}）：只有画面`
                      : (asr ? '语音识别待加载（首次用时自动加载，约 8 秒）'
                        : '未启用语音识别：只有画面'))
                };
              })()
            },
            share: {
              enabled: b.share?.enabled !== false,
              minInterest: b.share?.minInterest,
              probability: b.share?.probability,
              lastShareAt: deps.live.lastBiliShareAt || 0,
              nextAllowedInSec: deps.live.lastBiliShareAt
                ? Math.max(0, Math.round((deps.live.lastBiliShareAt + (Number(b.share?.minGapMs) || 6 * 3600 * 1000) - now) / 1000))
                : 0,
              // 推荐目的地策略（2026-10-21 用户要求「更多推荐给活跃的群聊」）
              preferActiveGroups: b.share?.preferActiveGroups !== false,
              activeWindowHours: Math.max(1, Number(b.share?.activeWindowHours) || 24),
              minActivityForShare: Math.max(0, Number(b.share?.minActivityForShare) || 0),
              // 各群活跃度：控制台据此显示"推荐会落到哪些群"
              groups: [...socialV2.conversations.entries()]
                .filter(([k]) => k.startsWith('group:'))
                .map(([k, st]) => {
                  const hours = Math.max(1, Number(b.share?.activeWindowHours) || 24);
                  const activity = groupActivityScore(st, { hours, now });
                  return {
                    key: k,
                    activity,
                    // 是否够格作为推荐目的地
                    shareEligible: activity >= Math.max(1, Number(b.share?.minActivityForShare) || 1),
                    lastActionAt: Number(st.lastActionAt) || 0
                  };
                })
                .sort((x, y) => y.activity - x.activity)
            },
            memory: deps.live.biliMem ? deps.live.biliMem.stats() : null,
            taste: deps.live.biliMem ? deps.live.biliMem.taste(5) : null,
            recent: deps.live.biliMem ? deps.live.biliMem.recent(6).map((v) => ({
              bvid: v.bvid, title: v.title, owner: v.owner, category: v.category,
              liked: v.liked, interest: v.interest, tags: v.tags, lastSeenAt: v.lastSeenAt, source: v.source,
              desc: String(v.desc || '').slice(0, 120)
            })) : []
          });
          return;
        }

        if (req.method === 'POST' && url.pathname === '/api/socialV2/memory-append') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const category = String(body.category ?? '').trim();
          const content = String(body.content ?? '').trim();
          const extra = body.extra && typeof body.extra === 'object' ? body.extra : {};
          if (!key || !category || !content) { sendJson({ ok: false, error: 'key/category/content 不能为空' }, 400); return; }
          if (!['activeTopic', 'pendingThought', 'memberImpression'].includes(category)) { sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression' }, 400); return; }
          if (category === 'memberImpression' && !String(extra.target || '').trim()) { sendJson({ ok: false, error: 'memberImpression 需要 extra.target 指定群友名字' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_append' }, 403); return; }
          const st = getSocialV2State(key);
          appendMemoryV2(st, category, content, extra);
          sendJson({ ok: true, key, category, content, memory: formatMemoryV2(st) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/memory-update') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const category = String(body.category ?? '').trim();
          const oldContent = String(body.oldContent ?? '').trim();
          const target = redactKnownTokensOnly(String(body.target ?? '').trim());
          const newContent = body.newContent !== undefined && body.newContent !== null ? redactKnownTokensOnly(String(body.newContent).trim()) : undefined;
          const newExtra = body.newExtra && typeof body.newExtra === 'object' && !Array.isArray(body.newExtra) ? body.newExtra : {};
          const redactExtra = (v) => redactKnownTokensOnly(String(v ?? '')).trim();
          const cleanNewExtra = {
            ...newExtra,
            pendingQuestion: newExtra.pendingQuestion !== undefined ? redactExtra(newExtra.pendingQuestion) : undefined,
            participants: Array.isArray(newExtra.participants) ? newExtra.participants.map((p) => redactExtra(p)) : undefined,
            motivation: newExtra.motivation !== undefined ? redactExtra(newExtra.motivation) : undefined,
            target: newExtra.target !== undefined ? redactExtra(newExtra.target) : undefined
          };
          if (!key || !category) { sendJson({ ok: false, error: 'key/category 不能为空' }, 400); return; }
          if (!['activeTopic', 'pendingThought', 'memberImpression'].includes(category)) { sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression' }, 400); return; }
          if (category === 'memberImpression' && !target) { sendJson({ ok: false, error: 'memberImpression 需要 target 指定原群友名字' }, 400); return; }
          if (category !== 'memberImpression' && !oldContent) { sendJson({ ok: false, error: '该类别需要 oldContent 指定要编辑的记忆内容' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_*' }, 403); return; }
          const st = getSocialV2State(key);
          if (category === 'activeTopic' && Array.isArray(st.activeTopics)) {
            const idx = st.activeTopics.findIndex((t) => String(t?.text ?? '') === oldContent);
            if (idx < 0) { sendJson({ ok: false, error: '找不到要编辑的 activeTopic' }, 404); return; }
            if (newContent !== undefined) st.activeTopics[idx].text = newContent.slice(0, 200);
            if (cleanNewExtra.pendingQuestion !== undefined) st.activeTopics[idx].pendingQuestion = String(cleanNewExtra.pendingQuestion).slice(0, 200);
            if (Array.isArray(cleanNewExtra.participants)) st.activeTopics[idx].participants = cleanNewExtra.participants.map(String).slice(0, 10);
          } else if (category === 'pendingThought' && Array.isArray(st.pendingThoughts)) {
            const idx = st.pendingThoughts.findIndex((t) => String(t?.text ?? '') === oldContent);
            if (idx < 0) { sendJson({ ok: false, error: '找不到要编辑的 pendingThought' }, 404); return; }
            if (newContent !== undefined) st.pendingThoughts[idx].text = newContent.slice(0, 200);
            if (cleanNewExtra.motivation !== undefined) st.pendingThoughts[idx].motivation = String(cleanNewExtra.motivation).slice(0, 50);
            if (cleanNewExtra.expiresAtMs !== undefined) st.pendingThoughts[idx].expiresAt = Date.now() + Math.max(0, Number(cleanNewExtra.expiresAtMs) || 0);
          } else if (category === 'memberImpression' && st.memberImpressions && typeof st.memberImpressions === 'object') {
            const oldTarget = target;
            if (['__proto__', 'constructor', 'prototype'].includes(oldTarget)) { sendJson({ ok: false, error: '非法的群友名字' }, 400); return; }
            const im = st.memberImpressions[oldTarget] || {};
            const newTarget = String(cleanNewExtra.target || oldTarget).trim();
            if (!newTarget || ['__proto__', 'constructor', 'prototype'].includes(newTarget)) { sendJson({ ok: false, error: '非法的群友名字' }, 400); return; }
            if (newContent !== undefined) {
              im.traits = newContent.split(/[,，、]/).map((s) => s.trim()).filter(Boolean).slice(0, 20);
            }
            if (cleanNewExtra.interactionCount !== undefined) im.interactionCount = Math.max(0, Number(cleanNewExtra.interactionCount) || 0);
            if (newTarget !== oldTarget) delete st.memberImpressions[oldTarget];
            st.memberImpressions[newTarget] = im;
          }
          saveSocialV2State();
          sendJson({ ok: true, key, category, memory: formatMemoryV2(st) });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/memory') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const category = String(url.searchParams.get('category') ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_query' }, 403); return; }
          const st = getSocialV2State(key);
          const raw = {
            activeTopics: Array.isArray(st.activeTopics) ? st.activeTopics.slice(-20) : [],
            pendingThoughts: Array.isArray(st.pendingThoughts) ? st.pendingThoughts.filter((t) => !t.expiresAt || Date.now() < t.expiresAt).slice(-20) : [],
            memberImpressions: st.memberImpressions && typeof st.memberImpressions === 'object' ? st.memberImpressions : {}
          };
          if (category === 'activeTopic') {
            raw.pendingThoughts = [];
            raw.memberImpressions = {};
          } else if (category === 'pendingThought') {
            raw.activeTopics = [];
            raw.memberImpressions = {};
          } else if (category === 'memberImpression') {
            raw.activeTopics = [];
            raw.pendingThoughts = [];
          }
          sendJson({ ok: true, key, category, formatted: formatMemoryV2({ ...st, ...raw }), raw });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/memory-remove') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const category = String(body.category ?? '').trim();
          const content = String(body.content ?? '').trim();
          const target = String(body.target ?? '').trim();
          if (!key || !category) { sendJson({ ok: false, error: 'key/category 不能为空' }, 400); return; }
          if (!['activeTopic', 'pendingThought', 'memberImpression'].includes(category)) { sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression' }, 400); return; }
          if (category === 'memberImpression' && !target) { sendJson({ ok: false, error: 'memberImpression 需要 target 指定群友名字' }, 400); return; }
          if (category === 'memberImpression' && ['__proto__', 'constructor', 'prototype'].includes(target)) { sendJson({ ok: false, error: '非法的群友名字' }, 400); return; }
          if (category !== 'memberImpression' && !content) { sendJson({ ok: false, error: '该类别需要 content 指定要删除的记忆内容' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_remove' }, 403); return; }
          const st = getSocialV2State(key);
          if (category === 'activeTopic' && Array.isArray(st.activeTopics)) {
            st.activeTopics = st.activeTopics.filter((t) => String(t?.text ?? '') !== content);
          } else if (category === 'pendingThought' && Array.isArray(st.pendingThoughts)) {
            st.pendingThoughts = st.pendingThoughts.filter((t) => String(t?.text ?? '') !== content);
          } else if (category === 'memberImpression' && st.memberImpressions && typeof st.memberImpressions === 'object') {
            delete st.memberImpressions[target];
          }
          saveSocialV2State();
          sendJson({ ok: true, key, category, memory: formatMemoryV2(st) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/memory-clear') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const category = String(body.category ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (category && !['activeTopic', 'pendingThought', 'memberImpression'].includes(category)) { sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_clear' }, 403); return; }
          const st = getSocialV2State(key);
          if (!category || category === 'activeTopic') st.activeTopics = [];
          if (!category || category === 'pendingThought') st.pendingThoughts = [];
          if (!category || category === 'memberImpression') st.memberImpressions = {};
          saveSocialV2State();
          sendJson({ ok: true, key, category: category || 'all', memory: formatMemoryV2(st) });
          return;
        }
        // ── 上下文持久化（Phase 0/1）：状态 / 立即总结 / 清空 ────────────────
        // Phase 3 P0：按当前话题检索 journal + episode（控制台/模型工具共用）。
        if (req.method === 'GET' && url.pathname === '/api/socialV2/recall') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const query = String(url.searchParams.get('q') ?? url.searchParams.get('query') ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) {
            sendJson({ ok: false, error: 'agent token 无效' }, 403);
            return;
          }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('recallMemory')) {
            sendJson({ ok: false, error: '工具未启用：qq_recall_memory' }, 403);
            return;
          }
          const limit = Math.min(20, Math.max(1, Number(url.searchParams.get('limit')) || 6));
          const fromRaw = url.searchParams.get('from');
          const toRaw = url.searchParams.get('to');
          const toMs = (v) => {
            if (v == null || v === '') return 0;
            const n = Number(v);
            if (Number.isFinite(n) && n > 0) return n < 1e12 ? n * 1000 : n;
            const t = Date.parse(v);
            return Number.isFinite(t) ? t : 0;
          };
          const index = getRecallIndexV2(key);
          const results = searchMemory(index, query, {
            limit,
            from: toMs(fromRaw),
            to: toMs(toRaw),
            minScore: 0.1
          });
          sendJson({
            ok: true,
            key,
            query,
            count: results.length,
            results,
            index: { documents: index.docs.length, builtAt: index.builtAt }
          });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/context-status') {
          const cm = contextCfg();
          void refreshContextNames().catch(() => {});
          // 24 号卡每行显示「今日总输入（含缓存，累计旧会话+摘要器）」。
          // 只读 token 缓存，不在这里现算（GET 不做全量扫描）。
          const usageSnapshot = deps.live.tokenUsage || loadTokenUsage();
          const tokenToday = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
          const tokenByKey = new Map(
            buildSessionUsageRows({
              usage: usageSnapshot || {},
              currentSessions: state.sessions || {},
              displayName: contextDisplayName,
              today: tokenToday
            }).rows.map((row) => [row.key, row])
          );
          const rows = [];
          for (const [key, st] of socialV2.conversations) {
            if (!/^(group|private):\d+$/.test(key)) continue;
            const stats = contextStats(STATE_DIR, key);
            const m = contextMetrics.get(key) || {};
            const lastEpSeq = Number(stats.lastEpisodeSeq) || 0;
            const pendingMessages = countContextPendingV2(
              key, st, lastEpSeq, Number(stats.lastEpisodeEndAt) || 0
            );
            let longTerm = longTermStats(STATE_DIR, key);
            // Phase 2 迁移：老 episode 在 memory.json 还不存在时补种一次。
            if (stats.episodes > 0 && !longTerm.updatedAt) {
              try { backfillLongTermMemory(STATE_DIR, key); longTerm = longTermStats(STATE_DIR, key); } catch {}
            }
            const journal = journalStats(STATE_DIR, key);
            const coverage = journalCoverage(STATE_DIR, key, { hours: 24, indexLimit: 3000 });
            const auditStats = recallAuditStats(STATE_DIR, key, 200);
            const lastAudit = auditStats.last;
            const backlogLevel = Number(pendingMessages) >= Number(cm.backlogCriticalMessages || 800)
              ? 'critical'
              : Number(pendingMessages) >= Number(cm.backlogWarnMessages || 200) ? 'warn' : 'ok';
            const sid = state.sessions[key] || '';
            const isGroup = key.startsWith('group:');
            const groupId = isGroup ? key.slice('group:'.length) : '';
            rows.push({
              key,
              inGroupList: isGroup ? deps.live.contextNameCache.groups.has(groupId) : true,
              displayName: contextDisplayName(key),
              sessionId: sid,
              sessionBytes: sessionFileBytes(sid),
              compactions: stats.compactions,
              lastCompactionAt: stats.lastCompactionAt,
              compactionTokenNotch: stats.lastCompactionNotch,
              episodes: stats.episodes,
              lastEpisodeAt: stats.lastEpisodeAt,
              lastEpisodeSummary: String(stats.lastEpisodeSummary || '').slice(0, 140),
              pendingMessages: Number(pendingMessages) || 0,
              backlogLevel,
              backlogWarnMessages: Number(cm.backlogWarnMessages) || 200,
              backlogCriticalMessages: Number(cm.backlogCriticalMessages) || 800,
              journalBytes: Number(journal.bytes) || 0,
              coverage,
              longTerm,
              memory: {
                topics: Array.isArray(st.activeTopics) ? st.activeTopics.length : 0,
                thoughts: Array.isArray(st.pendingThoughts) ? st.pendingThoughts.length : 0,
                impressions: st.memberImpressions && typeof st.memberImpressions === 'object' ? Object.keys(st.memberImpressions).length : 0
              },
              lastPromptChars: Number(m.lastPromptChars) || 0,
              lastMemoryChars: Number(m.lastMemoryChars) || 0,
              lastSharedChars: Number(m.lastSharedChars) || 0,
              tokenToday: Number(tokenByKey.get(key)?.today?.totalInput) || 0,
              tokenTotal: Number(tokenByKey.get(key)?.cumulative?.totalInput) || 0,
              lastRecallChars: Number(m.lastRecallChars) || Number(lastAudit?.chars) || 0,
              lastRecallSeqs: Array.isArray(m.lastRecallSeqs) ? m.lastRecallSeqs.slice(-10) : [],
              lastRecallMs: Number(m.lastRecallMs) || Number(lastAudit?.ms) || 0,
              lastRecallHits: Number(m.lastRecallHits) || Number(lastAudit?.hits) || 0,
              lastRecallAt: Number(m.lastRecallAt) || Number(lastAudit?.at) || 0,
              lastRecallQuery: String(m.lastRecallQuery || lastAudit?.query || ''),
              recallCalls: auditStats.calls || Number(m.recallCalls) || 0,
              recallHitCalls: auditStats.calls ? auditStats.hits : Number(m.recallHitCalls) || 0,
              recallHitRate: auditStats.calls ? auditStats.hitRate : (Number(m.recallCalls) ? Math.round((Number(m.recallHitCalls) || 0) / Number(m.recallCalls) * 100) : 0),
              recallAvgMs: auditStats.calls ? auditStats.avgMs : (Number(m.recallCalls) ? Math.round((Number(m.recallMsTotal) || 0) / Number(m.recallCalls)) : 0),
              lastEpisodeError: String(m.lastEpisodeError || '')
            });
          }
          rows.sort((a, b) => b.sessionBytes - a.sessionBytes);
          const totals = rows.reduce((acc, r) => ({
            sessionBytes: acc.sessionBytes + r.sessionBytes,
            episodes: acc.episodes + r.episodes,
            compactions: acc.compactions + r.compactions,
            journalBytes: acc.journalBytes + (Number(r.journalBytes) || 0),
            people: acc.people + (Number(r.longTerm?.people) || 0),
            facts: acc.facts + (Number(r.longTerm?.facts) || 0),
            openThreads: acc.openThreads + (Number(r.longTerm?.openThreads) || 0),
            pendingMessages: acc.pendingMessages + (Number(r.pendingMessages) || 0),
            messages24h: acc.messages24h + (Number(r.coverage?.messages24h) || 0),
            indexed24h: acc.indexed24h + (Number(r.coverage?.indexed24h) || 0),
            recallCalls: acc.recallCalls + (Number(r.recallCalls) || 0),
            recallHitCalls: acc.recallHitCalls + (Number(r.recallHitCalls) || 0),
            tokenToday: acc.tokenToday + (Number(r.tokenToday) || 0)
          }), {
            sessionBytes: 0, episodes: 0, compactions: 0, journalBytes: 0,
            people: 0, facts: 0, openThreads: 0, pendingMessages: 0,
            messages24h: 0, indexed24h: 0, recallCalls: 0, recallHitCalls: 0,
            tokenToday: 0
          });
          totals.coveragePct = totals.messages24h
            ? Math.round((totals.indexed24h / totals.messages24h) * 100)
            : 100;
          totals.recallHitRate = totals.recallCalls
            ? Math.round((totals.recallHitCalls / totals.recallCalls) * 100)
            : 0;
          sendJson({
            ok: true,
            enabled: cm.enabled !== false,
            rows,
            totals,
            // P2 跨会话人物记忆只做统计展示；列表走独立端点（避免 30 秒轮询拉 2000 人）。
            sharedMemory: sharedMemoryStats(STATE_DIR, cfg.socialV2?.sharedMemory || {}),
            tokenFuse: deps.ops.tokenFuseStatus?.() || null,
            backlogHistory: readBacklogHistory(STATE_DIR, 48)
          });
          return;
        }
        // ── P2 跨会话人物记忆（控制台 24 卡）──────────────────────────────
        // 只返回结构化人物资料（QQ/昵称审计/偏好），绝不返回消息原文或 episode。
        // 全部 console-only：不在 AGENT_ALLOWED_PATHS 里，Agent 默认拒绝。
        if (req.method === 'GET' && url.pathname === '/api/socialV2/shared-memory') {
          const c = normalizeSharedMemoryConfig(cfg.socialV2?.sharedMemory || {});
          const q = String(url.searchParams.get('q') ?? '').trim().slice(0, 80);
          const limit = Number(url.searchParams.get('limit')) || 100;
          const list = listSharedPeople(STATE_DIR, { q, limit });
          sendJson({
            ok: true,
            config: c,
            stats: sharedMemoryStats(STATE_DIR, c),
            updatedAt: list.updatedAt,
            rows: list.rows
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/shared-memory-config') {
          const body = await readBody();
          try {
            const configFile = path.join(ROOT, 'config.json');
            const file = readJsonSafe(configFile, null, true);
            const current = file.socialV2 ?? {};
            // 只允许已知字段；normalize 会忽略其余键并做布尔/数值归一化。
            const next = normalizeSharedMemoryConfig({ ...(current.sharedMemory || {}), ...body });
            file.socialV2 = { ...current, sharedMemory: next };
            // 写盘失败不更新内存（AGENTS 约定：进程内看似生效、重启即丢最迷惑）。
            atomicWriteJson(configFile, file);
            cfg.socialV2 = { ...(cfg.socialV2 ?? {}), ...file.socialV2 };
            log(`[共享记忆] 配置更新：enabled=${next.enabled} profiles=${next.shareProfiles} private=${next.includePrivate}`);
            sendJson({ ok: true, config: next, stats: sharedMemoryStats(STATE_DIR, next) });
          } catch (error) {
            sendJson({ ok: false, error: `保存失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/shared-memory-forget') {
          const body = await readBody();
          const id = String(body.id ?? '').trim();
          if (!/^\d{5,12}$/.test(id)) { sendJson({ ok: false, error: 'id 应为 QQ 号' }, 400); return; }
          const removed = forgetSharedPerson(STATE_DIR, id);
          if (!removed) { sendJson({ ok: false, error: '没有这个人的共享资料' }, 404); return; }
          log(`控制台：已忘记跨会话人物 ${id}`);
          sendJson({ ok: true, stats: sharedMemoryStats(STATE_DIR, cfg.socialV2?.sharedMemory || {}) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/shared-memory-clear') {
          clearSharedMemory(STATE_DIR);
          log('控制台：已清空跨会话人物记忆');
          sendJson({ ok: true, stats: sharedMemoryStats(STATE_DIR, cfg.socialV2?.sharedMemory || {}) });
          return;
        }
        // ── 会话级 Token 熔断（二期 F3）──────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/socialV2/token-fuse') {
          const status = deps.ops.tokenFuseStatus?.() || { enabled: false, config: normalizeTokenFuseConfig({}), keys: [] };
          // 面板要能给「每个会话」单独设阈值：把当前所有会话都列出来，而不只是今天有消耗的。
          const keySet = new Set((status.keys || []).map((x) => x.key));
          for (const key of socialV2.conversations.keys()) {
            if (/^(group|private):\d+$/.test(key)) keySet.add(key);
          }
          for (const key of Object.keys(state.sessions || {})) {
            if (/^(group|private):\d+$/.test(key)) keySet.add(key);
          }
          for (const key of Object.keys(status.config?.overrides || {})) keySet.add(key);
          const byKey = new Map((status.keys || []).map((x) => [x.key, x]));
          const zero = { totalInput: 0, uncached: 0, calls: 0, state: 'normal', warnedAt: 0, fusedAt: 0, fusedNotifiedAt: 0, resetAt: 0 };
          const keys = [...keySet].map((key) => {
            const b = byKey.get(key) || zero;
            return {
              ...b,
              key,
              displayName: contextDisplayName(key) || key,
              ...effectiveTokenFuseThresholds(status.config || {}, key)
            };
          }).sort((a, b) => (b.totalInput || 0) - (a.totalInput || 0));
          sendJson({ ok: true, ...status, keys });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/token-fuse-config') {
          const body = await readBody();
          try {
            const configFile = path.join(ROOT, 'config.json');
            const file = readJsonSafe(configFile, null, true);
            const current = file.socialV2 ?? {};
            const next = normalizeTokenFuseConfig({ ...(current.tokenFuse || {}), ...body });
            file.socialV2 = { ...current, tokenFuse: next };
            atomicWriteJson(configFile, file);
            cfg.socialV2 = { ...(cfg.socialV2 ?? {}), ...file.socialV2 };
            log(`[Token熔断] 配置更新：enabled=${next.enabled} warn=${next.warnTokens} fuse=${next.fuseTokens}`);
            sendJson({ ok: true, config: next, ...(deps.ops.tokenFuseStatus?.() || {}) });
          } catch (error) {
            sendJson({ ok: false, error: `保存失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/token-fuse-override') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!/^(group|private):\d+$/.test(key)) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          try {
            const configFile = path.join(ROOT, 'config.json');
            const file = readJsonSafe(configFile, null, true);
            const current = file.socialV2 ?? {};
            const cur = current.tokenFuse ?? {};
            const overrides = { ...(cur.overrides || {}) };
            if (body.clear === true) delete overrides[key];
            else overrides[key] = normalizeTokenFuseOverride(body);
            const next = normalizeTokenFuseConfig({ ...cur, overrides });
            file.socialV2 = { ...current, tokenFuse: next };
            atomicWriteJson(configFile, file);
            cfg.socialV2 = { ...(cfg.socialV2 ?? {}), ...file.socialV2 };
            log(`[Token熔断] ${key} 阈值${body.clear === true ? '恢复全局' : '已单独设置'}`);
            sendJson({ ok: true, config: next });
          } catch (error) {
            sendJson({ ok: false, error: `保存失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/token-fuse-reset') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!/^(group|private):\d+$/.test(key)) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const removed = deps.ops.resetTokenFuse?.(key);
          if (!removed) { sendJson({ ok: false, error: '没有该会话的熔断计数' }, 404); return; }
          log(`控制台：已解除 Token 熔断 ${key}`);
          sendJson({ ok: true, ...(deps.ops.tokenFuseStatus?.() || {}) });
          return;
        }
        // 长期记忆详情（控制台 24 号卡「长期」按钮）
        if (req.method === 'GET' && url.pathname === '/api/socialV2/context-memory') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          if (!/^(group|private):\d+$/.test(key)) { sendJson({ ok: false, error: 'key 非法' }, 400); return; }
          const stats = contextStats(STATE_DIR, key);
          let memory = loadLongTermMemory(STATE_DIR, key);
          if (stats.episodes > 0 && !memory.updatedAt) {
            try { memory = backfillLongTermMemory(STATE_DIR, key); } catch {}
          }
          sendJson({
            ok: true,
            key,
            stats,
            longTerm: longTermStats(STATE_DIR, key),
            journal: journalStats(STATE_DIR, key),
            memory,
            episodes: loadEpisodes(STATE_DIR, key, 5),
            recallAudit: readRecallAudit(STATE_DIR, key, 20)
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/context-rebuild-memory') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!/^(group|private):\d+$/.test(key)) { sendJson({ ok: false, error: 'key 非法' }, 400); return; }
          try {
            fs.rmSync(path.join(contextDir(STATE_DIR, key), 'memory.json'), { force: true });
            const memory = backfillLongTermMemory(STATE_DIR, key);
            log(`[上下文] 已从 episode 重建长期记忆 ${key}`);
            sendJson({
              ok: true,
              key,
              memory,
              stats: contextStats(STATE_DIR, key),
              longTerm: longTermStats(STATE_DIR, key)
            });
          } catch (error) {
            sendJson({ ok: false, error: `重建失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/context-summarize') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!/^(group|private):\d+$/.test(key) || !socialV2.conversations.has(key)) {
            sendJson({ ok: false, error: '会话不存在' }, 404);
            return;
          }
          const r = await makeEpisodeNow(key, { force: body.force !== false });
          sendJson({ ok: r.ok === true, ...r });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/context-catchup') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!/^(group|private):\d+$/.test(key) || !socialV2.conversations.has(key)) {
            sendJson({ ok: false, error: '会话不存在' }, 404);
            return;
          }
          const max = Math.min(12, Math.max(1, Number(body.max) || 8));
          let made = 0;
          let last = null;
          for (let i = 0; i < max; i += 1) {
            // 追赶只消化“已经够一个 episode”的积压，不用 force 硬切最近 N 条：
            // force 会把已总结过的消息再压一遍，重复生成情节。
            last = await makeEpisodeNow(key, { force: false });
            if (!last?.ok) break;
            made += 1;
          }
          log(`[上下文] 手动追赶 ${key}：生成 ${made} 条情节`);
          sendJson({ ok: true, key, made, last });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/context-rebuild-index') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (key && !/^(group|private):\d+$/.test(key)) {
            sendJson({ ok: false, error: 'key 非法' }, 400);
            return;
          }
          clearRecallIndex(key || null);
          log(`[上下文] 已重建检索索引 ${key || '（全部）'}`);
          sendJson({ ok: true, key: key || '*' });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/context-clear') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (key !== '*' && !/^(group|private):\d+$/.test(key)) {
            sendJson({ ok: false, error: 'key 非法（用会话 key 或 *）' }, 400);
            return;
          }
          try {
            const clearFiles = (k) => {
              const dir = contextDir(STATE_DIR, k);
              // journals（messages.jsonl）是聊天记录，清空记忆时**保留**；
              // 只删派生的情节/压缩/长期记忆。
              for (const name of ['episodes.jsonl', 'compactions.jsonl', 'memory.json']) {
                try { fs.rmSync(path.join(dir, name), { force: true }); } catch {}
              }
            };
            if (key === '*') {
              for (const k of socialV2.conversations.keys()) clearFiles(k);
            } else {
              clearFiles(key);
            }
            const m = contextMetrics.get(key);
            if (m) {
              delete m.lastEpisodeAt;
              delete m.lastEpisodeSummary;
              delete m.lastEpisodeError;
            }
            log(`[上下文] 已清空 ${key === '*' ? '全部会话' : key} 的情节/压缩/长期记忆（保留消息日志）`);
            sendJson({ ok: true, key });
          } catch (error) {
            sendJson({ ok: false, error: `清空失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // 删除一个已离群/失效会话的全部本地状态（控制台 24 号卡「已不在当前群列表」用）。
        // 只允许删当前群列表里没有的群，避免误删正在用的会话。
        if (req.method === 'POST' && url.pathname === '/api/socialV2/context-delete') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!/^group:\d+$/.test(key)) { sendJson({ ok: false, error: '只允许删除群会话（group:群号）' }, 400); return; }
          const gid = key.slice('group:'.length);
          if (deps.live.contextNameCache.groups.has(gid)) {
            sendJson({ ok: false, error: '该群仍在机器人当前群列表，拒绝删除' }, 400);
            return;
          }
          try {
            const sid = state.sessions[key];
            if (sid) {
              deps.ops.bumpSessionEpoch();
              deps.ops.recordSessionHistory?.(sid, key, 'delete');
              delete state.sessions[key];
              if (state.sessionMeta) delete state.sessionMeta[key];
              reverse.delete(sid);
              deps.ops.clearSessionTracking(sid);
              collectors.delete(sid);
              sendToolSucceededSessions.delete(sid);
              pendingSendToolCalls.delete(sid);
              v2TurnStartAt.delete(sid);
              toolCallNames.delete(sid);
              social.silentTurns.delete(sid);
              social.exitingSessions.delete(sid);
            }
            cancelSocialTimers(key);
            clearSocialV2Timers(key);
            drainPromptQueue(key, '会话已删除');
            pending.delete(key);
            queued.delete(key);
            queuedHintAt.delete(key);
            sessionPromises.delete(key);
            social.recentMessages.delete(key);
            messageMediaStore.delete(key);
            social.pendingSummaries.delete(key);
            social.states.delete(key);
            social.silentContext.delete(key);
            slangWindows.delete(key);
            slangExtractionCooldowns.delete(key);
            slangSubmitTimes.delete(key);
            pendingWakeKeys.delete(key);
            wakeConfigUpdatedKeys.delete(key);
            markReadCalledKeys.delete(key);
            wakeConfigMissCount.delete(key);
            lastSentImage.delete(key);
            seenForwardIds.delete(key);
            contextMetrics.delete(key);
            const st = socialV2.conversations.get(key);
            if (st?.agentToken) KNOWN_AGENT_TOKENS.delete(st.agentToken);
            socialV2.conversations.delete(key);
            writeConversationRole(key, null);
            try { fs.rmSync(contextDir(STATE_DIR, key), { recursive: true, force: true }); } catch {}
            saveSocialV2State();
            saveState();
            log(`[上下文] 已删除失效会话 ${key}（session=${sid || '无'}）`);
            sendJson({ ok: true, key, removedSession: !!sid });
          } catch (error) {
            sendJson({ ok: false, error: `删除会话失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // ── 二代黑话学习（reserved2）：AI 查询/提交黑话候选 ─────────────────
        if (req.method === 'GET' && url.pathname === '/api/socialV2/slang/query') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const q = String(url.searchParams.get('q') ?? '').trim().toLowerCase();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('slangQuery')) { sendJson({ ok: false, error: '工具未启用：qq_slang_query' }, 403); return; }
          const list = confirmedSlangListV2().filter((e) => {
            if (!q) return true;
            return e.content.toLowerCase().includes(q)
              || e.meaning.toLowerCase().includes(q)
              || e.usage.toLowerCase().includes(q)
              || e.example.toLowerCase().includes(q);
          });
          sendJson({
            ok: true,
            key,
            total: list.length,
            entries: list,
            block: buildSlangContext(deps.live.slangEntries, cfg.slang?.injectMax ?? 8)
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/slang/submit') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const token = String(body.token ?? '').trim();
          const content = redactKnownTokensOnly(String(body.content ?? '')).trim();
          const context = redactKnownTokensOnly(String(body.context ?? '')).trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('slangSubmit')) { sendJson({ ok: false, error: '工具未启用：qq_slang_submit' }, 403); return; }
          if (cfg.slang?.enabled === false) { sendJson({ ok: false, error: '黑话学习已关闭（slang.enabled=false）' }, 403); return; }
          if (!content) { sendJson({ ok: false, error: 'content 不能为空' }, 400); return; }
          if (content.length > 50) { sendJson({ ok: false, error: '黑话词条过长（最多 50 字）' }, 400); return; }
          if (!allowSlangSubmit(key)) { sendJson({ ok: false, error: '黑话提交过于频繁，请稍后再试' }, 429); return; }
          const existing = deps.live.slangEntries.find((e) => e.content === content);
          if (existing) {
            if (existing.status === SLANG_STATUS.CONFIRMED) {
              sendJson({ ok: true, duplicate: true, status: 'confirmed', entry: publicSlangEntry(existing) });
              return;
            }
            if (existing.status === SLANG_STATUS.REJECTED) {
              sendJson({ ok: false, error: '该词已被管理员拒绝，如需重新收录请联系管理员' }, 403);
              return;
            }
            // candidate：累计出现次数并追加语境证据
            existing.count = (Number(existing.count) || 0) + 1;
            if (context) {
              existing.evidence = mergeEvidence(existing.evidence, [{ key, sender: 'AI提交', text: context.slice(0, 200), time: Date.now() }]);
            }
            existing.updatedAt = new Date().toISOString();
            saveSlangStore();
            if (cfg.slang?.autoResearch !== false) {
              const thresholds = Array.isArray(cfg.slang?.inferenceThresholds) ? cfg.slang.inferenceThresholds.map(Number).filter(Boolean) : [2, 4, 8];
              if (thresholds.includes(existing.count) && existing.count > (Number(existing.lastInferenceCount) || 0)) {
                queueSlangTask(() => runSlangResearch([existing]));
              }
            }
            log(`[reserved2] AI 再次提交黑话候选「${content}」(${key})，累计 ${existing.count} 次`);
            sendJson({ ok: true, duplicate: true, status: 'candidate', entry: publicSlangEntry(existing) });
            return;
          }
          const entry = createSlangEntry({
            content,
            source: 'ai',
            status: SLANG_STATUS.CANDIDATE,
            evidence: context ? [{ key, sender: 'AI提交', text: context.slice(0, 200), time: Date.now() }] : []
          });
          deps.live.slangEntries.push(entry);
          saveSlangStore();
          if (cfg.slang?.autoResearch !== false) {
            queueSlangTask(() => runSlangResearch([entry]));
          }
          log(`[reserved2] AI 提交黑话候选「${content}」(${key})`);
          appendActivity(`${key} [reserved2] AI 提交黑话候选：${content}${context ? '（附语境）' : ''}`);
          sendJson({ ok: true, entry: publicSlangEntry(entry) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/authorize/read') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const token = String(body.token ?? '').trim();
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          if (deps.live.currentMode === 'reserved2' && !agentTokenOk(key, token)) {
            sendJson({ ok: false, error: 'reserved2 模式下旧只读工具不可用，请使用带会话令牌的 v2 读工具' }, 403);
            return;
          }
          if (token && !agentTokenOk(key, token)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, deps.live.currentMode)) {
            sendJson({ ok: false, error: '当前模式不允许读取该会话' }, 403);
            return;
          }
          sendJson({ ok: true, key });
          return;
        }
        // ── 图片/表情查询端点（MCP qq_get_message_images 走这里） ────────────
        if (req.method === 'GET' && url.pathname === '/api/images/message') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const messageId = String(url.searchParams.get('messageId') ?? '').trim();
          const agentToken = String(req.headers['x-agent-token'] ?? '').trim();
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          if (!messageId) { sendJson({ ok: false, error: 'messageId 不能为空' }, 400); return; }
          if (deps.live.currentMode === 'reserved2' && !agentToken) {
            sendJson({ ok: false, error: 'reserved2 模式读取图片必须携带 agent token' }, 403);
            return;
          }
          if (deps.live.currentMode === 'chat' || deps.live.currentMode === 'reserved') {
            sendJson({ ok: false, error: '一代 chat/reserved 模式图片已自动内联，按需图片工具仅 reserved2 模式可用' }, 403);
            return;
          }
          if (agentToken && !agentTokenOk(key, agentToken)) {
            sendJson({ ok: false, error: 'agent token 无效' }, 403);
            return;
          }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, deps.live.currentMode)) {
            sendJson({ ok: false, error: '当前模式不允许读取该会话' }, 403);
            return;
          }
          if (agentToken && !v2ToolEnabled('getImages')) {
            sendJson({ ok: false, error: '工具未启用：qq_get_message_images' }, 403);
            return;
          }
          if (!agentToken && deps.live.currentMode === 'closed-agent' && !v2ToolEnabled('getImages')) {
            sendJson({ ok: false, error: '工具未启用：qq_get_message_images' }, 403);
            return;
          }
          // 本地缓存优先，未命中则回源取那条消息（群友引用别人的图时本地没有）
          const media = await findMessageMediaAsync(key, messageId);
          if (!media.length) {
            sendJson({ ok: true, messageId, media: [], images: [], note: '该消息没有可读取的图片/表情元数据' });
            return;
          }
          try {
            // raw=1：跳过缩放/抽帧，返回原图（供 qq_upscale_image 做超分）
            const images = await fetchMediaData(media, { raw: url.searchParams.get('raw') === '1' });
            sendJson({ ok: true, messageId, media, images });
          } catch (error) {
            log(`图片查询失败 ${key} ${messageId}: ${error?.message ?? error}`);
            sendJson({ ok: false, error: `图片查询失败：${error?.message ?? error}` }, 500);
          }
          return;
        }

        // ── 超分结果回传（把放大后的图发给群友）─────────────────────────────
        //
        // 需求（2026-10-19）：「超分完没有把超分后的结果发回」——超分图原先只作为
        // image part 交给模型，群友看不到。这个端点把结果真正发到会话里。
        //
        // 安全边界与其它发送端点一致：模式校验 → agent token → 目标在允许范围内 →
        // 发送配额 → 静默模式。图片走 base64 段（不落临时文件，也不接受任意 URL／路径）。
        if (req.method === 'POST' && url.pathname === '/api/socialV2/send-upscaled') {
          // 这里要收一张 base64 图片，申请放宽的请求体上限（白名单路由，见 readBody）。
          const body = await readBody({ route: url.pathname, maxBytes: 8_000_000 });
          const headerToken = String(req.headers['x-agent-token'] ?? '').trim();
          const bodyToken = String(body.token ?? '').trim();
          if (headerToken && bodyToken && headerToken !== bodyToken) { sendJson({ ok: false, error: 'Header 与 Body 的 agent token 不一致' }, 403); return; }
          const token = headerToken || bodyToken;
          const key = String(body.key ?? '').trim();
          const dataB64 = String(body.data ?? '').replace(/\s/g, '');
          const caption = String(body.caption ?? '').trim().slice(0, 200);
          if ((token || deps.live.currentMode === 'reserved2') && socialV2.paused) {
            sendJson({ ok: false, error: 'AI 已暂停，当前不允许执行发送工具' }, 403);
            return;
          }
          if ((token || deps.live.currentMode === 'reserved2') && cfg.socialV2?.enabled === false) {
            sendJson({ ok: false, error: '二代模式已关闭，当前不允许执行发送工具' }, 403);
            return;
          }
          if (deps.live.currentMode === 'chat' || deps.live.currentMode === 'reserved') {
            sendJson({ ok: false, error: '发送工具仅限 closed-agent / reserved2 模式使用' }, 403);
            return;
          }
          if (deps.live.currentMode === 'reserved2' && !token) { sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return; }
          if (!key || !/^(group|private):(\d+)$/.test(key)) { sendJson({ ok: false, error: 'key 格式无效' }, 400); return; }
          if (token && !agentTokenOk(key, token)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (token && !v2ToolEnabled('sendImage')) { sendJson({ ok: false, error: '工具未启用：qq_send_image' }, 403); return; }
          if (shouldBlockSilentReply(key)) { sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403); return; }
          const [, kind, idStr] = /^(group|private):(\d+)$/.exec(key);
          if (!modeAllowed(key, kind, Number(idStr), cfg, deps.live.currentMode)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          if (!dataB64) { sendJson({ ok: false, error: 'data 不能为空' }, 400); return; }
          // 只接受 base64：拒绝任何 URL／本地路径 —— 那会绕过 SSRF/本地文件防护。
          if (!/^[A-Za-z0-9+/]+={0,2}$/.test(dataB64.slice(0, 64))) { sendJson({ ok: false, error: 'data 必须是 base64 编码的图片' }, 400); return; }
          const buf = Buffer.from(dataB64, 'base64');
          if (!buf.length) { sendJson({ ok: false, error: 'data 解码后为空' }, 400); return; }
          if (buf.length > MAX_MEDIA_BYTES) { sendJson({ ok: false, error: `图片过大（${(buf.length / 1024 / 1024).toFixed(1)}MB），上限 ${(MAX_MEDIA_BYTES / 1024 / 1024) | 0}MB` }, 400); return; }
          // 必须是图片：超分端点只发图，不能变成任意文件发送通道。
          const sniffed = sniffImageMime(buf);
          if (!sniffed) { sendJson({ ok: false, error: 'data 不是可识别的图片格式' }, 400); return; }
          try {
            const st = getSocialV2State(key);
            const gate = imageSendAllowed(key);
            if (!gate.ok) { sendJson({ ok: false, error: gate.error }, 429); return; }
            const sent = await onebotSendImageFile(key, buf, { label: '［超分］' });
            const now = Date.now();
            const times = (imageSendTimes.get(key) ?? []).filter((t) => now - t < 3600000);
            times.push(now);
            imageSendTimes.set(key, times);
            st.lastActionAt = now;
            saveSocialV2State();
            // 说明文字可选：先说图再补一句（分两条发，避免图配长文被截断）
            if (caption) {
              await sendToQQ(key, caption).catch((e) => log(`超分回传附言发送失败 ${key}: ${e?.message ?? e}`));
            }
            log(`[超分] 已回传图片到 ${key}（${(buf.length / 1024).toFixed(0)}KB）`);
            sendJson({ ok: true, key, messageId: sent?.message_id ?? null, bytes: buf.length, mimeType: sniffed });
          } catch (error) {
            log(`超分回传失败 ${key}: ${error?.message ?? error}`);
            sendJson({ ok: false, error: `发送失败：${error?.message ?? error}` }, 500);
          }
          return;
        }

        // ── 统一发送端点（MCP 旧发送工具也走这里） ───────────────────────────
        if (req.method === 'POST' && (url.pathname === '/api/send/group' || url.pathname === '/api/send/private' || url.pathname === '/api/send/reply')) {
          const body = await readBody();
          const headerToken = String(req.headers['x-agent-token'] ?? '').trim();
          const bodyToken = String(body.token ?? '').trim();
          if (headerToken && bodyToken && headerToken !== bodyToken) { sendJson({ ok: false, error: 'Header 与 Body 的 agent token 不一致' }, 403); return; }
          const token = headerToken || bodyToken;
          const isPrivate = url.pathname === '/api/send/private';
          const isReply = url.pathname === '/api/send/reply';
          const targetId = isPrivate ? String(body.userId ?? '').trim() : String(body.groupId ?? '').trim();
          const message = stripLeadingMetaMarker(unquoteJsonString(String(body.message ?? '').trim()));
          const replyToMessageId = isReply ? body.replyToMessageId : body.replyToMessageId;
          const atUserId = body.atUserId ?? null;
          const key = isPrivate ? `private:${targetId}` : `group:${targetId}`;
          // 安全边界：发送工具只允许在 closed-agent（管理员私聊）或 reserved2（二代 AI 带会话令牌）下使用；
          // chat/reserved 的自动转发已覆盖正常回复，MCP 发送工具不应成为 prompt injection 的越权出口。
          if (deps.live.currentMode === 'chat' || deps.live.currentMode === 'reserved') {
            sendJson({ ok: false, error: '发送工具仅限 closed-agent / reserved2 模式使用' }, 403);
            return;
          }
          if ((token || deps.live.currentMode === 'reserved2') && socialV2.paused) {
            sendJson({ ok: false, error: 'AI 已暂停，当前不允许执行发送工具' }, 403);
            return;
          }
          if ((token || deps.live.currentMode === 'reserved2') && cfg.socialV2?.enabled === false) {
            sendJson({ ok: false, error: '二代模式已关闭，当前不允许执行发送工具' }, 403);
            return;
          }
          if (!targetId || !message) { sendJson({ ok: false, error: '目标 id 和 message 不能为空' }, 400); return; }
          if (isPrivate && atUserId) { sendJson({ ok: false, error: '私聊不需要 @' }, 400); return; }
          if (isReply && (replyToMessageId === undefined || replyToMessageId === null || String(replyToMessageId).trim() === '')) {
            sendJson({ ok: false, error: 'replyToMessageId 不能为空' }, 400);
            return;
          }
          if (deps.live.currentMode === 'reserved2' && !token) { sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return; }
          if (token && !agentTokenOk(key, token)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          const flag = isPrivate ? 'sendPrivate' : (isReply ? 'reply' : 'sendGroup');
          if (token && !v2ToolEnabled(flag)) { sendJson({ ok: false, error: `工具未启用：${flag}` }, 403); return; }
          if (shouldBlockSilentReply(key)) {
            sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403);
            return;
          }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式无效' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, deps.live.currentMode)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '' && !isSymbolicReplyRef(replyToMessageId) && !/^-?[1-9]\d*$/.test(String(replyToMessageId).trim())) {
            sendJson({ ok: false, error: 'replyToMessageId 必须是非零整数（消息 id 可能为负数），或传 latest/上一条 表示引用最近一条别人的消息' }, 400);
            return;
          }
          let quotedInfo = null;
          let actualReplyToMessageId = replyToMessageId;
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
            const stForReply = getSocialV2State(key);
            const resolved = await resolveReplyTargetV2(stForReply, kind, id, String(replyToMessageId).trim());
            if (!resolved) {
              sendJson({ ok: false, error: '无法解析被引用消息，请确认 message id 正确且属于当前会话（可用 qq_get_message_detail 查看）' }, 400);
              return;
            }
            quotedInfo = resolved.info;
            actualReplyToMessageId = resolved.messageId;
          }
          const sendCfg = cfg.socialV2?.send ?? {};
          const maxChars = Math.max(1, Number(sendCfg.maxMessageChars) || 500);
          if (message.length > maxChars) { sendJson({ ok: false, error: `单条消息不能超过 ${maxChars} 字` }, 400); return; }
          if (SENSITIVE_RE.test(message)) { sendJson({ ok: false, error: '消息含敏感信息，已阻止发送' }, 403); return; }
          try {
            const st = getSocialV2State(key);
            const now = Date.now();
            const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
            const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
            const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
            const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
            if ((maxPerMinute > 0 && recentMinute + 1 > maxPerMinute) || (maxPerHour > 0 && recentHour + 1 > maxPerHour)) {
              sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
              return;
            }
            st.sendTimes.push(now);
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            const sentMessages = await sendMessagesV2(key, [message], [], actualReplyToMessageId, atUserId, { quoted: quotedInfo });
            recordSentMessagesV2(key, sentMessages);
            st.lastAiReplyAt = now;
            st.lastActionAt = now;
            st.wakeConfig.noActionCount = 0;
            // 已回复的那条立即从未读移除：与它对应的请求已经处理完了，
            // 留着只会让本轮/下一轮又把同一条当待办重答一次（实测重复回答 3~4 次）。
            // 只在**真的发出去了**之后才移除，发送失败则保留（下次还能补）。
            if (sentMessages.length > 0 && quotedInfo?.messageId != null) {
              const before = st.unread.length;
              st.unread = st.unread.filter((m) => String(m?.messageId ?? '') !== String(quotedInfo.messageId));
              if (st.unread.length !== before) {
                log(`[send] ${key} 已回复 seq 对应消息，从待回复列表移除 1 条（余 ${st.unread.length}）`);
              }
            }
            if (sentMessages.length > 0 && quotedInfo?.messageId != null) {
              const targetEntry = st.recentMessages.find((m) => m && String(m.messageId) === String(quotedInfo.messageId));
              const targetSeq = Number(quotedInfo.seq) || Number(targetEntry?.seq) || 0;
              if (targetSeq) {
                const set = new Set((Array.isArray(st.answeredSeqs) ? st.answeredSeqs : []).map(Number).filter(Number.isFinite));
                set.add(targetSeq);
                st.answeredSeqs = [...set].slice(-200);
              }
            }
            saveSocialV2State();
            log(`[send] ${url.pathname} ${key}: 成功 ${sentMessages.length}/1 条`);
            appendActivity(`${key} [send] 成功 ${sentMessages.length}/1 条：${message.slice(0, 80)}`);
            if (sentMessages.length > 0) scheduleReplyCheckV2(key);
            sendJson({ ok: true, key, sent: sentMessages.length, failed: sentMessages.length ? 0 : 1, quoted: quotedInfo });
          } catch (error) {
            if (error?.sent?.length) {
              recordSentMessagesV2(key, error.sent);
              log(`[send] ${url.pathname} ${key} 部分成功 ${error.sent.length}/1 条，已记录已发消息`);
            }
            // 失败/未发出的消息回滚预占的发送额度，避免假 429。
            const sentCount = Array.isArray(error?.sent) ? error.sent.length : 0;
            const failedCount = Math.max(0, 1 - sentCount);
            for (let i = 0; i < failedCount; i++) {
              const idx = st.sendTimes.indexOf(now);
              if (idx >= 0) st.sendTimes.splice(idx, 1);
            }
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            saveSocialV2State();
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }
        // ── 清除上下文 / 清空工作区 ──────────────────────────────────────────
        if (req.method === 'POST' && url.pathname === '/api/session/reset') {
          const body = await readBody();
          const key = String(body.key ?? '');
          if (!key || !state.sessions[key]) { sendJson({ ok: false, error: '会话不存在' }, 404); return; }
          deps.ops.bumpSessionEpoch();
          const oldSessionId = state.sessions[key];
          deps.ops.recordSessionHistory?.(oldSessionId, key, 'reset');
          delete state.sessions[key];
          if (state.sessionMeta) delete state.sessionMeta[key];
          reverse.delete(oldSessionId);
          deps.ops.clearSessionTracking(oldSessionId);
          collectors.delete(oldSessionId);
          sendToolSucceededSessions.delete(oldSessionId);
          pendingSendToolCalls.delete(oldSessionId);
          v2TurnStartAt.delete(oldSessionId);
          toolCallNames.delete(oldSessionId);
          const pe = pending.get(key);
          if (pe) {
            clearTimeout(pe.timer);
            cancelPendingEntry(pe).catch(() => {});
          }
          pending.delete(key);
          queued.delete(key);
          queuedHintAt.delete(key);
          sessionPromises.delete(key);
          drainPromptQueue(key, '会话已重置');
          social.recentMessages.delete(key);
          messageMediaStore.delete(key);
          social.pendingSummaries.delete(key);
          social.states.delete(key);
          social.silentContext.delete(key);
          social.silentTurns.delete(oldSessionId);
          social.exitingSessions.delete(oldSessionId);
          slangWindows.delete(key);
          slangExtractionCooldowns.delete(key);
          slangSubmitTimes.delete(key);
          cancelSocialTimers(key);
          clearSocialV2Timers(key);
          pendingWakeKeys.delete(key);
          wakeConfigUpdatedKeys.delete(key);
          markReadCalledKeys.delete(key);
          wakeConfigMissCount.delete(key);
          const removedV2 = socialV2.conversations.get(key);
          if (removedV2?.agentToken) KNOWN_AGENT_TOKENS.delete(removedV2.agentToken);
          socialV2.conversations.delete(key);
          seenForwardIds.delete(key);
          saveSocialV2State();
          saveState();
          try { await api.workspace.archiveSession({ sessionId: oldSessionId }); } catch {}
          log(`控制台：已清除会话上下文 ${key}（旧会话 ${oldSessionId} 已归档）`);
          sendJson({ ok: true, key, archived: oldSessionId });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/workspace/reset') {
          deps.ops.bumpSessionEpoch();
          let archivedCount = 0;
          try {
            const ws = unwrap(await api.workspace.list({}), 'workspace.list');
            const qq = ws.items.find((w) => w.title === cfg.workspaceTitle);
            if (qq) {
              for (const sid of qq.sessionIds) {
                try { await api.workspace.archiveSession({ sessionId: sid }); archivedCount += 1; } catch {}
              }
              try { await api.workspace.delete({ workspaceId: qq.workspaceId }); } catch {}
            }
          } catch {}
          for (const entry of pending.values()) {
            clearTimeout(entry.timer);
            cancelPendingEntry(entry).catch(() => {});
          }
          pending.clear();
          queued.clear();
          queuedHintAt.clear();
          sessionPromises.clear();
          drainAllPromptQueues('工作区已清空');
          social.states.clear();
          social.recentMessages.clear();
          messageMediaStore.clear();
          seenForwardIds.clear();
          social.pendingSummaries.clear();
          social.silentContext.clear();
          social.silentTurns.clear();
          social.exitingSessions.clear();
          slangWindows.clear();
          slangExtractionCooldowns.clear();
          slangSubmitTimes.clear();
          cancelAllSocialTimers();
          clearAllSocialV2Timers();
          for (const st of socialV2.conversations.values()) {
            if (st?.agentToken) KNOWN_AGENT_TOKENS.delete(st.agentToken);
          }
          socialV2.conversations.clear();
          saveSocialV2State();
          for (const [key, sid] of Object.entries(state.sessions || {})) {
            deps.ops.recordSessionHistory?.(sid, key, 'workspace');
          }
          state.sessions = {};
          state.sessionMeta = {};
          reverse.clear();
          deps.ops.clearAllSessionTracking();
          collectors.clear();
          sendToolSucceededSessions.clear();
          pendingSendToolCalls.clear();
          v2TurnStartAt.clear();
          toolCallNames.clear();
          saveState();
          try { fs.writeFileSync(ACTIVITY_LOG, ''); } catch {}
          log(`控制台：已清空 QQ 聊天工作区（归档 ${archivedCount} 个会话，映射与活动日志已清空）`);
          sendJson({ ok: true, archivedCount });
          return;
        }
        // ── 重启桥接（守护模式下 5 秒后自动拉起） ──────────────────────────────
        if (req.method === 'POST' && url.pathname === '/api/restart') {
          // 重启 = **自己拉一个新进程**，不能只 process.exit 等外部守护窗口。
          //
          // 2026-10-21 用户反馈「控制台的重启桥接按钮并没有重启的效果」。
          // 实测日志：19:52:12 打出"控制台：重启桥接"后 exit(0)，到 19:53:06 才
          // 出现新进程——中间空了 54 秒，而前端只轮询 30 秒就显示"桥接尚未恢复"。
          // 根因不是按钮没发命令，而是**没有任何守护在跑**：`start.bat` 的死循环
          // 只存在于手动双击启动的那个窗口里；用 nohup / 计划任务 / 别的方式拉起时，
          // exit(0) 就是彻底停服。把"能不能起来"交给运气是不对的。
          //
          // 做法：detached 子进程 + stdio 忽略 + unref，父进程退出后子进程继续跑。
          // 子进程等 800ms 再启动（给父进程释放 :3100 和锁文件的时间），
          // 并通过 QQB_RESTARTED_BY 标记来源，便于日志区分"手动启动"与"自重启"。
          // 子进程启动时会 acquireLock()：若父进程还没退干净，它会 exit(2) 自行放弃，
          // 不会出现两个实例同时抢端口。
          const logFile = path.join(STATE_DIR, 'bridge.log');
          sendJson({ ok: true, message: '正在重启桥接（已安排自重启，约 3~5 秒恢复）…' });
          setTimeout(async () => {
            log('控制台：重启桥接（将以 detached 子进程自重启）');
            let spawned = false;
            try {
              const { spawn } = await import('node:child_process');
              const out = fs.openSync(logFile, 'a');
              const child = spawn(process.execPath, [path.join(ROOT, 'src', 'bridge.js')], {
                cwd: ROOT,
                detached: true,
                stdio: ['ignore', out, out],
                windowsHide: true,
                env: { ...process.env, QQB_RESTARTED_BY: 'console' }
              });
              child.unref();
              spawned = true;
            } catch (error) {
              log(`重启失败：无法拉起新进程（${error?.message ?? error}）；若由守护脚本启动，会由它恢复`);
            }
            releaseLock();
            process.exit(spawned ? 0 : 1);
          }, 500);
          return;
        }
        sendJson({ ok: false, error: 'not found' }, 404);
      } catch (error) {
        const status = Number(error?.statusCode) || 500;
        sendJson({ ok: false, error: error?.message ?? String(error) }, status);
      }
    });
    server.listen(port, '127.0.0.1', () => {
      log(`本地控制台已启动：http://127.0.0.1:${port}`);
    });
    // 端口被占用说明已有实例在跑：以 exit 2 退出，守护脚本会识别为"已有实例"而不是无限重启
    server.on('error', (error) => {
      log(`控制台服务错误: ${error?.message ?? error}`);
      if (error?.code === 'EADDRINUSE') {
        console.error(`[bridge] 控制台端口 ${port} 已被占用（可能已有实例在运行），退出。`);
        process.exit(2);
      }
      process.exit(1);
    });
    return server;
  }
