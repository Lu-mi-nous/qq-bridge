// 控制台路由域：记忆 / 召回（R4）。
//
// 从 console-server.js 原样搬出，只调整了缩进；鉴权 / CSRF / agent 白名单 /
// 暂停隔离仍由 console-server 统一处理，走到这里时请求已通过全部前置校验。
export const id = '15-memory';
export const title = '记忆 / 召回';

/** 本模块负责的路由；console-server 据此分派，不必解析 handler 内部。 */
export const routes = [
  ['POST', '/api/socialV2/memory-append', 'exact'],
  ['POST', '/api/socialV2/memory-update', 'exact'],
  ['GET', '/api/socialV2/memory', 'exact'],
  ['POST', '/api/socialV2/memory-remove', 'exact'],
  ['POST', '/api/socialV2/memory-clear', 'exact'],
  ['GET', '/api/socialV2/recall', 'exact'],
  ['GET', '/api/socialV2/context-status', 'exact']
];

export async function handle(req, res, url, ctx) {
  const { sendJson, readBody, deps } = ctx;
  const { agentTokenOk, v2SessionAllowed, v2ToolEnabled } = ctx;
  const {
    STATE_DIR,
    appendMemoryV2,
    backfillLongTermMemory,
    cfg,
    contextCfg,
    contextDisplayName,
    contextMetrics,
    contextStats,
    journalCoverage,
    recallAuditStats,
    readBacklogHistory,
    countContextPendingV2,
    formatMemoryV2,
    getRecallIndexV2,
    getSocialV2State,
    journalStats,
    loadTokenUsage,
    longTermStats,
    redactKnownTokensOnly,
    refreshContextNames,
    saveSocialV2State,
    searchMemory,
    sessionFileBytes,
    socialV2,
    state
  } = deps;
  const {
    buildSessionUsageRows,
    sharedMemoryStats
  } = ctx.helpers;


  if (req.method === 'POST' && url.pathname === '/api/socialV2/memory-append') {
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    const category = String(body.category ?? '').trim();
    const content = String(body.content ?? '').trim();
    const extra = body.extra && typeof body.extra === 'object' ? body.extra : {};
    if (!key || !category || !content) { sendJson({ ok: false, error: 'key/category/content 不能为空' }, 400); return; }
    if (!['activeTopic', 'pendingThought', 'memberImpression'].includes(category)) { sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression' }, 400); return; }
    if (category === 'memberImpression' && !String(extra.target || '').trim()) { sendJson({ ok: false, error: 'memberImpression 需要 extra.target 指定群友名字' }, 400); return; }
    if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
    if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
    if (req.headers['x-agent-token'] && !v2ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_append' }, 403); return; }
    const st = getSocialV2State(key);
    appendMemoryV2(st, category, content, extra);
    sendJson({ ok: true, key, category, content, memory: formatMemoryV2(st) });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/socialV2/memory-update') {
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    const category = String(body.category ?? '').trim();
    const oldContent = String(body.oldContent ?? '').trim();
    const target = redactKnownTokensOnly(String(body.target ?? '').trim());
    const newContent = body.newContent !== undefined && body.newContent !== null ? redactKnownTokensOnly(String(body.newContent).trim()) : undefined;
    const newExtra = body.newExtra && typeof body.newExtra === 'object' && !Array.isArray(body.newExtra) ? body.newExtra : {};
    const redactExtra = (v) => redactKnownTokensOnly(String(v ?? '')).trim();
    const cleanNewExtra = {
      ...newExtra,
      pendingQuestion: newExtra.pendingQuestion !== undefined ? redactExtra(newExtra.pendingQuestion) : undefined,
      participants: Array.isArray(newExtra.participants) ? newExtra.participants.map((p) => redactExtra(p)) : undefined,
      motivation: newExtra.motivation !== undefined ? redactExtra(newExtra.motivation) : undefined,
      target: newExtra.target !== undefined ? redactExtra(newExtra.target) : undefined
    };
    if (!key || !category) { sendJson({ ok: false, error: 'key/category 不能为空' }, 400); return; }
    if (!['activeTopic', 'pendingThought', 'memberImpression'].includes(category)) { sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression' }, 400); return; }
    if (category === 'memberImpression' && !target) { sendJson({ ok: false, error: 'memberImpression 需要 target 指定原群友名字' }, 400); return; }
    if (category !== 'memberImpression' && !oldContent) { sendJson({ ok: false, error: '该类别需要 oldContent 指定要编辑的记忆内容' }, 400); return; }
    if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
    if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
    if (req.headers['x-agent-token'] && !v2ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_*' }, 403); return; }
    const st = getSocialV2State(key);
    if (category === 'activeTopic' && Array.isArray(st.activeTopics)) {
      const idx = st.activeTopics.findIndex((t) => String(t?.text ?? '') === oldContent);
      if (idx < 0) { sendJson({ ok: false, error: '找不到要编辑的 activeTopic' }, 404); return; }
      if (newContent !== undefined) st.activeTopics[idx].text = newContent.slice(0, 200);
      if (cleanNewExtra.pendingQuestion !== undefined) st.activeTopics[idx].pendingQuestion = String(cleanNewExtra.pendingQuestion).slice(0, 200);
      if (Array.isArray(cleanNewExtra.participants)) st.activeTopics[idx].participants = cleanNewExtra.participants.map(String).slice(0, 10);
    } else if (category === 'pendingThought' && Array.isArray(st.pendingThoughts)) {
      const idx = st.pendingThoughts.findIndex((t) => String(t?.text ?? '') === oldContent);
      if (idx < 0) { sendJson({ ok: false, error: '找不到要编辑的 pendingThought' }, 404); return; }
      if (newContent !== undefined) st.pendingThoughts[idx].text = newContent.slice(0, 200);
      if (cleanNewExtra.motivation !== undefined) st.pendingThoughts[idx].motivation = String(cleanNewExtra.motivation).slice(0, 50);
      if (cleanNewExtra.expiresAtMs !== undefined) st.pendingThoughts[idx].expiresAt = Date.now() + Math.max(0, Number(cleanNewExtra.expiresAtMs) || 0);
    } else if (category === 'memberImpression' && st.memberImpressions && typeof st.memberImpressions === 'object') {
      const oldTarget = target;
      if (['__proto__', 'constructor', 'prototype'].includes(oldTarget)) { sendJson({ ok: false, error: '非法的群友名字' }, 400); return; }
      const im = st.memberImpressions[oldTarget] || {};
      const newTarget = String(cleanNewExtra.target || oldTarget).trim();
      if (!newTarget || ['__proto__', 'constructor', 'prototype'].includes(newTarget)) { sendJson({ ok: false, error: '非法的群友名字' }, 400); return; }
      if (newContent !== undefined) {
        im.traits = newContent.split(/[,，、]/).map((s) => s.trim()).filter(Boolean).slice(0, 20);
      }
      if (cleanNewExtra.interactionCount !== undefined) im.interactionCount = Math.max(0, Number(cleanNewExtra.interactionCount) || 0);
      if (newTarget !== oldTarget) delete st.memberImpressions[oldTarget];
      st.memberImpressions[newTarget] = im;
    }
    saveSocialV2State();
    sendJson({ ok: true, key, category, memory: formatMemoryV2(st) });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/socialV2/memory') {
    const key = String(url.searchParams.get('key') ?? '').trim();
    const category = String(url.searchParams.get('category') ?? '').trim();
    if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
    if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
    if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
    if (req.headers['x-agent-token'] && !v2ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_query' }, 403); return; }
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
    sendJson({ ok: true, key, category, formatted: formatMemoryV2({ ...st, ...raw }), raw });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/socialV2/memory-remove') {
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    const category = String(body.category ?? '').trim();
    const content = String(body.content ?? '').trim();
    const target = String(body.target ?? '').trim();
    if (!key || !category) { sendJson({ ok: false, error: 'key/category 不能为空' }, 400); return; }
    if (!['activeTopic', 'pendingThought', 'memberImpression'].includes(category)) { sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression' }, 400); return; }
    if (category === 'memberImpression' && !target) { sendJson({ ok: false, error: 'memberImpression 需要 target 指定群友名字' }, 400); return; }
    if (category === 'memberImpression' && ['__proto__', 'constructor', 'prototype'].includes(target)) { sendJson({ ok: false, error: '非法的群友名字' }, 400); return; }
    if (category !== 'memberImpression' && !content) { sendJson({ ok: false, error: '该类别需要 content 指定要删除的记忆内容' }, 400); return; }
    if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
    if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
    if (req.headers['x-agent-token'] && !v2ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_remove' }, 403); return; }
    const st = getSocialV2State(key);
    if (category === 'activeTopic' && Array.isArray(st.activeTopics)) {
      st.activeTopics = st.activeTopics.filter((t) => String(t?.text ?? '') !== content);
    } else if (category === 'pendingThought' && Array.isArray(st.pendingThoughts)) {
      st.pendingThoughts = st.pendingThoughts.filter((t) => String(t?.text ?? '') !== content);
    } else if (category === 'memberImpression' && st.memberImpressions && typeof st.memberImpressions === 'object') {
      delete st.memberImpressions[target];
    }
    saveSocialV2State();
    sendJson({ ok: true, key, category, memory: formatMemoryV2(st) });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/socialV2/memory-clear') {
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    const category = String(body.category ?? '').trim();
    if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
    if (category && !['activeTopic', 'pendingThought', 'memberImpression'].includes(category)) { sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression' }, 400); return; }
    if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
    if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
    if (req.headers['x-agent-token'] && !v2ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_clear' }, 403); return; }
    const st = getSocialV2State(key);
    if (!category || category === 'activeTopic') st.activeTopics = [];
    if (!category || category === 'pendingThought') st.pendingThoughts = [];
    if (!category || category === 'memberImpression') st.memberImpressions = {};
    saveSocialV2State();
    sendJson({ ok: true, key, category: category || 'all', memory: formatMemoryV2(st) });
    return;
  }
  // ── 上下文持久化（Phase 0/1）：状态 / 立即总结 / 清空 ────────────────
  // Phase 3 P0：按当前话题检索 journal + episode（控制台/模型工具共用）。
  if (req.method === 'GET' && url.pathname === '/api/socialV2/recall') {
    const key = String(url.searchParams.get('key') ?? '').trim();
    const query = String(url.searchParams.get('q') ?? url.searchParams.get('query') ?? '').trim();
    if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
    if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) {
      sendJson({ ok: false, error: 'agent token 无效' }, 403);
      return;
    }
    if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) {
      sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
      return;
    }
    if (req.headers['x-agent-token'] && !v2ToolEnabled('recallMemory')) {
      sendJson({ ok: false, error: '工具未启用：qq_recall_memory' }, 403);
      return;
    }
    const limit = Math.min(20, Math.max(1, Number(url.searchParams.get('limit')) || 6));
    const fromRaw = url.searchParams.get('from');
    const toRaw = url.searchParams.get('to');
    const toMs = (v) => {
      if (v == null || v === '') return 0;
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) return n < 1e12 ? n * 1000 : n;
      const t = Date.parse(v);
      return Number.isFinite(t) ? t : 0;
    };
    const index = getRecallIndexV2(key);
    const results = searchMemory(index, query, {
      limit,
      from: toMs(fromRaw),
      to: toMs(toRaw),
      minScore: 0.1
    });
    sendJson({
      ok: true,
      key,
      query,
      count: results.length,
      results,
      index: { documents: index.docs.length, builtAt: index.builtAt }
    });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/socialV2/context-status') {
    const cm = contextCfg();
    void refreshContextNames().catch(() => {});
    // 24 号卡每行显示「今日总输入（含缓存，累计旧会话+摘要器）」。
    // 只读 token 缓存，不在这里现算（GET 不做全量扫描）。
    const usageSnapshot = deps.live.tokenUsage || loadTokenUsage();
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
        try { backfillLongTermMemory(STATE_DIR, key); longTerm = longTermStats(STATE_DIR, key); } catch {}
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
        inGroupList: isGroup ? deps.live.contextNameCache.groups.has(groupId) : true,
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
    sendJson({
      ok: true,
      enabled: cm.enabled !== false,
      rows,
      totals,
      // P2 跨会话人物记忆只做统计展示；列表走独立端点（避免 30 秒轮询拉 2000 人）。
      sharedMemory: sharedMemoryStats(STATE_DIR, cfg.socialV2?.sharedMemory || {}),
      tokenFuse: deps.ops.tokenFuseStatus?.() || null,
      backlogHistory: readBacklogHistory(STATE_DIR, 48)
    });
    return;
  }
}
