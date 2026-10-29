// R4.7-2：核心状态 / 预设 / 人格读模型。
//
// 只读：状态栏、agent preset 列表、角色列表/分配、角色卡正文。
// 模式切换、角色设置、角色卡保存/创建在 `src/console/commands/core.js`。

export function createCoreReadModel({
  ROOT,
  cfg = {},
  live = {},
  socialV2 = { conversations: new Map() },
  state = {},
  api,
  unwrap,
  readActivityTail,
  readRoleState,
  listRoles,
  readConversationRoles,
  refreshContextNames,
  roleFor,
  sanitizeRoleName,
  fs,
  path
} = {}) {
  /** GET /api/status：控制台状态栏。 */
  function status() {
    const rs = readRoleState();
    return {
      mode: live.currentMode,
      closedAgentPreset: live.closedAgentPreset,
      role: rs.role ?? null,
      roleMode: rs.mode ?? 'active',
      dshReady: live.dshReady,
      ownerQQ: cfg.ownerQQ ?? null,
      allowGroups: cfg.allow?.groups ?? [],
      allowPrivate: cfg.allow?.private ?? [],
      // 私聊准入策略与好友数：控制台状态栏按它显示"好友自动放行/纯黑名单/白名单"
      privateMode: cfg.allow?.privateMode ?? 'list',
      friendCount: live.friendIds.size,
      socialV2Paused: socialV2.paused,
      activity: readActivityTail(100)
    };
  }

  /** GET /api/presets：agent preset id 与信任级别。 */
  async function presets() {
    let list = [];
    try {
      const all = unwrap
        ? unwrap(await api.agentPresets.list({}), 'agentPreset.list')
        : await api.agentPresets.list({});
      list = all.presets.map((p) => ({ id: p.id, trust: p.trust ?? 'system' }));
    } catch { /* 预设列表失败只回空 */ }
    return { presets: list };
  }

  /** GET /api/roles */
  function roles() {
    const rs = readRoleState();
    return { roles: listRoles(), current: rs.role ?? null, defaultRole: rs.role ?? null, overrides: readConversationRoles() };
  }

  /** GET /api/role-assignments：默认角色 + 每个群的独立人格。 */
  async function roleAssignments() {
    // 首屏群名缓存可能还没建好：强制拉一次，避免人格卡里全是空群名。之后走 5 分钟缓存。
    try {
      await refreshContextNames(!live.contextNameCache.at || live.contextNameCache.groups.size === 0);
    } catch { /* 群名刷新失败不影响列表 */ }
    const rs = readRoleState();
    const overrides = readConversationRoles();
    const keys = new Set();
    for (const gid of (Array.isArray(cfg.allow?.groups) ? cfg.allow.groups : [])) keys.add(`group:${String(gid)}`);
    // 机器人当前所在的群即使还没进白名单/还没会话，也应能单独配人格。
    for (const gid of live.contextNameCache.groups.keys()) keys.add(`group:${String(gid)}`);
    for (const key of socialV2.conversations.keys()) if (String(key).startsWith('group:')) keys.add(String(key));
    for (const key of Object.keys(state.sessions ?? {})) if (String(key).startsWith('group:')) keys.add(String(key));
    for (const key of Object.keys(overrides)) if (String(key).startsWith('group:')) keys.add(String(key));
    const conversations = [...keys].map((key) => {
      const id = key.slice('group:'.length);
      return {
        key,
        kind: 'group',
        id,
        name: live.contextNameCache.groups.get(id) || '',
        inGroupList: live.contextNameCache.groups.has(id),
        overrideRole: overrides[key] || null,
        effectiveRole: roleFor(key),
      };
    }).sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id), 'zh-CN'));
    return { ok: true, defaultRole: rs.role ?? null, mode: rs.mode ?? 'active', roles: listRoles(), conversations };
  }

  /** GET /api/role-content：读取单个角色 Markdown 原文。 */
  function roleContent({ name } = {}) {
    if (!name) return { ok: false, status: 400, error: 'name 不能为空' };
    // 走与创建/设置同一套名字校验，既防路径穿越（../）也保证与列表口径一致
    const safe = sanitizeRoleName(name);
    if (!safe || safe !== name) return { ok: false, status: 400, error: '角色名不合法' };
    const roleFile = path.join(ROOT, 'roles', safe + '.md');
    if (!fs.existsSync(roleFile)) return { ok: false, status: 404, error: `角色「${safe}」不存在` };
    try {
      const content = fs.readFileSync(roleFile, 'utf8');
      return { ok: true, name: safe, content, bytes: Buffer.byteLength(content, 'utf8') };
    } catch (error) {
      return { ok: false, status: 500, error: `读取失败：${error?.message ?? error}` };
    }
  }

  return { status, presets, roles, roleAssignments, roleContent };
}
