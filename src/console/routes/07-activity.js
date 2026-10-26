// 控制台路由域：活动流 / 二代状态 / 提示词（R4）。
//
// 从 console-server.js 原样搬出，只调整了缩进；鉴权 / CSRF / agent 白名单 /
// 暂停隔离仍由 console-server 统一处理，走到这里时请求已通过全部前置校验。
export const id = '07-activity';
export const title = '活动流 / 二代状态 / 提示词';

/** 本模块负责的路由；console-server 据此分派，不必解析 handler 内部。 */
export const routes = [
  ['GET', '/api/socialV2/activity', 'exact'],
  ['GET', '/api/socialV2/activity-feed', 'exact'],
  ['POST', '/api/socialV2/activity', 'exact'],
  ['POST', '/api/socialV2/reset', 'exact'],
  ['GET', '/api/socialV2/state', 'exact'],
  ['GET', '/api/socialV2/prompt', 'exact']
];

export async function handle(req, res, url, ctx) {
  const { sendJson, readBody, deps } = ctx;
  const { agentTokenOk, v2SessionAllowed, v2ToolEnabled } = ctx;
  const {
    KNOWN_AGENT_TOKENS,
    SOCIAL_V2_FILE,
    atomicWriteJson,
    buildSlangContext,
    buildStickerContext,
    buildStickerStrategyHint,
    cfg,
    clearAllPendingWakeLeases,
    clearAllSocialV2Timers,
    collectors,
    computeWakeSafetyV2,
    confirmedSlangListV2,
    contextDisplayName,
    currentRoleHint,
    currentRoleHintV2,
    drainAllPromptQueues,
    findCallersV2,
    formatMemoryV2,
    formatParticipationV2,
    getSocialV2State,
    isConversationBusyV2,
    log,
    markReadCalledKeys,
    pendingSendToolCalls,
    pendingWakeKeys,
    reverse,
    roleFor,
    saveSocialV2State,
    scheduleProactiveCheckV2,
    seenForwardIds,
    sendToolSucceededSessions,
    sessionPromises,
    setupSleepTimerV2,
    socialV2,
    state,
    stickerCacheOpts,
    stickerEnabled,
    syncStickerLibrary,
    toolCallNames,
    v2TurnStartAt,
    wakeConfigMissCount,
    wakeConfigUpdatedKeys
  } = deps;

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
}
