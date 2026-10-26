// 控制台路由域：核心状态 / 模式 / 人格（R4）。
//
// 从 console-server.js 原样搬出，只调整了缩进；鉴权 / CSRF / agent 白名单 /
// 暂停隔离仍由 console-server 统一处理，走到这里时请求已通过全部前置校验。
export const id = '01-core';
export const title = '核心状态 / 模式 / 人格';

/** 本模块负责的路由；console-server 据此分派，不必解析 handler 内部。 */
export const routes = [
  ['GET', '/api/status', 'exact'],
  ['GET', '/api/presets', 'exact'],
  ['POST', '/api/mode', 'exact'],
  ['POST', '/api/role', 'exact'],
  ['POST', '/api/role-mode', 'exact'],
  ['GET', '/api/roles', 'exact'],
  ['GET', '/api/role-assignments', 'exact'],
  ['GET', '/api/role-content', 'exact'],
  ['POST', '/api/role-content', 'exact'],
  ['POST', '/api/roles/create', 'exact']
];

export async function handle(req, res, url, ctx) {
  const { sendJson, readBody, deps } = ctx;
  const {
    ROOT,
    STATE_DIR,
    api,
    atomicWriteJson,
    atomicWriteText,
    cfg,
    cleanupSocialForModeChange,
    clearAllSocialV2Timers,
    drainAllPromptQueues,
    fs,
    listRoles,
    log,
    path,
    readActivityTail,
    readConversationRoles,
    readJsonSafe,
    readRoleState,
    refreshContextNames,
    roleExists,
    roleFor,
    sanitizeRoleName,
    scheduleProactiveCheckV2,
    setupSleepTimerV2,
    socialV2,
    state,
    unwrap,
    writeConversationRole,
    writeRoleState
  } = deps;

  if (req.method === 'GET' && url.pathname === '/api/status') {
    const rs = readRoleState();
    sendJson({
      mode: deps.live.currentMode,
      closedAgentPreset: deps.live.closedAgentPreset,
      role: rs.role ?? null,
      roleMode: rs.mode ?? 'active',
      dshReady: deps.live.dshReady,
      ownerQQ: cfg.ownerQQ ?? null,
      allowGroups: cfg.allow?.groups ?? [],
      allowPrivate: cfg.allow?.private ?? [],
      // 私聊准入策略与好友数：控制台状态栏按它显示"好友自动放行/纯黑名单/白名单"
      privateMode: cfg.allow?.privateMode ?? 'list',
      friendCount: deps.live.friendIds.size,
      socialV2Paused: socialV2.paused,
      activity: readActivityTail(100)
    });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/presets') {
    let presets = [];
    try {
      const { presets: list } = unwrap(await api.agentPresets.list({}), 'agentPreset.list');
      presets = list.map((p) => ({ id: p.id, trust: p.trust ?? 'system' }));
    } catch {}
    sendJson({ presets });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/mode') {
    const body = await readBody();
    if (!['chat', 'closed-agent', 'reserved', 'reserved2'].includes(body.mode)) {
      sendJson({ ok: false, error: 'mode 必须是 chat / closed-agent / reserved / reserved2' }, 400);
      return;
    }
    const existing = readJsonSafe(path.join(STATE_DIR, 'mode.json'), {});
    const next = {
      mode: body.mode,
      ...(body.closedAgentPreset ? { closedAgentPreset: String(body.closedAgentPreset) } : { closedAgentPreset: existing.closedAgentPreset ?? 'router-standard' })
    };
    atomicWriteJson(path.join(STATE_DIR, 'mode.json'), next);
    if (next.closedAgentPreset) deps.live.closedAgentPreset = next.closedAgentPreset;
    if (deps.live.currentMode === 'reserved' && body.mode !== 'reserved') {
      cleanupSocialForModeChange();
      log('控制台：模式离开一代仿真模式，清理社交状态');
    }
    if (deps.live.currentMode === 'reserved2' && body.mode !== 'reserved2') {
      clearAllSocialV2Timers();
      drainAllPromptQueues('模式切换，已取消排队中的投递');
      log('控制台：模式离开二代仿真模式，清理 reserved2 定时器与排队投递');
    }
    deps.live.currentMode = body.mode;
    deps.live.lastMode = body.mode;
    if (body.mode === 'reserved2') {
      for (const key of socialV2.conversations.keys()) {
        setupSleepTimerV2(key);
        scheduleProactiveCheckV2(key);
      }
      log('控制台：模式进入二代仿真模式，重建有限睡眠定时器');
    }
    log(`控制台：模式已设置为 ${body.mode}${next.closedAgentPreset ? `（closed-agent preset: ${next.closedAgentPreset}）` : ''}`);
    sendJson({ ok: true, mode: body.mode, closedAgentPreset: next.closedAgentPreset });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/role') {
    const body = await readBody();
    const rs = readRoleState();
    const targetKey = String(body.key ?? '').trim();
    // 带 key = 设置某个群/私聊的 override；不带 key = 设置全局默认（兼容旧调用）。
    if (targetKey) {
      if (!/^(group|private):\d+$/.test(targetKey)) {
        sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400);
        return;
      }
      if (body.role && typeof body.role === 'string') {
        const name = sanitizeRoleName(body.role);
        if (!roleExists(name)) {
          sendJson({ ok: false, error: `角色「${name}」不存在（roles/${name}.md）` }, 400);
          return;
        }
        writeConversationRole(targetKey, name);
        log(`控制台：${targetKey} 人格已设置为 ${name}`);
        sendJson({ ok: true, key: targetKey, role: name, effectiveRole: roleFor(targetKey) });
      } else {
        writeConversationRole(targetKey, null);
        log(`控制台：${targetKey} 人格已清除（回退默认）`);
        sendJson({ ok: true, key: targetKey, role: null, effectiveRole: roleFor(targetKey) });
      }
      return;
    }
    if (body.role && typeof body.role === 'string') {
      const name = sanitizeRoleName(body.role);
      if (!roleExists(name)) {
        sendJson({ ok: false, error: `角色「${name}」不存在（roles/${name}.md）` }, 400);
        return;
      }
      writeRoleState(name, rs.mode);
      log(`控制台：默认角色已设置为 ${name}`);
      sendJson({ ok: true, role: name, defaultRole: name });
    } else {
      writeRoleState(null, rs.mode);
      log('控制台：默认角色已清除');
      sendJson({ ok: true, role: null, defaultRole: null });
    }
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/role-mode') {
    const body = await readBody();
    const rs = readRoleState();
    const mode = body.mode === 'silent' ? 'silent' : 'active';
    writeRoleState(rs.role, mode);
    log(`控制台：静默模式 ${mode === 'silent' ? '开启' : '关闭'}`);
    sendJson({ ok: true, roleMode: mode });
    return;
  }
  // ── 人格管理 ──────────────────────────────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/api/roles') {
    const rs = readRoleState();
    sendJson({ roles: listRoles(), current: rs.role ?? null, defaultRole: rs.role ?? null, overrides: readConversationRoles() });
    return;
  }
  // 控制台「人格」卡片：默认角色 + 每个群的独立人格配置。
  if (req.method === 'GET' && url.pathname === '/api/role-assignments') {
    // 首屏群名缓存可能还没建好：强制拉一次，避免人格卡里全是空群名。之后走 5 分钟缓存。
    try { await refreshContextNames(!deps.live.contextNameCache.at || deps.live.contextNameCache.groups.size === 0); } catch {}
    const rs = readRoleState();
    const overrides = readConversationRoles();
    const keys = new Set();
    for (const gid of (Array.isArray(cfg.allow?.groups) ? cfg.allow.groups : [])) keys.add(`group:${String(gid)}`);
    // 机器人当前所在的群即使还没进白名单/还没会话，也应能单独配人格。
    for (const gid of deps.live.contextNameCache.groups.keys()) keys.add(`group:${String(gid)}`);
    for (const key of socialV2.conversations.keys()) if (String(key).startsWith('group:')) keys.add(String(key));
    for (const key of Object.keys(state.sessions ?? {})) if (String(key).startsWith('group:')) keys.add(String(key));
    for (const key of Object.keys(overrides)) if (String(key).startsWith('group:')) keys.add(String(key));
    const conversations = [...keys].map((key) => {
      const id = key.slice('group:'.length);
      return {
        key,
        kind: 'group',
        id,
        name: deps.live.contextNameCache.groups.get(id) || '',
        inGroupList: deps.live.contextNameCache.groups.has(id),
        overrideRole: overrides[key] || null,
        effectiveRole: roleFor(key),
      };
    }).sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id), 'zh-CN'));
    sendJson({ ok: true, defaultRole: rs.role ?? null, mode: rs.mode ?? 'active', roles: listRoles(), conversations });
    return;
  }
  // 读取单个角色的 Markdown 原文（控制台用来在卡片里渲染人格内容）。
  // 直接读文件而不是维护副本：角色卡是热更新的（改完下次读就生效），
  // 缓存一份反而会出现"控制台看到的和实际用的不一致"。
  if (req.method === 'GET' && url.pathname === '/api/role-content') {
    const name = String(url.searchParams.get('name') ?? '').trim();
    if (!name) { sendJson({ ok: false, error: 'name 不能为空' }, 400); return; }
    // 走与创建/设置同一套名字校验，既防路径穿越（../）也保证与列表口径一致
    const safe = sanitizeRoleName(name);
    if (!safe || safe !== name) { sendJson({ ok: false, error: '角色名不合法' }, 400); return; }
    const roleFile = path.join(ROOT, 'roles', safe + '.md');
    if (!fs.existsSync(roleFile)) { sendJson({ ok: false, error: `角色「${safe}」不存在` }, 404); return; }
    try {
      const content = fs.readFileSync(roleFile, 'utf8');
      sendJson({ ok: true, name: safe, content, bytes: Buffer.byteLength(content, 'utf8') });
    } catch (error) {
      sendJson({ ok: false, error: `读取失败：${error?.message ?? error}` }, 500);
    }
    return;
  }
  // 控制台直接修改人格卡正文（2026-10-23 用户要求「人格卡不能直接在控制台修改」）。
  // 角色卡是热更新的（currentRoleHint 按 mtime 失效），保存后下一轮对话即生效，不用重启。
  if (req.method === 'POST' && url.pathname === '/api/role-content') {
    const body = await readBody();
    const name = String(body.name ?? '').trim();
    const content = String(body.content ?? '');
    const safe = sanitizeRoleName(name);
    if (!safe || safe !== name) { sendJson({ ok: false, error: '角色名不合法' }, 400); return; }
    if (safe === 'README') { sendJson({ ok: false, error: '该名称被保留' }, 400); return; }
    if (!content.trim()) { sendJson({ ok: false, error: '人格卡内容不能为空' }, 400); return; }
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > 512 * 1024) { sendJson({ ok: false, error: '人格卡过大（上限 512KB）' }, 400); return; }
    const roleFile = path.join(ROOT, 'roles', safe + '.md');
    if (!fs.existsSync(roleFile)) { sendJson({ ok: false, error: `角色「${safe}」不存在` }, 404); return; }
    // 先备份再原子写：手滑删掉整段也能从 roles/.backups 找回（每角色保留最近 20 份）。
    try {
      const backupDir = path.join(ROOT, 'roles', '.backups');
      fs.mkdirSync(backupDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      fs.copyFileSync(roleFile, path.join(backupDir, `${safe}.${stamp}.md`));
      const old = fs.readdirSync(backupDir)
        .filter((f) => f.startsWith(safe + '.') && f.endsWith('.md'))
        .sort();
      for (const f of old.slice(0, Math.max(0, old.length - 20))) {
        try { fs.unlinkSync(path.join(backupDir, f)); } catch {}
      }
    } catch (error) {
      log(`控制台：备份人格「${safe}」失败（继续保存）：${error?.message ?? error}`);
    }
    const next = content.endsWith('\n') ? content : content + '\n';
    atomicWriteText(roleFile, next);
    log(`控制台：已修改人格「${safe}」（${bytes} 字节）`);
    sendJson({ ok: true, name: safe, bytes, hintLimit: 12000 });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/roles/create') {
    const body = await readBody();
    const name = sanitizeRoleName(body.name);
    const content = String(body.content ?? '').trim();
    if (!name) { sendJson({ ok: false, error: '角色名不能为空（仅限中文/字母/数字/横线）' }, 400); return; }
    if (!content) { sendJson({ ok: false, error: '角色内容不能为空' }, 400); return; }
    if (name === 'README') { sendJson({ ok: false, error: '该名称被保留' }, 400); return; }
    const roleFile = path.join(ROOT, 'roles', name + '.md');
    if (fs.existsSync(roleFile)) { sendJson({ ok: false, error: `角色「${name}」已存在` }, 400); return; }
    fs.mkdirSync(path.join(ROOT, 'roles'), { recursive: true });
    atomicWriteText(roleFile, content + (content.endsWith('\n') ? '' : '\n'));
    log(`控制台：创建人格「${name}」`);
    sendJson({ ok: true, role: name });
    return;
  }
}
