// 控制台路由域：黑话学习（R4）。
//
// 从 console-server.js 原样搬出，只调整了缩进；鉴权 / CSRF / agent 白名单 /
// 暂停隔离仍由 console-server 统一处理，走到这里时请求已通过全部前置校验。
export const id = '02-slang';
export const title = '黑话学习';

/** 本模块负责的路由；console-server 据此分派，不必解析 handler 内部。 */
export const routes = [
  ['GET', '/api/slang', 'exact'],
  ['POST', '/api/slang', 'exact'],
  ['POST', '/api/slang/clear', 'exact'],
  ['POST', '/api/slang/batch-delete', 'exact'],
  ['POST', '/api/slang/batch-confirm', 'exact'],
  ['POST', '/api/slang/batch-reject', 'exact'],
  ['POST', '/api/slang/extract', 'exact'],
  ['POST', '/api/slang/research', 'exact'],
  ['POST', '/api/slang/config', 'exact'],
  // 动态路径：PATCH/DELETE /api/slang/:id、POST /api/slang/:id/(confirm|reject)。
  // 模块内用正则再判断；精确路由优先命中，不会抢走 /api/slang/extract 等。
  ['PATCH', '/api/slang/', 'prefix'],
  ['DELETE', '/api/slang/', 'prefix'],
  ['POST', '/api/slang/', 'prefix']
];

