// 控制台路由域：重置与重启（R4）。
//
// 从 console-server.js 原样搬出，只调整了缩进；鉴权 / CSRF / agent 白名单 /
// 暂停隔离仍由 console-server 统一处理，走到这里时请求已通过全部前置校验。
export const id = '18-ops';
export const title = '重置与重启';

/** 本模块负责的路由；console-server 据此分派，不必解析 handler 内部。 */
export const routes = [
  ['POST', '/api/session/reset', 'exact'],
  ['POST', '/api/workspace/reset', 'exact'],
  ['POST', '/api/restart', 'exact']
];

export async function handle(req, res, url, ctx) {
  const { sendJson, readBody, deps } = ctx;
  const {
    ACTIVITY_LOG,
    KNOWN_AGENT_TOKENS,
    ROOT,
    STATE_DIR,
    api,
    cancelAllSocialTimers,
    cancelPendingEntry,
    cancelSocialTimers,
    cfg,
    clearAllSocialV2Timers,
    clearSocialV2Timers,
    collectors,
    drainAllPromptQueues,
    drainPromptQueue,
    fs,
    log,
    markReadCalledKeys,
    messageMediaStore,
    path,
    pending,
    pendingSendToolCalls,
    pendingWakeKeys,
    queued,
    queuedHintAt,
    releaseLock,
    reverse,
    saveSocialV2State,
    saveState,
    seenForwardIds,
    sendToolSucceededSessions,
    sessionPromises,
    slangExtractionCooldowns,
    slangSubmitTimes,
    slangWindows,
    social,
    socialV2,
    state,
    toolCallNames,
    unwrap,
    v2TurnStartAt,
    wakeConfigMissCount,
    wakeConfigUpdatedKeys
  } = deps;

  // ── 清除上下文 / 清空工作区 ──────────────────────────────────────────
  if (req.method === 'POST' && url.pathname === '/api/session/reset') {
    const body = await readBody();
    const key = String(body.key ?? '');
    if (!key || !state.sessions[key]) { sendJson({ ok: false, error: '会话不存在' }, 404); return; }
    deps.ops.bumpSessionEpoch();
    const oldSessionId = state.sessions[key];
    deps.ops.recordSessionHistory?.(oldSessionId, key, 'reset');
    delete state.sessions[key];
    if (state.sessionMeta) delete state.sessionMeta[key];
    reverse.delete(oldSessionId);
    deps.ops.clearSessionTracking(oldSessionId);
    collectors.delete(oldSessionId);
    sendToolSucceededSessions.delete(oldSessionId);
    pendingSendToolCalls.delete(oldSessionId);
    v2TurnStartAt.delete(oldSessionId);
    toolCallNames.delete(oldSessionId);
    const pe = pending.get(key);
    if (pe) {
      clearTimeout(pe.timer);
      cancelPendingEntry(pe).catch(() => {});
    }
    pending.delete(key);
    queued.delete(key);
    queuedHintAt.delete(key);
    sessionPromises.delete(key);
    drainPromptQueue(key, '会话已重置');
    social.recentMessages.delete(key);
    messageMediaStore.delete(key);
    social.pendingSummaries.delete(key);
    social.states.delete(key);
    social.silentContext.delete(key);
    social.silentTurns.delete(oldSessionId);
    social.exitingSessions.delete(oldSessionId);
    slangWindows.delete(key);
    slangExtractionCooldowns.delete(key);
    slangSubmitTimes.delete(key);
    cancelSocialTimers(key);
    clearSocialV2Timers(key);
    pendingWakeKeys.delete(key);
    wakeConfigUpdatedKeys.delete(key);
    markReadCalledKeys.delete(key);
    wakeConfigMissCount.delete(key);
    const removedV2 = socialV2.conversations.get(key);
    if (removedV2?.agentToken) KNOWN_AGENT_TOKENS.delete(removedV2.agentToken);
    socialV2.conversations.delete(key);
    seenForwardIds.delete(key);
    saveSocialV2State();
    saveState();
    try { await api.workspace.archiveSession({ sessionId: oldSessionId }); } catch {}
    log(`控制台：已清除会话上下文 ${key}（旧会话 ${oldSessionId} 已归档）`);
    sendJson({ ok: true, key, archived: oldSessionId });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/workspace/reset') {
    deps.ops.bumpSessionEpoch();
    let archivedCount = 0;
    try {
      const ws = unwrap(await api.workspace.list({}), 'workspace.list');
      const qq = ws.items.find((w) => w.title === cfg.workspaceTitle);
      if (qq) {
        for (const sid of qq.sessionIds) {
          try { await api.workspace.archiveSession({ sessionId: sid }); archivedCount += 1; } catch {}
        }
        try { await api.workspace.delete({ workspaceId: qq.workspaceId }); } catch {}
      }
    } catch {}
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      cancelPendingEntry(entry).catch(() => {});
    }
    pending.clear();
    queued.clear();
    queuedHintAt.clear();
    sessionPromises.clear();
    drainAllPromptQueues('工作区已清空');
    social.states.clear();
    social.recentMessages.clear();
    messageMediaStore.clear();
    seenForwardIds.clear();
    social.pendingSummaries.clear();
    social.silentContext.clear();
    social.silentTurns.clear();
    social.exitingSessions.clear();
    slangWindows.clear();
    slangExtractionCooldowns.clear();
    slangSubmitTimes.clear();
    cancelAllSocialTimers();
    clearAllSocialV2Timers();
    for (const st of socialV2.conversations.values()) {
      if (st?.agentToken) KNOWN_AGENT_TOKENS.delete(st.agentToken);
    }
    socialV2.conversations.clear();
    saveSocialV2State();
    for (const [key, sid] of Object.entries(state.sessions || {})) {
      deps.ops.recordSessionHistory?.(sid, key, 'workspace');
    }
    state.sessions = {};
    state.sessionMeta = {};
    reverse.clear();
    deps.ops.clearAllSessionTracking();
    collectors.clear();
    sendToolSucceededSessions.clear();
    pendingSendToolCalls.clear();
    v2TurnStartAt.clear();
    toolCallNames.clear();
    saveState();
    try { fs.writeFileSync(ACTIVITY_LOG, ''); } catch {}
    log(`控制台：已清空 QQ 聊天工作区（归档 ${archivedCount} 个会话，映射与活动日志已清空）`);
    sendJson({ ok: true, archivedCount });
    return;
  }
  // ── 重启桥接（守护模式下 5 秒后自动拉起） ──────────────────────────────
  if (req.method === 'POST' && url.pathname === '/api/restart') {
    // 重启 = **自己拉一个新进程**，不能只 process.exit 等外部守护窗口。
    //
    // 2026-10-21 用户反馈「控制台的重启桥接按钮并没有重启的效果」。
    // 实测日志：19:52:12 打出"控制台：重启桥接"后 exit(0)，到 19:53:06 才
    // 出现新进程——中间空了 54 秒，而前端只轮询 30 秒就显示"桥接尚未恢复"。
    // 根因不是按钮没发命令，而是**没有任何守护在跑**：`start.bat` 的死循环
    // 只存在于手动双击启动的那个窗口里；用 nohup / 计划任务 / 别的方式拉起时，
    // exit(0) 就是彻底停服。把"能不能起来"交给运气是不对的。
    //
    // 做法：detached 子进程 + stdio 忽略 + unref，父进程退出后子进程继续跑。
    // 子进程等 800ms 再启动（给父进程释放 :3100 和锁文件的时间），
    // 并通过 QQB_RESTARTED_BY 标记来源，便于日志区分"手动启动"与"自重启"。
    // 子进程启动时会 acquireLock()：若父进程还没退干净，它会 exit(2) 自行放弃，
    // 不会出现两个实例同时抢端口。
    const logFile = path.join(STATE_DIR, 'bridge.log');
    sendJson({ ok: true, message: '正在重启桥接（已安排自重启，约 3~5 秒恢复）…' });
    setTimeout(async () => {
      log('控制台：重启桥接（将以 detached 子进程自重启）');
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
        log(`重启失败：无法拉起新进程（${error?.message ?? error}）；若由守护脚本启动，会由它恢复`);
      }
      releaseLock();
      process.exit(spawned ? 0 : 1);
    }, 500);
    return;
  }
  sendJson({ ok: false, error: 'not found' }, 404);
}
