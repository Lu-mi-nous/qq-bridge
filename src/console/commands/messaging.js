// R4.7-3：二代发送命令（连发 / 统一消息 / 拍一拍）。
//
// 三个端点原先各有一份 100+ 行的校验、额度预占、引用解析、时间线与失败回滚。
// 收进命令层后，路由只传 body 与 Header token；agentTokenOk/v2ToolEnabled 按请求传入。
// 关键约束保留：st/now 上提到 try 外、失败回滚预占额度、引用失败先回滚、已回复未读移除。

export function createMessagingCommands({
  config = {},
  operations = {},
  sessions = {},
  social = {},
  messaging = {}
} = {}) {
  const { cfg = {}, SENSITIVE_RE, log } = config;
  const { live = {}, ops = {}, appendActivity } = operations;
  const { socialV2 = { conversations: new Map() }, getSocialV2State, saveSocialV2State } = sessions;
  const {
    normalizeMessagesInput,
    stripLeadingMetaMarkers,
    sendMessagesV2,
    recordSentMessagesV2,
    findCjkSpaceWarning,
    findSplitBoundaryWarning,
    resolveReplyTargetV2,
    isSymbolicReplyRef,
    resolvePokeTarget,
    isSymbolicPokeRef,
    resolveGroupMemberName,
    bot
  } = messaging;
  const { computeGapsV2, scheduleReplyCheckV2, shouldBlockSilentReply, modeAllowed } = social;
  const logLine = (message, error) => { try { log?.(message, error); } catch { /* 日志失败不影响主流程 */ } };

  function pushSendTimes(st, now, count) {
    for (let i = 0; i < count; i++) st.sendTimes.push(now);
    if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
  }

  function rollbackSendTimes(st, now, count) {
    for (let i = 0; i < count; i++) {
      const idx = st.sendTimes.indexOf(now);
      if (idx >= 0) st.sendTimes.splice(idx, 1);
    }
    if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
  }

  /** POST /api/socialV2/send-burst */
  async function sendBurst({ body = {}, headerToken = '', agentTokenOk, toolEnabled } = {}) {
    const key = String(body.key ?? '').trim();
    const messages = stripLeadingMetaMarkers(normalizeMessagesInput(body.messages))
      .map((m) => String(m ?? '').trim())
      .filter(Boolean);
    const replyToMessageId = body.replyToMessageId;
    if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
      return { ok: false, status: 400, error: 'qq_send_burst 暂不支持引用，请使用 qq_reply' };
    }
    if (!key || !messages.length) return { ok: false, status: 400, error: 'key 和 messages 不能为空' };
    const sendCfgBurst = cfg.socialV2?.send ?? {};
    if (sendCfgBurst.burstEnabled === false && messages.length > 1) {
      return { ok: false, status: 403, error: '已禁用多条发送，请合并为一条消息' };
    }
    if (headerToken && !agentTokenOk?.(key, headerToken)) return { ok: false, status: 403, error: 'agent token 无效' };
    if (headerToken && !toolEnabled?.('sendBurst')) return { ok: false, status: 403, error: '工具未启用：qq_send_burst' };
    if (live.currentMode !== 'reserved2') return { ok: false, status: 403, error: '该接口仅 reserved2 模式可用' };
    if (!headerToken) return { ok: false, status: 403, error: 'reserved2 模式发送必须携带 agent token' };
    if (ops.isTokenFused?.(key)) {
      return { ok: false, status: 403, error: '会话已触发 Token 熔断，自动发送已停止；请先在控制台解除熔断' };
    }
    const keyMatch = /^(group|private):(\d+)$/.exec(key);
    if (!keyMatch) return { ok: false, status: 400, error: 'key 格式应为 group:群号 或 private:QQ号' };
    const kind = keyMatch[1];
    const id = Number(keyMatch[2]);
    if (!Number.isFinite(id) || id <= 0 || typeof modeAllowed !== 'function' || !modeAllowed(key, kind, id, cfg, live.currentMode)) {
      return { ok: false, status: 403, error: '目标不在当前模式允许范围内' };
    }
    if (typeof shouldBlockSilentReply === 'function' && shouldBlockSilentReply(key)) {
      return { ok: false, status: 403, error: '静默模式已开启，当前不允许发送' };
    }
    const sendCfg = cfg.socialV2?.send ?? {};
    const maxMsgs = Math.max(1, Number(sendCfg.burstMaxMessages) || 8);
    const maxChars = Math.max(1, Number(sendCfg.maxMessageChars) || 500);
    if (messages.length > maxMsgs) return { ok: false, status: 400, error: `最多发送 ${maxMsgs} 条` };
    for (const msg of messages) {
      if (msg.length > maxChars) return { ok: false, status: 400, error: `单条消息不能超过 ${maxChars} 字` };
      if (SENSITIVE_RE?.test(msg)) return { ok: false, status: 403, error: '消息含敏感信息，已阻止发送' };
    }
    const st = getSocialV2State(key);
    const now = Date.now();
    try {
      const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
      const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
      const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
      const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
      if ((maxPerMinute > 0 && recentMinute + messages.length > maxPerMinute) || (maxPerHour > 0 && recentHour + messages.length > maxPerHour)) {
        return { ok: false, status: 429, error: '发送频率超限，请稍后再试' };
      }
      pushSendTimes(st, now, messages.length);
      const delays = computeGapsV2(messages, 'auto', undefined, undefined, sendCfg);
      const sentMessages = await sendMessagesV2(key, messages, delays);
      recordSentMessagesV2?.(key, sentMessages);
      st.lastAiReplyAt = now;
      st.lastActionAt = now;
      st.wakeConfig.noActionCount = 0;
      saveSocialV2State?.();
      logLine(`[reserved2] 工具分条发送 ${key}: 成功 ${sentMessages.length}/${messages.length} 条`);
      appendActivity?.(`${key} [reserved2] 工具分条发送：成功 ${sentMessages.length}/${messages.length} 条`);
      if (sentMessages.length > 0) scheduleReplyCheckV2?.(key);
      const burstHint = messages.length >= 3 ? '你已经连发了多条，确认是必要的吗？真人很少一口气补完。' : undefined;
      const spaceWarn = findCjkSpaceWarning?.(messages);
      const splitWarn = findSplitBoundaryWarning?.(messages);
      return {
        ok: true,
        key,
        sent: sentMessages.length,
        failed: messages.length - sentMessages.length,
        ...(burstHint ? { hint: burstHint } : {}),
        ...(spaceWarn ? { warn: spaceWarn } : {}),
        ...(splitWarn ? { splitWarn } : {})
      };
    } catch (error) {
      if (error?.sent?.length) {
        recordSentMessagesV2?.(key, error.sent);
        logLine(`[reserved2] 工具分条发送部分成功 ${error.sent.length}/${messages.length} 条，已记录已发消息`);
      }
      const sentCount = Array.isArray(error?.sent) ? error.sent.length : 0;
      rollbackSendTimes(st, now, Math.max(0, messages.length - sentCount));
      saveSocialV2State?.();
      return { ok: false, status: 500, error: error?.message ?? String(error) };
    }
  }

  /** POST /api/socialV2/send-message */
  async function sendMessage({ body = {}, headerToken = '', agentTokenOk, toolEnabled } = {}) {
    const key = String(body.key ?? '').trim();
    const rawMessages = normalizeMessagesInput(body.messages);
    const isRawString = typeof body.messages === 'string' && rawMessages.length === 1;
    // 剥掉模型误写在开头的元标记（如 `[[这是玩笑]]正文`）。
    const messages = stripLeadingMetaMarkers(rawMessages).map((m) => String(m ?? '').trim()).filter(Boolean);
    const replyToMessageId = body.replyToMessageId;
    const atUserId = body.atUserId ?? null;
    // 二代不再按空格自动分条：字符串就是一条消息；数组模式原样使用调用方间隔。
    const gapMode = (isRawString && messages.length > 1) ? 'auto' : (body.gapMode === 'fixed' || body.gapMode === 'byLength' ? body.gapMode : 'auto');
    const gapMs = Number(body.gapMs);
    const gaps = Array.isArray(body.gaps) ? body.gaps.map(Number) : [];
    if (!key || !messages.length) return { ok: false, status: 400, error: 'key 和 messages 不能为空' };
    const sendCfgBurst = cfg.socialV2?.send ?? {};
    if (sendCfgBurst.burstEnabled === false && messages.length > 1) {
      return { ok: false, status: 403, error: '已禁用多条发送，请合并为一条消息' };
    }
    if (headerToken && !agentTokenOk?.(key, headerToken)) return { ok: false, status: 403, error: 'agent token 无效' };
    if (headerToken && !toolEnabled?.('sendMessage')) return { ok: false, status: 403, error: '工具未启用：qq_send_message' };
    if (live.currentMode !== 'reserved2') return { ok: false, status: 403, error: '该接口仅 reserved2 模式可用' };
    if (!headerToken) return { ok: false, status: 403, error: 'reserved2 模式发送必须携带 agent token' };
    if (ops.isTokenFused?.(key)) {
      return { ok: false, status: 403, error: '会话已触发 Token 熔断，自动发送已停止；请先在控制台解除熔断' };
    }
    const keyMatch = /^(group|private):(\d+)$/.exec(key);
    if (!keyMatch) return { ok: false, status: 400, error: 'key 格式应为 group:群号 或 private:QQ号' };
    const kind = keyMatch[1];
    const id = Number(keyMatch[2]);
    if (!Number.isFinite(id) || id <= 0 || typeof modeAllowed !== 'function' || !modeAllowed(key, kind, id, cfg, live.currentMode)) {
      return { ok: false, status: 403, error: '目标不在当前模式允许范围内' };
    }
    if (kind === 'private' && atUserId) return { ok: false, status: 400, error: '私聊不需要 @' };
    if (typeof shouldBlockSilentReply === 'function' && shouldBlockSilentReply(key)) {
      return { ok: false, status: 403, error: '静默模式已开启，当前不允许发送' };
    }
    if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== ''
      && !isSymbolicReplyRef?.(replyToMessageId) && !/^-?[1-9]\d*$/.test(String(replyToMessageId).trim())) {
      return { ok: false, status: 400, error: 'replyToMessageId 必须是非零整数（消息 id 可能为负数），或传 latest/上一条 表示引用最近一条别人的消息' };
    }
    const sendCfg = cfg.socialV2?.send ?? {};
    const maxMsgs = Math.max(1, Number(sendCfg.burstMaxMessages) || 8);
    const maxChars = Math.max(1, Number(sendCfg.maxMessageChars) || 500);
    if (messages.length > maxMsgs) return { ok: false, status: 400, error: `最多发送 ${maxMsgs} 条` };
    for (const msg of messages) {
      if (msg.length > maxChars) return { ok: false, status: 400, error: `单条消息不能超过 ${maxChars} 字` };
      if (SENSITIVE_RE?.test(msg)) return { ok: false, status: 403, error: '消息含敏感信息，已阻止发送' };
    }
    const delays = computeGapsV2(messages, gapMode, gapMs, gaps, sendCfg);
    // 干跑：只验证引用解析结果，不真发、不占用发送额度。
    if (body.dryRun === true) {
      const stDry = getSocialV2State(key);
      const resolvedDry = (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '')
        ? await resolveReplyTargetV2?.(stDry, kind, id, String(replyToMessageId).trim())
        : null;
      return {
        ok: !!resolvedDry || replyToMessageId == null || String(replyToMessageId).trim() === '',
        key,
        dryRun: true,
        wouldSend: messages,
        replyToMessageId: resolvedDry ? resolvedDry.messageId : null,
        quoted: resolvedDry ? resolvedDry.info : null
      };
    }
    // 先做频率检查并预占额度，再解析引用目标，避免未限流的引用查询打爆 OneBot。
    const st = getSocialV2State(key);
    const now = Date.now();
    const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
    const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
    const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
    const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
    if ((maxPerMinute > 0 && recentMinute + messages.length > maxPerMinute) || (maxPerHour > 0 && recentHour + messages.length > maxPerHour)) {
      return { ok: false, status: 429, error: '发送频率超限，请稍后再试' };
    }
    pushSendTimes(st, now, messages.length);
    let quotedInfo = null;
    let actualReplyToMessageId = replyToMessageId;
    if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
      const resolved = await resolveReplyTargetV2?.(st, kind, id, String(replyToMessageId).trim());
      if (!resolved) {
        rollbackSendTimes(st, now, messages.length);
        saveSocialV2State?.();
        return { ok: false, status: 400, error: '无法解析被引用消息，请确认 message id 正确且属于当前会话（可用 qq_get_message_detail 查看）' };
      }
      quotedInfo = resolved.info;
      actualReplyToMessageId = resolved.messageId;
    }
    try {
      const sentMessages = await sendMessagesV2(key, messages, delays, actualReplyToMessageId, atUserId, { quoted: quotedInfo });
      recordSentMessagesV2?.(key, sentMessages);
      st.lastAiReplyAt = now;
      st.lastActionAt = now;
      st.wakeConfig.noActionCount = 0;
      // 已回复的那条立即移出未读，避免本轮/下一轮重复回答同一条。
      if (sentMessages.length > 0 && quotedInfo?.messageId != null) {
        const before = st.unread.length;
        st.unread = st.unread.filter((m) => String(m?.messageId ?? '') !== String(quotedInfo.messageId));
        if (st.unread.length !== before) {
          logLine(`[reserved2] ${key} 已回复的消息从未读移除 1 条（余 ${st.unread.length}）`);
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
      saveSocialV2State?.();
      logLine(`[reserved2] 工具统一发送 ${key}: 成功 ${sentMessages.length}/${messages.length} 条`);
      appendActivity?.(`${key} [reserved2] 工具统一发送：成功 ${sentMessages.length}/${messages.length} 条`);
      if (sentMessages.length > 0) scheduleReplyCheckV2?.(key);
      const burstHint = messages.length >= 3 ? '你已经连发了多条，确认是必要的吗？真人很少一口气补完。' : undefined;
      const spaceWarn = findCjkSpaceWarning?.(messages);
      const splitWarn = findSplitBoundaryWarning?.(messages);
      return {
        ok: true,
        key,
        sent: sentMessages.length,
        failed: messages.length - sentMessages.length,
        delays,
        quoted: quotedInfo,
        ...(burstHint ? { hint: burstHint } : {}),
        ...(spaceWarn ? { warn: spaceWarn } : {}),
        ...(splitWarn ? { splitWarn } : {})
      };
    } catch (error) {
      if (error?.sent?.length) {
        recordSentMessagesV2?.(key, error.sent);
        logLine(`[reserved2] 工具统一发送部分成功 ${error.sent.length}/${messages.length} 条，已记录已发消息`);
      }
      const sentCount = Array.isArray(error?.sent) ? error.sent.length : 0;
      rollbackSendTimes(st, now, Math.max(0, messages.length - sentCount));
      saveSocialV2State?.();
      return { ok: false, status: 500, error: error?.message ?? String(error) };
    }
  }

  /** POST /api/socialV2/send-poke */
  async function sendPoke({ body = {}, headerToken = '', agentTokenOk, toolEnabled } = {}) {
    const key = String(body.key ?? '').trim();
    let targetUserId = String(body.targetUserId ?? body.userId ?? '').trim();
    if (!key) return { ok: false, status: 400, error: 'key 不能为空' };
    if (live.currentMode !== 'reserved2') return { ok: false, status: 403, error: '该接口仅 reserved2 模式可用' };
    if (!headerToken) return { ok: false, status: 403, error: 'reserved2 模式发送拍一拍必须携带 agent token' };
    if (!agentTokenOk?.(key, headerToken)) return { ok: false, status: 403, error: 'agent token 无效' };
    if (!toolEnabled?.('sendPoke')) return { ok: false, status: 403, error: '工具未启用：qq_send_poke' };
    if (socialV2.paused) return { ok: false, status: 403, error: '二代 AI 已暂停，不能发送拍一拍' };
    if (ops.isTokenFused?.(key)) {
      return { ok: false, status: 403, error: '会话已触发 Token 熔断，自动发送已停止；请先在控制台解除熔断' };
    }
    const keyMatch = /^(group|private):(\d+)$/.exec(key);
    if (!keyMatch) return { ok: false, status: 400, error: 'key 格式应为 group:群号 或 private:QQ号' };
    const kind = keyMatch[1];
    const id = Number(keyMatch[2]);
    if (!Number.isFinite(id) || id <= 0 || typeof modeAllowed !== 'function' || !modeAllowed(key, kind, id, cfg, live.currentMode)) {
      return { ok: false, status: 403, error: '当前模式不允许操作该会话' };
    }
    if (typeof shouldBlockSilentReply === 'function' && shouldBlockSilentReply(key)) {
      return { ok: false, status: 403, error: '静默模式已开启，当前不允许拍一拍' };
    }
    if (kind === 'group' && !targetUserId) {
      return { ok: false, status: 400, error: '群聊拍一拍必须指定 targetUserId（QQ 号 / 昵称 / latest）' };
    }
    // 目标解析：允许 latest（最近戳我的人）或对方昵称，由桥接在本会话消息里换算成 QQ 号。
    if (kind === 'group') {
      const peek = getSocialV2State(key);
      const resolved = resolvePokeTarget?.({
        ref: targetUserId,
        unread: peek.unread,
        recentMessages: peek.recentMessages
      });
      if (!resolved?.ok) {
        if (resolved?.reason === 'ambiguous') {
          const cands = (resolved.candidates || []).map((c) => `${c.sender}(${c.userId})`).join('、');
          return { ok: false, status: 400, error: `昵称「${targetUserId}」在本会话对应多人：${cands}。请直接传 QQ 号` };
        }
        if (resolved?.reason === 'not-found') {
          return {
            ok: false,
            status: 400,
            error: isSymbolicPokeRef?.(targetUserId)
              ? '最近没有戳你的人，无法用 latest；请传 QQ 号或对方昵称'
              : `本会话里找不到「${targetUserId}」对应的 QQ 号，请传数字 QQ 号，或传 latest（最近戳你的人）`
          };
        }
        return { ok: false, status: 400, error: 'targetUserId 不能为空' };
      }
      if (resolved.reason !== 'numeric') {
        logLine(`[拍一拍] ${key} 目标解析：${targetUserId} → ${resolved.userId}${resolved.sender ? `（${resolved.sender}）` : ''}，来源=${resolved.reason}`);
        targetUserId = resolved.userId;
      }
    }
    if (targetUserId && !/^[1-9]\d*$/.test(targetUserId)) {
      return { ok: false, status: 400, error: 'targetUserId 必须是正整数 QQ 号' };
    }
    const st = getSocialV2State(key);
    const sendCfg = cfg.socialV2?.send ?? {};
    const now = Date.now();
    const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
    const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
    const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
    const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
    if ((maxPerMinute > 0 && recentMinute + 1 > maxPerMinute) || (maxPerHour > 0 && recentHour + 1 > maxPerHour)) {
      return { ok: false, status: 429, error: '发送频率超限，请稍后再试' };
    }
    st.sendTimes.push(now);
    if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
    try {
      if (kind === 'group') {
        await bot.raw('group_poke', { group_id: id, user_id: Number(targetUserId) });
      } else {
        await bot.raw('send_poke', { user_id: id });
      }
      st.lastActionAt = now;
      st.lastAiReplyAt = now;
      st.wakeConfig.noActionCount = 0;
      // 自己的拍一拍记成**名字**并明确「你拍了拍」，不再写裸 QQ 号。
      let targetName = targetUserId;
      if (kind === 'group') {
        try {
          targetName = (await resolveGroupMemberName?.(id, targetUserId)) || targetUserId;
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
      saveSocialV2State?.();
      logLine(`[reserved2] 工具拍一拍 ${key}${kind === 'group' ? ' -> ' + targetUserId : ''}`);
      appendActivity?.(`${key} [reserved2] 工具拍一拍${kind === 'group' ? ' -> ' + targetUserId : ''}`);
      return { ok: true, key, kind, targetUserId: targetUserId || String(id) };
    } catch (error) {
      const idx = st.sendTimes.indexOf(now);
      if (idx >= 0) st.sendTimes.splice(idx, 1);
      if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
      logLine(`[reserved2] 工具拍一拍失败 ${key}:`, error?.message ?? error);
      return { ok: false, status: 500, error: `拍一拍失败：${error?.message ?? error}` };
    }
  }

  return { sendBurst, sendMessage, sendPoke };
}
