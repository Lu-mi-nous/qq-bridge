// 控制台路由域：图片：预检 / 搜索 / 发图 / 图库（R4）。
//
// 从 console-server.js 原样搬出，只调整了缩进；鉴权 / CSRF / agent 白名单 /
// 暂停隔离仍由 console-server 统一处理，走到这里时请求已通过全部前置校验。
export const id = '10-images';
export const title = '图片：预检 / 搜索 / 发图 / 图库';

/** 本模块负责的路由；console-server 据此分派，不必解析 handler 内部。 */
export const routes = [
  ['GET', '/api/socialV2/image-preflight', 'exact'],
  ['POST', '/api/socialV2/x-auth-check', 'exact'],
  ['POST', '/api/socialV2/fetch-x-posts', 'exact'],
  ['POST', '/api/socialV2/send-image', 'exact'],
  ['POST', '/api/socialV2/archive-image', 'exact'],
  ['GET', '/api/socialV2/reverse-search', 'exact'],
  ['GET', '/api/socialV2/image-source', 'exact'],
  ['POST', '/api/socialV2/react-message', 'exact'],
  ['POST', '/api/socialV2/reject-image', 'exact'],
  ['GET', '/api/socialV2/image-stats', 'exact'],
  ['GET', '/api/socialV2/image-quota', 'exact'],
  ['POST', '/api/socialV2/refresh-image-lib', 'exact'],
  ['GET', '/api/socialV2/sticker-image', 'exact']
];

