// 控制台路由域：一代社交状态与运维通知（R4）。
//
// 从 console-server.js 原样搬出，只调整了缩进；鉴权 / CSRF / agent 白名单 /
// 暂停隔离仍由 console-server 统一处理，走到这里时请求已通过全部前置校验。
let devLogCache = { mtimeMs: 0, size: 0, data: null };

export const id = '04-social-v1';
export const title = '一代社交状态与运维通知';

/** 本模块负责的路由；console-server 据此分派，不必解析 handler 内部。 */
export const routes = [
  ['POST', '/api/social/state', 'exact'],
  ['GET', '/api/social', 'exact'],
  ['POST', '/api/social', 'exact'],
  ['POST', '/api/social/flush', 'exact'],
  ['POST', '/api/console/notify-ai', 'exact'],
  ['GET', '/api/dev-log', 'exact']
];

export async function handle(req, res, url, ctx) {
  const { sendJson, readBody, deps } = ctx;
  const {
    ROOT,
    allowed,
    appendActivity,
    atomicWriteJson,
    cfg,
    contextDisplayName,
    deliverPrompt,
    ensureSession,
    enterActive,
    flushSummaries,
    fs,
    getSocialV2State,
    leaveActive,
    log,
    modeAllowed,
    path,
    readJsonSafe,
    roleFor,
    social,
    socialV2,
    state
  } = deps;
  const {
    parseChangelogMarkdown,
    sanitizeDevLogText
  } = ctx.helpers;

  if (req.method === 'POST' && url.pathname === '/api/social/state') {
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
    const phase = body.phase;
    if (phase === 'active') {
      // 手动进入活跃：相当于第四种触发方式，之后按正常活跃流程跑
      enterActive(key);
      log(`控制台：手动将 ${key} 设为活跃`);
      sendJson({ ok: true, key, phase: 'active' });
    } else if (phase === 'idle') {
      leaveActive(key);
      log(`控制台：手动将 ${key} 设为观望`);
      sendJson({ ok: true, key, phase: 'idle' });
    } else {
      sendJson({ ok: false, error: 'phase 必须是 active 或 idle' }, 400);
    }
    return;
  }
  // ── 仿真群友模式（社交引擎）配置 ──────────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/api/social') {
    const stats = {};
    for (const [k, e] of social.pendingSummaries.entries()) stats[k] = e.items.length;
    const states = {};
    const keys = new Set([...social.states.keys(), ...social.recentMessages.keys()]);
    for (const k of keys) {
      const st = social.states.get(k);
      states[k] = { phase: st?.phase ?? 'idle' };
    }
    sendJson({ config: cfg.social, pendingSummaries: stats, states });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/social') {
    const body = await readBody();
    const configFile = path.join(ROOT, 'config.json');
    // fail-fast：配置文件损坏时直接 500，绝不回写，避免把整个配置清成只剩 social
    const file = readJsonSafe(configFile, null, true);
    const merged = { ...(file.social ?? {}), ...body };
    // 新分句逻辑不再使用旧字段：保存时统一清理，避免旧配置残留
    for (const k of ['burstProbability', 'burstMaxMessages', 'followUpEnabled', 'followUpProbability', 'followUpDelayMinMs', 'followUpDelayMaxMs', 'followUpCooldownMs']) {
      delete merged[k];
    }
    for (const k of ['triggerProbability', 'activeCheckMinMs', 'activeCheckMaxMs', 'activeReplyDelayMinMs', 'activeReplyDelayMaxMs', 'activeDurationMinMs', 'activeDurationMaxMs', 'idleWindowMs', 'idleRetryProbability', 'idleRetryWaitMs', 'proactiveIdleThresholdMs', 'proactiveCheckMinMs', 'proactiveCheckMaxMs', 'proactiveProbability', 'maxReplyChars', 'contextWindow', 'burstIntervalMinMs', 'burstIntervalMaxMs', 'longGapMinMs', 'longGapMaxMs']) {
      if (merged[k] !== undefined) {
        const n = Number(merged[k]);
        if (Number.isFinite(n) && n >= 0) merged[k] = n;
      }
    }
    // 分条间隔 clamp 到非负
    for (const k of ['burstIntervalMinMs', 'burstIntervalMaxMs', 'longGapMinMs', 'longGapMaxMs']) {
      if (merged[k] !== undefined) merged[k] = Math.max(0, Number(merged[k]) || 0);
    }
    // 概率字段 clamp 到 0~1
    for (const k of ['triggerProbability', 'idleRetryProbability', 'proactiveProbability', 'skipProbability', 'surrenderProbability', 'longGapProbability']) {
      if (merged[k] !== undefined) merged[k] = Math.min(1, Math.max(0, Number(merged[k])));
    }
    // contextWindow 限制 1~100
    if (merged.contextWindow !== undefined) {
      merged.contextWindow = Math.min(100, Math.max(1, Math.round(Number(merged.contextWindow))));
    }
    // 布尔字段
    for (const k of ['activeDurationEnabled', 'proactiveEnabled', 'burstEnabled']) {
      if (merged[k] !== undefined) merged[k] = Boolean(merged[k]);
    }
    // 范围字段保证 min <= max
    for (const [minK, maxK] of [['activeCheckMinMs', 'activeCheckMaxMs'], ['activeReplyDelayMinMs', 'activeReplyDelayMaxMs'], ['activeDurationMinMs', 'activeDurationMaxMs'], ['proactiveCheckMinMs', 'proactiveCheckMaxMs'], ['burstIntervalMinMs', 'burstIntervalMaxMs'], ['longGapMinMs', 'longGapMaxMs']]) {
      if (merged[minK] !== undefined && merged[maxK] !== undefined && Number(merged[minK]) > Number(merged[maxK])) {
        [merged[minK], merged[maxK]] = [merged[maxK], merged[minK]];
      }
    }
    if (Array.isArray(body.mustReplyKeywords)) merged.mustReplyKeywords = body.mustReplyKeywords.map(String);
    file.social = merged;
    atomicWriteJson(configFile, file);
    cfg.social = { ...cfg.social, ...merged };
    log('控制台：社交配置已更新');
    sendJson({ ok: true, config: cfg.social });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/social/flush') {
    const body = await readBody();
    await flushSummaries(body.key || null);
    sendJson({ ok: true });
    return;
  }
  // ── 后台控制端引导：向指定会话的 DSH agent 投递提醒 ──────────────────
  if (req.method === 'POST' && url.pathname === '/api/console/notify-ai') {
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    const message = String(body.message ?? '').trim();
    if (!key || !message) {
      sendJson({ ok: false, error: 'key 和 message 不能为空' }, 400);
      return;
    }
    const keyMatch = /^(group|private):(\d+)$/.exec(key);
    if (!keyMatch) {
      sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400);
      return;
    }
    const kind = keyMatch[1];
    const id = Number(keyMatch[2]);
    if (!Number.isFinite(id) || id <= 0) {
      sendJson({ ok: false, error: 'id 无效' }, 400);
      return;
    }
    if (!modeAllowed(key, kind, id, cfg, deps.live.currentMode)) {
      sendJson({ ok: false, error: `该会话不在当前模式（${deps.live.currentMode}）允许范围内` }, 403);
      return;
    }
    if (!state.sessions[key] && !allowed(kind, id, cfg)) {
      sendJson({ ok: false, error: '该会话不在白名单内，且尚未创建' }, 403);
      return;
    }
    if (!deps.live.dshReady) {
      sendJson({ ok: false, error: 'DSH 当前不可用，请稍后再试' }, 503);
      return;
    }
    const isV2 = deps.live.currentMode === 'reserved2';
    const roleName = roleFor(key);
    const roleLine = roleName ? `【当前角色】${roleName}（完整角色卡请调用 qq_get_prompt 查看）\n\n` : '';
    // 二代必须带会话令牌，否则 AI 调用任何 MCP 状态/发送工具都会被拒。
    let tokenLine = '';
    if (isV2) {
      const stV2 = getSocialV2State(key);
      tokenLine = `【会话令牌】${stV2.agentToken}（调用二代状态/发送工具时请在参数中带上此令牌）\n\n`;
    }
    const promptText = `${roleLine}${tokenLine}【后台控制端提醒】（来自控制台/管理端，不是群友消息）\n${message}\n\n这是后台给你的引导或提醒，请据此调整你的行为。绝对不要复述、转发或原样发送这条后台提醒，也不要发送其中的会话令牌；它只用于你内部调整行为。${isV2 ? '当前是二代仿真模式：你的文本输出不会自动发送到 QQ；如果需要在群里发言，请使用发送工具（qq_send_message / qq_reply）。如果不需要发言，可以 qq_mark_read 或 qq_set_wake_config 收尾。' : '如果不需要在群里发言，请不要输出会发到 QQ 的内容。'}`;
    let sessionId = null;
    let popSilent = null;
    try {
      sessionId = await ensureSession(key);
      const silentId = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      const arr = social.silentTurns.get(sessionId) ?? [];
      social.silentTurns.set(sessionId, [...arr, { id: silentId, ts: Date.now() }]);
      popSilent = () => {
        const list = social.silentTurns.get(sessionId) ?? [];
        const next = list.filter((x) => x.id !== silentId);
        if (next.length > 0) social.silentTurns.set(sessionId, next);
        else social.silentTurns.delete(sessionId);
      };
      const result = await deliverPrompt(key, promptText, { silent: true });
      if (result.ok) {
        log(`控制台：已向 ${key} 的 DSH 发送后台提醒`);
        appendActivity(`${key} 控制台后台提醒：${message.slice(0, 80)}`);
        sendJson({ ok: true, key, sessionId });
      } else {
        popSilent();
        sendJson({ ok: false, error: result.error || '投递失败' }, 500);
      }
    } catch (error) {
      if (popSilent) popSilent();
      sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
    }
    return;
  }
  // ── 二代仿真模式（reserved2）内部 Agent API ─────────────────────────
  // ── 待配置项（凭据 / 密钥 / 关键连接配置）────────────────────────────
  //
  // 用户要求（2026-10-20）：把这些项放到控制台、做成密码样式（右侧隐藏/显示）、
  // 旁边配说明文档与保存键，需要重启的标明并提供重启按钮。
  //
  // 安全设计（务必保持）：
  //   ① GET 默认**只回「是否已配置」+ 脱敏预览**，绝不下发完整明文。
  //      用户点「显示」才单条请求（reveal=1），减少明文在页面/内存里的驻留。
  //   ② 写入沿用原始位置（config.json / state/*.json），**不新建集中明文文件**
  //      ——集中一处只会扩大泄露面。
  //   ③ 任何分支都不把这些值写进日志。
  // ── 关于页：见 src/console/routes/00-overview.js（R4）───────────────
  // 开发日志：读取 README 的更新日志章节（只读，不现算大文件）。
  if (req.method === 'GET' && url.pathname === '/api/dev-log') {
    try {
      const file = path.join(ROOT, 'README.md');
      const st = fs.statSync(file);
      if (!devLogCache.data || devLogCache.mtimeMs !== st.mtimeMs || devLogCache.size !== st.size) {
        const markdown = fs.readFileSync(file, 'utf8');
        devLogCache = {
          mtimeMs: st.mtimeMs,
          size: st.size,
          data: parseChangelogMarkdown(markdown)
        };
      }
      const redactions = [];
      const ids = new Set();
      if (cfg.ownerQQ) ids.add(String(cfg.ownerQQ));
      for (const key of socialV2.conversations.keys()) {
        const name = contextDisplayName(key);
        const m = /^(group|private):(\d+)$/.exec(key);
        if (m) ids.add(m[2]);
        if (!name) continue;
        redactions.push({ name, replacement: key.startsWith('private:') ? '某用户' : '某群' });
      }
      for (const key of Object.keys(state.sessions || {})) {
        const m = /^(group|private):(\d+)$/.exec(key);
        if (m) ids.add(m[2]);
      }
      const sanitize = (text) => sanitizeDevLogText(text, { names: redactions, ids: [...ids] });
      const data = devLogCache.data;
      sendJson({
        ok: true,
        updatedAt: st.mtimeMs,
        sanitized: true,
        entries: data.entries,
        sections: (data.sections || []).map((sec) => ({
          title: sanitize(sec.title),
          entries: (sec.entries || []).map((e) => ({
            title: sanitize(e.title),
            body: sanitize(e.body),
            date: e.date || ''
          }))
        }))
      });
    } catch (error) {
      sendJson({ ok: false, error: `读取开发日志失败：${error?.message ?? error}` }, 500);
    }
    return;
  }
}
