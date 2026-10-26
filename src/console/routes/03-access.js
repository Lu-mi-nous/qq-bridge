// 控制台路由域：会话 / 白名单 / 安全 / 控制台令牌（R4）。
//
// 从 console-server.js 原样搬出，只调整了缩进；鉴权 / CSRF / agent 白名单 /
// 暂停隔离仍由 console-server 统一处理，走到这里时请求已通过全部前置校验。
export const id = '03-access';
export const title = '会话 / 白名单 / 安全 / 控制台令牌';

/** 本模块负责的路由；console-server 据此分派，不必解析 handler 内部。 */
export const routes = [
  ['GET', '/api/sessions', 'exact'],
  ['GET', '/api/pending', 'exact'],
  ['GET', '/api/whitelist', 'exact'],
  ['POST', '/api/whitelist', 'exact'],
  ['GET', '/api/security', 'exact'],
  ['POST', '/api/security', 'exact'],
  ['GET', '/api/console/token', 'exact'],
  ['POST', '/api/console/token', 'exact'],
  ['POST', '/api/test-send', 'exact']
];

export async function handle(req, res, url, ctx) {
  const { sendJson, readBody, deps } = ctx;
  const { port, authState } = ctx;
  const {
    ROOT,
    SENSITIVE_RE,
    STATE_DIR,
    allowed,
    atomicWriteJson,
    atomicWriteText,
    bot,
    cfg,
    contextDisplayName,
    crypto,
    escapeCqText,
    log,
    modeAllowed,
    normalizeOwnerQQ,
    normalizePrivateMode,
    path,
    pending,
    readJsonSafe,
    recordSentMessage,
    redactKnownTokensOnly,
    refreshContextNames,
    refreshFriendList,
    state,
    text
  } = deps;

  // ── 会话查看 ──────────────────────────────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/api/sessions') {
    // 带上群名 / QQ 昵称：控制台的会话列表不能只显示号码。
    // 复用上下文卡片的名称缓存（群列表 + 好友列表 + 陌生人资料，5 分钟 TTL）。
    try { await refreshContextNames(false); } catch {}
    const list = [];
    for (const [key, sessionId] of Object.entries(state.sessions)) {
      const [kind, id] = String(key).split(':');
      list.push({
        key,
        sessionId,
        owner: key === `private:${String(cfg.ownerQQ ?? '')}`,
        kind,
        name: contextDisplayName(key) || ''
      });
    }
    sendJson({ sessions: list });
    return;
  }
  // ── 挂起审批 / 提问 ───────────────────────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/api/pending') {
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
    sendJson({ pending: list });
    return;
  }
  // ── 白名单可视化编辑（写 config.json + 热更新内存） ───────────────────
  if (req.method === 'GET' && url.pathname === '/api/whitelist') {
    try { await refreshContextNames(!deps.live.contextNameCache.at || deps.live.contextNameCache.groups.size === 0); } catch {}
    sendJson({
      allow: cfg.allow ?? { private: [], groups: [] },
      deny: cfg.deny ?? { private: [], groups: [] },
      ownerQQ: cfg.ownerQQ ?? null,
      // 私聊准入策略（'list' 白名单 / 'friends' 好友自动放行 / 'all' 纯黑名单）
      privateMode: cfg.allow?.privateMode ?? 'list',
      // 好友数：'friends' 模式下控制台据此提示"当前生效的好友有多少"
      friendCount: deps.live.friendIds.size,
      // 控制台显示用：群名 / QQ 昵称；取不到的号码前端只显示号码
      groupNames: Object.fromEntries(deps.live.contextNameCache.groups),
      privateNames: Object.fromEntries(deps.live.contextNameCache.privates),
    });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/whitelist') {
    const body = await readBody();
    const toNum = (arr) => Array.isArray(arr) ? [...new Set(arr.map((x) => Number(String(x).trim())).filter((n) => Number.isFinite(n)))] : undefined;
    const configFile = path.join(ROOT, 'config.json');
    // fail-fast：配置文件损坏时直接 500，绝不回写，避免把整个配置清成只剩 allow/deny/ownerQQ
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
        sendJson({ ok: false, error: error?.message ?? 'ownerQQ 无效' }, 400);
        return;
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
      refreshFriendList({ force: true }).then((ids) => log(`[私聊准入] 好友列表已刷新：${ids.size} 人`)).catch(() => {});
    }
    const modeLabel = { list: '白名单', friends: '好友自动放行', all: '纯黑名单（全放开）' }[allow.privateMode] || allow.privateMode;
    log(`控制台：白名单已更新（群: ${allow.groups.join(',') || '无'}，私聊: ${allow.private.join(',') || '无'}，私聊策略: ${modeLabel}，管理员: ${ownerQQ ?? '未设置'}）`);
    sendJson({ ok: true, allow, deny, ownerQQ, friendCount: deps.live.friendIds.size });
    return;
  }

  // ── 安全拦截通知设置 ─────────────────────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/api/security') {
    sendJson({ security: cfg.security ?? { interceptNotify: true } });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/security') {
    const body = await readBody();
    const configFile = path.join(ROOT, 'config.json');
    const file = readJsonSafe(configFile, null, true);
    const next = { ...(file.security ?? {}), ...body };
    if (typeof next.interceptNotify === 'boolean') next.interceptNotify = next.interceptNotify;
    else if (next.interceptNotify !== undefined) next.interceptNotify = Boolean(next.interceptNotify);
    file.security = next;
    atomicWriteJson(configFile, file);
    cfg.security = { ...(cfg.security ?? {}), ...next };
    log(`控制台：安全拦截通知已更新（interceptNotify=${cfg.security.interceptNotify}）`);
    sendJson({ ok: true, security: cfg.security });
    return;
  }
  // ── 控制台访问令牌（可手动修改/生成随机） ─────────────────────────────
  // GET：只读返回「鉴权是否开启」，供页面显示当前状态。
  // **不回传令牌本身**（控制台页面不需要它，令牌值在 state/console-token 与 config 里）。
  if (req.method === 'GET' && url.pathname === '/api/console/token') {
    sendJson({
      ok: true,
      authEnabled: authState.consoleToken !== '',
      hasToken: authState.consoleToken !== '',
      port,
      hint: authState.consoleToken === ''
        ? '令牌鉴权已关闭（config.consoleAuth=false）：直接访问即可，无需登录'
        : '令牌鉴权已开启：刷新页面时会要求输入令牌'
    });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/console/token') {
    const body = await readBody();
    let newToken = String(body.token ?? '').trim();
    const generated = !newToken;
    if (generated) {
      newToken = crypto.randomBytes(24).toString('hex');
    }
    if (newToken.length < 16) {
      sendJson({ ok: false, error: '控制台访问令牌至少需要 16 位；留空可生成随机令牌' }, 400);
      return;
    }
    if (newToken.length > 128) {
      sendJson({ ok: false, error: '控制台访问令牌不能超过 128 位' }, 400);
      return;
    }
    if (!/^[A-Za-z0-9_-]+$/.test(newToken)) {
      sendJson({ ok: false, error: '控制台访问令牌只能包含字母、数字、下划线或短横线' }, 400);
      return;
    }
    const configFile = path.join(ROOT, 'config.json');
    const file = readJsonSafe(configFile, null, true);
    // 手动令牌写入 config.json（用户可见、可再改）；随机令牌写入 state/console-token 并清空 config 中的手动值。
    file.consoleToken = generated ? '' : newToken;
    atomicWriteJson(configFile, file);
    cfg.consoleToken = generated ? '' : newToken;
    atomicWriteText(path.join(STATE_DIR, 'console-token'), newToken);
    authState.consoleToken = newToken;
    log(`控制台：访问令牌已${generated ? '重新生成' : '手动修改'}（不记录完整值）`);
    sendJson({ ok: true, token: newToken, generated });
    return;
  }
  // ── 测试发送消息（强制走白名单校验） ───────────────────────────────────
  if (req.method === 'POST' && url.pathname === '/api/test-send') {
    const body = await readBody();
    const kind = body.kind === 'private' ? 'private' : 'group';
    const id = Number(body.id);
    const message = String(body.message ?? '').trim();
    if (!Number.isFinite(id) || id <= 0) { sendJson({ ok: false, error: '目标 id 无效' }, 400); return; }
    if (!message) { sendJson({ ok: false, error: '消息不能为空' }, 400); return; }
    if (SENSITIVE_RE.test(message)) { sendJson({ ok: false, error: '消息含敏感信息，已阻止发送' }, 403); return; }
    if (!allowed(kind, id, cfg)) { sendJson({ ok: false, error: `目标不在白名单内（${kind} ${id}），请先加入白名单` }, 403); return; }
    if (!modeAllowed(`${kind}:${id}`, kind, id, cfg, deps.live.currentMode)) { sendJson({ ok: false, error: `当前模式（${deps.live.currentMode}）不允许向 ${kind}:${id} 发送测试消息` }, 403); return; }
    try {
      const safeMessage = escapeCqText(redactKnownTokensOnly(message));
      const result = kind === 'private'
        ? await bot.sendPrivateMessage(id, text(safeMessage))
        : await bot.sendGroupMessage(id, text(safeMessage));
      recordSentMessage(`${kind}:${id}`, result, safeMessage);
      log(`控制台：测试发送 ${kind}:${id} 成功`);
      sendJson({ ok: true, kind, id, message_id: result?.message_id ?? result });
    } catch (error) {
      sendJson({ ok: false, error: `发送失败: ${error?.message ?? error}` }, 500);
    }
    return;
  }
}
