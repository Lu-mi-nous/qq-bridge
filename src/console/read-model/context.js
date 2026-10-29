// R4.7-2：共享记忆 / Token 熔断 / 上下文 / 黑话读模型。
//
// 这四个 GET 端点原来从 60+ 项平铺依赖里拼响应。这里只读：
// 共享记忆只返回结构化人物资料（绝不返回消息原文/episode）；熔断视图补齐所有会话；
// 长期记忆详情在缺失时按 episode 回填一次（历史兼容，不删除任何数据）。
//
// 写动作（配置保存、忘记/清空、重建、追赶、删除会话、AI 提交黑话）在
// `src/console/commands/context.js`。

export function createContextReadModel({
  cfg = {},
  STATE_DIR,
  live = {},
  socialV2 = { conversations: new Map() },
  state = {},
  ops = {},
  contextDisplayName,
  contextStats,
  loadLongTermMemory,
  backfillLongTermMemory,
  longTermStats,
  journalStats,
  loadEpisodes,
  readRecallAudit,
  confirmedSlangListV2,
  buildSlangContext,
  normalizeSharedMemoryConfig,
  sharedMemoryStats,
  listSharedPeople,
  normalizeTokenFuseConfig,
  effectiveTokenFuseThresholds
} = {}) {
  /** GET /api/socialV2/shared-memory：只回结构化人物资料与统计。 */
  function sharedMemoryView({ q = '', limit } = {}) {
    const config = normalizeSharedMemoryConfig?.(cfg.socialV2?.sharedMemory || {}) || {};
    const query = String(q ?? '').trim().slice(0, 80);
    const list = listSharedPeople?.(STATE_DIR, { q: query, limit: Number(limit) || 100 })
      || { updatedAt: 0, rows: [] };
    return {
      ok: true,
      config,
      stats: sharedMemoryStats?.(STATE_DIR, config) || {},
      updatedAt: list.updatedAt,
      rows: list.rows
    };
  }

  /**
   * GET /api/socialV2/token-fuse：面板要能给「每个会话」单独设阈值，
   * 所以把当前所有会话都列出来，而不只是今天有消耗的。
   */
  function tokenFuseView() {
    const status = ops.tokenFuseStatus?.() || {
      enabled: false,
      config: normalizeTokenFuseConfig?.({}) || {},
      keys: []
    };
    const keySet = new Set((status.keys || []).map((x) => x.key));
    for (const key of socialV2.conversations.keys()) {
      if (/^(group|private):\d+$/.test(key)) keySet.add(key);
    }
    for (const key of Object.keys(state.sessions || {})) {
      if (/^(group|private):\d+$/.test(key)) keySet.add(key);
    }
    for (const key of Object.keys(status.config?.overrides || {})) keySet.add(key);
    const byKey = new Map((status.keys || []).map((x) => [x.key, x]));
    const zero = { totalInput: 0, uncached: 0, calls: 0, state: 'normal', warnedAt: 0, fusedAt: 0, fusedNotifiedAt: 0, resetAt: 0 };
    const keys = [...keySet].map((key) => {
      const b = byKey.get(key) || zero;
      return {
        ...b,
        key,
        displayName: contextDisplayName?.(key) || key,
        ...(effectiveTokenFuseThresholds?.(status.config || {}, key) || {})
      };
    }).sort((a, b) => (b.totalInput || 0) - (a.totalInput || 0));
    return { ok: true, ...status, keys };
  }

  /** GET /api/socialV2/context-memory：长期记忆详情（控制台 24 号卡「长期」按钮）。 */
  function contextMemoryView(key) {
    const stats = contextStats?.(STATE_DIR, key) || {};
    let memory = loadLongTermMemory?.(STATE_DIR, key) || {};
    // 老数据只有 episode 没有 memory.json：读时补建一次，不删任何文件。
    if (stats.episodes > 0 && !memory.updatedAt) {
      try { memory = backfillLongTermMemory?.(STATE_DIR, key) || memory; } catch { /* 回填失败就返回空记忆 */ }
    }
    return {
      ok: true,
      key,
      stats,
      longTerm: longTermStats?.(STATE_DIR, key),
      journal: journalStats?.(STATE_DIR, key),
      memory,
      episodes: loadEpisodes?.(STATE_DIR, key, 5),
      recallAudit: readRecallAudit?.(STATE_DIR, key, 20)
    };
  }

  /** GET /api/socialV2/slang/query：已确认词条 + 注入片段（只读）。 */
  function slangQueryView({ key, q = '' } = {}) {
    const query = String(q ?? '').trim().toLowerCase();
    const list = (confirmedSlangListV2?.() || []).filter((e) => {
      if (!query) return true;
      return e.content.toLowerCase().includes(query)
        || e.meaning.toLowerCase().includes(query)
        || e.usage.toLowerCase().includes(query)
        || e.example.toLowerCase().includes(query);
    });
    return {
      ok: true,
      key,
      total: list.length,
      entries: list,
      block: buildSlangContext?.(live.slangEntries, cfg.slang?.injectMax ?? 8) || ''
    };
  }

  return { sharedMemoryView, tokenFuseView, contextMemoryView, slangQueryView };
}
