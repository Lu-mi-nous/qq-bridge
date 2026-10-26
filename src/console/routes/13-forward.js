// 控制台路由域：转发与活跃成员（R4）。
//
// 从 console-server.js 原样搬出，只调整了缩进；鉴权 / CSRF / agent 白名单 /
// 暂停隔离仍由 console-server 统一处理，走到这里时请求已通过全部前置校验。
export const id = '13-forward';
export const title = '转发与活跃成员';

/** 本模块负责的路由；console-server 据此分派，不必解析 handler 内部。 */
export const routes = [
  ['GET', '/api/socialV2/forward-message', 'exact'],
  ['POST', '/api/socialV2/forward-media', 'exact'],
  ['GET', '/api/socialV2/active-members', 'exact']
];

export async function handle(req, res, url, ctx) {
  const { sendJson, readBody, deps } = ctx;
  const { agentTokenOk, v2SessionAllowed, v2ToolEnabled } = ctx;
  const {
    bot,
    cfg,
    fetchMediaData,
    formatForwardResponse,
    getSocialV2State,
    log,
    modeAllowed,
    seenForwardIds
  } = deps;

  // ── 合并转发消息查询端点（MCP qq_get_forward_msg 走这里） ────────────
  if (req.method === 'GET' && url.pathname === '/api/socialV2/forward-message') {
    const key = String(url.searchParams.get('key') ?? '').trim();
    const id = String(url.searchParams.get('id') ?? '').trim();
    const agentToken = String(req.headers['x-agent-token'] ?? '').trim();
    const keyMatch = /^(group|private):(\d+)$/.exec(key);
    if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
    if (!id) { sendJson({ ok: false, error: 'id 不能为空' }, 400); return; }
    if (deps.live.currentMode !== 'reserved2') {
      sendJson({ ok: false, error: '合并转发查看仅 reserved2 模式可用' }, 403);
      return;
    }
    if (!agentToken) {
      sendJson({ ok: false, error: 'reserved2 模式读取合并转发必须携带 agent token' }, 403);
      return;
    }
    if (!agentTokenOk(key, agentToken)) {
      sendJson({ ok: false, error: 'agent token 无效' }, 403);
      return;
    }
    const kind = keyMatch[1];
    const num = Number(keyMatch[2]);
    if (!Number.isFinite(num) || num <= 0 || !modeAllowed(key, kind, num, cfg, deps.live.currentMode)) {
      sendJson({ ok: false, error: '当前模式不允许读取该会话' }, 403);
      return;
    }
    if (!v2ToolEnabled('getForwardMsg')) {
      sendJson({ ok: false, error: '工具未启用：qq_get_forward_msg' }, 403);
      return;
    }
    // 安全边界：只允许读取本会话确实收到过的 forward id，防止 AI 任意探测/跨会话读取
    const st = getSocialV2State(key);
    const seenInRecent = (st?.recentMessages || []).some((m) => Array.isArray(m?.forwardIds) && m.forwardIds.includes(id));
    const seenInUnread = (st?.unread || []).some((m) => Array.isArray(m?.forwardIds) && m.forwardIds.includes(id));
    const seenInMemory = seenForwardIds.get(key)?.has(id) === true;
    if (!seenInRecent && !seenInUnread && !seenInMemory) {
      sendJson({ ok: false, error: '该转发消息 id 不在当前会话可见范围内，拒绝读取' }, 404);
      return;
    }
    try {
      const data = await bot.raw('get_forward_msg', { id });
      const formatted = formatForwardResponse(data);
      const remember = (fid) => {
        if (!fid) return;
        let set = seenForwardIds.get(key);
        if (!set) {
          set = new Set();
          seenForwardIds.set(key, set);
        }
        set.add(fid);
        if (set.size > 1000) {
          for (const old of set) {
            set.delete(old);
            if (set.size <= 1000) break;
          }
        }
      };
      // 把本层出现的嵌套 forward id 登记为“本会话已见过”，AI 后续可直接再次读取。
      for (const m of formatted.messages || []) {
        for (const fid of m.nestedForwardIds || []) remember(fid);
      }
      // 抓取嵌套转发的前几条作为预览，让 AI 不需要二次调用也能先看到内容。
      const nestedPreviews = [];
      const nestedIds = [];
      const seenNested = new Set();
      for (const m of formatted.messages || []) {
        for (const fid of m.nestedForwardIds || []) {
          if (!seenNested.has(fid) && nestedIds.length < 5) {
            seenNested.add(fid);
            nestedIds.push(fid);
          }
        }
      }
      for (const fid of nestedIds) {
        try {
          const ndata = await bot.raw('get_forward_msg', { id: fid });
          const nfmt = formatForwardResponse(ndata, { maxMessages: 3, maxCharsPerMessage: 120 });
          for (const nm of nfmt.messages || []) {
            for (const nfid of nm.nestedForwardIds || []) remember(nfid);
          }
          nestedPreviews.push({ id: fid, ...nfmt });
        } catch (error) {
          log(`嵌套转发预览失败 ${key} ${fid}:`, error?.message ?? error);
          nestedPreviews.push({ id: fid, error: error?.message ?? '嵌套转发读取失败' });
        }
      }
      sendJson({ ok: true, key, id, ...formatted, nestedPreviews });
    } catch (error) {
      log(`合并转发查询失败 ${key} ${id}: ${error?.message ?? error}`);
      sendJson({ ok: false, error: `合并转发查询失败：${error?.message ?? error}` }, 500);
    }
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/socialV2/forward-media') {
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    const media = Array.isArray(body.media) ? body.media : [];
    if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
    if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
    if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
    if (req.headers['x-agent-token'] && !v2ToolEnabled('getForwardMsg')) { sendJson({ ok: false, error: '工具未启用：qq_get_forward_msg' }, 403); return; }
    if (deps.live.currentMode !== 'reserved2') { sendJson({ ok: false, error: '转发媒体读取仅 reserved2 模式可用' }, 403); return; }
    if (!media.length) { sendJson({ ok: true, key, media: [], images: [] }); return; }
    try {
      const images = await fetchMediaData(media);
      sendJson({ ok: true, key, media, images });
    } catch (error) {
      log(`转发媒体读取失败 ${key}:`, error?.message ?? error);
      sendJson({ ok: false, error: `转发媒体读取失败：${error?.message ?? error}` }, 500);
    }
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/socialV2/active-members') {
    const key = String(url.searchParams.get('key') ?? '').trim();
    const limit = Math.min(20, Math.max(1, Number(url.searchParams.get('limit')) || 10));
    if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
    if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
    if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
    if (req.headers['x-agent-token'] && !v2ToolEnabled('getActiveMembers')) { sendJson({ ok: false, error: '工具未启用：qq_get_active_members' }, 403); return; }
    const st = getSocialV2State(key);
    const map = new Map();
    for (const m of st.recentMessages) {
      if (!m || m.isSelf) continue;
      const uid = m.userId ? String(m.userId) : '';
      const key2 = uid || String(m.sender || '未知');
      const cur = map.get(key2) || { sender: m.sender || key2, userId: uid || undefined, count: 0, lastTime: 0, isOwner: !!m.isOwner };
      if (!cur.userId && uid) cur.userId = uid;
      cur.count += 1;
      if (m.time > cur.lastTime) cur.lastTime = m.time;
      if (m.isOwner) cur.isOwner = true;
      map.set(key2, cur);
    }
    const members = [...map.values()].sort((a, b) => b.count - a.count || b.lastTime - a.lastTime).slice(0, limit);
    sendJson({ ok: true, key, members });
    return;
  }
}
