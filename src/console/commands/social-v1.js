// R4.7-3：一代社交阶段 / 配置 / flush / 后台提醒命令。
//
// 配置保存的清理/clamp/min-max 交换全部保留；写盘成功后才同步内存。
// 后台提醒沿用「silent turn 占位 + 失败回滚」流程，提醒文本禁止复述/泄露令牌。

export function createSocialV1Commands({
  config = {},
  operations = {},
  sessions = {},
  social = {}
} = {}) {
  const { ROOT, cfg = {}, fs, path, log, readJsonSafe, atomicWriteJson, roleFor } = config;
  const { live = {}, appendActivity, deliverPrompt, ensureSession } = operations;
  const { socialV2 = { conversations: new Map() }, state = {}, allowed, social: socialRuntime = {} } = sessions;
  const { enterActive, leaveActive, flushSummaries, getSocialV2State, modeAllowed } = social;
  const logLine = (message) => { try { log?.(message); } catch { /* 日志失败不影响主流程 */ } };

  /** POST /api/social/state */
  function setPhase(body = {}) {
    const key = String(body.key ?? '').trim();
    if (!key) return { ok: false, status: 400, error: 'key 不能为空' };
    const phase = body.phase;
    if (phase === 'active') {
      enterActive?.(key);
      logLine(`控制台：手动将 ${key} 设为活跃`);
      return { ok: true, key, phase: 'active' };
    }
    if (phase === 'idle') {
      leaveActive?.(key);
      logLine(`控制台：手动将 ${key} 设为观望`);
      return { ok: true, key, phase: 'idle' };
    }
    return { ok: false, status: 400, error: 'phase 必须是 active 或 idle' };
  }

  /** POST /api/social：仿真群友模式配置。 */
  function saveConfig(body = {}) {
    const configFile = path.join(ROOT, 'config.json');
    // fail-fast：配置文件损坏时直接抛，绝不回写，避免把整个配置清成只剩 social
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
    logLine('控制台：社交配置已更新');
    return { ok: true, config: cfg.social };
  }

  /** POST /api/social/flush */
  async function flush(body = {}) {
    await flushSummaries?.(body.key || null);
    return { ok: true };
  }

  /** POST /api/console/notify-ai */
  async function notifyAi(body = {}) {
    const key = String(body.key ?? '').trim();
    const message = String(body.message ?? '').trim();
    if (!key || !message) return { ok: false, status: 400, error: 'key 和 message 不能为空' };
    const keyMatch = /^(group|private):(\d+)$/.exec(key);
    if (!keyMatch) return { ok: false, status: 400, error: 'key 格式应为 group:群号 或 private:QQ号' };
    const kind = keyMatch[1];
    const id = Number(keyMatch[2]);
    if (!Number.isFinite(id) || id <= 0) return { ok: false, status: 400, error: 'id 无效' };
    if (typeof modeAllowed === 'function' && !modeAllowed(key, kind, id, cfg, live.currentMode)) {
      return { ok: false, status: 403, error: `该会话不在当前模式（${live.currentMode}）允许范围内` };
    }
    if (!state.sessions?.[key] && typeof allowed === 'function' && !allowed(kind, id, cfg)) {
      return { ok: false, status: 403, error: '该会话不在白名单内，且尚未创建' };
    }
    if (!live.dshReady) return { ok: false, status: 503, error: 'DSH 当前不可用，请稍后再试' };
    const isV2 = live.currentMode === 'reserved2';
    const roleName = roleFor?.(key);
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
      const arr = socialRuntime.silentTurns.get(sessionId) ?? [];
      socialRuntime.silentTurns.set(sessionId, [...arr, { id: silentId, ts: Date.now() }]);
      popSilent = () => {
        const list = socialRuntime.silentTurns.get(sessionId) ?? [];
        const next = list.filter((x) => x.id !== silentId);
        if (next.length > 0) socialRuntime.silentTurns.set(sessionId, next);
        else socialRuntime.silentTurns.delete(sessionId);
      };
      const result = await deliverPrompt(key, promptText, { silent: true });
      if (result.ok) {
        logLine(`控制台：已向 ${key} 的 DSH 发送后台提醒`);
        appendActivity?.(`${key} 控制台后台提醒：${message.slice(0, 80)}`);
        return { ok: true, key, sessionId };
      }
      popSilent();
      return { ok: false, status: 500, error: result.error || '投递失败' };
    } catch (error) {
      if (popSilent) popSilent();
      return { ok: false, status: 500, error: error?.message ?? String(error) };
    }
  }

  return { setPhase, saveConfig, flush, notifyAi };
}