export async function handle(req, res, url, ctx) {
  const { sendJson, readBody, deps } = ctx;
  const {
    ROOT,
    SLANG_STATUS,
    atomicWriteJson,
    cfg,
    createSlangEntry,
    invalidateSlangLearnerSession,
    log,
    path,
    queueSlangTask,
    readJsonSafe,
    runSlangExtraction,
    runSlangResearch,
    saveSlangStore,
    slangExtractionCooldowns,
    slangResearchingIds,
    slangSubmitTimes,
    slangWindows
  } = deps;

  // ── 黑话库管理 ──────────────────────────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/api/slang') {
    const status = url.searchParams.get('status') || '';
    const list = status ? deps.live.slangEntries.filter((e) => e.status === status) : deps.live.slangEntries;
    sendJson({ entries: list, config: cfg.slang });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/slang') {
    const body = await readBody();
    const content = String(body.content ?? '').trim();
    if (!content) { sendJson({ ok: false, error: '黑话内容不能为空' }, 400); return; }
    if (deps.live.slangEntries.some((e) => e.content === content)) { sendJson({ ok: false, error: `黑话「${content}」已存在` }, 400); return; }
    const entry = createSlangEntry({
      content,
      meaning: String(body.meaning ?? '').trim(),
      usage: String(body.usage ?? '').trim(),
      example: String(body.example ?? '').trim(),
      risk: String(body.risk ?? '').trim(),
      sources: Array.isArray(body.sources) ? body.sources.map(String).filter(Boolean) : [],
      status: body.status === SLANG_STATUS.CANDIDATE ? SLANG_STATUS.CANDIDATE : SLANG_STATUS.CONFIRMED,
      source: 'manual',
      evidence: Array.isArray(body.evidence) ? body.evidence : []
    });
    deps.live.slangEntries.push(entry);
    saveSlangStore();
    log(`控制台：新增黑话「${content}」`);
    sendJson({ ok: true, entry });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/slang/clear') {
    const body = await readBody();
    const status = String(body.status ?? '').trim();
    if (status && ![SLANG_STATUS.CANDIDATE, SLANG_STATUS.CONFIRMED, SLANG_STATUS.REJECTED].includes(status)) {
      sendJson({ ok: false, error: `无效的 status：${status}，仅支持 candidate/confirmed/rejected 或留空全部删除` }, 400);
      return;
    }
    let removedCount = 0;
    if (status) {
      removedCount = deps.live.slangEntries.filter((e) => e.status === status).length;
      deps.live.slangEntries = deps.live.slangEntries.filter((e) => e.status !== status);
    } else {
      removedCount = deps.live.slangEntries.length;
      deps.live.slangEntries = [];
      // 清空所有时同步清掉待提取窗口和冷却，避免“删了又回来”
      slangWindows.clear();
      slangExtractionCooldowns.clear();
      slangSubmitTimes.clear();
      slangResearchingIds.clear();
    }
    saveSlangStore();
    log(`控制台：清空黑话 ${removedCount} 条${status ? `（${status}）` : ''}`);
    sendJson({ ok: true, removedCount });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/slang/batch-delete') {
    const body = await readBody();
    const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : [];
    const status = String(body.status ?? '').trim();
    if (ids.length) {
      const idSet = new Set(ids);
      const before = deps.live.slangEntries.length;
      deps.live.slangEntries = deps.live.slangEntries.filter((e) => !idSet.has(e.id));
      const removedCount = before - deps.live.slangEntries.length;
      if (!removedCount) { sendJson({ ok: false, error: '没有匹配到要删除的黑话' }, 404); return; }
      saveSlangStore();
      log(`控制台：批量删除黑话 ${removedCount} 条`);
      sendJson({ ok: true, removedCount });
      return;
    }
    if (status && ![SLANG_STATUS.CANDIDATE, SLANG_STATUS.CONFIRMED, SLANG_STATUS.REJECTED].includes(status)) {
      sendJson({ ok: false, error: `无效的 status：${status}` }, 400);
      return;
    }
    if (!status) { sendJson({ ok: false, error: '请提供 ids 或 status' }, 400); return; }
    const removedCount = deps.live.slangEntries.filter((e) => e.status === status).length;
    deps.live.slangEntries = deps.live.slangEntries.filter((e) => e.status !== status);
    saveSlangStore();
    log(`控制台：批量删除黑话 ${removedCount} 条（${status}）`);
    sendJson({ ok: true, removedCount });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/slang/batch-confirm') {
    const body = await readBody();
    const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : [];
    if (!ids.length) { sendJson({ ok: false, error: '请选择要确认的黑话' }, 400); return; }
    let confirmedCount = 0;
    let skippedCount = 0;
    const skipped = [];
    for (const id of ids) {
      const idx = deps.live.slangEntries.findIndex((e) => e.id === id);
      if (idx < 0) { skippedCount++; skipped.push({ id, reason: '不存在' }); continue; }
      const entry = deps.live.slangEntries[idx];
      if (entry.status !== SLANG_STATUS.CANDIDATE) { skippedCount++; skipped.push({ id, content: entry.content, reason: '不是候选' }); continue; }
      if (!entry.meaning || !String(entry.meaning).trim()) { skippedCount++; skipped.push({ id, content: entry.content, reason: '缺少含义' }); continue; }
      entry.status = SLANG_STATUS.CONFIRMED;
      entry.updatedAt = new Date().toISOString();
      confirmedCount++;
    }
    if (confirmedCount) saveSlangStore();
    log(`控制台：批量确认黑话 ${confirmedCount} 条，跳过 ${skippedCount} 条`);
    sendJson({ ok: true, confirmedCount, skippedCount, skipped: skipped.slice(0, 20) });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/slang/batch-reject') {
    const body = await readBody();
    const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : [];
    if (!ids.length) { sendJson({ ok: false, error: '请选择要拒绝的黑话' }, 400); return; }
    let rejectedCount = 0;
    for (const id of ids) {
      const idx = deps.live.slangEntries.findIndex((e) => e.id === id);
      if (idx < 0) continue;
      const entry = deps.live.slangEntries[idx];
      if (entry.status === SLANG_STATUS.REJECTED) continue;
      entry.status = SLANG_STATUS.REJECTED;
      entry.updatedAt = new Date().toISOString();
      rejectedCount++;
    }
    if (rejectedCount) saveSlangStore();
    log(`控制台：批量拒绝黑话 ${rejectedCount} 条`);
    sendJson({ ok: true, rejectedCount });
    return;
  }
  const slangMatch = url.pathname.match(/^\/api\/slang\/([^/]+)(?:\/(confirm|reject))?$/);
  if (req.method === 'PATCH' && slangMatch && !slangMatch[2]) {
    const id = slangMatch[1];
    const idx = deps.live.slangEntries.findIndex((e) => e.id === id);
    if (idx < 0) { sendJson({ ok: false, error: '黑话不存在' }, 404); return; }
    const body = await readBody();
    const entry = { ...deps.live.slangEntries[idx] };
    if (body.content !== undefined) entry.content = String(body.content ?? '').trim();
    if (body.content !== undefined && deps.live.slangEntries.some((e) => e.id !== id && e.content === entry.content)) {
      sendJson({ ok: false, error: `黑话「${entry.content}」已存在` }, 400);
      return;
    }
    if (body.meaning !== undefined) entry.meaning = String(body.meaning ?? '').trim();
    if (body.usage !== undefined) entry.usage = String(body.usage ?? '').trim();
    if (body.example !== undefined) entry.example = String(body.example ?? '').trim();
    if (body.risk !== undefined) entry.risk = String(body.risk ?? '').trim();
    if (body.sources !== undefined) entry.sources = Array.isArray(body.sources) ? body.sources.map(String).filter(Boolean).slice(0, 10) : [];
    if (body.status !== undefined && [SLANG_STATUS.CANDIDATE, SLANG_STATUS.CONFIRMED, SLANG_STATUS.REJECTED].includes(body.status)) entry.status = body.status;
    if (!entry.content) { sendJson({ ok: false, error: '黑话内容不能为空' }, 400); return; }
    entry.updatedAt = new Date().toISOString();
    deps.live.slangEntries[idx] = entry;
    saveSlangStore();
    log(`控制台：更新黑话「${entry.content}」`);
    sendJson({ ok: true, entry });
    return;
  }
  if (req.method === 'POST' && slangMatch && slangMatch[2] === 'confirm') {
    const id = slangMatch[1];
    const idx = deps.live.slangEntries.findIndex((e) => e.id === id);
    if (idx < 0) { sendJson({ ok: false, error: '黑话不存在' }, 404); return; }
    const body = await readBody();
    const entry = deps.live.slangEntries[idx];
    if (body.meaning !== undefined) entry.meaning = String(body.meaning ?? '').trim();
    if (body.usage !== undefined) entry.usage = String(body.usage ?? '').trim();
    if (body.example !== undefined) entry.example = String(body.example ?? '').trim();
    if (body.risk !== undefined) entry.risk = String(body.risk ?? '').trim();
    if (body.sources !== undefined) entry.sources = Array.isArray(body.sources) ? body.sources.map(String).filter(Boolean).slice(0, 10) : [];
    if (!entry.meaning) {
      sendJson({ ok: false, error: '请先填写含义再确认，否则不会注入 AI 上下文' }, 400);
      return;
    }
    entry.status = SLANG_STATUS.CONFIRMED;
    entry.updatedAt = new Date().toISOString();
    saveSlangStore();
    log(`控制台：确认黑话「${entry.content}」`);
    sendJson({ ok: true, entry });
    return;
  }
  if (req.method === 'POST' && slangMatch && slangMatch[2] === 'reject') {
    const id = slangMatch[1];
    const idx = deps.live.slangEntries.findIndex((e) => e.id === id);
    if (idx < 0) { sendJson({ ok: false, error: '黑话不存在' }, 404); return; }
    const entry = deps.live.slangEntries[idx];
    entry.status = SLANG_STATUS.REJECTED;
    entry.updatedAt = new Date().toISOString();
    saveSlangStore();
    log(`控制台：拒绝黑话「${entry.content}」`);
    sendJson({ ok: true, entry });
    return;
  }
  if (req.method === 'DELETE' && slangMatch && !slangMatch[2]) {
    const id = slangMatch[1];
    const idx = deps.live.slangEntries.findIndex((e) => e.id === id);
    if (idx < 0) { sendJson({ ok: false, error: '黑话不存在' }, 404); return; }
    const [removed] = deps.live.slangEntries.splice(idx, 1);
    saveSlangStore();
    log(`控制台：删除黑话「${removed.content}」`);
    sendJson({ ok: true, removed });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/slang/extract') {
    if (cfg.slang?.enabled === false) { sendJson({ ok: false, error: '黑话学习已关闭（slang.enabled=false）' }, 400); return; }
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    if (key && slangWindows.has(key)) {
      queueSlangTask(() => runSlangExtraction(key));
      sendJson({ ok: true, key });
    } else {
      const firstKey = slangWindows.keys().next().value;
      if (!firstKey) { sendJson({ ok: false, error: '当前没有可学习消息窗口' }, 400); return; }
      queueSlangTask(() => runSlangExtraction(firstKey));
      sendJson({ ok: true, key: firstKey });
    }
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/slang/research') {
    if (cfg.slang?.enabled === false) { sendJson({ ok: false, error: '黑话学习已关闭（slang.enabled=false）' }, 400); return; }
    const body = await readBody();
    const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
    const candidates = ids.length
      ? deps.live.slangEntries.filter((e) => ids.includes(e.id) && e.status === SLANG_STATUS.CANDIDATE)
      : deps.live.slangEntries.filter((e) => e.status === SLANG_STATUS.CANDIDATE);
    if (!candidates.length) { sendJson({ ok: false, error: '没有可研究的候选黑话' }, 400); return; }
    queueSlangTask(() => runSlangResearch(candidates));
    sendJson({ ok: true, count: candidates.length });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/slang/config') {
    const body = await readBody();
    const oldPreset = cfg.slang?.learnerPreset;
    const oldWorkspaceTitle = cfg.slang?.workspaceTitle;
    const configFile = path.join(ROOT, 'config.json');
    const file = readJsonSafe(configFile, null, true);
    const merged = { ...(file.slang ?? {}), ...body };
    if (typeof merged.enabled === 'boolean') merged.enabled = merged.enabled;
    else if (merged.enabled !== undefined) merged.enabled = merged.enabled === true;
    if (merged.extractMinMessages !== undefined) merged.extractMinMessages = Math.max(1, Math.round(Number(merged.extractMinMessages) || 1));
    if (merged.extractCooldownMs !== undefined) merged.extractCooldownMs = Math.max(0, Math.round(Number(merged.extractCooldownMs) || 0));
    if (merged.injectMax !== undefined) merged.injectMax = Math.min(30, Math.max(1, Math.round(Number(merged.injectMax) || 1)));
    if (merged.autoResearch !== undefined) merged.autoResearch = merged.autoResearch === true;
    if (merged.learnerPreset !== undefined) merged.learnerPreset = String(merged.learnerPreset ?? '').trim();
    if (merged.workspaceTitle !== undefined) merged.workspaceTitle = String(merged.workspaceTitle ?? '').trim() || 'QQ 黑话学习';
    if (body.inferenceThresholds !== undefined) {
      const raw = Array.isArray(body.inferenceThresholds)
        ? body.inferenceThresholds
        : String(body.inferenceThresholds).split(/[,，\s]+/);
      merged.inferenceThresholds = [...new Set(raw.map((n) => Math.max(1, Math.round(Number(n) || 1))))].sort((a, b) => a - b);
      if (!merged.inferenceThresholds.length) merged.inferenceThresholds = [2, 4, 8];
    }
    file.slang = merged;
    atomicWriteJson(configFile, file);
    cfg.slang = { ...cfg.slang, ...merged };
    if (body.learnerPreset !== undefined && String(body.learnerPreset ?? '').trim() !== String(oldPreset ?? '')) {
      invalidateSlangLearnerSession();
      log('黑话学习 preset 已变更，已重置学习会话');
    } else if (body.workspaceTitle !== undefined && String(body.workspaceTitle ?? '').trim() !== String(oldWorkspaceTitle ?? '')) {
      invalidateSlangLearnerSession();
      log('黑话学习工作区名已变更，已重置学习会话');
    }
    log('控制台：黑话系统配置已更新');
    sendJson({ ok: true, config: cfg.slang });
    return;
  }

  // 前缀路由兜底：/api/slang/<未知子路径> 不能静默挂起（原内联链会落到全局 404）。
  sendJson({ ok: false, error: 'not found' }, 404);
}
