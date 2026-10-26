// 控制台路由域：二代发送：连发 / 消息 / 戳一戳（R4）。
//
// 从 console-server.js 原样搬出，只调整了缩进；鉴权 / CSRF / agent 白名单 /
// 暂停隔离仍由 console-server 统一处理，走到这里时请求已通过全部前置校验。
export const id = '09-messaging';
export const title = '二代发送：连发 / 消息 / 戳一戳';

/** 本模块负责的路由；console-server 据此分派，不必解析 handler 内部。 */
export const routes = [
  ['POST', '/api/socialV2/send-burst', 'exact'],
  ['POST', '/api/socialV2/send-message', 'exact'],
  ['POST', '/api/socialV2/send-poke', 'exact']
];

export async function handle(req, res, url, ctx) {
  const { sendJson, readBody, deps } = ctx;
  const { agentTokenOk, v2SessionAllowed, v2ToolEnabled } = ctx;
  const {
    SENSITIVE_RE,
    appendActivity,
    bot,
    cfg,
    computeGapsV2,
    findCjkSpaceWarning,
    findSplitBoundaryWarning,
    getSocialV2State,
    isSymbolicPokeRef,
    isSymbolicReplyRef,
    log,
    modeAllowed,
    normalizeMessagesInput,
    recordSentMessagesV2,
    resolveGroupMemberName,
    resolvePokeTarget,
    resolveReplyTargetV2,
    saveSocialV2State,
    scheduleReplyCheckV2,
    sendMessagesV2,
    shouldBlockSilentReply,
    socialV2,
    stripLeadingMetaMarkers
  } = deps;

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
    if (deps.ops.isTokenFused?.(key)) { sendJson({ ok: false, error: '会话已触发 Token 熔断，自动发送已停止；请先在控制台解除熔断' }, 403); return; }
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
    // st/now 原本声明在 try 内部，catch 回滚发送额度时引用不到（会抛 ReferenceError
    // 把真实错误盖成 500 内部错误）。这里上提到 try 之前，回滚才按设计生效。
    const st = getSocialV2State(key);
    const now = Date.now();
    try {
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
    if (deps.ops.isTokenFused?.(key)) { sendJson({ ok: false, error: '会话已触发 Token 熔断，自动发送已停止；请先在控制台解除熔断' }, 403); return; }
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
    if (deps.ops.isTokenFused?.(key)) { sendJson({ ok: false, error: '会话已触发 Token 熔断，自动发送已停止；请先在控制台解除熔断' }, 403); return; }
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
}