export async function handle(req, res, url, ctx) {
  const { sendJson, readBody, deps } = ctx;
  const { agentTokenOk, v2SessionAllowed, v2ToolEnabled } = ctx;
  const {
    MAX_MEDIA_BYTES,
    MAX_MEDIA_PIXELS,
    REACTION_EMOJIS,
    ROOT,
    STATE_DIR,
    STICKER_CACHE_DIR,
    appendActivity,
    archiveImage,
    cfg,
    crypto,
    emojiCatalogIds,
    emojiReactGate,
    fetchMediaData,
    findMessageMediaAsync,
    fs,
    getImageDimensions,
    getSocialV2State,
    getStickerImageData,
    imagePreflightV2,
    imageSendAllowed,
    imageStore,
    imagesEnabled,
    lastSentImage,
    log,
    mimeFromBuffer,
    mimeFromUrl,
    modeAllowed,
    normalizeSourceFilter,
    onebotSendImageFile,
    onebotSendVideoFile,
    path,
    refreshImageLib,
    reverseSearcher,
    safeFetchBuffer,
    saveSocialV2State,
    sendImageV2,
    setEmojiLike,
    shouldBlockSilentReply,
    sleep,
    socialV2,
    sourcePageOf,
    stickerEnabled,
    validateEmojiId,
    writeStickerCacheImage,
    xMonitor
  } = deps;

  // ── 图库（reserved2）：按需取图发送 ────────────────────────────────
  // 发图预检：毫秒级告知「会立刻发」还是「要现拉等一会儿」。
  // 模型先调这个，就能在要等的时候先回一句「等我找找」再发图，避免闷头等十几秒。
  if (req.method === 'GET' && url.pathname === '/api/socialV2/image-preflight') {
    const key = String(url.searchParams.get('key') ?? '').trim();
    if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
    if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
    if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
    if (req.headers['x-agent-token'] && !v2ToolEnabled('sendImage')) { sendJson({ ok: false, error: '工具未启用：qq_send_image' }, 403); return; }
    const rawTags = url.searchParams.get('tags') ?? '';
    const tags = rawTags ? rawTags.split(/[,，\s]+/).map((t) => t.trim()).filter(Boolean) : [];
    const rawSources = url.searchParams.get('sources') ?? '';
    const pf = imagePreflightV2(tags, rawSources, key);
    const gate = imageSendAllowed(key);
    // 已发图会被定期删除，所以「本地有」= 有**没发过的**图。
    // 这里把 TTL 说清楚，避免模型以为"本地永远有"而误判等待时间。
    const ttlMin = Math.round((Number(cfg.socialV2?.images?.sentTtlMs) || 0) / 60000);
    const srcFilter = normalizeSourceFilter(rawSources);
    sendJson({
      ok: true,
      key,
      tags,
      ...(srcFilter.requested ? { sources: srcFilter.valid } : {}),
      // 说明这个源限制是哪来的：模型自己传的，还是桥接从群主的话里识别的。
      // 后者要告诉模型，免得它以为"怎么只有一个站的图"。
      ...(srcFilter.requested && !normalizeSourceFilter(rawSources).requested
        ? { sourcesNote: `图源限制来自群主的话（${srcFilter.valid.join('/') || srcFilter.unavailable.join('/')}），桥接已自动应用，发图时不用重复传 sources。` }
        : {}),
      ...pf,
      sendAllowed: gate.ok,
      ...(gate.ok ? {} : { sendBlockedReason: gate.error }),
      ...(ttlMin > 0 ? { sentTtlMinutes: ttlMin } : {}),
      // 指定的源不可用时要说清楚，否则模型/群主不明白为什么查不到
      ...(srcFilter.unavailable.length ? { unavailableSources: srcFilter.unavailable } : {}),
      advice: srcFilter.requested && !srcFilter.valid.length
        ? `群主要求的图源（${srcFilter.unavailable.join('/')}）当前不可用，所以查不到任何图（也不会退回其他站点，因为那不符合要求）。可用图源：${Object.entries(cfg.socialV2?.images?.sources ?? {}).filter(([, v]) => v?.enabled === true).map(([k]) => k).join('/') || '无'}。请告诉群主这个站点目前用不了。`
        : pf.willWait
          ? `本地没有匹配的图（发过的图会在 ${ttlMin > 0 ? `${ttlMin} 分钟后被清理` : '下次清理时移除'}，所以库里主要是不重复的新图），这次发图需要现去图站拉取（可能 5~30 秒）${srcFilter.valid.length ? `，且只会在 ${srcFilter.valid.join('/')} 上找` : ''}。建议先用 qq_send_message 回一句（例如「等我找找」）再调用 qq_send_image，这样不会让对方干等；拉取期间你无法回应新消息。`
          : `本地有 ${pf.count} 张匹配的图${srcFilter.valid.length ? `（仅统计 ${srcFilter.valid.join('/')}）` : ''}，会立刻发出（约 0.1 秒），可以直接调用 qq_send_image。`
    });
    return;
  }
  // ── 按需拉取 X（Twitter）帖子并直接发到当前会话 ─────────────────────
  // 由 MCP 工具 qq_fetch_x_posts 调用：群友点名要看某个 X 账号的帖子时触发。
  // 参数：handle（账号，可带 @）、count（条数）、date（YYYY-MM-DD 指定某天）、
  //       lastHours（最近 N 小时）。拉取 → 翻译 → 渲染成卡片 → 发图。
  // X 登录凭据自检：查 state/x-auth.json 是否可用、能否连上 X（不泄露凭据值）。
  // 凭据会因改密码/登出而失效，出问题时先打这个端点定位。
  if (req.method === 'POST' && url.pathname === '/api/socialV2/x-auth-check') {
    if (req.headers['x-agent-token']) { sendJson({ ok: false, error: '该接口仅控制台可用' }, 403); return; }
    if (!xMonitor) { sendJson({ ok: false, error: 'X 插件未加载（plugins/x-posts）' }, 503); return; }
    const st = xMonitor.describeAuth();
    if (!st.available) { sendJson({ ok: false, ...st, hint: '按记忆 x-monitor 登录态的说明取 auth_token/ct0 写入 state/x-auth.json' }); return; }
    // 真的发一次请求验证（凭据存在≠有效）
    try {
      const probe = await xMonitor.verifyAuth();
      sendJson({ ok: probe.ok, ...st, ...probe });
    } catch (e) {
      sendJson({ ok: false, ...st, error: `自检失败：${e?.message ?? e}` });
    }
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/socialV2/fetch-x-posts') {
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    const handleRaw = String(body.handle ?? '').trim();
    if (!key || !handleRaw) { sendJson({ ok: false, error: 'key 和 handle 不能为空' }, 400); return; }
    if (!/^(group|private):\d+$/.test(key)) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
    if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
    if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
    // P0 内容安全止血：即使旧 MCP 会话仍能看到工具，桥接也必须在拉取前拒绝。
    // 这里不能只依赖 MCP 注册时的开关——工具注册发生在 DSH 启动时，配置改动不会热生效。
    if (!v2ToolEnabled('fetchXPosts')) {
      sendJson({ ok: false, error: 'X 帖子转发已临时关闭' }, 403);
      return;
    }
    if (!xMonitor) { sendJson({ ok: false, error: 'X 插件未加载（plugins/x-posts）' }, 503); return; }

    const account = handleRaw.replace(/^@/, '').trim();
    if (!/^[A-Za-z0-9_]{1,15}$/.test(account)) {
      sendJson({ ok: false, error: `账号名不合法：${handleRaw}（X 账号只能含字母/数字/下划线，最多 15 位）` }, 400);
      return;
    }

    const count = Math.max(1, Math.min(5, Number(body.count) || 1));
    // 时间条件三选一：date（某一天）/ lastHours（最近 N 小时）/ 默认（最新几条）
    let sinceMs = 0;
    let untilMs = 0;
    let rangeNote = '';
    if (body.date) {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(body.date).trim());
      if (!m) { sendJson({ ok: false, error: 'date 格式应为 YYYY-MM-DD' }, 400); return; }
      const start = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0);
      const end = new Date(start.getTime() + 24 * 3600 * 1000);
      sinceMs = start.getTime();
      untilMs = end.getTime();
      rangeNote = `${m[1]}-${m[2]}-${m[3]} 当天`;
    } else if (Number(body.lastHours) > 0) {
      const h = Math.min(24 * 30, Number(body.lastHours));
      sinceMs = Date.now() - h * 3600 * 1000;
      rangeNote = `最近 ${h} 小时`;
    }
    // 未来日期：直接拒绝（避免空转一圈）
    if (sinceMs && sinceMs > Date.now()) {
      sendJson({ ok: false, error: `指定的时间还没到（${String(body.date ?? '')}），换个日期或说“最新”` }, 400);
      return;
    }

    log(`[x-monitor] 按需拉取 @${account}（${rangeNote || '最新'}，${count} 条）→ ${key}${body.dryRun === true ? '（干跑）' : ''}`);
    let result;
    try {
      result = await xMonitor.fetchAndRender(account, { count, sinceMs, untilMs });
    } catch (e) {
      sendJson({ ok: false, error: `拉取失败：${e?.message ?? e}` }, 500);
      return;
    }

    if (!result.ok) {
      // 400 而非 404：「那天没发帖 / 翻不到那么远」是查询条件没有结果，
      // 不是接口不存在。404 会让调用方误以为是路由问题。
      sendJson({
        ok: false,
        error: result.errors.join('；') || '没有拉到帖子',
        user: result.user,
        fetched: 0,
        oldestMs: result.oldestMs || 0
      }, 400);
      return;
    }

    // 发图（每张一条消息，与真人发图节奏一致）
    // dryRun：只拉取+渲染、不发送。排障时用，避免测试消息打扰群（踩过：以为传 send:false
    // 能拦住，实际端点不认这个参数，结果真发到群里了）。
    const dryRun = body.dryRun === true;
    let sentCount = 0;
    let sentVideos = 0;
    const sendErrors = [];
    for (const item of result.posts) {
      if (dryRun) break;
      try {
        const dir = path.join(STATE_DIR, 'x-monitor');
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `x-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.png`);
        fs.writeFileSync(file, item.image.buffer);
        try {
          await onebotSendImageFile(key, file, { post: item.post });
        } finally {
          setTimeout(() => { try { fs.unlinkSync(file); } catch {} }, 60000).unref?.();
        }
        sentCount += 1;
        await sleep(700);   // 多条之间留点间隔，避免像刷屏
      } catch (e) {
        sendErrors.push(`${item.post.id}: ${e?.message ?? e}`);
      }
      // 视频必须**单独一条消息**发（SnowLuma 的 assertVideoSendPolicy：
      // video 段必须唯一且是消息里唯一的段），所以放在卡片之后另发，不与文字/图片同条。
      if (item.video?.file) {
        try {
          await sleep(500);
          await onebotSendVideoFile(key, item.video.file, { post: item.post });
          sentVideos += 1;
          await sleep(700);
        } catch (e) {
          sendErrors.push(`${item.post.id} 视频: ${e?.message ?? e}`);
        }
      }
    }

    const skippedNote = result.videoSkipped?.length
      ? `；跳过 ${result.videoSkipped.length} 个超限视频（${result.videoSkipped.map((v) => v.reason).join('；')}）`
      : '';
    log(`[x-monitor] @${account} 拉取完成：${dryRun ? `干跑（未发送）${result.posts.length} 条` : `发出 ${sentCount}/${result.posts.length} 张图、${sentVideos} 个视频`}${skippedNote}${sendErrors.length ? `，失败 ${sendErrors.length}` : ''}`);
    sendJson({
      ok: dryRun ? result.posts.length > 0 : sentCount > 0,
      dryRun: dryRun || undefined,
      user: result.user,
      fetched: result.posts.length,
      sent: sentCount,
      sentVideos,
      videoSkipped: result.videoSkipped ?? [],
      posts: result.posts.map((p) => ({
        id: p.post.id,
        url: p.post.url,
        createdAt: p.post.createdAt,
        createdAtMs: p.post.createdAtMs,
        pinnedSkipped: result.pinnedSkipped,
        hasVideo: !!p.video,
        videoBytes: p.video?.bytes ?? 0,
        videoSize: p.video ? `${p.video.width}x${p.video.height}` : '',
        videoDurationMs: p.video?.durationMs ?? 0,
        summary: String(p.post.text || '').replace(/\s+/g, ' ').slice(0, 120)
      })),
      errors: [...result.errors, ...sendErrors].slice(0, 5)
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/socialV2/send-image') {
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
    if (deps.live.currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
    if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'reserved2 模式发图必须携带 agent token' }, 403); return; }
    if (!agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
    if (!v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
    if (!v2ToolEnabled('sendImage')) { sendJson({ ok: false, error: '工具未启用：qq_send_image' }, 403); return; }
    if (socialV2.paused) { sendJson({ ok: false, error: '二代 AI 已暂停，不能发图' }, 403); return; }
    if (deps.ops.isTokenFused?.(key)) { sendJson({ ok: false, error: '会话已触发 Token 熔断，自动发送已停止；请先在控制台解除熔断' }, 403); return; }
    const keyMatch = /^(group|private):(\d+)$/.exec(key);
    if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
    const kind = keyMatch[1];
    const id = Number(keyMatch[2]);
    if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, deps.live.currentMode)) {
      sendJson({ ok: false, error: '当前模式不允许操作该会话' }, 403);
      return;
    }
    if (shouldBlockSilentReply(key)) { sendJson({ ok: false, error: '静默模式已开启，当前不允许发图' }, 403); return; }
    const tags = Array.isArray(body.tags) ? body.tags.map(String) : (body.tags ? String(body.tags).split(/[,，\s]+/) : []);
    // mode → 排序与时间窗。「日榜」用 age:<2day + order:score 近似
    // （图站没有真正的 pixiv 式日榜；近两日按热度是最接近的语义）。
    const modeMap = {
      hot: { order: 'score', maxAgeDays: 0 },
      daily: { order: 'score', maxAgeDays: 2 },
      new: { order: 'new', maxAgeDays: 0 },
      random: { order: 'random', maxAgeDays: 0 }
    };
    const mode = modeMap[String(body.mode ?? 'hot')] ?? modeMap.hot;
    try {
      const r = await sendImageV2(key, { tags, replyToMessageId: body.replyToMessageId, sources: body.sources, ...mode });
      const st = getSocialV2State(key);
      // 记入会话时间线，让 AI 与后续上下文知道「我刚发了张图」
      st.recentMessages.push({
        messageId: null,
        sender: '我',
        text: `[图片] 已发送一张图（${r.entry.source}${r.entry.artist ? ' / ' + r.entry.artist : ''}）`,
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
      st.wakeConfig.noActionCount = 0;
      saveSocialV2State();
      log(`[图库] 工具发图 ${key}：${r.entry.id}`);
      appendActivity(`${key} [图库] 已发送图片（${r.entry.source}）`);
      // tagCorrections：告知调用方「你要的词被换成了别的标签」。
      // 模型据此自查：若换后的标签跨了作品/角色，应主动说明或更正，别当查到了就完事。
      sendJson({
        ok: true,
        key,
        source: r.entry.source,
        artist: r.entry.artist,
        page: r.entry.page,
        annotation: r.annotation,
        ...(r.tagCorrections?.length
          ? {
              tagCorrections: r.tagCorrections.map((c) => `${c.from} → ${c.to}（${c.postCount} 张）`),
              notice: `注意：你给的标签「${r.tagCorrections.map((c) => c.from).join('、')}」在上游不存在，已自动改用「${r.tagCorrections.map((c) => c.to).join('、')}」。如果这与你想要的角色/作品不符（例如名字相近但是不同作品），请告诉群友你实际发的是什么，别默认它就是要的那张。`
            }
          : {})
      });
    } catch (error) {
      log(`[图库] 工具发图失败 ${key}: ${error?.message ?? error}`);
      sendJson({ ok: false, error: `${error?.message ?? error}` }, 500);
    }
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/socialV2/archive-image') {
    const body = await readBody();
    // 同 refresh-image-lib 的鉴权：管理员可直接调，AI 必须带合法 agent token。
    let allowed = !req.headers['x-agent-token'];
    let vkey = '';
    if (req.headers['x-agent-token']) {
      vkey = String(body.key ?? '').trim();
      allowed = !!vkey && agentTokenOk(vkey, req.headers['x-agent-token']) && v2SessionAllowed(vkey) && v2ToolEnabled('archiveImage');
    }
    if (!allowed) { sendJson({ ok: false, error: '无权收藏图片' }, 403); return; }
    if (!imagesEnabled()) { sendJson({ ok: false, error: '图库未启用' }, 403); return; }
    // 目标：显式 id，或本会话「最近发出的那张」
    let entry = null;
    const wantId = String(body.id ?? '').trim();
    if (wantId) entry = imageStore.getById(wantId);
    if (!entry && vkey) {
      const last = lastSentImage.get(vkey);
      if (last) entry = imageStore.getById(last.id) ?? last.entry ?? null;
    }
    if (!entry) { sendJson({ ok: false, error: wantId ? `图库中没有 ${wantId}` : '未指定 id，且本会话最近没发过图' }, 404); return; }
    try {
      const r = await archiveImage(entry);
      log(`[图库] 已收藏原图 ${entry.id} → ${r.path}（${(r.bytes / 1024).toFixed(0)}KB${r.skipped ? '，此前已存过' : ''}）`);
      appendActivity(`${vkey || 'admin'} [图库] 收藏原图 ${entry.id}（${(r.bytes / 1024).toFixed(0)}KB）`);
      sendJson({
        ok: true,
        id: entry.id,
        path: r.path,
        originalUrl: r.url,
        bytes: r.bytes,
        alreadySaved: !!r.skipped,
        note: r.skipped
          ? `此前已收藏过，文件在 ${r.path}`
          : `已把原图保存到 ${r.path}（${(r.bytes / 1024).toFixed(0)}KB）`
      });
    } catch (error) {
      log(`[图库] 收藏原图失败 ${entry.id}: ${error?.message ?? error}`);
      sendJson({ ok: false, id: entry.id, error: `收藏失败：${error?.message ?? error}` }, 500);
    }
    return;
  }
  // 反向搜图（以图搜图）：拿一张图去 SauceNAO 反查出处（谁画的、来自哪个站）。
  // 参数：messageId（群友发的那条消息，取其图）或 id（图库里某张）；两者都没有则用
  // 本会话「最近发出的那张」。与 /image-source 的区别：那个只查**图库已有条目**的元数据，
  // 这个能对**任意一张图**做全站反查（含群友发的外来图）。
  if (req.method === 'GET' && url.pathname === '/api/socialV2/reverse-search') {
    const key = String(url.searchParams.get('key') ?? '').trim();
    if (key && req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
    if (key && req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
    if (key && req.headers['x-agent-token'] && !v2ToolEnabled('reverseSearch')) { sendJson({ ok: false, error: '工具未启用：qq_reverse_search' }, 403); return; }
    if (cfg.imageReverseSearch?.enabled === false) { sendJson({ ok: false, error: '反向搜图已关闭（imageReverseSearch.enabled）' }, 403); return; }
    const avail = reverseSearcher.available();
    if (!avail.ok) { sendJson({ ok: false, error: avail.reason, needKey: true }, 400); return; }

    const wantMsgId = String(url.searchParams.get('messageId') ?? '').trim();
    const wantId = String(url.searchParams.get('id') ?? '').trim();
    let buffer = null;
    let from = '';
    if (wantMsgId && key) {
      const media = await findMessageMediaAsync(key, wantMsgId);
      if (!media.length) { sendJson({ ok: false, error: '这条消息里没有图片/表情' }, 404); return; }
      const imgs = await fetchMediaData(media.slice(0, 1));
      const first = imgs.find((x) => x?.data);
      if (!first) { sendJson({ ok: false, error: '图片读取失败（可能已过期或取不到原图）' }, 404); return; }
      buffer = Buffer.from(first.data, 'base64');
      from = `消息 ${wantMsgId}`;
    } else {
      let entry = wantId ? imageStore.getById(wantId) : null;
      if (!entry && key) {
        const last = lastSentImage.get(key);
        if (last) entry = imageStore.getById(last.id) ?? last.entry ?? null;
      }
      if (!entry) { sendJson({ ok: false, error: wantId ? `图库中没有 ${wantId}` : '请给 messageId（群友发的图）或 id（图库图）' }, 404); return; }
      buffer = imageStore.readBuffer(entry);
      if (!buffer) { sendJson({ ok: false, error: '图库文件读取失败' }, 500); return; }
      from = `图库 ${entry.id}`;
    }

    const r = await reverseSearcher.search(buffer, {
      db: Number(cfg.imageReverseSearch?.db) || 999,
      minsim: Number(cfg.imageReverseSearch?.minsim) || 50,
      numres: Number(cfg.imageReverseSearch?.numres) || 5
    });
    if (!r.ok) { sendJson({ ok: false, error: r.error }, r.quota ? 429 : 502); return; }
    const top = r.results?.[0];
    sendJson({
      ok: true,
      from,
      cached: !!r.cached,
      count: r.results.length,
      results: r.results,
      note: top
        ? `最匹配：${top.site || '未知站点'}（相似度 ${top.similarity.toFixed(1)}%）`
          + (top.creator ? `，作者 ${top.creator}` : '')
          + (top.urls?.length ? `，出处 ${top.urls[0]}` : '')
        : '没找到相似度足够高的来源（可能是原创/改图/冷门作品）',
      stats: reverseSearcher.stats()
    });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/socialV2/image-source') {
    const key = String(url.searchParams.get('key') ?? '').trim();
    if (key && req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
    if (key && req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
    if (key && req.headers['x-agent-token'] && !v2ToolEnabled('imageSource')) { sendJson({ ok: false, error: '工具未启用：qq_image_source' }, 403); return; }
    // 目标：显式给 id，或用本会话「最近发出的那张」（模型通常不知道图库 id）
    let entry = null;
    const wantId = String(url.searchParams.get('id') ?? '').trim();
    if (wantId) entry = imageStore.getById(wantId);
    if (!entry && key) {
      const last = lastSentImage.get(key);
      if (last) entry = imageStore.getById(last.id) ?? last.entry ?? null;
    }
    if (!entry) {
      sendJson({ ok: false, error: wantId ? `图库中没有 ${wantId}` : '本会话最近没有发出过图，也请传 id' }, 404);
      return;
    }
    const sp = sourcePageOf(entry);
    sendJson({
      ok: true,
      id: entry.id,
      source: entry.source || '',
      artist: entry.artist || '',
      artistId: entry.artistId || '',
      // originUrl：画师原始发布处；sourcePage：图源站条目页
      originUrl: entry.page || '',
      sourcePage: sp,
      tags: Array.isArray(entry.tags) ? entry.tags.slice(0, 40) : [],
      rating: entry.rating || '',
      width: entry.width || 0,
      height: entry.height || 0,
      note: sp
        ? `这是在 ${entry.source} 上查这张图的页面：${sp}${entry.page && entry.page !== sp ? `；画师原始发布处：${entry.page}` : ''}`
        : '该图没有可推导的图源站点页面'
    });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/socialV2/react-message') {
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
    // 鉴权同 send-image：reserved2 下 AI 必须带 agent token
    if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'reserved2 模式贴表情必须携带 agent token' }, 403); return; }
    if (!agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
    if (!v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
    if (!v2ToolEnabled('reactMessage')) { sendJson({ ok: false, error: '工具未启用：qq_react_message' }, 403); return; }
    if (cfg.socialV2?.emojiReact?.enabled === false) { sendJson({ ok: false, error: '贴表情功能已关闭（socialV2.emojiReact.enabled）' }, 403); return; }
    if (socialV2.paused) { sendJson({ ok: false, error: '二代 AI 已暂停，不能贴表情' }, 403); return; }
    if (deps.ops.isTokenFused?.(key)) { sendJson({ ok: false, error: '会话已触发 Token 熔断，自动操作已停止；请先在控制台解除熔断' }, 403); return; }
    const keyMatch = /^(group|private):(\d+)$/.exec(key);
    if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
    const kind = keyMatch[1];
    const convId = Number(keyMatch[2]);
    if (!Number.isFinite(convId) || convId <= 0 || !modeAllowed(key, kind, convId, cfg, deps.live.currentMode)) {
      sendJson({ ok: false, error: '当前模式不允许操作该会话' }, 403);
      return;
    }
    // QQ 的表情回应**只支持群聊**（实测私聊报 "emoji reactions are not supported
    // on private messages"）。提前拦掉并说清原因，别让模型以为是自己参数错了。
    if (kind !== 'group') {
      sendJson({ ok: false, error: 'QQ 的表情回应只支持群消息，私聊不支持（这不是参数问题，无需重试）' }, 400);
      return;
    }
    const rawId = String(body.messageId ?? body.id ?? '').trim();
    if (!rawId) { sendJson({ ok: false, error: 'messageId 不能为空（用 qq_get_unread_messages 里的 messageId）' }, 400); return; }
    const emojiId = String(body.emojiId ?? '').trim();
    const v = validateEmojiId(emojiId, emojiCatalogIds());
    if (!v.ok) {
      sendJson({ ok: false, error: v.reason, ...(v.hint ? { hint: v.hint } : {}) }, 400);
      return;
    }
    const set = body.set !== false; // 默认贴；传 set:false 撤销
    // 限流：模型可能一时兴起连贴一串。撤销不计入限流（那是修正行为）。
    if (set) {
      const gate = emojiReactGate.check(key);
      if (!gate.allow) { sendJson({ ok: false, error: gate.reason, rateLimited: true }, 429); return; }
    }
    const ok = await setEmojiLike(convId, rawId, emojiId, set);
    if (!ok) {
      sendJson({ ok: false, error: '贴表情失败（消息可能太旧、已不在 QQ 消息缓存里；请对较新的消息贴）' }, 502);
      return;
    }
    const named = REACTION_EMOJIS.find((e) => String(e.id) === emojiId);
    log(`[表情] ${key} ${set ? '贴了' : '撤销了'}「${named?.name || emojiId}」（msg ${rawId}）`);
    appendActivity(`${key} [表情] ${set ? '贴' : '撤销'}${named?.name || emojiId}`);
    sendJson({ ok: true, key, messageId: rawId, emojiId, emojiName: named?.name || '', set });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/socialV2/reject-image') {
    const body = await readBody();
    // 同 refresh-image-lib 的鉴权：管理员可直接调，AI 必须带合法 agent token。
    let allowed = !req.headers['x-agent-token'];
    let vkey = '';
    if (req.headers['x-agent-token']) {
      vkey = String(body.key ?? '').trim();
      allowed = !!vkey && agentTokenOk(vkey, req.headers['x-agent-token']) && v2SessionAllowed(vkey) && v2ToolEnabled('rejectImage');
    }
    if (!allowed) { sendJson({ ok: false, error: '无权删除图库图片' }, 403); return; }
    if (!imagesEnabled()) { sendJson({ ok: false, error: '图库未启用' }, 403); return; }
    // 目标：显式给 id；不传则用本会话「最近发出的那张」（AI 通常不知道图库 id）
    let targetId = String(body.id ?? '').trim();
    if (!targetId && vkey) targetId = lastSentImage.get(vkey)?.id ?? '';
    if (!targetId) { sendJson({ ok: false, error: '没有可删除的目标（未指定 id，且本会话最近没发过图）' }, 400); return; }
    const r = imageStore.reject(targetId, { reason: String(body.reason ?? 'AI 判定不合适') });
    if (vkey && lastSentImage.get(vkey)?.id === targetId) lastSentImage.delete(vkey);
    log(`[图库] 删除并拒绝 ${targetId}（${r.existed ? '已从库中移除' : '条目原本不在库'}，原因：${body.reason ?? '未说明'}）`);
    appendActivity(`${vkey || 'admin'} [图库] 删除图 ${targetId}（${String(body.reason ?? '').slice(0, 30)}）`);
    sendJson({ ok: true, id: targetId, removed: r.existed, freedBytes: r.freedBytes ?? 0, note: '该图已加入拒绝名单，之后不会再被拉取或发出' });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/socialV2/image-stats') {
    const key = String(url.searchParams.get('key') ?? '').trim();
    if (key && req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
    sendJson({
      ok: true,
      enabled: imagesEnabled(),
      libDir: imageStore.libDir,
      ...imageStore.stats(),
      fetchedAt: deps.live.imageFetchedAt || null,
      sources: Object.fromEntries(
        Object.entries(cfg.socialV2?.images?.sources ?? {}).map(([n, c]) => [n, { enabled: c?.enabled === true, limit: c?.limit ?? 20 }])
      )
    });
    return;
  }
  // ── 取图额度总览（控制台「12c 取图额度」卡片）──────────────────────
  //
  // 用户要求（2026-10-20）：「取图 API 额度能不能在控制台中加一个显示」。
  //
  // 这里把**三类互相独立的上限**放在一起，因为它们都会以"取不到图"的形式
  // 表现，但原因完全不同，混在一起排查会走错方向：
  //   ① 图库容量（maxFiles / maxTotalBytes）——满了会淘汰旧图，不代表不能用
  //   ② 拉取冷却（cooldownMs）——两次"补货"之间的最小间隔，冷却中预检会 willWait
  //   ③ SauceNAO 反查额度（每天 100 次 / 30 秒 1 次）——**真正的上游免费额度**，
  //      用完了当天就没法反查（这是唯一"会真的用完"的）
  // 另外附各图源的启用状态，因为"某个源没开"也会被误当成额度问题。
  if (req.method === 'GET' && url.pathname === '/api/socialV2/image-quota') {
    const ic = cfg.socialV2?.images ?? {};
    const now = Date.now();
    const enabled = imagesEnabled();

    // 图库容量
    let lib = null;
    try { lib = imageStore.stats(); } catch { lib = null; }

    // 拉取冷却：imageFetchedAt 是"上次成功拉取"的时刻
    const cooldownMs = Math.max(0, Number(ic.cooldownMs) || 0);
    const sinceFetch = deps.live.imageFetchedAt ? now - deps.live.imageFetchedAt : Infinity;
    const cooling = cooldownMs > 0 && deps.live.imageFetchedAt > 0 && sinceFetch < cooldownMs;

    // 反查额度（唯一真正的"API 额度"）
    const rs = reverseSearcher.stats();

    // 各图源开关：pixiv/yandere 默认关，容易和"额度用完"混淆
    const srcCfg = ic.sources ?? {};
    const sources = Object.keys(srcCfg).map((name) => ({
      name,
      enabled: srcCfg[name]?.enabled === true,
      limit: Number(srcCfg[name]?.limit) || 0,
      hasProxy: !!String(srcCfg[name]?.proxy || ic.proxy || '').trim()
    }));

    // 每会话发送限频（同会话冷却 / 每小时上限）——也不是"额度"，但会拦发图
    sendJson({
      ok: true,
      enabled,
      library: lib,
      fetch: {
        cooldownMs,
        lastFetchedAt: deps.live.imageFetchedAt || 0,
        cooling,
        remainMs: cooling ? Math.max(0, cooldownMs - sinceFetch) : 0,
        fetching: !!deps.live.imageFetching,
        fetchPerRun: Math.max(1, Number(ic.fetchPerRun) || 20)
      },
      reverseSearch: {
        hasKey: rs.hasKey,
        usedToday: rs.usedToday,
        dailyMax: rs.dailyMax,
        remainingToday: rs.remainingToday,
        windowMax: rs.windowMax,
        windowUsed: rs.windowUsed,
        windowResetMs: rs.windowResetMs,
        cached: rs.cached
      },
      send: {
        cooldownMs: Math.max(0, Number(ic.sendCooldownMs) || 0),
        maxSendPerHour: Math.max(0, Number(ic.maxSendPerHour) || 0)
      },
      sources
    });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/socialV2/refresh-image-lib') {
    const body = await readBody();
    // 管理员可直接刷；AI 必须带合法 agent token（允许它自己按需补图，但受限频）。
    let allowed = !req.headers['x-agent-token'];
    if (req.headers['x-agent-token']) {
      const key = String(body.key ?? '').trim();
      allowed = !!key && agentTokenOk(key, req.headers['x-agent-token']) && v2SessionAllowed(key) && v2ToolEnabled('refreshImageLib');
    }
    if (!allowed) { sendJson({ ok: false, error: '无权刷新图库' }, 403); return; }
    if (!imagesEnabled()) { sendJson({ ok: false, error: '图库未启用：请在 config.json 设置 socialV2.images.enabled=true' }, 403); return; }
    try {
      const r = await refreshImageLib({
        force: body.force === true && !req.headers['x-agent-token'],
        tags: Array.isArray(body.tags) ? body.tags.map(String) : undefined,
        order: body.order,
        maxAgeDays: body.maxAgeDays,
        limit: body.limit,
        sources: Array.isArray(body.sources) ? body.sources.map(String) : undefined
      });
      if (r.cooled) {
        sendJson({ ok: true, cooled: true, remainMs: r.remainMs, total: imageStore.count() });
      } else {
        sendJson({ ok: true, added: r.added, skipped: r.skipped, total: r.total, errors: (r.errors ?? []).slice(0, 5) });
      }
    } catch (error) {
      sendJson({ ok: false, error: `${error?.message ?? error}` }, 500);
    }
    return;
  }
  // ── 表情包体系（reserved2） ──────────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/api/socialV2/sticker-image') {
    if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
    const key = String(url.searchParams.get('key') ?? '').trim();
    const stickerId = String(url.searchParams.get('stickerId') ?? '').trim();
    if (!key || !stickerId) { sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400); return; }
    if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
    if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
    if (req.headers['x-agent-token'] && !v2ToolEnabled('getStickerImage')) { sendJson({ ok: false, error: '工具未启用：qq_get_sticker_image' }, 403); return; }
    try {
      const entry = await getStickerImageData(stickerId);
      const fetched = await safeFetchBuffer(entry.url, MAX_MEDIA_BYTES);
      const dims = getImageDimensions(fetched.buffer);
      if (dims && dims.width * dims.height > MAX_MEDIA_PIXELS) {
        sendJson({ ok: false, error: `表情图片像素超限（${dims.width}x${dims.height}），已拒绝` }, 400);
        return;
      }
      const mimeType = mimeFromBuffer(fetched.buffer) || mimeFromUrl(entry.url);
      try { writeStickerCacheImage(STICKER_CACHE_DIR, entry, fetched.buffer, { mimeType, width: dims?.width, height: dims?.height }); } catch { /* 图片缓存失败不影响看图 */ }
      sendJson({
        ok: true,
        key,
        sticker: {
          id: entry.id,
          desc: entry.desc || '',
          localNote: entry.localNote || '',
          tags: entry.tags || [],
          url: entry.url,
          md5: entry.md5
        },
        image: { mimeType, data: fetched.buffer.toString('base64') }
      });
    } catch (error) {
      sendJson({ ok: false, error: `获取表情图片失败：${error?.message ?? error}` }, 500);
    }
    return;
  }
  if ((req.method === 'GET' || req.method === 'POST') && url.pathname === '/api/socialV2/self-image') {
    if (req.method === 'GET' && url.searchParams.has('publish')) {
      sendJson({ ok: false, error: 'GET 仅用于预览；发布形象图必须使用 POST' }, 405);
      return;
    }
    const body = req.method === 'POST' ? await readBody() : {};
    const key = String(req.method === 'POST' ? body.key : url.searchParams.get('key') ?? '').trim();
    if (!/^(group|private):\d+$/.test(key)) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
    const agentToken = req.headers['x-agent-token'];
    if (req.method === 'POST' && !agentToken) { sendJson({ ok: false, error: '发布形象图必须携带 agent token' }, 403); return; }
    if (agentToken && !agentTokenOk(key, agentToken)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
    if (agentToken && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
    if (agentToken && !v2ToolEnabled('getSelfImage')) { sendJson({ ok: false, error: '工具未启用：qq_get_self_image' }, 403); return; }
    // publish：**顺便把形象图发到当前会话**（用户要求「别人问及自拍时把自拍图片一并发出去」）。
    //
    // 为什么由桥接发、而不是让模型再调一次 qq_send_image：
    //   qq_send_image 只会从图库里挑图，拿不到这张本地形象图；
    //   而且分两步会让模型「看了图却忘了发」，或被问「发张自拍」时只描述长相。
    //   一次做完「放进视觉上下文 + 发到群里」才是能用的语义。
    const publish = req.method === 'POST' && body.publish !== false;
    const selfPath = path.join(ROOT, 'assets', 'deepseek娘.png');
    try {
      if (!fs.existsSync(selfPath)) { sendJson({ ok: false, error: '未找到 AI 形象图片 assets/deepseek娘.png' }, 404); return; }
      const buf = fs.readFileSync(selfPath);
      const mimeType = mimeFromBuffer(buf) || 'image/png';
      const image = { mimeType, data: buf.toString('base64') };

      // 发图前照例过一遍准入与静默：不能因为「是自拍」就绕过暂停/静默/模式限制
      let sent = null;
      let sendError = '';
      if (publish) {
        if (deps.live.currentMode !== 'reserved2') {
          sendError = '该接口仅 reserved2 模式可用';
        } else if (cfg.socialV2?.enabled === false) {
          sendError = '二代模式已关闭，不能发图';
        } else if (socialV2.paused) {
          sendError = '二代 AI 已暂停，不能发图';
        } else if (shouldBlockSilentReply(key)) {
          sendError = '静默模式已开启，当前不允许发图';
        } else {
          try {
            const r = await onebotSendImageFile(key, buf, { label: '［自拍］' });
            sent = r?.message_id ?? true;
            // 记进会话时间线：模型与后续上下文要知道"我刚发了张自拍"
            const st = getSocialV2State(key);
            st.recentMessages.push({
              messageId: null,
              sender: '我',
              text: '[图片] 发了张自己的形象图',
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
            st.wakeConfig.noActionCount = 0;
            saveSocialV2State();
            appendActivity(`${key} [自拍] 已发送形象图`);
            log(`[自拍] 已发送形象图 → ${key}`);
          } catch (error) {
            // 发失败不算致命：图仍然给模型（它至少能照着描述），但要如实告知
            sendError = String(error?.message ?? error);
            log(`[自拍] 发送失败 ${key}：${sendError}`);
          }
        }
      }

      sendJson({
        ok: true,
        key,
        image,
        published: publish,
        sent: sent || undefined,
        // 没发出去时给模型一句可转述的话，避免它以为已经发了
        sendError: sendError || undefined
      });
    } catch (error) {
      sendJson({ ok: false, error: `读取 AI 形象图片失败：${error?.message ?? error}` }, 500);
    }
    return;
  }
}
