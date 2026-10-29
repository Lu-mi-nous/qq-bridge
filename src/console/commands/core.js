// R4.7-3：模式切换 / 角色设置 / 人格卡保存与创建命令。
//
// 这些写动作原先在路由里直接改 live 状态、写 mode.json、操作 roles 文件。
// 收进命令层后，路由只读 body；「写盘失败不改内存」「先备份再原子写」集中维护。

export function createCoreCommands({
  config = {},
  sessions = {},
  social = {},
  role = {},
  operations = {}
} = {}) {
  const { ROOT, STATE_DIR, cfg = {}, fs, path, log, readJsonSafe, atomicWriteJson, atomicWriteText } = config;
  const { state = {}, socialV2 = { conversations: new Map() } } = sessions;
  const { cleanupSocialForModeChange, clearAllSocialV2Timers, drainAllPromptQueues, setupSleepTimerV2, scheduleProactiveCheckV2 } = social;
  const { readRoleState, writeRoleState, writeConversationRole, sanitizeRoleName, roleExists, roleFor } = role;
  const { live = {} } = operations;
  const logLine = (message) => { try { log?.(message); } catch { /* 日志失败不影响主流程 */ } };

  /** POST /api/mode */
  function setMode(body = {}) {
    if (!['chat', 'closed-agent', 'reserved', 'reserved2'].includes(body.mode)) {
      return { ok: false, status: 400, error: 'mode 必须是 chat / closed-agent / reserved / reserved2' };
    }
    const existing = readJsonSafe(path.join(STATE_DIR, 'mode.json'), {});
    const next = {
      mode: body.mode,
      ...(body.closedAgentPreset ? { closedAgentPreset: String(body.closedAgentPreset) } : { closedAgentPreset: existing.closedAgentPreset ?? 'router-standard' })
    };
    atomicWriteJson(path.join(STATE_DIR, 'mode.json'), next);
    if (next.closedAgentPreset) live.closedAgentPreset = next.closedAgentPreset;
    if (live.currentMode === 'reserved' && body.mode !== 'reserved') {
      cleanupSocialForModeChange?.();
      logLine('控制台：模式离开一代仿真模式，清理社交状态');
    }
    if (live.currentMode === 'reserved2' && body.mode !== 'reserved2') {
      clearAllSocialV2Timers?.();
      drainAllPromptQueues?.('模式切换，已取消排队中的投递');
      logLine('控制台：模式离开二代仿真模式，清理 reserved2 定时器与排队投递');
    }
    live.currentMode = body.mode;
    live.lastMode = body.mode;
    if (body.mode === 'reserved2') {
      for (const key of socialV2.conversations.keys()) {
        setupSleepTimerV2?.(key);
        scheduleProactiveCheckV2?.(key);
      }
      logLine('控制台：模式进入二代仿真模式，重建有限睡眠定时器');
    }
    logLine(`控制台：模式已设置为 ${body.mode}${next.closedAgentPreset ? `（closed-agent preset: ${next.closedAgentPreset}）` : ''}`);
    return { ok: true, mode: body.mode, closedAgentPreset: next.closedAgentPreset };
  }

  /** POST /api/role：带 key 设置会话 override；不带 key 设置全局默认。 */
  function setRole(body = {}) {
    const rs = readRoleState();
    const targetKey = String(body.key ?? '').trim();
    if (targetKey) {
      if (!/^(group|private):\d+$/.test(targetKey)) {
        return { ok: false, status: 400, error: 'key 格式应为 group:群号 或 private:QQ号' };
      }
      if (body.role && typeof body.role === 'string') {
        const name = sanitizeRoleName(body.role);
        if (!roleExists(name)) return { ok: false, status: 400, error: `角色「${name}」不存在（roles/${name}.md）` };
        writeConversationRole(targetKey, name);
        logLine(`控制台：${targetKey} 人格已设置为 ${name}`);
        return { ok: true, key: targetKey, role: name, effectiveRole: roleFor(targetKey) };
      }
      writeConversationRole(targetKey, null);
      logLine(`控制台：${targetKey} 人格已清除（回退默认）`);
      return { ok: true, key: targetKey, role: null, effectiveRole: roleFor(targetKey) };
    }
    if (body.role && typeof body.role === 'string') {
      const name = sanitizeRoleName(body.role);
      if (!roleExists(name)) return { ok: false, status: 400, error: `角色「${name}」不存在（roles/${name}.md）` };
      writeRoleState(name, rs.mode);
      logLine(`控制台：默认角色已设置为 ${name}`);
      return { ok: true, role: name, defaultRole: name };
    }
    writeRoleState(null, rs.mode);
    logLine('控制台：默认角色已清除');
    return { ok: true, role: null, defaultRole: null };
  }

  /** POST /api/role-mode：active / silent。 */
  function setRoleMode(body = {}) {
    const rs = readRoleState();
    const mode = body.mode === 'silent' ? 'silent' : 'active';
    writeRoleState(rs.role, mode);
    logLine(`控制台：静默模式 ${mode === 'silent' ? '开启' : '关闭'}`);
    return { ok: true, roleMode: mode };
  }

  /** POST /api/role-content：先备份再原子写。 */
  function saveRoleContent(body = {}) {
    const name = String(body.name ?? '').trim();
    const content = String(body.content ?? '');
    const safe = sanitizeRoleName(name);
    if (!safe || safe !== name) return { ok: false, status: 400, error: '角色名不合法' };
    if (safe === 'README') return { ok: false, status: 400, error: '该名称被保留' };
    if (!content.trim()) return { ok: false, status: 400, error: '人格卡内容不能为空' };
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > 512 * 1024) return { ok: false, status: 400, error: '人格卡过大（上限 512KB）' };
    const roleFile = path.join(ROOT, 'roles', safe + '.md');
    if (!fs.existsSync(roleFile)) return { ok: false, status: 404, error: `角色「${safe}」不存在` };
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
        try { fs.unlinkSync(path.join(backupDir, f)); } catch { /* 旧备份删不掉可忽略 */ }
      }
    } catch (error) {
      logLine(`控制台：备份人格「${safe}」失败（继续保存）：${error?.message ?? error}`);
    }
    const next = content.endsWith('\n') ? content : content + '\n';
    atomicWriteText(roleFile, next);
    logLine(`控制台：已修改人格「${safe}」（${bytes} 字节）`);
    return { ok: true, name: safe, bytes, hintLimit: 12000 };
  }

  /** POST /api/roles/create */
  function createRole(body = {}) {
    const name = sanitizeRoleName(body.name);
    const content = String(body.content ?? '').trim();
    if (!name) return { ok: false, status: 400, error: '角色名不能为空（仅限中文/字母/数字/横线）' };
    if (!content) return { ok: false, status: 400, error: '角色内容不能为空' };
    if (name === 'README') return { ok: false, status: 400, error: '该名称被保留' };
    const roleFile = path.join(ROOT, 'roles', name + '.md');
    if (fs.existsSync(roleFile)) return { ok: false, status: 400, error: `角色「${name}」已存在` };
    fs.mkdirSync(path.join(ROOT, 'roles'), { recursive: true });
    atomicWriteText(roleFile, content + (content.endsWith('\n') ? '' : '\n'));
    logLine(`控制台：创建人格「${name}」`);
    return { ok: true, role: name };
  }

  return { setMode, setRole, setRoleMode, saveRoleContent, createRole };
}
