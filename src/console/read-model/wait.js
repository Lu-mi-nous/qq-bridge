// R4.7-2：等待/反馈/工具日志读模型。
//
// 这些 GET 端点原先从 30+ 项依赖里拼响应。这里只读：不等待、不写文件。
// 长轮询等待、反馈写入、清空日志/反馈、报错自检在 `src/console/commands/wait.js`。

export function createWaitReadModel({
  readToolLog,
  readFeedbackEntries,
  getSocialV2State,
  resolveReplyInfo
} = {}) {
  /** GET /api/socialV2/tool-log */
  function toolLog(rawLimit) {
    const limit = Math.min(500, Math.max(1, Number(rawLimit) || 200));
    return { ok: true, entries: readToolLog?.(limit) ?? [] };
  }

  /** GET /api/socialV2/feedback */
  function feedback() {
    return { ok: true, entries: readFeedbackEntries?.() ?? [] };
  }

  /** GET /api/socialV2/my-recent：只返回自己发过的最近消息。 */
  function myRecent({ key, rawLimit } = {}) {
    const limit = Math.min(50, Math.max(1, Number(rawLimit) || 10));
    const st = getSocialV2State?.(key);
    const mine = (st?.recentMessages || []).filter((m) => m.isSelf).slice(-limit);
    return { ok: true, key, messages: mine };
  }

  /** GET /api/socialV2/message-detail：本地消息优先，缺失时查 OneBot。 */
  async function messageDetail({ key, messageId } = {}) {
    const keyMatch = /^(group|private):(\d+)$/.exec(key);
    if (!keyMatch) return { ok: false, status: 400, error: 'key 格式应为 group:群号 或 private:QQ号' };
    const kind = keyMatch[1];
    const id = Number(keyMatch[2]);
    try {
      const st = getSocialV2State?.(key);
      const found = (st?.recentMessages || []).find((m) => m && (String(m.seq) === messageId || (m.messageId && String(m.messageId) === messageId)));
      const forwardFields = found ? {
        forwardIds: Array.isArray(found.forwardIds) ? found.forwardIds : [],
        hasForward: !!found.hasForward
      } : {};
      let info = null;
      // 如果入参命中本地 seq 且本地存有真实 messageId，优先按 seq 展示，避免与真实 id 冲突。
      if (found && found.messageId && String(found.messageId) !== messageId) {
        info = {
          sender: String(found.sender || ''),
          text: String(found.text || found.plain || '').slice(0, 200),
          userId: found.userId ? String(found.userId) : null,
          messageId: String(found.messageId),
          seq: found.seq
        };
      } else {
        info = await resolveReplyInfo?.(kind, id, messageId);
        if (!info && found) {
          info = {
            sender: String(found.sender || ''),
            text: String(found.text || found.plain || '').slice(0, 200),
            userId: found.userId ? String(found.userId) : null,
            messageId: found.messageId ? String(found.messageId) : null,
            seq: found.seq
          };
        }
      }
      // 无论 info 来自本地还是 OneBot，只要本地有 found 就补充转发字段，避免提示词与实现不一致。
      if (info && found) Object.assign(info, forwardFields);
      return { ok: true, key, messageId, info };
    } catch (error) {
      return { ok: false, status: 500, error: `获取消息详情失败：${error?.message ?? error}` };
    }
  }

  return { toolLog, feedback, myRecent, messageDetail };
}
