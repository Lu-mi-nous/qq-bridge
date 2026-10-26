// 控制台路由域：Agent 回调：授权 / 图片 / 超分回传（R4）。
//
// 从 console-server.js 原样搬出，只调整了缩进；鉴权 / CSRF / agent 白名单 /
// 暂停隔离仍由 console-server 统一处理，走到这里时请求已通过全部前置校验。
export const id = '17-agent';
export const title = 'Agent 回调：授权 / 图片 / 超分回传';

/** 本模块负责的路由；console-server 据此分派，不必解析 handler 内部。 */
export const routes = [
  ['POST', '/api/authorize/read', 'exact'],
  ['GET', '/api/images/message', 'exact'],
  ['POST', '/api/socialV2/send-upscaled', 'exact'],
  // 统一发送端点（MCP 旧工具）：同一段 handler 里按 pathname 分 group/private/reply。
  ['POST', '/api/send/group', 'exact'],
  ['POST', '/api/send/private', 'exact'],
  ['POST', '/api/send/reply', 'exact']
];

export async function handle(req, res, url, ctx) {
  const { sendJson, readBody, deps } = ctx;
  const { agentTokenOk, v2ToolEnabled } = ctx;
  const {
    MAX_MEDIA_BYTES,
    SENSITIVE_RE,
    appendActivity,
    cfg,
    fetchMediaData,
    findMessageMediaAsync,
    getSocialV2State,
    imageSendAllowed,
    imageSendTimes,
    isSymbolicReplyRef,
    log,
    modeAllowed,
    onebotSendImageFile,
    recordSentMessagesV2,
    resolveReplyTargetV2,
    saveSocialV2State,
    scheduleReplyCheckV2,
    sendMessagesV2,
    sendToQQ,
    shouldBlockSilentReply,
    sniffImageMime,
    socialV2,
    stripLeadingMetaMarker,
    unquoteJsonString
  } = deps;

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
    if (deps.ops.isTokenFused?.(key)) { sendJson({ ok: false, error: '会话已触发 Token 熔断，自动发送已停止；请先在控制台解除熔断' }, 403); return; }
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
    // 同 09-messaging：st/now 必须上提到 try 外，catch 的额度回滚才拿得到。
    const st = getSocialV2State(key);
    const now = Date.now();
    try {
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
}
