// R4.7-3：活动流领域的写命令（暂停 / 重置）。
//
// 这两个动作原先在路由里直接摸 20+ 个运行态 Map/Set（会话映射、collector、唤醒租约、
// 发送工具追踪、agent token 表……）。收进命令层后，路由只表达「暂停/恢复/重置」，
// 具体清理清单在这里维护；新增一处需要清理的状态时也只改这一处。

export function createActivityCommands({
  live = {},
  socialV2 = { conversations: new Map() },
  state = {},
  ops = {},
  log,
  atomicWriteJson,
  SOCIAL_V2_FILE,
  KNOWN_AGENT_TOKENS,
  sessionPromises,
  reverse,
  collectors,
  v2TurnStartAt,
  toolCallNames,
  pendingSendToolCalls,
  sendToolSucceededSessions,
  pendingWakeKeys,
  wakeConfigUpdatedKeys,
  markReadCalledKeys,
  wakeConfigMissCount,
  seenForwardIds,
  clearAllSocialV2Timers,
  clearAllPendingWakeLeases,
  drainAllPromptQueues,
  setupSleepTimerV2,
  scheduleProactiveCheckV2,
  saveSocialV2State
} = {}) {
  const logLine = (message, error) => { try { log?.(message, error); } catch { /* 日志失败不影响主流程 */ } };

  /** POST /api/socialV2/activity：暂停时停掉等待/唤醒定时器，恢复时按会话重新排期。 */
  function setPaused(paused) {
    socialV2.paused = paused === true;
    if (socialV2.paused) {
      clearAllSocialV2Timers?.();
      logLine('控制台：二代 AI 已暂停（唤醒/等待任务已停止）');
    } else {
      logLine('控制台：二代 AI 已恢复');
      for (const key of socialV2.conversations.keys()) {
        setupSleepTimerV2?.(key);
        scheduleProactiveCheckV2?.(key);
      }
    }
    saveSocialV2State?.();
    return { paused: socialV2.paused };
  }

  /**
   * POST /api/socialV2/reset：清空会话、定时器、唤醒配置与 agent token。
   * 工具日志保留；不删除群聊记忆（recentMessages 随会话对象一起清），
   * 这是「重置二代状态」而不是「清空记忆卡」——两者是不同按钮。
   */
  function reset() {
    ops.bumpSessionEpoch?.();
    sessionPromises?.clear();
    clearAllSocialV2Timers?.();
    drainAllPromptQueues?.('二代状态已重置');
    for (const key of [...socialV2.conversations.keys()]) {
      const sid = state.sessions?.[key];
      if (sid) {
        ops.recordSessionHistory?.(sid, key, 'reset');
        delete state.sessions[key];
        if (state.sessionMeta) delete state.sessionMeta[key];
        reverse?.delete(sid);
        ops.clearSessionTracking?.(sid);
        collectors?.delete(sid);
        v2TurnStartAt?.delete(sid);
        toolCallNames?.delete(sid);
        pendingSendToolCalls?.delete(sid);
        sendToolSucceededSessions?.delete(sid);
      }
      const removedV2 = socialV2.conversations.get(key);
      if (removedV2?.agentToken) KNOWN_AGENT_TOKENS?.delete(removedV2.agentToken);
      socialV2.conversations.delete(key);
      seenForwardIds?.delete(key);
    }
    pendingWakeKeys?.clear();
    clearAllPendingWakeLeases?.();
    wakeConfigUpdatedKeys?.clear();
    markReadCalledKeys?.clear();
    wakeConfigMissCount?.clear();
    socialV2.paused = false;
    try {
      atomicWriteJson?.(SOCIAL_V2_FILE, { conversations: {} });
    } catch (error) {
      logLine('重置二代状态：写空状态文件失败:', error?.message ?? error);
    }
    logLine('控制台：二代 AI 状态已重置（会话、定时器、唤醒配置已清空，工具日志保留）');
    return { ok: true };
  }

  return { setPaused, reset };
}
