// 控制台路由域：共享记忆 / Token 熔断 / 上下文 / 黑话查询（R4）。
//
// 从 console-server.js 原样搬出，只调整了缩进；鉴权 / CSRF / agent 白名单 /
// 暂停隔离仍由 console-server 统一处理，走到这里时请求已通过全部前置校验。
export const id = '16-context';
export const title = '共享记忆 / Token 熔断 / 上下文 / 黑话查询';

/** 本模块负责的路由；console-server 据此分派，不必解析 handler 内部。 */
export const routes = [
  ['GET', '/api/socialV2/shared-memory', 'exact'],
  ['POST', '/api/socialV2/shared-memory-config', 'exact'],
  ['POST', '/api/socialV2/shared-memory-forget', 'exact'],
  ['POST', '/api/socialV2/shared-memory-clear', 'exact'],
  ['GET', '/api/socialV2/token-fuse', 'exact'],
  ['POST', '/api/socialV2/token-fuse-config', 'exact'],
  ['POST', '/api/socialV2/token-fuse-override', 'exact'],
  ['POST', '/api/socialV2/token-fuse-reset', 'exact'],
  ['GET', '/api/socialV2/context-memory', 'exact'],
  ['POST', '/api/socialV2/context-rebuild-memory', 'exact'],
  ['POST', '/api/socialV2/context-summarize', 'exact'],
  ['POST', '/api/socialV2/context-catchup', 'exact'],
  ['POST', '/api/socialV2/context-rebuild-index', 'exact'],
  ['POST', '/api/socialV2/context-clear', 'exact'],
  ['POST', '/api/socialV2/context-delete', 'exact'],
  ['GET', '/api/socialV2/slang/query', 'exact'],
  ['POST', '/api/socialV2/slang/submit', 'exact']
];

export async function handle(req, res, url, ctx) {
  const { sendJson, readBody, deps } = ctx;
  const { agentTokenOk, v2SessionAllowed, v2ToolEnabled } = ctx;
  const {
    KNOWN_AGENT_TOKENS,
    ROOT,
    SLANG_STATUS,
    STATE_DIR,
    allowSlangSubmit,
    appendActivity,
    atomicWriteJson,
    backfillLongTermMemory,
    buildSlangContext,
    cancelSocialTimers,
    cfg,
    clearSocialV2Timers,
    collectors,
    confirmedSlangListV2,
    contextDir,
    contextDisplayName,
    contextMetrics,
    contextStats,
    readRecallAudit,
    clearRecallIndex,
    createSlangEntry,
    drainPromptQueue,
    fs,
    journalStats,
    lastSentImage,
    loadEpisodes,
    loadLongTermMemory,
    log,
    longTermStats,
    makeEpisodeNow,
    markReadCalledKeys,
    mergeEvidence,
    messageMediaStore,
    path,
    pending,
    pendingSendToolCalls,
    pendingWakeKeys,
    publicSlangEntry,
    queueSlangTask,
    queued,
    queuedHintAt,
    readJsonSafe,
    redactKnownTokensOnly,
    reverse,
    runSlangResearch,
    saveSlangStore,
    saveSocialV2State,
    saveState,
    seenForwardIds,
    sendToolSucceededSessions,
    sessionPromises,
    slangExtractionCooldowns,
    slangSubmitTimes,
    slangWindows,
    social,
    socialV2,
    state,
    toolCallNames,
    v2TurnStartAt,
    wakeConfigMissCount,
    wakeConfigUpdatedKeys,
    writeConversationRole
  } = deps;
  const {
    clearSharedMemory,
    effectiveTokenFuseThresholds,
    forgetSharedPerson,
    listSharedPeople,
    normalizeSharedMemoryConfig,
    normalizeTokenFuseConfig,
    normalizeTokenFuseOverride,
    sharedMemoryStats
  } = ctx.helpers;

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
}
