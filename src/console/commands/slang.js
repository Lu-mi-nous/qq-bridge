// R4.7-3：黑话库管理命令（新增/清空/批量/单条/提取/研究/配置）。
//
// 插件可用性由 facets 注入 `isAvailable()` 前置检查；路由不再直接摸 pluginHost。
// 所有写操作保留原校验、状态机与失效/清空行为。

export function createSlangCommands({
  live = {},
  cfg = {},
  SLANG_STATUS,
  createSlangEntry,
  saveSlangStore,
  log,
  slangWindows,
  slangExtractionCooldowns,
  slangSubmitTimes,
  slangResearchingIds,
  queueSlangTask,
  runSlangExtraction,
  runSlangResearch,
  invalidateSlangLearnerSession,
  ROOT,
  path,
  readJsonSafe,
  atomicWriteJson,
  isAvailable
} = {}) {
  const logLine = (message) => { try { log?.(message); } catch { /* 日志失败不影响主流程 */ } };
  const entries = () => live.slangEntries;

  function available() {
    try { return typeof isAvailable === 'function' ? isAvailable() : true; } catch { return false; }
  }

  function create(body = {}) {
    const content = String(body.content ?? '').trim();
    if (!content) return { ok: false, status: 400, error: '黑话内容不能为空' };
    if (entries().some((e) => e.content === content)) return { ok: false, status: 400, error: `黑话「${content}」已存在` };
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
    entries().push(entry);
    saveSlangStore?.();
    logLine(`控制台：新增黑话「${content}」`);
    return { ok: true, entry };
  }

  function clear(body = {}) {
    const status = String(body.status ?? '').trim();
    if (status && ![SLANG_STATUS.CANDIDATE, SLANG_STATUS.CONFIRMED, SLANG_STATUS.REJECTED].includes(status)) {
      return { ok: false, status: 400, error: `无效的 status：${status}，仅支持 candidate/confirmed/rejected 或留空全部删除` };
    }
    let removedCount = 0;
    if (status) {
      removedCount = entries().filter((e) => e.status === status).length;
      live.slangEntries = entries().filter((e) => e.status !== status);
    } else {
      removedCount = entries().length;
      live.slangEntries = [];
      // 清空所有时同步清掉待提取窗口和冷却，避免“删了又回来”
      slangWindows?.clear();
      slangExtractionCooldowns?.clear();
      slangSubmitTimes?.clear();
      slangResearchingIds?.clear();
    }
    saveSlangStore?.();
    logLine(`控制台：清空黑话 ${removedCount} 条${status ? `（${status}）` : ''}`);
    return { ok: true, removedCount };
  }

  function batchDelete(body = {}) {
    const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : [];
    const status = String(body.status ?? '').trim();
    if (ids.length) {
      const idSet = new Set(ids);
      const before = entries().length;
      live.slangEntries = entries().filter((e) => !idSet.has(e.id));
      const removedCount = before - entries().length;
      if (!removedCount) return { ok: false, status: 404, error: '没有匹配到要删除的黑话' };
      saveSlangStore?.();
      logLine(`控制台：批量删除黑话 ${removedCount} 条`);
      return { ok: true, removedCount };
    }
    if (status && ![SLANG_STATUS.CANDIDATE, SLANG_STATUS.CONFIRMED, SLANG_STATUS.REJECTED].includes(status)) {
      return { ok: false, status: 400, error: `无效的 status：${status}` };
    }
    if (!status) return { ok: false, status: 400, error: '请提供 ids 或 status' };
    const removedCount = entries().filter((e) => e.status === status).length;
    live.slangEntries = entries().filter((e) => e.status !== status);
    saveSlangStore?.();
    logLine(`控制台：批量删除黑话 ${removedCount} 条（${status}）`);
    return { ok: true, removedCount };
  }

  function batchConfirm(body = {}) {
    const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : [];
    if (!ids.length) return { ok: false, status: 400, error: '请选择要确认的黑话' };
    let confirmedCount = 0;
    let skippedCount = 0;
    const skipped = [];
    for (const id of ids) {
      const idx = entries().findIndex((e) => e.id === id);
      if (idx < 0) { skippedCount++; skipped.push({ id, reason: '不存在' }); continue; }
      const entry = entries()[idx];
      if (entry.status !== SLANG_STATUS.CANDIDATE) { skippedCount++; skipped.push({ id, content: entry.content, reason: '不是候选' }); continue; }
      if (!entry.meaning || !String(entry.meaning).trim()) { skippedCount++; skipped.push({ id, content: entry.content, reason: '缺少含义' }); continue; }
      entry.status = SLANG_STATUS.CONFIRMED;
      entry.updatedAt = new Date().toISOString();
      confirmedCount++;
    }
    if (confirmedCount) saveSlangStore?.();
    logLine(`控制台：批量确认黑话 ${confirmedCount} 条，跳过 ${skippedCount} 条`);
    return { ok: true, confirmedCount, skippedCount, skipped: skipped.slice(0, 20) };
  }

  function batchReject(body = {}) {
    const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : [];
    if (!ids.length) return { ok: false, status: 400, error: '请选择要拒绝的黑话' };
    let rejectedCount = 0;
    for (const id of ids) {
      const idx = entries().findIndex((e) => e.id === id);
      if (idx < 0) continue;
      const entry = entries()[idx];
      if (entry.status === SLANG_STATUS.REJECTED) continue;
      entry.status = SLANG_STATUS.REJECTED;
      entry.updatedAt = new Date().toISOString();
      rejectedCount++;
    }
    if (rejectedCount) saveSlangStore?.();
    logLine(`控制台：批量拒绝黑话 ${rejectedCount} 条`);
    return { ok: true, rejectedCount };
  }

  function update(id, body = {}) {
    const idx = entries().findIndex((e) => e.id === id);
    if (idx < 0) return { ok: false, status: 404, error: '黑话不存在' };
    const entry = { ...entries()[idx] };
    if (body.content !== undefined) entry.content = String(body.content ?? '').trim();
    if (body.content !== undefined && entries().some((e) => e.id !== id && e.content === entry.content)) {
      return { ok: false, status: 400, error: `黑话「${entry.content}」已存在` };
    }
    if (body.meaning !== undefined) entry.meaning = String(body.meaning ?? '').trim();
    if (body.usage !== undefined) entry.usage = String(body.usage ?? '').trim();
    if (body.example !== undefined) entry.example = String(body.example ?? '').trim();
    if (body.risk !== undefined) entry.risk = String(body.risk ?? '').trim();
    if (body.sources !== undefined) entry.sources = Array.isArray(body.sources) ? body.sources.map(String).filter(Boolean).slice(0, 10) : [];
    if (body.status !== undefined && [SLANG_STATUS.CANDIDATE, SLANG_STATUS.CONFIRMED, SLANG_STATUS.REJECTED].includes(body.status)) entry.status = body.status;
    if (!entry.content) return { ok: false, status: 400, error: '黑话内容不能为空' };
    entry.updatedAt = new Date().toISOString();
    live.slangEntries[idx] = entry;
    saveSlangStore?.();
    logLine(`控制台：更新黑话「${entry.content}」`);
    return { ok: true, entry };
  }

  function confirm(id, body = {}) {
    const idx = entries().findIndex((e) => e.id === id);
    if (idx < 0) return { ok: false, status: 404, error: '黑话不存在' };
    const entry = entries()[idx];
    if (body.meaning !== undefined) entry.meaning = String(body.meaning ?? '').trim();
    if (body.usage !== undefined) entry.usage = String(body.usage ?? '').trim();
    if (body.example !== undefined) entry.example = String(body.example ?? '').trim();
    if (body.risk !== undefined) entry.risk = String(body.risk ?? '').trim();
    if (body.sources !== undefined) entry.sources = Array.isArray(body.sources) ? body.sources.map(String).filter(Boolean).slice(0, 10) : [];
    if (!entry.meaning) return { ok: false, status: 400, error: '请先填写含义再确认，否则不会注入 AI 上下文' };
    entry.status = SLANG_STATUS.CONFIRMED;
    entry.updatedAt = new Date().toISOString();
    saveSlangStore?.();
    logLine(`控制台：确认黑话「${entry.content}」`);
    return { ok: true, entry };
  }

  function reject(id) {
    const idx = entries().findIndex((e) => e.id === id);
    if (idx < 0) return { ok: false, status: 404, error: '黑话不存在' };
    const entry = entries()[idx];
    entry.status = SLANG_STATUS.REJECTED;
    entry.updatedAt = new Date().toISOString();
    saveSlangStore?.();
    logLine(`控制台：拒绝黑话「${entry.content}」`);
    return { ok: true, entry };
  }

  function remove(id) {
    const idx = entries().findIndex((e) => e.id === id);
    if (idx < 0) return { ok: false, status: 404, error: '黑话不存在' };
    const [removed] = live.slangEntries.splice(idx, 1);
    saveSlangStore?.();
    logLine(`控制台：删除黑话「${removed.content}」`);
    return { ok: true, removed };
  }

  function extract(body = {}) {
    if (cfg.slang?.enabled === false) return { ok: false, status: 400, error: '黑话学习已关闭（slang.enabled=false）' };
    const key = String(body.key ?? '').trim();
    if (key && slangWindows?.has(key)) {
      queueSlangTask?.(() => runSlangExtraction?.(key));
      return { ok: true, key };
    }
    const firstKey = slangWindows?.keys().next().value;
    if (!firstKey) return { ok: false, status: 400, error: '当前没有可学习消息窗口' };
    queueSlangTask?.(() => runSlangExtraction?.(firstKey));
    return { ok: true, key: firstKey };
  }

  function research(body = {}) {
    if (cfg.slang?.enabled === false) return { ok: false, status: 400, error: '黑话学习已关闭（slang.enabled=false）' };
    const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
    const candidates = ids.length
      ? entries().filter((e) => ids.includes(e.id) && e.status === SLANG_STATUS.CANDIDATE)
      : entries().filter((e) => e.status === SLANG_STATUS.CANDIDATE);
    if (!candidates.length) return { ok: false, status: 400, error: '没有可研究的候选黑话' };
    queueSlangTask?.(() => runSlangResearch?.(candidates));
    return { ok: true, count: candidates.length };
  }

  function saveConfig(body = {}) {
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
      invalidateSlangLearnerSession?.();
      logLine('黑话学习 preset 已变更，已重置学习会话');
    } else if (body.workspaceTitle !== undefined && String(body.workspaceTitle ?? '').trim() !== String(oldWorkspaceTitle ?? '')) {
      invalidateSlangLearnerSession?.();
      logLine('黑话学习工作区名已变更，已重置学习会话');
    }
    logLine('控制台：黑话系统配置已更新');
    return { ok: true, config: cfg.slang };
  }

  return { available, create, clear, batchDelete, batchConfirm, batchReject, update, confirm, reject, remove, extract, research, saveConfig };
}
