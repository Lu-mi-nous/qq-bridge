// R4.7-2：转发与活跃成员读模型。
//
// 三个端点都只读取/缓存：合并转发查询会把本层嵌套 forward id 登记到本会话的
// seenForwardIds（防止 AI 任意探测），不发送、不写盘。
// agentTokenOk / v2ToolEnabled 由路由按请求传入。

export function createForwardReadModel({
  bot,
  cfg = {},
  live = {},
  fetchMediaData,
  formatForwardResponse,
  getSocialV2State,
  log,
  modeAllowed,
  seenForwardIds
} = {}) {
  const logLine = (message, error) => { try { log?.(message, error); } catch { /* 日志失败不影响返回 */ } };

  /** GET /api/socialV2/forward-message */
  async function forwardMessage({ key, id, agentToken = '', agentTokenOk, toolEnabled } = {}) {
    const keyMatch = /^(group|private):(\d+)$/.exec(key);
    if (!keyMatch) return { ok: false, status: 400, error: 'key 格式应为 group:群号 或 private:QQ号' };
    if (!id) return { ok: false, status: 400, error: 'id 不能为空' };
    if (live.currentMode !== 'reserved2') return { ok: false, status: 403, error: '合并转发查看仅 reserved2 模式可用' };
    if (!agentToken) return { ok: false, status: 403, error: 'reserved2 模式读取合并转发必须携带 agent token' };
    if (!agentTokenOk?.(key, agentToken)) return { ok: false, status: 403, error: 'agent token 无效' };
    const kind = keyMatch[1];
    const num = Number(keyMatch[2]);
    if (!Number.isFinite(num) || num <= 0 || typeof modeAllowed !== 'function' || !modeAllowed(key, kind, num, cfg, live.currentMode)) {
      return { ok: false, status: 403, error: '当前模式不允许读取该会话' };
    }
    if (!toolEnabled?.('getForwardMsg')) return { ok: false, status: 403, error: '工具未启用：qq_get_forward_msg' };
    // 安全边界：只允许读取本会话确实收到过的 forward id，防止 AI 任意探测/跨会话读取
    const st = getSocialV2State(key);
    const seenInRecent = (st?.recentMessages || []).some((m) => Array.isArray(m?.forwardIds) && m.forwardIds.includes(id));
    const seenInUnread = (st?.unread || []).some((m) => Array.isArray(m?.forwardIds) && m.forwardIds.includes(id));
    const seenInMemory = seenForwardIds.get(key)?.has(id) === true;
    if (!seenInRecent && !seenInUnread && !seenInMemory) {
      return { ok: false, status: 404, error: '该转发消息 id 不在当前会话可见范围内，拒绝读取' };
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
          logLine(`嵌套转发预览失败 ${key} ${fid}:`, error?.message ?? error);
          nestedPreviews.push({ id: fid, error: error?.message ?? '嵌套转发读取失败' });
        }
      }
      return { ok: true, key, id, ...formatted, nestedPreviews };
    } catch (error) {
      logLine(`合并转发查询失败 ${key} ${id}:`, error?.message ?? error);
      return { ok: false, status: 500, error: `合并转发查询失败：${error?.message ?? error}` };
    }
  }

  /** POST /api/socialV2/forward-media */
  async function forwardMedia({ key, media = [], agentToken = '', agentTokenOk, toolEnabled } = {}) {
    if (agentToken && !agentTokenOk?.(key, agentToken)) return { ok: false, status: 403, error: 'agent token 无效' };
    if (agentToken && !toolEnabled?.('getForwardMsg')) return { ok: false, status: 403, error: '工具未启用：qq_get_forward_msg' };
    if (live.currentMode !== 'reserved2') return { ok: false, status: 403, error: '转发媒体读取仅 reserved2 模式可用' };
    if (!media.length) return { ok: true, key, media: [], images: [] };
    try {
      const images = await fetchMediaData(media);
      return { ok: true, key, media, images };
    } catch (error) {
      logLine(`转发媒体读取失败 ${key}:`, error?.message ?? error);
      return { ok: false, status: 500, error: `转发媒体读取失败：${error?.message ?? error}` };
    }
  }

  /** GET /api/socialV2/active-members：按发言次数与最近时间排序。 */
  function activeMembers({ key, limit, agentToken = '', agentTokenOk, toolEnabled } = {}) {
    const lim = Math.min(20, Math.max(1, Number(limit) || 10));
    if (agentToken && !agentTokenOk?.(key, agentToken)) return { ok: false, status: 403, error: 'agent token 无效' };
    if (agentToken && !toolEnabled?.('getActiveMembers')) return { ok: false, status: 403, error: '工具未启用：qq_get_active_members' };
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
    const members = [...map.values()].sort((a, b) => b.count - a.count || b.lastTime - a.lastTime).slice(0, lim);
    return { ok: true, key, members };
  }

  return { forwardMessage, forwardMedia, activeMembers };
}
