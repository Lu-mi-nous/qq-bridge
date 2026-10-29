// R4.7-2：记忆 / 召回 / 上下文状态读模型。
//
// memory/recall/context-status 原先从 25 项依赖里拼响应。这里只读：
// 不追加/编辑/删除记忆、不清空、不写盘。写动作在 `src/console/commands/memory.js`。

export function createMemoryReadModel({
  cfg = {},
  STATE_DIR,
  live = {},
  socialV2 = { conversations: new Map() },
  state = {},
  ops = {},
  contextCfg,
  contextStats,
  contextMetrics,
  countContextPendingV2,
  longTermStats,
  backfillLongTermMemory,
  journalStats,
  journalCoverage,
  recallAuditStats,
  refreshContextNames,
  loadTokenUsage,
  contextDisplayName,
  sessionFileBytes,
  formatMemoryV2,
  getSocialV2State,
  getRecallIndexV2,
  searchMemory,
  buildSessionUsageRows,
  sharedMemoryStats,
  readBacklogHistory
} = {}) {
  /** GET /api/socialV2/memory：按 category 只回一类（formatted + raw）。 */
  function memoryView({ key, category } = {}) {
    const st = getSocialV2State(key);
    const raw = {
      activeTopics: Array.isArray(st.activeTopics) ? st.activeTopics.slice(-20) : [],
      pendingThoughts: Array.isArray(st.pendingThoughts) ? st.pendingThoughts.filter((t) => !t.expiresAt || Date.now() < t.expiresAt).slice(-20) : [],
      memberImpressions: st.memberImpressions && typeof st.memberImpressions === 'object' ? st.memberImpressions : {}
    };
    if (category === 'activeTopic') {
      raw.pendingThoughts = [];
      raw.memberImpressions = {};
    } else if (category === 'pendingThought') {
      raw.activeTopics = [];
      raw.memberImpressions = {};
    } else if (category === 'memberImpression') {
      raw.activeTopics = [];
      raw.pendingThoughts = [];
    }
    return { ok: true, key, category, formatted: formatMemoryV2({ ...st, ...raw }), raw };
  }

  /** GET /api/socialV2/recall：按当前话题检索 journal + episode。 */
  function recall({ key, query, limit, from, to } = {}) {
    const lim = Math.min(20, Math.max(1, Number(limit) || 6));
    const toMs = (v) => {
      if (v == null || v === '') return 0;
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) return n < 1e12 ? n * 1000 : n;
      const t = Date.parse(v);
      return Number.isFinite(t) ? t : 0;
    };
    const index = getRecallIndexV2(key);
    const results = searchMemory(index, String(query ?? ''), {
      limit: lim,
      from: toMs(from),
      to: toMs(to),
      minScore: 0.1
    });
    return {
      ok: true,
      key,
      query: String(query ?? ''),
      count: results.length,
      results,
      index: { documents: index.docs.length, builtAt: index.builtAt }
    };
  }

  /** GET /api/socialV2/context-status：24 号卡聚合（只读缓存，不现算 Token）。 */
  function contextStatus() {
    const cm = contextCfg();
    void refreshContextNames?.().catch(() => {});
    // 24 号卡每行显示「今日总输入（含缓存，累计旧会话+摘要器）」。
    // 只读 token 缓存，不在这里现算（GET 不做全量扫描）。
    const usageSnapshot = live.tokenUsage || loadTokenUsage?.();
    const tokenToday = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
    const tokenByKey = new Map(
      buildSessionUsageRows({
        usage: usageSnapshot || {},
        currentSessions: state.sessions || {},
        displayName: contextDisplayName,
        today: tokenToday
      }).rows.map((row) => [row.key, row])
    );
    const rows = [];
    for (const [key, st] of socialV2.conversations) {
      if (!/^(group|private):\d+$/.test(key)) continue;
      const stats = contextStats(STATE_DIR, key);
      const m = contextMetrics.get(key) || {};
      const lastEpSeq = Number(stats.lastEpisodeSeq) || 0;
      const pendingMessages = countContextPendingV2(
        key, st, lastEpSeq, Number(stats.lastEpisodeEndAt) || 0
      );
      let longTerm = longTermStats(STATE_DIR, key);
      // Phase 2 迁移：老 episode 在 memory.json 还不存在时补种一次。
      if (stats.episodes > 0 && !longTerm.updatedAt) {
        try { backfillLongTermMemory?.(STATE_DIR, key); longTerm = longTermStats(STATE_DIR, key); } catch { /* 回填失败按空记忆 */ }
      }
      const journal = journalStats(STATE_DIR, key);
      const coverage = journalCoverage(STATE_DIR, key, { hours: 24, indexLimit: 3000 });
      const auditStats = recallAuditStats(STATE_DIR, key, 200);
      const lastAudit = auditStats.last;
      const backlogLevel = Number(pendingMessages) >= Number(cm.backlogCriticalMessages || 800)
        ? 'critical'
        : Number(pendingMessages) >= Number(cm.backlogWarnMessages || 200) ? 'warn' : 'ok';
      const sid = state.sessions[key] || '';
      const isGroup = key.startsWith('group:');
      const groupId = isGroup ? key.slice('group:'.length) : '';
      rows.push({
        key,
        inGroupList: isGroup ? live.contextNameCache.groups.has(groupId) : true,
        displayName: contextDisplayName(key),
        sessionId: sid,
        sessionBytes: sessionFileBytes(sid),
        compactions: stats.compactions,
        lastCompactionAt: stats.lastCompactionAt,
        compactionTokenNotch: stats.lastCompactionNotch,
        episodes: stats.episodes,
        lastEpisodeAt: stats.lastEpisodeAt,
        lastEpisodeSummary: String(stats.lastEpisodeSummary || '').slice(0, 140),
        pendingMessages: Number(pendingMessages) || 0,
        backlogLevel,
        backlogWarnMessages: Number(cm.backlogWarnMessages) || 200,
        backlogCriticalMessages: Number(cm.backlogCriticalMessages) || 800,
        journalBytes: Number(journal.bytes) || 0,
        coverage,
        longTerm,
        memory: {
          topics: Array.isArray(st.activeTopics) ? st.activeTopics.length : 0,
          thoughts: Array.isArray(st.pendingThoughts) ? st.pendingThoughts.length : 0,
          impressions: st.memberImpressions && typeof st.memberImpressions === 'object' ? Object.keys(st.memberImpressions).length : 0
        },
        lastPromptChars: Number(m.lastPromptChars) || 0,
        lastMemoryChars: Number(m.lastMemoryChars) || 0,
        lastSharedChars: Number(m.lastSharedChars) || 0,
        tokenToday: Number(tokenByKey.get(key)?.today?.totalInput) || 0,
        tokenTotal: Number(tokenByKey.get(key)?.cumulative?.totalInput) || 0,
        lastRecallChars: Number(m.lastRecallChars) || Number(lastAudit?.chars) || 0,
        lastRecallSeqs: Array.isArray(m.lastRecallSeqs) ? m.lastRecallSeqs.slice(-10) : [],
        lastRecallMs: Number(m.lastRecallMs) || Number(lastAudit?.ms) || 0,
        lastRecallHits: Number(m.lastRecallHits) || Number(lastAudit?.hits) || 0,
        lastRecallAt: Number(m.lastRecallAt) || Number(lastAudit?.at) || 0,
        lastRecallQuery: String(m.lastRecallQuery || lastAudit?.query || ''),
        recallCalls: auditStats.calls || Number(m.recallCalls) || 0,
        recallHitCalls: auditStats.calls ? auditStats.hits : Number(m.recallHitCalls) || 0,
        recallHitRate: auditStats.calls ? auditStats.hitRate : (Number(m.recallCalls) ? Math.round((Number(m.recallHitCalls) || 0) / Number(m.recallCalls) * 100) : 0),
        recallAvgMs: auditStats.calls ? auditStats.avgMs : (Number(m.recallCalls) ? Math.round((Number(m.recallMsTotal) || 0) / Number(m.recallCalls)) : 0),
        lastEpisodeError: String(m.lastEpisodeError || '')
      });
    }
    rows.sort((a, b) => b.sessionBytes - a.sessionBytes);
    const totals = rows.reduce((acc, r) => ({
      sessionBytes: acc.sessionBytes + r.sessionBytes,
      episodes: acc.episodes + r.episodes,
      compactions: acc.compactions + r.compactions,
      journalBytes: acc.journalBytes + (Number(r.journalBytes) || 0),
      people: acc.people + (Number(r.longTerm?.people) || 0),
      facts: acc.facts + (Number(r.longTerm?.facts) || 0),
      openThreads: acc.openThreads + (Number(r.longTerm?.openThreads) || 0),
      pendingMessages: acc.pendingMessages + (Number(r.pendingMessages) || 0),
      messages24h: acc.messages24h + (Number(r.coverage?.messages24h) || 0),
      indexed24h: acc.indexed24h + (Number(r.coverage?.indexed24h) || 0),
      recallCalls: acc.recallCalls + (Number(r.recallCalls) || 0),
      recallHitCalls: acc.recallHitCalls + (Number(r.recallHitCalls) || 0),
      tokenToday: acc.tokenToday + (Number(r.tokenToday) || 0)
    }), {
      sessionBytes: 0, episodes: 0, compactions: 0, journalBytes: 0,
      people: 0, facts: 0, openThreads: 0, pendingMessages: 0,
      messages24h: 0, indexed24h: 0, recallCalls: 0, recallHitCalls: 0,
      tokenToday: 0
    });
    totals.coveragePct = totals.messages24h
      ? Math.round((totals.indexed24h / totals.messages24h) * 100)
      : 100;
    totals.recallHitRate = totals.recallCalls
      ? Math.round((totals.recallHitCalls / totals.recallCalls) * 100)
      : 0;
    return {
      ok: true,
      enabled: cm.enabled !== false,
      rows,
      totals,
      // P2 跨会话人物记忆只做统计展示；列表走独立端点（避免 30 秒轮询拉 2000 人）。
      sharedMemory: sharedMemoryStats(STATE_DIR, cfg.socialV2?.sharedMemory || {}),
      tokenFuse: ops.tokenFuseStatus?.() || null,
      backlogHistory: readBacklogHistory(STATE_DIR, 48)
    };
  }

  return { memoryView, recall, contextStatus };
}
