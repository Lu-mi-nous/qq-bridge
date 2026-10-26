// 会话服务（R3-1）：QQ 会话 ↔ DSH 会话的映射、代际与并发创建。
//
// 只接管「映射」这一层；群聊记忆、发送队列、pending 等仍由 bridge 的编排层负责。
// 依赖全部显式注入，便于测试与后续继续拆分。
import fs from 'node:fs';

export function createSessionService({
  state,
  reverse,
  sessionPromises,
  getEpoch,
  getMode,
  getPreset,
  getSessionDir,
  needsNewSession,
  createDshSession,
  archiveSession,
  ensureVisionModel,
  retireForModeChange,
  sessionHistory,
  saveState,
  log = () => {},
  now = Date.now
} = {}) {
  if (!state || typeof state !== 'object') throw new Error('createSessionService: state 不能为空');
  if (!(reverse instanceof Map)) throw new Error('createSessionService: reverse 必须是 Map');
  if (!(sessionPromises instanceof Map)) throw new Error('createSessionService: sessionPromises 必须是 Map');

  function metaOf(key) {
    if (!state.sessionMeta || typeof state.sessionMeta !== 'object') state.sessionMeta = {};
    return state.sessionMeta[key];
  }

  async function ensureSession(key) {
    const epoch = getEpoch();
    const existing = state.sessions[key];
    const desiredMode = getMode();
    const desiredPreset = getPreset(key, desiredMode) ?? '';
    if (existing) {
      // reset/清空工作区期间旧映射可能尚未清理；发现代际不匹配必须丢弃旧会话，防止复活。
      if (epoch !== getEpoch()) {
        sessionHistory.record(existing, key, 'reset');
        delete state.sessions[key];
        if (state.sessionMeta) delete state.sessionMeta[key];
        if (reverse.get(existing) === key) reverse.delete(existing);
        try { await archiveSession(existing); } catch {}
      } else {
        const meta = metaOf(key);
        if (needsNewSession(meta, { mode: desiredMode, preset: desiredPreset })) {
          log(`[会话] ${key} 模式/预设变化 ${meta?.mode || '?'}/${meta?.preset || '默认'} → ${desiredMode}/${desiredPreset || '默认'}，重建会话`);
          await retireForModeChange(key, existing, meta, { mode: desiredMode, preset: desiredPreset });
        } else {
          if (!meta) {
            state.sessionMeta[key] = { mode: desiredMode, preset: desiredPreset, at: now() };
            saveState();
            log(`[会话] ${key} 缺少模式元数据，按当前模式接管（${desiredMode}/${desiredPreset || '默认'}）`);
          }
          await ensureVisionModel(existing);
          return existing;
        }
      }
    }
    if (sessionPromises.has(key)) return sessionPromises.get(key);
    const promise = (async () => {
      const dir = getSessionDir();
      fs.mkdirSync(dir, { recursive: true });
      let sessionId;
      try {
        sessionId = await createDshSession({ key, dir, preset: getPreset(key, getMode()) });
      } catch (error) {
        log(`[会话] ${key} 创建失败：${error?.message ?? error}`);
        throw error;
      }
      if (!sessionId) throw new Error(`[会话] ${key} 创建失败：未返回 sessionId`);
      // reset/清空工作区期间创建完成：丢弃，防止旧会话复活
      if (epoch !== getEpoch()) {
        log(`会话创建期间发生 reset，丢弃 ${key} 的新会话（${sessionId}）`);
        try { await archiveSession(sessionId); } catch {}
        throw new Error('会话创建期间已重置，丢弃新会话');
      }
      state.sessions[key] = sessionId;
      state.sessionMeta[key] = {
        mode: getMode(),
        preset: getPreset(key, getMode()) ?? '',
        at: now()
      };
      reverse.set(sessionId, key);
      sessionHistory.record(sessionId, key, 'create');
      saveState();
      await ensureVisionModel(sessionId);
      log(`新会话 ${key} -> ${sessionId}（模式 ${getMode()}，preset: ${getPreset(key, getMode()) ?? '默认'}）`);
      return sessionId;
    })();
    sessionPromises.set(key, promise);
    try {
      return await promise;
    } finally {
      if (sessionPromises.get(key) === promise) sessionPromises.delete(key);
    }
  }

  /** 仅处理映射/代际；业务状态清理由调用方负责。返回旧 sessionId。 */
  function detachMapping(key, reason = 'reset') {
    const old = state.sessions[key];
    if (!old) return '';
    sessionHistory.record(old, key, reason);
    delete state.sessions[key];
    if (state.sessionMeta) delete state.sessionMeta[key];
    if (reverse.get(old) === key) reverse.delete(old);
    sessionPromises.delete(key);
    saveState();
    return old;
  }

  return {
    ensureSession,
    detachMapping,
    get: (key) => state.sessions[key] || '',
    mapping: () => ({ ...state.sessions }),
    metaOf
  };
}
