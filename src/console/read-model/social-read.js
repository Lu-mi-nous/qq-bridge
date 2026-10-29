// R4.7-2：二代只读端点（群文件 / 未读 / 最近消息 / 会话状态）。
//
// 只读：不清理未读、不改唤醒配置、不唤醒。写动作在
// `src/console/commands/social-read.js`。

export function createSocialReadModel({
  bot,
  humanSize,
  searchGroupFiles,
  summarizeGroupFiles,
  formatSummary,
  getSocialV2State,
  socialV2 = { conversations: new Map() },
  state = {},
  promptQueues,
  pendingWakeKeys,
  v2TurnStartAt,
  collectors,
  isConversationBusyV2
} = {}) {
  /** GET /api/socialV2/group-files：只读列文件/搜索/汇总。 */
  async function groupFiles({ key, mode = 'summary', search = {}, recentDays = 7 } = {}) {
    const keyMatch = /^group:(\d+)$/.exec(key);
    if (!keyMatch) return { ok: false, status: 400, error: '群文件只适用于群会话（key 格式 group:群号）' };
    const groupId = Number(keyMatch[1]);
    try {
      // SDK 的 call() 已经解包（returns response.data）且出错会 throw，
      // 所以这里直接读 .files，不要再套一层 .data（那是原始 HTTP 的形状）。
      const raw = await bot.getGroupRootFiles(groupId);
      const files = (raw && raw.files) || [];
      if (mode === 'search') {
        const q = {
          keyword: search.keyword || '',
          category: search.category || '',
          ext: search.ext || '',
          uploader: search.uploader || '',
          minBytes: Number(search.minBytes) || 0,
          maxBytes: Number(search.maxBytes) || 0,
          limit: Number(search.limit) || 20
        };
        const r = searchGroupFiles(files, q);
        return { ok: true, key, mode, query: q, ...r };
      }
      const summary = summarizeGroupFiles(files, { recentDays: Number(recentDays) || 7 });
      return { ok: true, key, mode: 'summary', summary, text: formatSummary(summary) };
    } catch (error) {
      return { ok: false, status: 500, error: `群文件读取失败：${error?.message ?? error}` };
    }
  }

  /** GET /api/socialV2/group-file-stats：容量信息。 */
  async function groupFileStats({ key } = {}) {
    const keyMatch = /^group:(\d+)$/.exec(key);
    if (!keyMatch) return { ok: false, status: 400, error: '群文件只适用于群会话（key 格式 group:群号）' };
    try {
      const info = await bot.getGroupFileSystemInfo(Number(keyMatch[1]));
      const d = info ?? {}; // SDK 已解包
      const used = Number(d.used_space) || 0;
      const total = Number(d.total_space) || 0;
      return {
        ok: true,
        key,
        fileCount: Number(d.file_count) || 0,
        limitCount: Number(d.limit_count) || 0,
        usedSpace: used,
        totalSpace: total,
        usedText: humanSize(used),
        totalText: humanSize(total),
        usedPercent: total > 0 ? Math.round(used / total * 100) : null
      };
    } catch (error) {
      return { ok: false, status: 500, error: `容量读取失败：${error?.message ?? error}` };
    }
  }

  /** GET /api/socialV2/unread */
  function unread({ key, limit } = {}) {
    const lim = Math.min(100, Math.max(1, Number(limit) || 30));
    const st = getSocialV2State(key);
    return { ok: true, key, unreadCount: st.unread.length, messages: st.unread.slice(-lim) };
  }

  /** GET /api/socialV2/recent：offset 从最新往回数。 */
  function recent({ key, limit, offset } = {}) {
    const lim = Math.min(100, Math.max(1, Number(limit) || 20));
    const off = Math.max(0, Number(offset) || 0);
    const st = getSocialV2State(key);
    const start = Math.max(0, st.recentMessages.length - off - lim);
    const end = Math.max(0, st.recentMessages.length - off);
    return { ok: true, key, messages: st.recentMessages.slice(start, end) };
  }

  /** GET /api/socialV2/states：所有会话的运行态诊断。 */
  function states() {
    const list = [];
    for (const [key, st] of socialV2.conversations) {
      // 诊断：把 isConversationBusyV2 的四个判据分别透出，便于定位「虚假繁忙」卡在哪一项
      const sid = state.sessions?.[key];
      const q = promptQueues.get(key);
      list.push({
        key,
        wakeConfig: st.wakeConfig,
        unreadCount: st.unread.length,
        recentCount: st.recentMessages.length,
        lastWakeReason: st.lastWakeReason,
        lastAiReplyAt: st.lastAiReplyAt,
        noActionCount: st.wakeConfig.noActionCount || 0,
        busy: isConversationBusyV2(key, st),
        busyBy: {
          pendingWakeTimer: !!st.pendingWakeTimer,
          pendingWakeKeys: pendingWakeKeys.has(key),
          promptQueue: !!(q && (q.running || q.queue.length > 0)),
          promptQueueRunning: !!(q && q.running),
          promptQueueLen: q?.queue?.length ?? 0,
          v2TurnStartAt: !!(sid && v2TurnStartAt.has(sid)),
          collectors: !!(sid && collectors.has(sid))
        }
      });
    }
    return { ok: true, conversations: list };
  }

  return { groupFiles, groupFileStats, unread, recent, states };
}
