// 清理单个 DSH 会话的回合态；不改群聊记忆、持久化映射或其他会话。
export function clearSessionTracking(deps, sessionId) {
  if (!sessionId) return;
  for (const name of ['collectors', 'v2TurnStartAt', 'currentTurnBySession',
    'sendToolSucceededSessions', 'pendingSendToolCalls', 'toolCallNames', 'biliJudgeCollectors']) {
    deps[name]?.delete(sessionId);
  }
  for (const id of deps.autoAtTurnDone?.keys() || []) {
    if (id === sessionId || String(id).startsWith(`${sessionId}#`)) deps.autoAtTurnDone.delete(id);
  }
  deps.social?.silentTurns.delete(sessionId);
  deps.social?.exitingSessions.delete(sessionId);
  const waiter = deps.biliJudgeWaiters?.get(sessionId);
  deps.biliJudgeWaiters?.delete(sessionId);
  if (waiter) { try { waiter.resolve(''); } catch {} }
}
