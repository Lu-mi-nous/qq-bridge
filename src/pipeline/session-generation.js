// 消息管线 · 会话代际（mode + preset）。
//
// 同一个 QQ 会话在 DSH 侧只能有一个活跃 sessionId。模式或 agent preset 变化后，
// 旧 DSH 会话的能力面（工具集/系统提示）不会自动改变；继续复用会出现
// 「切到 reserved2 了，但模型还在用旧 preset 的工具」这类静默错配。
//
// 这里只做纯比较：真正 archive/重建由 bridge.ensureSession 执行。

/** 生成可比对的代际字符串：mode + preset。 */
export function sessionGeneration({ mode, preset } = {}) {
  return `${String(mode ?? '')}|${String(preset ?? '')}`;
}

/**
 * 现有会话元数据是否已经过期。
 * meta 缺失时返回 false：老状态没有元数据，首次接管按当前模式记录，避免升级后
 * 把所有会话一次性重建（会丢掉 DSH 历史）。
 */
export function needsNewSession(meta, { mode, preset } = {}) {
  if (!meta || typeof meta !== 'object') return false;
  return sessionGeneration(meta) !== sessionGeneration({ mode, preset });
}
