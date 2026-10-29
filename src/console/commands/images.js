// R4.7-3：图片领域写命令（发图/收藏/反查/贴表情/拒绝/刷新/表情图/自拍/X 帖子）。
//
// 这些端点原先在路由里直接摸 40+ 项依赖并自己拼发送闸门。收进命令层后：
//   - 路由只做 agent token / 会话准入 / 工具开关（鉴权层）；
//   - 模式、暂停、熔断、静默、限频等内容/业务闸门在命令层；
//   - 发送后的时间线、活动日志、缓存清理也与发送放在一起。

export function createImagesCommands({
  config = {},
  operations = {},
  sessions = {},
  media = {},
  emoji = {},
  x = {},
  policy = {}
} = {}) {
  const {
    cfg = {},
    ROOT,
    STATE_DIR,
    STICKER_CACHE_DIR,
    MAX_MEDIA_BYTES,
    MAX_MEDIA_PIXELS,
    REACTION_EMOJIS,
    fs,
    path,
    crypto,
    sleep,
    log
  } = config;
  const { live = {}, ops = {}, appendActivity } = operations;
  const { socialV2 = { conversations: new Map() }, getSocialV2State, saveSocialV2State, lastSentImage } = sessions;
  const {
    imageStore,
    imagesEnabled,
    sendImageV2,
    archiveImage,
    reverseSearcher,
    findMessageMediaAsync,
    fetchMediaData,
    onebotSendImageFile,
    onebotSendVideoFile,
    getStickerImageData,
    safeFetchBuffer,
    getImageDimensions,
    mimeFromBuffer,
    mimeFromUrl,
    writeStickerCacheImage,
    stickerEnabled,
    refreshImageLib
  } = media;
  const { emojiCatalogIds, emojiReactGate, setEmojiLike, validateEmojiId } = emoji;
  const { xMonitor } = x;
  const { modeAllowed, shouldBlockSilentReply } = policy;
  const logLine = (message) => { try { log?.(message); } catch { /* 日志失败不影响主流程 */ } };

  // ── 发图（reserved2 工具）────────────────────────────────────────────
  async function sendImage({ key, body = {} } = {}) {
    if (live.currentMode !== 'reserved2') return { ok: false, status: 403, error: '该接口仅 reserved2 模式可用' };
    if (socialV2.paused) return { ok: false, status: 403, error: '二代 AI 已暂停，不能发图' };
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
      return { ok: false, status: 403, error: '静默模式已开启，当前不允许发图' };
    }
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
      saveSocialV2State?.();
      logLine(`[图库] 工具发图 ${key}：${r.entry.id}`);
      appendActivity?.(`${key} [图库] 已发送图片（${r.entry.source}）`);
      // tagCorrections：告知调用方「你要的词被换成了别的标签」。
      return {
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
      };
    } catch (error) {
      logLine(`[图库] 工具发图失败 ${key}: ${error?.message ?? error}`);
      return { ok: false, status: 500, error: `${error?.message ?? error}` };
    }
  }

  // ── 收藏原图 ────────────────────────────────────────────────────────
  async function archive({ key = '', id } = {}) {
    if (!imagesEnabled?.()) return { ok: false, status: 403, error: '图库未启用' };
    let entry = null;
    const wantId = String(id ?? '').trim();
    if (wantId) entry = imageStore?.getById?.(wantId);
    if (!entry && key) {
      const last = lastSentImage?.get(key);
      if (last) entry = imageStore?.getById?.(last.id) ?? last.entry ?? null;
    }
    if (!entry) {
      return {
        ok: false,
        status: 404,
        error: wantId ? `图库中没有 ${wantId}` : '未指定 id，且本会话最近没发过图'
      };
    }
    try {
      const r = await archiveImage(entry);
      logLine(`[图库] 已收藏原图 ${entry.id} → ${r.path}（${(r.bytes / 1024).toFixed(0)}KB${r.skipped ? '，此前已存过' : ''}）`);
      appendActivity?.(`${key || 'admin'} [图库] 收藏原图 ${entry.id}（${(r.bytes / 1024).toFixed(0)}KB）`);
      return {
        ok: true,
        id: entry.id,
        path: r.path,
        originalUrl: r.url,
        bytes: r.bytes,
        alreadySaved: !!r.skipped,
        note: r.skipped
          ? `此前已收藏过，文件在 ${r.path}`
          : `已把原图保存到 ${r.path}（${(r.bytes / 1024).toFixed(0)}KB）`
      };
    } catch (error) {
      logLine(`[图库] 收藏原图失败 ${entry.id}: ${error?.message ?? error}`);
      return { ok: false, status: 500, id: entry.id, error: `收藏失败：${error?.message ?? error}` };
    }
  }

  // ── 反向搜图 ────────────────────────────────────────────────────────
  async function reverseSearch({ key = '', messageId = '', id = '' } = {}) {
    if (cfg.imageReverseSearch?.enabled === false) {
      return { ok: false, status: 403, error: '反向搜图已关闭（imageReverseSearch.enabled）' };
    }
    const avail = reverseSearcher?.available?.();
    if (!avail?.ok) return { ok: false, status: 400, error: avail?.reason, needKey: true };

    const wantMsgId = String(messageId ?? '').trim();
    const wantId = String(id ?? '').trim();
    let buffer = null;
    let from = '';
    if (wantMsgId && key) {
      const mediaItems = await findMessageMediaAsync(key, wantMsgId);
      if (!mediaItems.length) return { ok: false, status: 404, error: '这条消息里没有图片/表情' };
      const imgs = await fetchMediaData(mediaItems.slice(0, 1));
      const first = imgs.find((x) => x?.data);
      if (!first) return { ok: false, status: 404, error: '图片读取失败（可能已过期或取不到原图）' };
      buffer = Buffer.from(first.data, 'base64');
      from = `消息 ${wantMsgId}`;
    } else {
      let entry = wantId ? imageStore?.getById?.(wantId) : null;
      if (!entry && key) {
        const last = lastSentImage?.get(key);
        if (last) entry = imageStore?.getById?.(last.id) ?? last.entry ?? null;
      }
      if (!entry) {
        return {
          ok: false,
          status: 404,
          error: wantId ? `图库中没有 ${wantId}` : '请给 messageId（群友发的图）或 id（图库图）'
        };
      }
      buffer = imageStore?.readBuffer?.(entry);
      if (!buffer) return { ok: false, status: 500, error: '图库文件读取失败' };
      from = `图库 ${entry.id}`;
    }

    const r = await reverseSearcher.search(buffer, {
      db: Number(cfg.imageReverseSearch?.db) || 999,
      minsim: Number(cfg.imageReverseSearch?.minsim) || 50,
      numres: Number(cfg.imageReverseSearch?.numres) || 5
    });
    if (!r.ok) return { ok: false, status: r.quota ? 429 : 502, error: r.error };
    const top = r.results?.[0];
    return {
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
    };
  }

  // ── 贴表情 ──────────────────────────────────────────────────────────
  async function react({ key, body = {} } = {}) {
    if (cfg.socialV2?.emojiReact?.enabled === false) {
      return { ok: false, status: 403, error: '贴表情功能已关闭（socialV2.emojiReact.enabled）' };
    }
    if (socialV2.paused) return { ok: false, status: 403, error: '二代 AI 已暂停，不能贴表情' };
    if (ops.isTokenFused?.(key)) {
      return { ok: false, status: 403, error: '会话已触发 Token 熔断，自动操作已停止；请先在控制台解除熔断' };
    }
    const keyMatch = /^(group|private):(\d+)$/.exec(key);
    if (!keyMatch) return { ok: false, status: 400, error: 'key 格式应为 group:群号 或 private:QQ号' };
    const kind = keyMatch[1];
    const convId = Number(keyMatch[2]);
    if (!Number.isFinite(convId) || convId <= 0 || typeof modeAllowed !== 'function' || !modeAllowed(key, kind, convId, cfg, live.currentMode)) {
      return { ok: false, status: 403, error: '当前模式不允许操作该会话' };
    }
    // QQ 的表情回应**只支持群聊**（实测私聊报 "emoji reactions are not supported
    // on private messages"）。提前拦掉并说清原因，别让模型以为是自己参数错了。
    if (kind !== 'group') {
      return { ok: false, status: 400, error: 'QQ 的表情回应只支持群消息，私聊不支持（这不是参数问题，无需重试）' };
    }
    const rawId = String(body.messageId ?? body.id ?? '').trim();
    if (!rawId) return { ok: false, status: 400, error: 'messageId 不能为空（用 qq_get_unread_messages 里的 messageId）' };
    const emojiId = String(body.emojiId ?? '').trim();
    const v = validateEmojiId?.(emojiId, emojiCatalogIds?.());
    if (!v?.ok) return { ok: false, status: 400, error: v?.reason, ...(v?.hint ? { hint: v.hint } : {}) };
    const set = body.set !== false; // 默认贴；传 set:false 撤销
    // 限流：模型可能一时兴起连贴一串。撤销不计入限流（那是修正行为）。
    if (set) {
      const gate = emojiReactGate?.check?.(key);
      if (!gate?.allow) return { ok: false, status: 429, error: gate?.reason, rateLimited: true };
    }
    const ok = await setEmojiLike(convId, rawId, emojiId, set);
    if (!ok) {
      return { ok: false, status: 502, error: '贴表情失败（消息可能太旧、已不在 QQ 消息缓存里；请对较新的消息贴）' };
    }
    const named = REACTION_EMOJIS?.find?.((e) => String(e.id) === emojiId);
    logLine(`[表情] ${key} ${set ? '贴了' : '撤销了'}「${named?.name || emojiId}」（msg ${rawId}）`);
    appendActivity?.(`${key} [表情] ${set ? '贴' : '撤销'}${named?.name || emojiId}`);
    return { ok: true, key, messageId: rawId, emojiId, emojiName: named?.name || '', set };
  }

  // ── 删除并拒绝图片 ──────────────────────────────────────────────────
  function reject({ key = '', id, reason } = {}) {
    if (!imagesEnabled?.()) return { ok: false, status: 403, error: '图库未启用' };
    let targetId = String(id ?? '').trim();
    if (!targetId && key) targetId = lastSentImage?.get(key)?.id ?? '';
    if (!targetId) {
      return { ok: false, status: 400, error: '没有可删除的目标（未指定 id，且本会话最近没发过图）' };
    }
    const r = imageStore.reject(targetId, { reason: String(reason ?? 'AI 判定不合适') });
    if (key && lastSentImage?.get(key)?.id === targetId) lastSentImage.delete(key);
    logLine(`[图库] 删除并拒绝 ${targetId}（${r.existed ? '已从库中移除' : '条目原本不在库'}，原因：${reason ?? '未说明'}）`);
    appendActivity?.(`${key || 'admin'} [图库] 删除图 ${targetId}（${String(reason ?? '').slice(0, 30)}）`);
    return {
      ok: true,
      id: targetId,
      removed: r.existed,
      freedBytes: r.freedBytes ?? 0,
      note: '该图已加入拒绝名单，之后不会再被拉取或发出'
    };
  }

  // ── 补图 ────────────────────────────────────────────────────────────
  async function refresh({ key = '', body = {}, viaAgent = false } = {}) {
    if (!imagesEnabled?.()) {
      return { ok: false, status: 403, error: '图库未启用：请在 config.json 设置 socialV2.images.enabled=true' };
    }
    try {
      const r = await refreshImageLib({
        force: body.force === true && !viaAgent,
        tags: Array.isArray(body.tags) ? body.tags.map(String) : undefined,
        order: body.order,
        maxAgeDays: body.maxAgeDays,
        limit: body.limit,
        sources: Array.isArray(body.sources) ? body.sources.map(String) : undefined
      });
      if (r.cooled) {
        return { ok: true, cooled: true, remainMs: r.remainMs, total: imageStore.count() };
      }
      return { ok: true, added: r.added, skipped: r.skipped, total: r.total, errors: (r.errors ?? []).slice(0, 5) };
    } catch (error) {
      return { ok: false, status: 500, error: `${error?.message ?? error}` };
    }
  }

  // ── 表情图片 ────────────────────────────────────────────────────────
  async function stickerImage({ key, stickerId } = {}) {
    if (!stickerEnabled?.()) return { ok: false, status: 403, error: '表情包体系已关闭' };
    try {
      const entry = await getStickerImageData(stickerId);
      const fetched = await safeFetchBuffer(entry.url, MAX_MEDIA_BYTES);
      const dims = getImageDimensions(fetched.buffer);
      if (dims && dims.width * dims.height > MAX_MEDIA_PIXELS) {
        return { ok: false, status: 400, error: `表情图片像素超限（${dims.width}x${dims.height}），已拒绝` };
      }
      const mimeType = mimeFromBuffer(fetched.buffer) || mimeFromUrl(entry.url);
      try {
        writeStickerCacheImage?.(STICKER_CACHE_DIR, entry, fetched.buffer, { mimeType, width: dims?.width, height: dims?.height });
      } catch { /* 图片缓存失败不影响看图 */ }
      return {
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
      };
    } catch (error) {
      return { ok: false, status: 500, error: `获取表情图片失败：${error?.message ?? error}` };
    }
  }

  // ── 自拍 / 形象图 ───────────────────────────────────────────────────
  async function selfImage({ key, publish = false } = {}) {
    const selfPath = path.join(ROOT, 'assets', 'deepseek娘.png');
    try {
      if (!fs.existsSync(selfPath)) return { ok: false, status: 404, error: '未找到 AI 形象图片 assets/deepseek娘.png' };
      const buf = fs.readFileSync(selfPath);
      const mimeType = mimeFromBuffer(buf) || 'image/png';
      const image = { mimeType, data: buf.toString('base64') };

      // 发图前照例过一遍准入与静默：不能因为「是自拍」就绕过暂停/静默/模式限制
      let sent = null;
      let sendError = '';
      if (publish) {
        if (live.currentMode !== 'reserved2') {
          sendError = '该接口仅 reserved2 模式可用';
        } else if (cfg.socialV2?.enabled === false) {
          sendError = '二代模式已关闭，不能发图';
        } else if (socialV2.paused) {
          sendError = '二代 AI 已暂停，不能发图';
        } else if (typeof shouldBlockSilentReply === 'function' && shouldBlockSilentReply(key)) {
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
            saveSocialV2State?.();
            appendActivity?.(`${key} [自拍] 已发送形象图`);
            logLine(`[自拍] 已发送形象图 → ${key}`);
          } catch (error) {
            // 发失败不算致命：图仍然给模型（它至少能照着描述），但要如实告知
            sendError = String(error?.message ?? error);
            logLine(`[自拍] 发送失败 ${key}：${sendError}`);
          }
        }
      }

      return {
        ok: true,
        key,
        image,
        published: publish,
        sent: sent || undefined,
        // 没发出去时给模型一句可转述的话，避免它以为已经发了
        sendError: sendError || undefined
      };
    } catch (error) {
      return { ok: false, status: 500, error: `读取 AI 形象图片失败：${error?.message ?? error}` };
    }
  }

  // ── X 登录自检 ──────────────────────────────────────────────────────
  async function xAuthCheck() {
    if (!xMonitor) return { ok: false, status: 503, error: 'X 插件未加载（plugins/x-posts）' };
    const st = xMonitor.describeAuth();
    if (!st.available) {
      return { ok: false, ...st, hint: '按记忆 x-monitor 登录态的说明取 auth_token/ct0 写入 state/x-auth.json' };
    }
    try {
      const probe = await xMonitor.verifyAuth();
      return { ok: probe.ok, ...st, ...probe };
    } catch (e) {
      return { ok: false, ...st, error: `自检失败：${e?.message ?? e}` };
    }
  }

  // ── 按需拉取 X 帖子并发送 ───────────────────────────────────────────
  async function fetchXPosts({ key, body = {} } = {}) {
    const handleRaw = String(body.handle ?? '').trim();
    if (!xMonitor) return { ok: false, status: 503, error: 'X 插件未加载（plugins/x-posts）' };
    const account = handleRaw.replace(/^@/, '').trim();
    if (!/^[A-Za-z0-9_]{1,15}$/.test(account)) {
      return { ok: false, status: 400, error: `账号名不合法：${handleRaw}（X 账号只能含字母/数字/下划线，最多 15 位）` };
    }

    const count = Math.max(1, Math.min(5, Number(body.count) || 1));
    // 时间条件三选一：date（某一天）/ lastHours（最近 N 小时）/ 默认（最新几条）
    let sinceMs = 0;
    let untilMs = 0;
    let rangeNote = '';
    if (body.date) {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(body.date).trim());
      if (!m) return { ok: false, status: 400, error: 'date 格式应为 YYYY-MM-DD' };
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
      return { ok: false, status: 400, error: `指定的时间还没到（${String(body.date ?? '')}），换个日期或说“最新”` };
    }

    logLine(`[x-monitor] 按需拉取 @${account}（${rangeNote || '最新'}，${count} 条）→ ${key}${body.dryRun === true ? '（干跑）' : ''}`);
    let result;
    try {
      result = await xMonitor.fetchAndRender(account, { count, sinceMs, untilMs });
    } catch (e) {
      return { ok: false, status: 500, error: `拉取失败：${e?.message ?? e}` };
    }

    if (!result.ok) {
      // 400 而非 404：「那天没发帖 / 翻不到那么远」是查询条件没有结果，
      // 不是接口不存在。404 会让调用方误以为是路由问题。
      return {
        ok: false,
        status: 400,
        error: result.errors.join('；') || '没有拉到帖子',
        user: result.user,
        fetched: 0,
        oldestMs: result.oldestMs || 0
      };
    }

    // 发图（每张一条消息，与真人发图节奏一致）
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
        await sleep(700); // 多条之间留点间隔，避免像刷屏
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
    logLine(`[x-monitor] @${account} 拉取完成：${dryRun ? `干跑（未发送）${result.posts.length} 条` : `发出 ${sentCount}/${result.posts.length} 张图、${sentVideos} 个视频`}${skippedNote}${sendErrors.length ? `，失败 ${sendErrors.length}` : ''}`);
    return {
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
    };
  }

  return {
    sendImage,
    archive,
    reverseSearch,
    react,
    reject,
    refresh,
    stickerImage,
    selfImage,
    xAuthCheck,
    fetchXPosts
  };
}
