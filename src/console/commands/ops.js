// R4.7-3：重置与重启命令。
//
// 这三个动作都是破坏性/进程级操作，原先在路由里直接摸 40+ 个运行态集合。
// 收进命令层后，路由只解析 body 与转发；「重置保留活动日志以外的什么」
// 「自重启如何避免双实例」这些约束集中在这里维护。
//
// 可测试性：定时器与退出函数可注入，测试只验证“安排了什么”，不会真的重启。

export function createOpsCommands({
  config = {},
  sessions = {},
  social = {},
  operations = {},
  setTimer = (fn, ms) => setTimeout(fn, ms)
} = {}) {
  const {
    ROOT,
    STATE_DIR,
    ACTIVITY_LOG,
    KNOWN_AGENT_TOKENS,
    cfg = {},
    fs,
    path,
    log,
    unwrap
  } = config;
  const {
    state = {},
    socialV2 = { conversations: new Map() },
    social: socialRuntime = {},
    reverse,
    collectors,
    sendToolSucceededSessions,
    pendingSendToolCalls,
    v2TurnStartAt,
    toolCallNames,
    pending,
    queued,
    queuedHintAt,
    sessionPromises,
    messageMediaStore,
    slangWindows,
    slangExtractionCooldowns,
    slangSubmitTimes,
    pendingWakeKeys,
    wakeConfigUpdatedKeys,
    markReadCalledKeys,
    wakeConfigMissCount,
    seenForwardIds,
    saveState
  } = sessions;
  const {
    cancelSocialTimers,
    clearSocialV2Timers,
    drainPromptQueue,
    drainAllPromptQueues,
    cancelAllSocialTimers,
    clearAllSocialV2Timers,
    cancelPendingEntry,
    saveSocialV2State
  } = social;
  const { ops = {}, api, releaseLock } = operations;
  const logLine = (message) => { try { log?.(message); } catch { /* 日志失败不影响主流程 */ } };

  /** POST /api/session/reset：清除单个会话的上下文并归档旧 DSH 会话。 */
  async function resetSession(key) {
    if (!key || !state.sessions?.[key]) return { ok: false, status: 404, error: '会话不存在' };
    ops.bumpSessionEpoch?.();
    const oldSessionId = state.sessions[key];
    ops.recordSessionHistory?.(oldSessionId, key, 'reset');
    delete state.sessions[key];
    if (state.sessionMeta) delete state.sessionMeta[key];
    reverse?.delete(oldSessionId);
    ops.clearSessionTracking?.(oldSessionId);
    collectors?.delete(oldSessionId);
    sendToolSucceededSessions?.delete(oldSessionId);
    pendingSendToolCalls?.delete(oldSessionId);
    v2TurnStartAt?.delete(oldSessionId);
    toolCallNames?.delete(oldSessionId);
    const pe = pending?.get(key);
    if (pe) {
      clearTimeout(pe.timer);
      Promise.resolve(cancelPendingEntry?.(pe)).catch(() => {});
    }
    pending?.delete(key);
    queued?.delete(key);
    queuedHintAt?.delete(key);
    sessionPromises?.delete(key);
    drainPromptQueue?.(key, '会话已重置');
    socialRuntime.recentMessages?.delete(key);
    messageMediaStore?.delete(key);
    socialRuntime.pendingSummaries?.delete(key);
    socialRuntime.states?.delete(key);
    socialRuntime.silentContext?.delete(key);
    socialRuntime.silentTurns?.delete(oldSessionId);
    socialRuntime.exitingSessions?.delete(oldSessionId);
    slangWindows?.delete(key);
    slangExtractionCooldowns?.delete(key);
    slangSubmitTimes?.delete(key);
    cancelSocialTimers?.(key);
    clearSocialV2Timers?.(key);
    pendingWakeKeys?.delete(key);
    wakeConfigUpdatedKeys?.delete(key);
    markReadCalledKeys?.delete(key);
    wakeConfigMissCount?.delete(key);
    const removedV2 = socialV2.conversations.get(key);
    if (removedV2?.agentToken) KNOWN_AGENT_TOKENS?.delete(removedV2.agentToken);
    socialV2.conversations.delete(key);
    seenForwardIds?.delete(key);
    saveSocialV2State?.();
    saveState?.();
    try { await api?.workspace?.archiveSession?.({ sessionId: oldSessionId }); } catch { /* 归档失败不阻塞重置 */ }
    logLine(`控制台：已清除会话上下文 ${key}（旧会话 ${oldSessionId} 已归档）`);
    return { ok: true, key, archived: oldSessionId };
  }

  /** POST /api/workspace/reset：归档并删除工作区，清空全部会话映射与活动日志。 */
  async function resetWorkspace() {
    ops.bumpSessionEpoch?.();
    let archivedCount = 0;
    try {
      const ws = unwrap ? unwrap(await api.workspace.list({}), 'workspace.list') : await api.workspace.list({});
      const qq = ws.items.find((w) => w.title === cfg.workspaceTitle);
      if (qq) {
        for (const sid of qq.sessionIds) {
          try { await api.workspace.archiveSession({ sessionId: sid }); archivedCount += 1; } catch { /* 单个归档失败继续 */ }
        }
        try { await api.workspace.delete({ workspaceId: qq.workspaceId }); } catch { /* 删除失败不阻塞清理 */ }
      }
    } catch { /* 列工作区失败也继续清本地状态 */ }
    for (const entry of pending?.values() ?? []) {
      clearTimeout(entry.timer);
      Promise.resolve(cancelPendingEntry?.(entry)).catch(() => {});
    }
    pending?.clear();
    queued?.clear();
    queuedHintAt?.clear();
    sessionPromises?.clear();
    drainAllPromptQueues?.('工作区已清空');
    socialRuntime.states?.clear();
    socialRuntime.recentMessages?.clear();
    messageMediaStore?.clear();
    seenForwardIds?.clear();
    socialRuntime.pendingSummaries?.clear();
    socialRuntime.silentContext?.clear();
    socialRuntime.silentTurns?.clear();
    socialRuntime.exitingSessions?.clear();
    slangWindows?.clear();
    slangExtractionCooldowns?.clear();
    slangSubmitTimes?.clear();
    cancelAllSocialTimers?.();
    clearAllSocialV2Timers?.();
    for (const st of socialV2.conversations.values()) {
      if (st?.agentToken) KNOWN_AGENT_TOKENS?.delete(st.agentToken);
    }
    socialV2.conversations.clear();
    saveSocialV2State?.();
    for (const [key, sid] of Object.entries(state.sessions || {})) {
      ops.recordSessionHistory?.(sid, key, 'workspace');
    }
    state.sessions = {};
    state.sessionMeta = {};
    reverse?.clear();
    ops.clearAllSessionTracking?.();
    collectors?.clear();
    sendToolSucceededSessions?.clear();
    pendingSendToolCalls?.clear();
    v2TurnStartAt?.clear();
    toolCallNames?.clear();
    saveState?.();
    try { fs.writeFileSync(ACTIVITY_LOG, ''); } catch { /* 日志文件可能不存在 */ }
    logLine(`控制台：已清空 QQ 聊天工作区（归档 ${archivedCount} 个会话，映射与活动日志已清空）`);
    return { ok: true, archivedCount };
  }

  /**
   * POST /api/restart：detached 子进程 + stdio 忽略 + unref，父进程退出后子进程继续跑。
   * 子进程等 800ms 再启动（给父进程释放 :3100 和锁文件的时间），并通过
   * QQB_RESTARTED_BY 标记来源。锁文件由子进程 acquireLock() 兜底，避免双实例。
   *
   * 2026-10-21 用户反馈「重启按钮没有效果」：真实原因是没有任何守护在跑，
   * 只 process.exit 会彻底停服；所以这里必须自己拉起新进程，而不是等外部窗口。
   */
  function scheduleRestart({ delayMs = 500 } = {}) {
    const logFile = path.join(STATE_DIR, 'bridge.log');
    setTimer(async () => {
      logLine('控制台：重启桥接（将以 detached 子进程自重启）');
      let spawned = false;
      try {
        const { spawn } = await import('node:child_process');
        const out = fs.openSync(logFile, 'a');
        const child = spawn(process.execPath, [path.join(ROOT, 'src', 'bridge.js')], {
          cwd: ROOT,
          detached: true,
          stdio: ['ignore', out, out],
          windowsHide: true,
          env: { ...process.env, QQB_RESTARTED_BY: 'console' }
        });
        child.unref();
        spawned = true;
      } catch (error) {
        logLine(`重启失败：无法拉起新进程（${error?.message ?? error}）；若由守护脚本启动，会由它恢复`);
      }
      releaseLock?.();
      process.exit(spawned ? 0 : 1);
    }, delayMs);
    return { ok: true, message: '正在重启桥接（已安排自重启，约 3~5 秒恢复）…' };
  }

  return { resetSession, resetWorkspace, scheduleRestart };
}
