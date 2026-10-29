// R4.7-2：Agent 回调读模型（旧只读授权 / 图片查询）。
//
// 只读：不发送、不写会话状态。发送在 `src/console/commands/agent.js`。
// 鉴权 helper（agentTokenOk / v2ToolEnabled）由路由按请求传入，避免读模型持有请求闭包。

export function createAgentReadModel({
  cfg = {},
  live = {},
  findMessageMediaAsync,
  fetchMediaData,
  modeAllowed: modeAllowedFn,
  log
} = {}) {
  /** POST /api/authorize/read：旧只读工具的授权检查。 */
  function authorize({ key, token, agentTokenOk } = {}) {
    const keyMatch = /^(group|private):(\d+)$/.exec(key);
    if (!keyMatch) return { ok: false, status: 400, error: 'key 格式应为 group:群号 或 private:QQ号' };
    if (live.currentMode === 'reserved2' && !agentTokenOk?.(key, token)) {
      return { ok: false, status: 403, error: 'reserved2 模式下旧只读工具不可用，请使用带会话令牌的 v2 读工具' };
    }
    if (token && !agentTokenOk?.(key, token)) return { ok: false, status: 403, error: 'agent token 无效' };
    const kind = keyMatch[1];
    const id = Number(keyMatch[2]);
    if (!Number.isFinite(id) || id <= 0 || !modeAllowedFn?.(key, kind, id, cfg, live.currentMode)) {
      return { ok: false, status: 403, error: '当前模式不允许读取该会话' };
    }
    return { ok: true, key };
  }

  /** GET /api/images/message：图片/表情查询（本地缓存优先，未命中回源）。 */
  async function messageImages({ key, messageId, agentToken = '', agentTokenOk, toolEnabled, raw = false } = {}) {
    const keyMatch = /^(group|private):(\d+)$/.exec(key);
    if (!keyMatch) return { ok: false, status: 400, error: 'key 格式应为 group:群号 或 private:QQ号' };
    if (!messageId) return { ok: false, status: 400, error: 'messageId 不能为空' };
    if (live.currentMode === 'reserved2' && !agentToken) {
      return { ok: false, status: 403, error: 'reserved2 模式读取图片必须携带 agent token' };
    }
    if (live.currentMode === 'chat' || live.currentMode === 'reserved') {
      return { ok: false, status: 403, error: '一代 chat/reserved 模式图片已自动内联，按需图片工具仅 reserved2 模式可用' };
    }
    if (agentToken && !agentTokenOk?.(key, agentToken)) return { ok: false, status: 403, error: 'agent token 无效' };
    const kind = keyMatch[1];
    const id = Number(keyMatch[2]);
    if (!Number.isFinite(id) || id <= 0 || !modeAllowedFn?.(key, kind, id, cfg, live.currentMode)) {
      return { ok: false, status: 403, error: '当前模式不允许读取该会话' };
    }
    if (agentToken && !toolEnabled?.('getImages')) return { ok: false, status: 403, error: '工具未启用：qq_get_message_images' };
    if (!agentToken && live.currentMode === 'closed-agent' && !toolEnabled?.('getImages')) {
      return { ok: false, status: 403, error: '工具未启用：qq_get_message_images' };
    }
    // 本地缓存优先，未命中则回源取那条消息（群友引用别人的图时本地没有）
    const media = await findMessageMediaAsync(key, messageId);
    if (!media.length) {
      return { ok: true, messageId, media: [], images: [], note: '该消息没有可读取的图片/表情元数据' };
    }
    try {
      // raw=1：跳过缩放/抽帧，返回原图（供 qq_upscale_image 做超分）
      const images = await fetchMediaData(media, { raw: raw === true });
      return { ok: true, messageId, media, images };
    } catch (error) {
      try { log?.(`图片查询失败 ${key} ${messageId}: ${error?.message ?? error}`); } catch { /* 日志失败不影响返回 */ }
      return { ok: false, status: 500, error: `图片查询失败：${error?.message ?? error}` };
    }
  }

  return { authorize, messageImages };
}
