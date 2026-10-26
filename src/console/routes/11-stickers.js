// 控制台路由域：表情 / 功能菜单 / 抓取（R4）。
//
// 从 console-server.js 原样搬出，只调整了缩进；鉴权 / CSRF / agent 白名单 /
// 暂停隔离仍由 console-server 统一处理，走到这里时请求已通过全部前置校验。
export const id = '11-stickers';
export const title = '表情 / 功能菜单 / 抓取';

/** 本模块负责的路由；console-server 据此分派，不必解析 handler 内部。 */
export const routes = [
  ['GET', '/api/socialV2/send-feature-menu', 'exact'],
  ['POST', '/api/socialV2/github-shot', 'exact'],
  ['POST', '/api/socialV2/sticker-note', 'exact'],
  ['POST', '/api/socialV2/sticker-delete', 'exact'],
  ['POST', '/api/socialV2/sticker-remark', 'exact'],
  ['POST', '/api/socialV2/send-voice', 'exact'],
  ['POST', '/api/socialV2/send-sticker', 'exact'],
  ['POST', '/api/socialV2/collect-sticker', 'exact'],
  ['POST', '/api/socialV2/crawl', 'exact'],
  ['GET', '/api/socialV2/sticker-list', 'exact'],
  ['GET', '/api/stickers', 'exact'],
  ['POST', '/api/stickers/sync', 'exact'],
  ['POST', '/api/stickers/note', 'exact'],
  ['POST', '/api/stickers/remark', 'exact']
];

export async function handle(req, res, url, ctx) {
  const { sendJson, readBody, deps } = ctx;
  const { agentTokenOk, v2SessionAllowed, v2ToolEnabled } = ctx;
  const {
    STATE_DIR,
    appendActivity,
    applyStickerNoteV2,
    bot,
    cfg,
    collectStickerV2,
    crawlAigengtu,
    crawlUrl,
    deleteStickerV2,
    extractGitHubUrl,
    formatStickerList,
    fs,
    getSocialV2State,
    gitHubShotTimes,
    isAigengtuUrl,
    isOwnerTurn,
    isSymbolicReplyRef,
    log,
    modeAllowed,
    onebotSendImageFile,
    onebotSendVoiceFile,
    parseGitHubUrl,
    path,
    recordSentMessagesV2,
    renderFeatureMenu,
    resolveReplyTargetV2,
    roleFor,
    saveSocialV2State,
    saveStickerImage,
    scheduleReplyCheckV2,
    screenshotGitHubRepo,
    sendStickerV2,
    sendToQQ,
    setStickerRemarkV2,
    shouldBlockSilentReply,
    socialV2,
    stickerCacheOpts,
    stickerEnabled,
    syncStickerLibrary,
    ttsNum
  } = deps;

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
    if (deps.ops.isTokenFused?.(key)) { sendJson({ ok: false, error: '会话已触发 Token 熔断，自动发送已停止；请先在控制台解除熔断' }, 403); return; }
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
    if (deps.ops.isTokenFused?.(key)) { sendJson({ ok: false, error: '会话已触发 Token 熔断，自动发送已停止；请先在控制台解除熔断' }, 403); return; }
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
}
