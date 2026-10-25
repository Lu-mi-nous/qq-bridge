// 消息管线 · DSH 回合 ID。
//
// DSH 的 turn 号只在单个 session 内唯一；跨会话必须带 sessionId。
// 用显式 turnId 取代“只按 sessionId 猜回合”，避免 B 站初判/自动 @ 把
// 别的回合的结果认成自己的。
export function makeTurnId(sessionId, turn) {
  if (sessionId === undefined || sessionId === null || turn === undefined || turn === null) return '';
  return `${sessionId}#${turn}`;
}
