// R4.7-3：共享记忆 / Token 熔断 / 上下文 / 黑话写命令。
//
// 这些端点原来在路由里直接摸 60+ 个依赖：配置写盘、内存同步、运行态 Map/Set 清理、
// episode 生成、黑话候选入库。收进命令层后，路由只做 key/参数校验与 agent 鉴权；
// 「写盘失败不改内存」「删除保留消息日志」这些约束集中在这里维护。

export function createContextCommands({
  config = {},
  helpers = {},
  sessions = {},
  social = {},
  context = {},
  slang = {},
  operations = {}
} = {}) {
  const {
    cfg = {},
    ROOT,
    STATE_DIR,
    fs,
    path,
    readJsonSafe,
    atomicWriteJson,
    log,
    SLANG_STATUS,
    KNOWN_AGENT_TOKENS
  } = config;
  const {
    normalizeSharedMemoryConfig,
    sharedMemoryStats,
    forgetSharedPerson,
    clearSharedMemory,
    normalizeTokenFuseConfig,
    normalizeTokenFuseOverride
  } = helpers;
  const {
    state = {},
    socialV2 = { conversations: new Map() },
    social: socialRuntime = {},
    reverse,
    collectors,
    v2TurnStartAt,
    toolCallNames,
    pendingSendToolCalls,
    sendToolSucceededSessions,
    pendingWakeKeys,
    wakeConfigUpdatedKeys,
    markReadCalledKeys,
    wakeConfigMissCount,
    sessionPromises,
    pending,
    queued,
    queuedHintAt,
    messageMediaStore,
    slangWindows,
    slangExtractionCooldowns,
    slangSubmitTimes,
    lastSentImage,
    seenForwardIds,
    contextMetrics,
    saveState,
    writeConversationRole
  } = sessions;
  const { cancelSocialTimers, clearSocialV2Timers, drainPromptQueue, saveSocialV2State } = social;
  const { contextDir, contextStats, longTermStats, backfillLongTermMemory, makeEpisodeNow, clearRecallIndex } = context;
  const {
    allowSlangSubmit,
    redactKnownTokensOnly,
    publicSlangEntry,
    mergeEvidence,
    saveSlangStore,
    queueSlangTask,
    runSlangResearch,
    createSlangEntry
  } = slang;
  const { live = {}, ops = {}, appendActivity } = operations;
  const logLine = (message) => { try { log?.(message); } catch { /* 日志失败不影响主流程 */ } };

  function configFile() {
    return path.join(ROOT, 'config.json');
  }

  /** 读-改-写 config.json；写盘失败直接抛，内存不会被提前改。 */
  function updateSocialV2Section(section, next) {
    const file = readJsonSafe(configFile(), null, true);
    const current = file.socialV2 ?? {};
    file.socialV2 = { ...current, [section]: next };
    atomicWriteJson(configFile(), file);
    cfg.socialV2 = { ...(cfg.socialV2 ?? {}), ...file.socialV2 };
  }

  // ── 共享记忆 ────────────────────────────────────────────────────────
  function updateSharedMemoryConfig(body = {}) {
    try {
      const file = readJsonSafe(configFile(), null, true);
      const current = file.socialV2 ?? {};
      // 只允许已知字段；normalize 会忽略其余键并做布尔/数值归一化。
      const next = normalizeSharedMemoryConfig({ ...(current.sharedMemory || {}), ...body });
      updateSocialV2Section('sharedMemory', next);
      logLine(`[共享记忆] 配置更新：enabled=${next.enabled} profiles=${next.shareProfiles} private=${next.includePrivate}`);
      return { ok: true, config: next, stats: sharedMemoryStats?.(STATE_DIR, next) || {} };
    } catch (error) {
      return { ok: false, status: 500, error: `保存失败：${error?.message ?? error}` };
    }
  }

  function forgetPerson(id) {
    const removed = forgetSharedPerson?.(STATE_DIR, id);
    if (!removed) return { ok: false, status: 404, error: '没有这个人的共享资料' };
    logLine(`控制台：已忘记跨会话人物 ${id}`);
    return { ok: true, stats: sharedMemoryStats?.(STATE_DIR, cfg.socialV2?.sharedMemory || {}) || {} };
  }

  function clearPeople() {
    clearSharedMemory?.(STATE_DIR);
    logLine('控制台：已清空跨会话人物记忆');
    return { ok: true, stats: sharedMemoryStats?.(STATE_DIR, cfg.socialV2?.sharedMemory || {}) || {} };
  }

  // ── Token 熔断 ──────────────────────────────────────────────────────
  function saveTokenFuseConfig(body = {}) {
    try {
      const file = readJsonSafe(configFile(), null, true);
      const current = file.socialV2 ?? {};
      const next = normalizeTokenFuseConfig({ ...(current.tokenFuse || {}), ...body });
      updateSocialV2Section('tokenFuse', next);
      logLine(`[Token熔断] 配置更新：enabled=${next.enabled} warn=${next.warnTokens} fuse=${next.fuseTokens}`);
      return { ok: true, config: next, ...(ops.tokenFuseStatus?.() || {}) };
    } catch (error) {
      return { ok: false, status: 500, error: `保存失败：${error?.message ?? error}` };
    }
  }

  function saveTokenFuseOverride(body = {}) {
    const key = String(body.key ?? '').trim();
    if (!/^(group|private):\d+$/.test(key)) {
      return { ok: false, status: 400, error: 'key 格式应为 group:群号 或 private:QQ号' };
    }
    try {
      const file = readJsonSafe(configFile(), null, true);
      const current = file.socialV2 ?? {};
      const cur = current.tokenFuse ?? {};
      const overrides = { ...(cur.overrides || {}) };
      if (body.clear === true) delete overrides[key];
      else overrides[key] = normalizeTokenFuseOverride(body);
      const next = normalizeTokenFuseConfig({ ...cur, overrides });
      updateSocialV2Section('tokenFuse', next);
      logLine(`[Token熔断] ${key} 阈值${body.clear === true ? '恢复全局' : '已单独设置'}`);
      return { ok: true, config: next };
    } catch (error) {
      return { ok: false, status: 500, error: `保存失败：${error?.message ?? error}` };
    }
  }

  function resetTokenFuseCount(key) {
    const removed = ops.resetTokenFuse?.(key);
    if (!removed) return { ok: false, status: 404, error: '没有该会话的熔断计数' };
    logLine(`控制台：已解除 Token 熔断 ${key}`);
    return { ok: true, ...(ops.tokenFuseStatus?.() || {}) };
  }

  // ── 上下文 ──────────────────────────────────────────────────────────
  function rebuildMemory(key) {
    try {
      fs.rmSync(path.join(contextDir(STATE_DIR, key), 'memory.json'), { force: true });
      const memory = backfillLongTermMemory(STATE_DIR, key);
      logLine(`[上下文] 已从 episode 重建长期记忆 ${key}`);
      return {
        ok: true,
        key,
        memory,
        stats: contextStats(STATE_DIR, key),
        longTerm: longTermStats(STATE_DIR, key)
      };
    } catch (error) {
      return { ok: false, status: 500, error: `重建失败：${error?.message ?? error}` };
    }
  }

  async function summarize(key, body = {}) {
    if (!socialV2.conversations.has(key)) return { ok: false, status: 404, error: '会话不存在' };
    const r = await makeEpisodeNow(key, { force: body.force !== false });
    return { ok: r.ok === true, ...r };
  }

  async function catchup(key, body = {}) {
    if (!socialV2.conversations.has(key)) return { ok: false, status: 404, error: '会话不存在' };
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
    logLine(`[上下文] 手动追赶 ${key}：生成 ${made} 条情节`);
    return { ok: true, key, made, last };
  }

  function rebuildIndex(key) {
    clearRecallIndex(key || null);
    logLine(`[上下文] 已重建检索索引 ${key || '（全部）'}`);
    return { ok: true, key: key || '*' };
  }

  function clearContext(key) {
    try {
      const clearFiles = (k) => {
        const dir = contextDir(STATE_DIR, k);
        // journals（messages.jsonl）是聊天记录，清空记忆时**保留**；
        // 只删派生的情节/压缩/长期记忆。
        for (const name of ['episodes.jsonl', 'compactions.jsonl', 'memory.json']) {
          try { fs.rmSync(path.join(dir, name), { force: true }); } catch { /* 文件不存在可忽略 */ }
        }
      };
      if (key === '*') {
        for (const k of socialV2.conversations.keys()) clearFiles(k);
      } else {
        clearFiles(key);
      }
      const m = contextMetrics?.get(key);
      if (m) {
        delete m.lastEpisodeAt;
        delete m.lastEpisodeSummary;
        delete m.lastEpisodeError;
      }
      logLine(`[上下文] 已清空 ${key === '*' ? '全部会话' : key} 的情节/压缩/长期记忆（保留消息日志）`);
      return { ok: true, key };
    } catch (error) {
      return { ok: false, status: 500, error: `清空失败：${error?.message ?? error}` };
    }
  }

  /**
   * 删除一个已离群/失效会话的全部本地状态（控制台 24 号卡「已不在当前群列表」用）。
   * 只允许删当前群列表里没有的群，避免误删正在用的会话。
   */
  function deleteSession(key) {
    const gid = key.slice('group:'.length);
    if (live.contextNameCache?.groups?.has(gid)) {
      return { ok: false, status: 400, error: '该群仍在机器人当前群列表，拒绝删除' };
    }
    try {
      const sid = state.sessions?.[key];
      if (sid) {
        ops.bumpSessionEpoch?.();
        ops.recordSessionHistory?.(sid, key, 'delete');
        delete state.sessions[key];
        if (state.sessionMeta) delete state.sessionMeta[key];
        reverse?.delete(sid);
        ops.clearSessionTracking?.(sid);
        collectors?.delete(sid);
        sendToolSucceededSessions?.delete(sid);
        pendingSendToolCalls?.delete(sid);
        v2TurnStartAt?.delete(sid);
        toolCallNames?.delete(sid);
        socialRuntime.silentTurns?.delete(sid);
        socialRuntime.exitingSessions?.delete(sid);
      }
      cancelSocialTimers?.(key);
      clearSocialV2Timers?.(key);
      drainPromptQueue?.(key, '会话已删除');
      pending?.delete(key);
      queued?.delete(key);
      queuedHintAt?.delete(key);
      sessionPromises?.delete(key);
      socialRuntime.recentMessages?.delete(key);
      messageMediaStore?.delete(key);
      socialRuntime.pendingSummaries?.delete(key);
      socialRuntime.states?.delete(key);
      socialRuntime.silentContext?.delete(key);
      slangWindows?.delete(key);
      slangExtractionCooldowns?.delete(key);
      slangSubmitTimes?.delete(key);
      pendingWakeKeys?.delete(key);
      wakeConfigUpdatedKeys?.delete(key);
      markReadCalledKeys?.delete(key);
      wakeConfigMissCount?.delete(key);
      lastSentImage?.delete(key);
      seenForwardIds?.delete(key);
      contextMetrics?.delete(key);
      const st = socialV2.conversations.get(key);
      if (st?.agentToken) KNOWN_AGENT_TOKENS?.delete(st.agentToken);
      socialV2.conversations.delete(key);
      writeConversationRole?.(key, null);
      try { fs.rmSync(contextDir(STATE_DIR, key), { recursive: true, force: true }); } catch { /* 目录可能已不存在 */ }
      saveSocialV2State?.();
      saveState?.();
      logLine(`[上下文] 已删除失效会话 ${key}（session=${sid || '无'}）`);
      return { ok: true, key, removedSession: !!sid };
    } catch (error) {
      return { ok: false, status: 500, error: `删除会话失败：${error?.message ?? error}` };
    }
  }

  // ── 二代黑话学习（reserved2）：AI 提交候选 ───────────────────────────
  async function submitSlang({ key, content, context: contextText } = {}) {
    const cleanContent = redactKnownTokensOnly?.(String(content ?? ''))?.trim?.() ?? String(content ?? '').trim();
    const cleanContext = redactKnownTokensOnly?.(String(contextText ?? ''))?.trim?.() ?? String(contextText ?? '').trim();
    if (cfg.slang?.enabled === false) return { ok: false, status: 403, error: '黑话学习已关闭（slang.enabled=false）' };
    if (!cleanContent) return { ok: false, status: 400, error: 'content 不能为空' };
    if (cleanContent.length > 50) return { ok: false, status: 400, error: '黑话词条过长（最多 50 字）' };
    if (typeof allowSlangSubmit === 'function' && !allowSlangSubmit(key)) {
      return { ok: false, status: 429, error: '黑话提交过于频繁，请稍后再试' };
    }
    const entries = live.slangEntries || [];
    const existing = entries.find((e) => e.content === cleanContent);
    if (existing) {
      if (existing.status === SLANG_STATUS.CONFIRMED) {
        return { ok: true, duplicate: true, status: 'confirmed', entry: publicSlangEntry?.(existing) };
      }
      if (existing.status === SLANG_STATUS.REJECTED) {
        return { ok: false, status: 403, error: '该词已被管理员拒绝，如需重新收录请联系管理员' };
      }
      // candidate：累计出现次数并追加语境证据
      existing.count = (Number(existing.count) || 0) + 1;
      if (cleanContext) {
        existing.evidence = mergeEvidence?.(existing.evidence, [{
          key, sender: 'AI提交', text: cleanContext.slice(0, 200), time: Date.now()
        }]) || existing.evidence;
      }
      existing.updatedAt = new Date().toISOString();
      saveSlangStore?.();
      if (cfg.slang?.autoResearch !== false) {
        const thresholds = Array.isArray(cfg.slang?.inferenceThresholds) ? cfg.slang.inferenceThresholds.map(Number).filter(Boolean) : [2, 4, 8];
        if (thresholds.includes(existing.count) && existing.count > (Number(existing.lastInferenceCount) || 0)) {
          queueSlangTask?.(() => runSlangResearch?.([existing]));
        }
      }
      logLine(`[reserved2] AI 再次提交黑话候选「${cleanContent}」(${key})，累计 ${existing.count} 次`);
      return { ok: true, duplicate: true, status: 'candidate', entry: publicSlangEntry?.(existing) };
    }
    const entry = createSlangEntry?.({
      content: cleanContent,
      source: 'ai',
      status: SLANG_STATUS.CANDIDATE,
      evidence: cleanContext ? [{ key, sender: 'AI提交', text: cleanContext.slice(0, 200), time: Date.now() }] : []
    });
    entries.push(entry);
    saveSlangStore?.();
    if (cfg.slang?.autoResearch !== false) {
      queueSlangTask?.(() => runSlangResearch?.([entry]));
    }
    logLine(`[reserved2] AI 提交黑话候选「${cleanContent}」(${key})`);
    appendActivity?.(`${key} [reserved2] AI 提交黑话候选：${cleanContent}${cleanContext ? '（附语境）' : ''}`);
    return { ok: true, entry: publicSlangEntry?.(entry) };
  }

  return {
    updateSharedMemoryConfig,
    forgetPerson,
    clearPeople,
    saveTokenFuseConfig,
    saveTokenFuseOverride,
    resetTokenFuseCount,
    rebuildMemory,
    summarize,
    catchup,
    rebuildIndex,
    clearContext,
    deleteSession,
    submitSlang
  };
}
