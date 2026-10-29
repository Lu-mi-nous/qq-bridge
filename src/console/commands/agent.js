// R4.7-3：Agent 回调写命令（超分回传 / 统一发送）。
//
// 鉴权顺序与旧路由一致：模式 → 暂停/总开关 → agent token → 工具开关 → 静默 →
// 熔断/配额 → 目标模式。路由只传 body 与请求头 token，安全 helper 由路由注入。

export function createAgentCommands({
  config = {},
  operations = {},
  sessions = {},
  media = {},
  messaging = {},
  social = {}
} = {}) {
  const { cfg = {}, MAX_MEDIA_BYTES, SENSITIVE_RE, log } = config;
  const { live = {}, ops = {}, appendActivity } = operations;
  const { socialV2 = { conversations: new Map() }, imageSendTimes, getSocialV2State, saveSocialV2State } = sessions;
  const { imageSendAllowed, onebotSendImageFile, sendToQQ, sniffImageMime, sendMessagesV2 } = media;
  const { recordSentMessagesV2, stripLeadingMetaMarker, unquoteJsonString, isSymbolicReplyRef, resolveReplyTargetV2 } = messaging;
  const { scheduleReplyCheckV2, shouldBlockSilentReply, modeAllowed } = social;
  const logLine = (message) => { try { log?.(message); } catch { /* 日志失败不影响主流程 */ } };

  /** POST /api/socialV2/send-upscaled */
  async function sendUpscaled({ body = {}, headerToken = '', agentTokenOk, toolEnabled } = {}) {
    const bodyToken = String(body.token ?? '').trim();
    if (headerToken && bodyToken && headerToken !== bodyToken) return { ok: false, status: 403, error: 'Header 与 Body 的 agent token 不一致' };
    const token = headerToken || bodyToken;
    const key = String(body.key ?? '').trim();
    const dataB64 = String(body.data ?? '').replace(/\s/g, '');
    const caption = String(body.caption ?? '').trim().slice(0, 200);
    if ((token || live.currentMode === 'reserved2') && socialV2.paused) {
      return { ok: false, status: 403, error: 'AI 已暂停，当前不允许执行发送工具' };
    }
    if ((token || live.currentMode === 'reserved2') && cfg.socialV2?.enabled === false) {
      return { ok: false, status: 403, error: '二代模式已关闭，当前不允许执行发送工具' };
    }
    if (live.currentMode === 'chat' || live.currentMode === 'reserved') {
      return { ok: false, status: 403, error: '发送工具仅限 closed-agent / reserved2 模式使用' };
    }
    if (live.currentMode === 'reserved2' && !token) return { ok: false, status: 403, error: 'reserved2 模式发送必须携带 agent token' };
    if (!key || !/^(group|private):(\d+)$/.test(key)) return { ok: false, status: 400, error: 'key 格式无效' };
    if (token && !agentTokenOk?.(key, token)) return { ok: false, status: 403, error: 'agent token 无效' };
    if (token && !toolEnabled?.('sendImage')) return { ok: false, status: 403, error: '工具未启用：qq_send_image' };
    if (typeof shouldBlockSilentReply === 'function' && shouldBlockSilentReply(key)) {
      return { ok: false, status: 403, error: '静默模式已开启，当前不允许发送' };
    }
    if (ops.isTokenFused?.(key)) {
      return { ok: false, status: 403, error: '会话已触发 Token 熔断，自动发送已停止；请先在控制台解除熔断' };
    }
    const [, kind, idStr] = /^(group|private):(\d+)$/.exec(key);
    if (typeof modeAllowed !== 'function' || !modeAllowed(key, kind, Number(idStr), cfg, live.currentMode)) {
      return { ok: false, status: 403, error: '目标不在当前模式允许范围内' };
    }
    if (!dataB64) return { ok: false, status: 400, error: 'data 不能为空' };
    // 只接受 base64：拒绝任何 URL／本地路径 —— 那会绕过 SSRF/本地文件防护。
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(dataB64.slice(0, 64))) {
      return { ok: false, status: 400, error: 'data 必须是 base64 编码的图片' };
    }
    const buf = Buffer.from(dataB64, 'base64');
    if (!buf.length) return { ok: false, status: 400, error: 'data 解码后为空' };
    if (buf.length > MAX_MEDIA_BYTES) {
      return { ok: false, status: 400, error: `图片过大（${(buf.length / 1024 / 1024).toFixed(1)}MB），上限 ${(MAX_MEDIA_BYTES / 1024 / 1024) | 0}MB` };
    }
    // 必须是图片：超分端点只发图，不能变成任意文件发送通道。
    const sniffed = sniffImageMime(buf);
    if (!sniffed) return { ok: false, status: 400, error: 'data 不是可识别的图片格式' };
    try {
      const st = getSocialV2State(key);
      const gate = imageSendAllowed(key);
      if (!gate.ok) return { ok: false, status: 429, error: gate.error };
      const sent = await onebotSendImageFile(key, buf, { label: '［超分］' });
      const now = Date.now();
      const times = (imageSendTimes.get(key) ?? []).filter((t) => now - t < 3600000);
      times.push(now);
      imageSendTimes.set(key, times);
      st.lastActionAt = now;
      saveSocialV2State?.();
      // 说明文字可选：先说图再补一句（分两条发，避免图配长文被截断）
      if (caption) {
        await sendToQQ(key, caption).catch((e) => logLine(`超分回传附言发送失败 ${key}: ${e?.message ?? e}`));
      }
      logLine(`[超分] 已回传图片到 ${key}（${(buf.length / 1024).toFixed(0)}KB）`);
      return { ok: true, key, messageId: sent?.message_id ?? null, bytes: buf.length, mimeType: sniffed };
    } catch (error) {
      logLine(`超分回传失败 ${key}: ${error?.message ?? error}`);
      return { ok: false, status: 500, error: `发送失败：${error?.message ?? error}` };
    }
  }

  /** POST /api/send/group|private|reply */
  async function sendMessage({ pathname, body = {}, headerToken = '', agentTokenOk, toolEnabled } = {}) {
    const bodyToken = String(body.token ?? '').trim();
    if (headerToken && bodyToken && headerToken !== bodyToken) return { ok: false, status: 403, error: 'Header 与 Body 的 agent token 不一致' };
    const token = headerToken || bodyToken;
    const isPrivate = pathname === '/api/send/private';
    const isReply = pathname === '/api/send/reply';
    const targetId = isPrivate ? String(body.userId ?? '').trim() : String(body.groupId ?? '').trim();
    const message = stripLeadingMetaMarker(unquoteJsonString(String(body.message ?? '').trim()));
    const replyToMessageId = isReply ? body.replyToMessageId : body.replyToMessageId;
    const atUserId = body.atUserId ?? null;
    const key = isPrivate ? `private:${targetId}` : `group:${targetId}`;
    // 安全边界：发送工具只允许在 closed-agent（管理员私聊）或 reserved2（二代 AI 带会话令牌）下使用；
    // chat/reserved 的自动转发已覆盖正常回复，MCP 发送工具不应成为 prompt injection 的越权出口。
    if (live.currentMode === 'chat' || live.currentMode === 'reserved') {
      return { ok: false, status: 403, error: '发送工具仅限 closed-agent / reserved2 模式使用' };
    }
    if ((token || live.currentMode === 'reserved2') && socialV2.paused) {
      return { ok: false, status: 403, error: 'AI 已暂停，当前不允许执行发送工具' };
    }
    if ((token || live.currentMode === 'reserved2') && cfg.socialV2?.enabled === false) {
      return { ok: false, status: 403, error: '二代模式已关闭，当前不允许执行发送工具' };
    }
    if (!targetId || !message) return { ok: false, status: 400, error: '目标 id 和 message 不能为空' };
    if (isPrivate && atUserId) return { ok: false, status: 400, error: '私聊不需要 @' };
    if (isReply && (replyToMessageId === undefined || replyToMessageId === null || String(replyToMessageId).trim() === '')) {
      return { ok: false, status: 400, error: 'replyToMessageId 不能为空' };
    }
    if (live.currentMode === 'reserved2' && !token) return { ok: false, status: 403, error: 'reserved2 模式发送必须携带 agent token' };
    if (token && !agentTokenOk?.(key, token)) return { ok: false, status: 403, error: 'agent token 无效' };
    const flag = isPrivate ? 'sendPrivate' : (isReply ? 'reply' : 'sendGroup');
    if (token && !toolEnabled?.(flag)) return { ok: false, status: 403, error: `工具未启用：${flag}` };
    if (typeof shouldBlockSilentReply === 'function' && shouldBlockSilentReply(key)) {
      return { ok: false, status: 403, error: '静默模式已开启，当前不允许发送' };
    }
    const keyMatch = /^(group|private):(\d+)$/.exec(key);
    if (!keyMatch) return { ok: false, status: 400, error: 'key 格式无效' };
    const kind = keyMatch[1];
    const id = Number(keyMatch[2]);
    if (!Number.isFinite(id) || id <= 0 || typeof modeAllowed !== 'function' || !modeAllowed(key, kind, id, cfg, live.currentMode)) {
      return { ok: false, status: 403, error: '目标不在当前模式允许范围内' };
    }
    if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== ''
      && !isSymbolicReplyRef?.(replyToMessageId) && !/^-?[1-9]\d*$/.test(String(replyToMessageId).trim())) {
      return { ok: false, status: 400, error: 'replyToMessageId 必须是非零整数（消息 id 可能为负数），或传 latest/上一条 表示引用最近一条别人的消息' };
    }
    let quotedInfo = null;
    let actualReplyToMessageId = replyToMessageId;
    if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
      const stForReply = getSocialV2State(key);
      const resolved = await resolveReplyTargetV2(stForReply, kind, id, String(replyToMessageId).trim());
      if (!resolved) {
        return { ok: false, status: 400, error: '无法解析被引用消息，请确认 message id 正确且属于当前会话（可用 qq_get_message_detail 查看）' };
      }
      quotedInfo = resolved.info;
      actualReplyToMessageId = resolved.messageId;
    }
    const sendCfg = cfg.socialV2?.send ?? {};
    const maxChars = Math.max(1, Number(sendCfg.maxMessageChars) || 500);
    if (message.length > maxChars) return { ok: false, status: 400, error: `单条消息不能超过 ${maxChars} 字` };
    if (SENSITIVE_RE?.test(message)) return { ok: false, status: 403, error: '消息含敏感信息，已阻止发送' };
    // st/now 必须上提到 try 外，catch 的额度回滚才拿得到。
    const st = getSocialV2State(key);
    const now = Date.now();
    try {
      const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
      const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
      const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
      const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
      if ((maxPerMinute > 0 && recentMinute + 1 > maxPerMinute) || (maxPerHour > 0 && recentHour + 1 > maxPerHour)) {
        return { ok: false, status: 429, error: '发送频率超限，请稍后再试' };
      }
      st.sendTimes.push(now);
      if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
      const sentMessages = await sendMessagesV2(key, [message], [], actualReplyToMessageId, atUserId, { quoted: quotedInfo });
      recordSentMessagesV2?.(key, sentMessages);
      st.lastAiReplyAt = now;
      st.lastActionAt = now;
      st.wakeConfig.noActionCount = 0;
      // 已回复的那条立即从未读移除：与它对应的请求已经处理完了，
      // 留着只会让本轮/下一轮又把同一条当待办重答一次。
      if (sentMessages.length > 0 && quotedInfo?.messageId != null) {
        const before = st.unread.length;
        st.unread = st.unread.filter((m) => String(m?.messageId ?? '') !== String(quotedInfo.messageId));
        if (st.unread.length !== before) {
          logLine(`[send] ${key} 已回复 seq 对应消息，从待回复列表移除 1 条（余 ${st.unread.length}）`);
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
      saveSocialV2State?.();
      logLine(`[send] ${pathname} ${key}: 成功 ${sentMessages.length}/1 条`);
      appendActivity?.(`${key} [send] 成功 ${sentMessages.length}/1 条：${message.slice(0, 80)}`);
      if (sentMessages.length > 0) scheduleReplyCheckV2?.(key);
      return { ok: true, key, sent: sentMessages.length, failed: sentMessages.length ? 0 : 1, quoted: quotedInfo };
    } catch (error) {
      if (error?.sent?.length) {
        recordSentMessagesV2?.(key, error.sent);
        logLine(`[send] ${pathname} ${key} 部分成功 ${error.sent.length}/1 条，已记录已发消息`);
      }
      // 失败/未发出的消息回滚预占的发送额度，避免假 429。
      const sentCount = Array.isArray(error?.sent) ? error.sent.length : 0;
      const failedCount = Math.max(0, 1 - sentCount);
      for (let i = 0; i < failedCount; i++) {
        const idx = st.sendTimes.indexOf(now);
        if (idx >= 0) st.sendTimes.splice(idx, 1);
      }
      if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
      saveSocialV2State?.();
      return { ok: false, status: 500, error: error?.message ?? String(error) };
    }
  }

  return { sendUpscaled, sendMessage };
}
