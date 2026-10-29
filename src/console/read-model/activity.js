// R4.7-2：活动流 / 二代状态 / 提示词读模型。
//
// 这三个端点原来从 40+ 项平铺依赖里拼响应（活动流还要自己算 pending/answered/unread、
// prompt 还要按 detail 组织角色/记忆/黑话/表情）。这里把读口径收在一处：
// 只读，不改状态；暂停/重置等写动作在 `src/console/commands/activity.js`。
//
// 动态值（live.* / socialV2.conversations / state.sessions）每次调用现读，
// 不能创建时快照——控制台轮询的是运行中的状态，不是启动那一刻。

// T3：qq_get_prompt 的 compact 载荷（默认）。不重复唤醒提示里已有的状态信息，
// 只给角色摘要、可用工具、未读数与唤醒配置；完整内容走 detail=full。
export function buildPromptCompact({ key, roleName = null, digest = '', enabledTools = [], st = {}, wakeSafety = null, now = () => new Date().toISOString() } = {}) {
  return {
    ok: true,
    key,
    time: now(),
    detail: 'compact',
    role: { name: roleName, hint: String(digest || '') },
    enabledTools: Array.isArray(enabledTools) ? enabledTools : [],
    unreadCount: Array.isArray(st?.unread) ? st.unread.length : 0,
    currentWakeConfig: st?.wakeConfig ?? null,
    wakeSafety,
    note: '默认 compact：完整角色卡、推荐值、记忆/黑话/表情上下文请传 detail=full；唤醒提示里已有的状态信息不重复返回。'
  };
}

export function createActivityReadModel({
  live = {},
  socialV2 = { conversations: new Map() },
  cfg = {},
  state = {},
  contextDisplayName,
  findCallersV2,
  isConversationBusyV2,
  getSocialV2State,
  computeWakeSafetyV2,
  roleFor,
  currentRoleHint,
  currentRoleHintV2,
  confirmedSlangListV2,
  buildSlangContext,
  formatMemoryV2,
  formatParticipationV2,
  stickerEnabled,
  stickerCacheOpts,
  buildStickerContext,
  buildStickerStrategyHint,
  syncStickerLibrary
} = {}) {
  /** GET /api/socialV2/activity：只回报暂停态（前端每次轮询都要看到）。 */
  function statusView() {
    return { ok: true, paused: socialV2.paused };
  }

  /**
   * GET /api/socialV2/activity-feed：按“消息”聚合状态，而不是只追加一行文本。
   * 前端每秒拉一次，状态由当前 unread / pending / answeredSeqs 实时推导：
   * 未读 → 处理中/待回复 → 已回复/已读；自己发出的消息显示已发送/语音已发。
   */
  function feedView(limitParam) {
    const limit = Math.min(200, Math.max(20, Number(limitParam) || 120));
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
    return { ok: true, rows: rows.slice(0, limit), counts, generatedAt: Date.now() };
  }

  /** GET /api/socialV2/state：只给会话级的四个摘要字段，不返回消息正文。 */
  function stateView(key) {
    const st = getSocialV2State(key);
    return {
      ok: true,
      key,
      wakeConfig: st.wakeConfig,
      wakeSafety: computeWakeSafetyV2(st.wakeConfig),
      unreadCount: st.unread.length,
      recentCount: st.recentMessages.length,
      lastWakeReason: st.lastWakeReason,
      lastAiReplyAt: st.lastAiReplyAt
    };
  }

  /**
   * GET /api/socialV2/prompt：compact（默认）只给角色摘要 + 工具 + 唤醒配置；
   * detail=full 才返回完整角色卡与记忆/黑话/表情上下文。
   */
  async function promptView(key, detailParam) {
    const st = getSocialV2State(key);
    const detail = detailParam === 'full' ? 'full' : 'compact';
    // 让 prompt 里的表情摘要尽量新鲜：按 TTL 同步一次 QQ 收藏表情（失败不阻塞）。仅 full 需要。
    if (detail === 'full' && cfg.socialV2?.sticker?.enabled !== false) {
      try { await syncStickerLibrary?.(false); } catch { /* 同步失败不影响提示词返回 */ }
    }
    const roleName = roleFor?.(key);
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
      if (tools[flag] !== false && !(stickerToolFlags.has(flag) && !stickerEnabled?.())) enabledTools.push(name);
    }
    if (detail === 'compact') {
      const digest = typeof currentRoleHintV2 === 'function' ? currentRoleHintV2(key, { digest: true }) : '';
      return buildPromptCompact({
        key,
        roleName,
        digest,
        enabledTools,
        st,
        wakeSafety: computeWakeSafetyV2(st.wakeConfig)
      });
    }
    return {
      ok: true,
      key,
      time: new Date().toISOString(),
      detail,
      role: { name: roleName ?? null, hint: live.currentMode === 'reserved2' ? currentRoleHintV2?.(key) : currentRoleHint?.(key) },
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
      memory: formatMemoryV2?.(st),
      participation: formatParticipationV2?.(st),
      slang: {
        enabled: cfg.slang?.enabled !== false,
        entries: confirmedSlangListV2?.(),
        block: buildSlangContext?.(live.slangEntries, cfg.slang?.injectMax ?? 8)
      },
      stickers: {
        enabled: cfg.socialV2?.sticker?.enabled !== false,
        total: live.stickerEntries?.length ?? 0,
        context: cfg.socialV2?.sticker?.includeInPrompt !== false ? buildStickerContext?.(live.stickerEntries, cfg.socialV2?.sticker?.promptMaxStickers ?? 8, stickerCacheOpts?.()) : '',
        strategy: cfg.socialV2?.sticker?.includeInPrompt !== false ? buildStickerStrategyHint?.() : ''
      }
    };
  }

  return { statusView, feedView, stateView, promptView };
}
