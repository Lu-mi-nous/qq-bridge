// R4.7-2：会话 / 挂起 / 白名单 / 安全 / 控制台令牌读模型。
//
// 只读：列会话、挂起审批、白名单可视化、安全通知设置、令牌鉴权状态。
// 写动作在 `src/console/commands/access.js`。

export function createAccessReadModel({
  cfg = {},
  live = {},
  state = {},
  pending,
  contextDisplayName,
  refreshContextNames
} = {}) {
  /** GET /api/sessions：带群名/QQ 昵称的会话列表。 */
  async function sessions() {
    // 复用上下文卡片的名称缓存（群列表 + 好友列表 + 陌生人资料，5 分钟 TTL）。
    try { await refreshContextNames?.(false); } catch { /* 名称刷新失败只影响显示 */ }
    const list = [];
    for (const [key, sessionId] of Object.entries(state.sessions || {})) {
      const [kind, id] = String(key).split(':');
      list.push({
        key,
        sessionId,
        owner: key === `private:${String(cfg.ownerQQ ?? '')}`,
        kind,
        name: contextDisplayName?.(key) || ''
      });
    }
    return { sessions: list };
  }

  /** GET /api/pending：挂起审批/提问。 */
  function pendingList() {
    const list = [];
    for (const [key, p] of pending.entries()) {
      list.push({
        key,
        kind: p.kind,
        sessionId: p.sessionId,
        ...(p.kind === 'approval' ? { toolName: p.toolName, reason: p.reason, approvalId: p.approvalId } : {}),
        ...(p.kind === 'question' ? { questions: p.questions } : {})
      });
    }
    return { pending: list };
  }

  /** GET /api/whitelist */
  async function whitelist() {
    try {
      await refreshContextNames?.(!live.contextNameCache.at || live.contextNameCache.groups.size === 0);
    } catch { /* 名称刷新失败不影响配置展示 */ }
    return {
      allow: cfg.allow ?? { private: [], groups: [] },
      deny: cfg.deny ?? { private: [], groups: [] },
      ownerQQ: cfg.ownerQQ ?? null,
      // 私聊准入策略（'list' 白名单 / 'friends' 好友自动放行 / 'all' 纯黑名单）
      privateMode: cfg.allow?.privateMode ?? 'list',
      // 好友数：'friends' 模式下控制台据此提示"当前生效的好友有多少"
      friendCount: live.friendIds.size,
      // 控制台显示用：群名 / QQ 昵称；取不到的号码前端只显示号码
      groupNames: Object.fromEntries(live.contextNameCache.groups),
      privateNames: Object.fromEntries(live.contextNameCache.privates),
    };
  }

  /** GET /api/security */
  function security() {
    return { security: cfg.security ?? { interceptNotify: true } };
  }

  /** GET /api/console/token：只回鉴权是否开启，不回令牌本身。 */
  function consoleToken({ authState, port } = {}) {
    return {
      ok: true,
      authEnabled: authState.consoleToken !== '',
      hasToken: authState.consoleToken !== '',
      port,
      hint: authState.consoleToken === ''
        ? '令牌鉴权已关闭（config.consoleAuth=false）：直接访问即可，无需登录'
        : '令牌鉴权已开启：刷新页面时会要求输入令牌'
    };
  }

  return { sessions, pendingList, whitelist, security, consoleToken };
}
