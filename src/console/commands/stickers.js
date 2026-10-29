// R4.7-3：表情/功能菜单/抓取命令。
//
// 发送类端点的闸门（reserved2/暂停/熔断/静默/限频）与副作用（时间线、活动日志、
// 缓存刷新）收在这里；路由只做 agent token、会话准入与工具开关。
// QQ 账号级操作（删除/改备注）仍要求「最近一条消息发送者是管理员」。

export function createStickersCommands({
  config = {},
  operations = {},
  sessions = {},
  social = {},
  media = {},
  messaging = {},
  github = {},
  reply = {},
  crawl = {},
  policy = {},
  menu = {}
} = {}) {
  const { cfg = {}, STATE_DIR, fs, path, log, ttsNum } = config;
  const { live = {}, ops = {}, appendActivity } = operations;
  const { socialV2 = { conversations: new Map() }, getSocialV2State, saveSocialV2State, gitHubShotTimes } = sessions;
  const { scheduleReplyCheckV2 } = social;
  const {
    stickerEnabled,
    applyStickerNoteV2,
    deleteStickerV2,
    setStickerRemarkV2,
    sendStickerV2,
    collectStickerV2,
    syncStickerLibrary,
    saveStickerImage,
    crawlAigengtu,
    crawlUrl,
    isAigengtuUrl,
    onebotSendImageFile,
    onebotSendVoiceFile,
    sendToQQ
  } = media;
  const { recordSentMessagesV2 } = messaging;
  const { parseGitHubUrl, extractGitHubUrl, screenshotGitHubRepo } = github;
  const { isSymbolicReplyRef, resolveReplyTargetV2 } = reply;
  const { bot } = crawl;
  const { modeAllowed, shouldBlockSilentReply, isOwnerTurn } = policy;
  const { renderFeatureMenu, roleFor } = menu;
  const logLine = (message) => { try { log?.(message); } catch { /* 日志失败不影响主流程 */ } };

  // ── 功能菜单图 ──────────────────────────────────────────────────────
  async function sendFeatureMenu({ key, refresh = false } = {}) {
    if (socialV2.paused) return { ok: false, status: 403, error: 'AI 已暂停，当前不允许发送' };
    const keyMatch = /^(group|private):(\d+)$/.exec(key);
    if (!keyMatch) return { ok: false, status: 400, error: 'key 格式应为 group:群号 或 private:QQ号' };
    const kind = keyMatch[1];
    const id = Number(keyMatch[2]);
    if (!Number.isFinite(id) || id <= 0 || typeof modeAllowed !== 'function' || !modeAllowed(key, kind, id, cfg, live.currentMode)) {
      return { ok: false, status: 403, error: '当前模式不允许向该会话发送' };
    }
    if (typeof shouldBlockSilentReply === 'function' && shouldBlockSilentReply(key)) {
      return { ok: false, status: 403, error: '静默模式已开启，当前不允许发送' };
    }
    try {
      const r = await renderFeatureMenu({ force: refresh, config: cfg, roleName: roleFor?.(key) || '', log: (m) => logLine(m) });
      if (!r.ok) return { ok: false, status: 500, error: r.error };
      // 图库目录下不碰：菜单是桥接自有产物，放 state/feature-menu 缓存目录里直接发
      await onebotSendImageFile(key, r.file, { label: '群友功能菜单' });
      logLine(`[功能菜单] 已发送到 ${key}（${Math.round(r.bytes / 1024)}KB${r.cached ? '，缓存' : '，新渲染'}）`);
      appendActivity?.(`${key} [功能菜单] 已发送功能菜单图`);
      return { ok: true, key, cached: r.cached, bytes: r.bytes };
    } catch (error) {
      logLine(`功能菜单发送失败：${error?.message ?? error}`);
      return { ok: false, status: 500, error: `功能菜单发送失败：${error?.message ?? error}` };
    }
  }

  // ── GitHub 仓库首页截图 ─────────────────────────────────────────────
  async function githubShot({ key, raw = '' } = {}) {
    const gs = cfg.socialV2?.githubShot ?? {};
    if (gs.enabled === false) return { ok: false, status: 400, error: 'GitHub 截图功能已关闭（socialV2.githubShot.enabled）' };
    const keyMatch = /^(group|private):(\d+)$/.exec(key);
    if (!keyMatch) return { ok: false, status: 400, error: 'key 格式应为 group:群号 或 private:QQ号' };
    if (socialV2.paused) return { ok: false, status: 403, error: 'AI 已暂停，当前不允许发送' };
    const kind = keyMatch[1];
    const id = Number(keyMatch[2]);
    if (!Number.isFinite(id) || id <= 0 || typeof modeAllowed !== 'function' || !modeAllowed(key, kind, id, cfg, live.currentMode)) {
      return { ok: false, status: 403, error: '当前模式不允许向该会话发送' };
    }
    if (typeof shouldBlockSilentReply === 'function' && shouldBlockSilentReply(key)) {
      return { ok: false, status: 403, error: '静默模式已开启，当前不允许发送' };
    }

    // 解析：允许直接贴链接，也允许贴一段含链接的消息文本
    const candidate = parseGitHubUrl?.(raw) ? raw : (extractGitHubUrl?.(raw) || raw);
    const info = parseGitHubUrl?.(candidate);
    if (!info) {
      return { ok: false, status: 400, error: '识别不出 GitHub 仓库（支持 https://github.com/owner/repo、owner/repo；不支持 /issues、/tree 等子页面，会归到仓库首页）' };
    }

    // 同一仓库同一会话 30 秒内不重复截（群友常连发两次链接）
    const shotKey = `${key}|${info.url}`;
    const lastAt = gitHubShotTimes?.get(shotKey) || 0;
    if (Date.now() - lastAt < 30000) {
      return { ok: false, status: 429, error: '刚截过这个仓库，30 秒内不重复发（避免刷屏）' };
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
          logLine(`[GitHub] 第 ${sentCount + 1} 张发送失败：${error?.message ?? error}`);
          break; // 后面几张大概率也会失败（限频/断线），别硬刷
        }
      }
      if (!sentCount) throw new Error('截图已生成但一张都没发出去');

      gitHubShotTimes?.set(shotKey, Date.now());
      // 只留最近 200 条，避免无限增长
      while ((gitHubShotTimes?.size ?? 0) > 200) {
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
      saveSocialV2State?.();

      logLine(`[GitHub] 已发送 ${label} 首页截图 ${sentCount}/${slices.length} 张（整页 ${shot.height}px${shot.truncated ? '，已截断' : ''}）`);
      appendActivity?.(`${key} [GitHub] 已发送 ${label} 首页截图 ${sentCount} 张`);
      return {
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
      };
    } catch (error) {
      const msg = String(error?.message ?? error);
      logLine(`[GitHub] 截图失败 ${info.url}：${msg}`);
      // 直连失败是最常见的原因，直接点明，省得模型瞎猜
      const hint = /ECONNRESET|ECONNREFUSED|ETIMEDOUT|net::ERR/i.test(msg)
        ? '（GitHub 在本机直连不通，需要在 config.json 的 socialV2.githubShot.proxy 或 socialV2.images.proxy 配置代理）'
        : '';
      return { ok: false, status: 500, error: `截图失败：${msg}${hint}` };
    }
  }

  // ── 表情本地认知 / 备注 / 删除 ──────────────────────────────────────
  function applyNote({ key, stickerId, note, tags, usage } = {}) {
    if (!stickerEnabled?.()) return { ok: false, status: 403, error: '表情包体系已关闭' };
    const entry = applyStickerNoteV2?.(stickerId, note, tags, usage);
    if (!entry) return { ok: false, status: 404, error: `找不到表情 ${stickerId}` };
    logLine(`[sticker] 更新表情本地认知 ${key}: ${entry.id}`);
    return { ok: true, key, sticker: entry };
  }

  async function deleteSticker({ key, stickerId } = {}) {
    if (!stickerEnabled?.()) return { ok: false, status: 403, error: '表情包体系已关闭' };
    if (socialV2.paused) return { ok: false, status: 403, error: 'AI 已暂停，当前不允许执行写操作' };
    // **仅管理员可用**（2026-10-15 用户要求）：群里群友和管理员共用一个会话，
    // v2SessionAllowed 只验证"这个会话在白名单里"，不能说明"刚说话的是管理员"。
    if (typeof isOwnerTurn === 'function' && !isOwnerTurn(key)) {
      logLine(`[sticker] 拒绝删除表情：请求者不是管理员（${key}）`);
      return { ok: false, status: 403, error: '删除收藏表情仅管理员可用。如果确实需要删，请让管理员来说。' };
    }
    try {
      const r = await deleteStickerV2(stickerId);
      logLine(`[sticker] 删除收藏表情 ${key}: ${r.id}（${r.desc}）回读确认=${r.verifiedGone ? '已消失' : '未确认'}`);
      appendActivity?.(`${key} [表情] 已删除收藏表情${r.desc ? `「${r.desc}」` : ''}`);
      return { ok: true, key, deleted: { id: r.id, md5: r.md5, desc: r.desc }, verifiedGone: r.verifiedGone };
    } catch (error) {
      return { ok: false, status: 500, error: `删除表情失败：${error?.message ?? error}` };
    }
  }

  async function setRemark({ key, stickerId, remark } = {}) {
    if (!stickerEnabled?.()) return { ok: false, status: 403, error: '表情包体系已关闭' };
    // 与删除同理：改的是 QQ 账号上的官方备注，**仅管理员可用**。
    if (typeof isOwnerTurn === 'function' && !isOwnerTurn(key)) {
      logLine(`[sticker] 拒绝改备注：请求者不是管理员（${key}）`);
      return { ok: false, status: 403, error: '修改收藏表情备注仅管理员可用。' };
    }
    try {
      const entry = await setStickerRemarkV2(stickerId, String(remark ?? ''));
      logLine(`[sticker] 修改 QQ 收藏表情备注 ${key}: ${entry.id} -> ${entry.desc}`);
      return { ok: true, key, sticker: entry };
    } catch (error) {
      return { ok: false, status: 500, error: `修改备注失败：${error?.message ?? error}` };
    }
  }

  // ── 主动语音 ────────────────────────────────────────────────────────
  async function sendVoice({ key, text } = {}) {
    if (live.currentMode !== 'reserved2') return { ok: false, status: 403, error: '该接口仅 reserved2 模式可用' };
    if (ops.isTokenFused?.(key)) {
      return { ok: false, status: 403, error: '会话已触发 Token 熔断，自动发送已停止；请先在控制台解除熔断' };
    }
    if (!live.ttsEngine || !live.ttsEngine.available()) {
      return { ok: false, status: 503, error: '语音合成不可用（未启用、未加载完成或探测失败；见控制台「17b 语音合成」）' };
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
    const limitChars = Math.max(20, Number(cfg.socialV2?.tts?.maxChars) || 140);
    if (String(text).length > limitChars) {
      return { ok: false, status: 400, error: `语音最多 ${limitChars} 字（念太长没人听）；这句有 ${String(text).length} 字，请精简或改用文字` };
    }
    // 念出来没有意义的内容直接挡掉（与概率语音同一套规则）
    if (/https?:\/\/|www\.|```/.test(String(text))) {
      return { ok: false, status: 400, error: '这条内容含链接或代码，念出来没用；请改用文字发送' };
    }
    const st = getSocialV2State(key);
    const now = Date.now();
    const hist = (Array.isArray(st.ttsTimes) ? st.ttsTimes : []).filter((x) => now - Number(x) < 3600000);
    const maxPerHour = ttsNum?.(cfg.socialV2?.tts?.maxPerHour, 3, 0, 60);
    if (maxPerHour > 0 && hist.length >= maxPerHour) {
      return { ok: false, status: 429, error: `这个会话一小时最多 ${maxPerHour} 条语音，已经发完了；这条先用文字吧` };
    }
    try {
      const r = await live.ttsEngine.speak(String(text));
      if (!r.ok) return { ok: false, status: 500, error: `合成失败：${r.error}` };
      await onebotSendVoiceFile(key, r.file, { text: String(text) });
      st.ttsTimes = [...hist, Date.now()].slice(-200);
      st.lastTtsAt = Date.now();
      // 主动语音也是一次真实发言：更新回复时间，并把 [语音] 标记写回
      // recentMessages/journal，避免模型下一轮不知道刚才发的是语音。
      st.lastAiReplyAt = Date.now();
      st.lastActionAt = st.lastAiReplyAt;
      st.wakeConfig.noActionCount = 0;
      recordSentMessagesV2?.(key, [{ text: String(text), isVoice: true }]);
      saveSocialV2State?.();
      logLine(`[TTS] 主动发语音（${r.cached ? '缓存' : `${r.synthSec ?? '?'}s 合成`}，${r.durSec}s，${String(text).length} 字）→ ${key}`);
      appendActivity?.(`${key} [TTS] 主动发了一条语音（${r.durSec}s）`);
      return { ok: true, key, durSec: r.durSec, cached: !!r.cached, chars: String(text).length };
    } catch (error) {
      logLine(`[TTS] 主动发语音失败：${error?.message ?? error}`);
      return { ok: false, status: 500, error: `发送失败：${error?.message ?? error}` };
    }
  }

  // ── 发送表情 ────────────────────────────────────────────────────────
  async function sendSticker({ key, body = {} } = {}) {
    if (!stickerEnabled?.()) return { ok: false, status: 403, error: '表情包体系已关闭' };
    const stickerId = String(body.stickerId ?? '').trim();
    const caption = String(body.message ?? body.caption ?? '').trim();
    const replyToMessageId = body.replyToMessageId;
    const atUserId = body.atUserId ?? null;
    // 仿真常识：表情消息只能是一张表情，不能在同一气泡里附带文字说明。
    if (caption) {
      return { ok: false, status: 400, error: '表情消息不能附带文字；请先用 qq_send_message / qq_reply 把想说的话作为单独气泡发送，再单独 qq_send_sticker 发表情' };
    }
    if (live.currentMode !== 'reserved2') return { ok: false, status: 403, error: '该接口仅 reserved2 模式可用' };
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
    const now = Date.now();
    try {
      const st = getSocialV2State(key);
      const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
      const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
      const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
      const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
      if ((maxPerMinute > 0 && recentMinute + 1 > maxPerMinute) || (maxPerHour > 0 && recentHour + 1 > maxPerHour)) {
        return { ok: false, status: 429, error: '发送频率超限，请稍后再试' };
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
      saveSocialV2State?.();
      scheduleReplyCheckV2?.(key);
      logLine(`[sticker] 工具发送表情 ${key}: ${sent.entry?.id || stickerId}`);
      appendActivity?.(`${key} [sticker] 工具发送表情：${label}`);
      return { ok: true, key, sticker: sent.entry, sent: 1, failed: 0, quoted: quotedInfo };
    } catch (error) {
      const st = getSocialV2State(key);
      const idx = st.sendTimes.indexOf(now);
      if (idx >= 0) st.sendTimes.splice(idx, 1);
      if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
      saveSocialV2State?.();
      logLine(`[sticker] 工具发送表情失败 ${key}: ${error?.message ?? error}`);
      return { ok: false, status: 500, error: `发送表情失败：${error?.message ?? error}` };
    }
  }

  // ── 收藏表情 ────────────────────────────────────────────────────────
  async function collectSticker({ key, messageRef, remark = '' } = {}) {
    if (!stickerEnabled?.()) return { ok: false, status: 403, error: '表情包体系已关闭' };
    const keyMatch = /^(group|private):(\d+)$/.exec(key);
    if (!keyMatch) return { ok: false, status: 400, error: 'key 格式应为 group:群号 或 private:QQ号' };
    const st = getSocialV2State(key);
    const collectCfg = cfg.socialV2?.sticker?.collect ?? {};
    if (collectCfg.enabled === false) return { ok: false, status: 403, error: 'AI 收藏表情功能已关闭' };
    const now = Date.now();
    const maxPerMinute = Math.max(0, Number(collectCfg.maxPerMinute) || 0);
    const maxPerHour = Math.max(0, Number(collectCfg.maxPerHour) || 0);
    const recentMinute = (st.stickerCollectTimes || []).filter((t) => now - t < 60000).length;
    const recentHour = (st.stickerCollectTimes || []).filter((t) => now - t < 3600000).length;
    if ((maxPerMinute > 0 && recentMinute + 1 > maxPerMinute) || (maxPerHour > 0 && recentHour + 1 > maxPerHour)) {
      return { ok: false, status: 429, error: '收藏表情太频繁了，请过一会儿再偷图' };
    }
    // 先预占收藏次数，避免并发调用绕过限频；失败时回滚。
    st.stickerCollectTimes = st.stickerCollectTimes || [];
    st.stickerCollectTimes.push(now);
    if (st.stickerCollectTimes.length > 500) st.stickerCollectTimes = st.stickerCollectTimes.slice(-500);
    try {
      const result = await collectStickerV2(key, messageRef, remark);
      saveSocialV2State?.();
      logLine(`[sticker] AI 收藏表情 ${key}: ${result.emojiId}${result.remark ? '（备注：' + result.remark + '）' : ''}`);
      appendActivity?.(`${key} [sticker] AI 收藏表情：${result.remark || result.emojiId}`);
      return { ok: true, key, sticker: result.entry, emojiId: result.emojiId, remark: result.remark };
    } catch (error) {
      const idx = st.stickerCollectTimes.indexOf(now);
      if (idx >= 0) st.stickerCollectTimes.splice(idx, 1);
      if (st.stickerCollectTimes.length > 500) st.stickerCollectTimes = st.stickerCollectTimes.slice(-500);
      saveSocialV2State?.();
      logLine(`[sticker] AI 收藏表情失败 ${key}: ${error?.message ?? error}`);
      return { ok: false, status: 500, error: `收藏表情失败：${error?.message ?? error}` };
    }
  }

  // ── 抓网页 / 找图 / 存收藏表情 ──────────────────────────────────────
  async function crawlWeb({ key, body = {} } = {}) {
    const ccfg = { ...(cfg.socialV2?.crawl ?? {}) };
    if (ccfg.enabled === false) return { ok: false, status: 403, error: '爬虫功能已关闭' };
    if (!/^(group|private):\d+$/.test(key)) return { ok: false, status: 400, error: 'key 格式应为 group:群号 或 private:QQ号' };

    const st = getSocialV2State(key);
    const now = Date.now();
    const maxPerHour = Math.max(0, Number(ccfg.maxPerHour) || 0);
    const crawlTimes = (Array.isArray(st.crawlTimes) ? st.crawlTimes : []).filter((t) => now - Number(t) < 3600000);
    if (maxPerHour > 0 && crawlTimes.length >= maxPerHour) {
      return { ok: false, status: 429, error: `爬取太频繁了：每小时最多 ${maxPerHour} 次` };
    }
    st.crawlTimes = [...crawlTimes, now].slice(-200);
    saveSocialV2State?.();

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
      if (!targetUrl || isAigengtuUrl?.(targetUrl)) {
        result = await crawlAigengtu({ query, category, limit });
      } else {
        result = await crawlUrl(targetUrl, { query, limit, maxText: 4000 });
      }

      if (!saveStickers) {
        const blocked = !!result.needsLogin;
        return {
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
        };
      }

      if (cfg.socialV2?.sticker?.enabled === false) {
        return { ok: false, status: 403, error: '表情包体系已关闭，不能存表情' };
      }
      const candidates = (result.images || []).slice(0, limit);
      if (!candidates.length) {
        return { ok: false, status: 404, error: '没有找到可用图片', needsLogin: !!result.needsLogin };
      }

      const maxPerDay = Math.max(0, Number(ccfg.stickerMaxPerDay) || 0);
      const addTimes = (Array.isArray(st.stickerAddTimes) ? st.stickerAddTimes : []).filter((t) => now - Number(t) < 86400000);
      if (maxPerDay > 0 && addTimes.length >= maxPerDay) {
        return { ok: false, status: 429, error: `今天存的表情太多了：每天最多 ${maxPerDay} 张` };
      }

      const synced = await syncStickerLibrary(false);
      const existingMd5 = new Set(
        (synced?.entries ?? live.stickerEntries ?? [])
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
      saveSocialV2State?.();
      logLine(`[crawl] ${key} ${dryRun ? '试运行' : '存表情'}：新增 ${added.length}，跳过 ${skipped.length}，失败 ${errors.length}`);
      appendActivity?.(`${key} [crawl] ${dryRun ? '试运行' : '存表情'}：${added.map((x) => x.name || x.emojiId).join('、').slice(0, 60) || '无新增'}`);
      return {
        ok: added.length > 0 || skipped.length > 0,
        kind: 'stickers',
        dryRun,
        added,
        skipped,
        errors,
        text: result.text || '',
        needsLogin: !!result.needsLogin,
        note: dryRun ? '试运行：只下载和校验，没有写入 QQ 收藏表情。' : ''
      };
    } catch (error) {
      logLine(`[crawl] ${key} 抓取失败：${error?.message ?? error}`);
      return { ok: false, status: 500, error: `抓取失败：${error?.message ?? error}` };
    }
  }

  // ── 管理端表情库 ────────────────────────────────────────────────────
  async function syncStickers() {
    try {
      const synced = await syncStickerLibrary(true);
      return { ok: true, total: synced?.entries?.length ?? live.stickerEntries.length, syncedAt: synced?.syncedAt ?? live.stickerSyncedAt };
    } catch (error) {
      return { ok: false, status: 500, error: `同步表情失败：${error?.message ?? error}` };
    }
  }

  function adminNote({ stickerId, note, tags, usage } = {}) {
    if (!stickerId) return { ok: false, status: 400, error: 'stickerId 不能为空' };
    const entry = applyStickerNoteV2?.(stickerId, note, tags, usage);
    if (!entry) return { ok: false, status: 404, error: `找不到表情 ${stickerId}` };
    return { ok: true, sticker: entry };
  }

  async function adminRemark({ stickerId, remark } = {}) {
    if (!stickerId) return { ok: false, status: 400, error: 'stickerId 不能为空' };
    try {
      const entry = await setStickerRemarkV2(stickerId, String(remark ?? ''));
      return { ok: true, sticker: entry };
    } catch (error) {
      return { ok: false, status: 500, error: `修改备注失败：${error?.message ?? error}` };
    }
  }

  return {
    sendFeatureMenu,
    githubShot,
    applyNote,
    deleteSticker,
    setRemark,
    sendVoice,
    sendSticker,
    collectSticker,
    crawlWeb,
    syncStickers,
    adminNote,
    adminRemark
  };
}
