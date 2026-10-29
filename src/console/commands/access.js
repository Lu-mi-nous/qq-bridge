// R4.7-3：白名单 / 安全 / 控制台令牌 / 测试发送命令。
//
// 写 config.json 的动作都先 fail-fast 读、再原子写；写盘成功后才同步内存
// （避免进程内看似生效、重启即丢）。测试发送强制白名单 + 模式 + 敏感词校验。

export function createAccessCommands({
  config = {},
  live = {},
  SENSITIVE_RE,
  allowed,
  modeAllowed,
  normalizeOwnerQQ,
  normalizePrivateMode,
  refreshFriendList,
  escapeCqText,
  redactKnownTokensOnly,
  bot,
  text,
  recordSentMessage
} = {}) {
  const { ROOT, STATE_DIR, cfg = {}, crypto, fs, path, log, readJsonSafe, atomicWriteJson, atomicWriteText } = config;
  const logLine = (message) => { try { log?.(message); } catch { /* 日志失败不影响主流程 */ } };

  /** POST /api/whitelist */
  function saveWhitelist(body = {}) {
    const toNum = (arr) => Array.isArray(arr) ? [...new Set(arr.map((x) => Number(String(x).trim())).filter((n) => Number.isFinite(n)))] : undefined;
    const configFile = path.join(ROOT, 'config.json');
    // fail-fast：配置文件损坏时直接抛，绝不回写，避免把整个配置清成只剩 allow/deny/ownerQQ
    const file = readJsonSafe(configFile, null, true);
    // 私聊准入策略：可改。缺省沿用原值，非法值回落到 'list'（fail-closed）。
    const privateMode = body.allow?.privateMode !== undefined
      ? normalizePrivateMode(body.allow.privateMode)
      : (file.allow?.privateMode ?? 'list');
    const allow = {
      private: toNum(body.allow?.private) ?? (file.allow?.private ?? []),
      groups: toNum(body.allow?.groups) ?? (file.allow?.groups ?? []),
      privateMode
    };
    const deny = {
      private: toNum(body.deny?.private) ?? (file.deny?.private ?? []),
      groups: toNum(body.deny?.groups) ?? (file.deny?.groups ?? [])
    };
    // 管理员 QQ 可在控制台输入；空值=清除管理员（fail-closed），非法值拒绝写入。
    let ownerQQ = cfg.ownerQQ ?? null;
    if (body.ownerQQ !== undefined) {
      try {
        ownerQQ = normalizeOwnerQQ(body.ownerQQ);
      } catch (error) {
        return { ok: false, status: 400, error: error?.message ?? 'ownerQQ 无效' };
      }
    }
    file.allow = allow;
    file.deny = deny;
    file.ownerQQ = ownerQQ;
    atomicWriteJson(configFile, file);
    cfg.allow = { private: allow.private, groups: allow.groups, privateMode: allow.privateMode };
    cfg.deny = { private: deny.private, groups: deny.groups };
    cfg.ownerQQ = ownerQQ;
    // 切到 'friends' 时立刻拉一次好友列表（否则要等 5 分钟的定期刷新才生效）
    if (privateMode === 'friends') {
      refreshFriendList({ force: true }).then((ids) => logLine(`[私聊准入] 好友列表已刷新：${ids.size} 人`)).catch(() => {});
    }
    const modeLabel = { list: '白名单', friends: '好友自动放行', all: '纯黑名单（全放开）' }[allow.privateMode] || allow.privateMode;
    logLine(`控制台：白名单已更新（群: ${allow.groups.join(',') || '无'}，私聊: ${allow.private.join(',') || '无'}，私聊策略: ${modeLabel}，管理员: ${ownerQQ ?? '未设置'}）`);
    return { ok: true, allow, deny, ownerQQ, friendCount: live.friendIds.size };
  }

  /** POST /api/security */
  function saveSecurity(body = {}) {
    const configFile = path.join(ROOT, 'config.json');
    const file = readJsonSafe(configFile, null, true);
    const next = { ...(file.security ?? {}), ...body };
    if (typeof next.interceptNotify === 'boolean') next.interceptNotify = next.interceptNotify;
    else if (next.interceptNotify !== undefined) next.interceptNotify = Boolean(next.interceptNotify);
    file.security = next;
    atomicWriteJson(configFile, file);
    cfg.security = { ...(cfg.security ?? {}), ...next };
    logLine(`控制台：安全拦截通知已更新（interceptNotify=${cfg.security.interceptNotify}）`);
    return { ok: true, security: cfg.security };
  }

  /** POST /api/console/token */
  function rotateConsoleToken(body = {}, authState) {
    let newToken = String(body.token ?? '').trim();
    const generated = !newToken;
    if (generated) {
      newToken = crypto.randomBytes(24).toString('hex');
    }
    if (newToken.length < 16) return { ok: false, status: 400, error: '控制台访问令牌至少需要 16 位；留空可生成随机令牌' };
    if (newToken.length > 128) return { ok: false, status: 400, error: '控制台访问令牌不能超过 128 位' };
    if (!/^[A-Za-z0-9_-]+$/.test(newToken)) return { ok: false, status: 400, error: '控制台访问令牌只能包含字母、数字、下划线或短横线' };
    const configFile = path.join(ROOT, 'config.json');
    const file = readJsonSafe(configFile, null, true);
    // 手动令牌写入 config.json（用户可见、可再改）；随机令牌写入 state/console-token 并清空 config 中的手动值。
    file.consoleToken = generated ? '' : newToken;
    atomicWriteJson(configFile, file);
    cfg.consoleToken = generated ? '' : newToken;
    atomicWriteText(path.join(STATE_DIR, 'console-token'), newToken);
    authState.consoleToken = newToken;
    logLine(`控制台：访问令牌已${generated ? '重新生成' : '手动修改'}（不记录完整值）`);
    return { ok: true, token: newToken, generated };
  }

  /** POST /api/test-send */
  async function testSend(body = {}) {
    const kind = body.kind === 'private' ? 'private' : 'group';
    const id = Number(body.id);
    const message = String(body.message ?? '').trim();
    if (!Number.isFinite(id) || id <= 0) return { ok: false, status: 400, error: '目标 id 无效' };
    if (!message) return { ok: false, status: 400, error: '消息不能为空' };
    if (SENSITIVE_RE.test(message)) return { ok: false, status: 403, error: '消息含敏感信息，已阻止发送' };
    if (!allowed(kind, id, cfg)) return { ok: false, status: 403, error: `目标不在白名单内（${kind} ${id}），请先加入白名单` };
    if (!modeAllowed(`${kind}:${id}`, kind, id, cfg, live.currentMode)) {
      return { ok: false, status: 403, error: `当前模式（${live.currentMode}）不允许向 ${kind}:${id} 发送测试消息` };
    }
    try {
      const safeMessage = escapeCqText(redactKnownTokensOnly(message));
      const result = kind === 'private'
        ? await bot.sendPrivateMessage(id, text(safeMessage))
        : await bot.sendGroupMessage(id, text(safeMessage));
      recordSentMessage(`${kind}:${id}`, result, safeMessage);
      logLine(`控制台：测试发送 ${kind}:${id} 成功`);
      return { ok: true, kind, id, message_id: result?.message_id ?? result };
    } catch (error) {
      return { ok: false, status: 500, error: `发送失败: ${error?.message ?? error}` };
    }
  }

  return { saveWhitelist, saveSecurity, rotateConsoleToken, testSend };
}
