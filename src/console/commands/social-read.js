// R4.7-3：标记已读 / 唤醒配置 / 手动唤醒命令。
//
// 这三个动作原先在路由里直接摸 20+ 个运行态集合与唤醒配置。收进命令层后，
// 路由只做 key/agent 鉴权；「未读里有人叫你不能直接收尾」「潜水前必须观察」
// 「无限期潜水必须至少一个触发条件」等硬拦截集中维护。

export function createSocialReadCommands({
  config = {},
  sessions = {},
  social = {},
  operations = {}
} = {}) {
  const { cfg = {}, log } = config;
  const { markReadCalledKeys, wakeConfigUpdatedKeys, wakeConfigMissCount } = sessions;
  const {
    getSocialV2State,
    findCallersV2,
    isSleepingConfigV2,
    preSleepWaitBlockedV2,
    ensureWakeableV2,
    computeWakeSafetyV2,
    saveSocialV2State,
    cancelReplyCheckV2,
    setupSleepTimerV2,
    normalizeSpeakerIdsV2,
    sendWakePromptV2
  } = social;
  const { live = {}, modeAllowed } = operations;
  const logLine = (message) => { try { log?.(message); } catch { /* 日志失败不影响主流程 */ } };

  /** POST /api/socialV2/mark-read */
  function markRead({ key } = {}) {
    const st = getSocialV2State(key);
    // 硬拦截：未读里有人在叫它（@ 它的任一别名 / 引用它），而它这一轮还没发过言时，
    // 不允许直接已读收尾。判据只看 pending（answered 是已经回过的旧 @）。
    {
      const callerMsgs = findCallersV2(key, st);
      if (callerMsgs.pending.length) {
        const brief = callerMsgs.pending
          .slice(-3)
          .map((m) => `${String(m.sender || '某人')}：${String(m.text || m.plain || '').slice(0, 30)}`)
          .join('；');
        return {
          ok: false,
          status: 400,
          error: `未读里有人在叫你，不能就这样已读收尾：${brief}。请先正面回应（优先用 qq_reply；用 qq_send_message 时带 replyToMessageId，桥接才能确认你回的是哪条）；如果这条你确实办不到，就直接对群友说明办不到的原因——话说给对方听，不要报告自己的处理流程或调度状态。`,
          callers: callerMsgs.pending.length
        };
      }
    }
    // 如果当前已经是“潜水”唤醒配置，且最近还有对话/刚被唤醒，不允许用 mark_read 直接回到潜水；
    // 必须先等够沉睡前观察窗口，避免“聊两句又去潜水”。
    if (isSleepingConfigV2(st.wakeConfig) && preSleepWaitBlockedV2(st, key)) {
      const preSleepMs = Math.max(0, Number(cfg.socialV2?.wake?.preSleepWaitMs) || 300000);
      const remaining = Math.max(0, preSleepMs - ((st.lastIncomingAt || 0) ? Date.now() - st.lastIncomingAt : 0));
      const remainMin = Math.ceil(remaining / 60000);
      return {
        ok: false,
        status: 400,
        error: `还不能通过 qq_mark_read 直接回到潜水：还需等待约 ${remainMin} 分钟无新消息，或调用 qq_wait_for_messages(timeoutMs=${preSleepMs}) 完成一次沉睡前观察。如果等待期间有人发新消息，请先查看返回的 newMessages；判断不需要你参与就可以直接收尾沉睡，若你参与了则需下次再等观察窗口。`,
        preSleepWaitMs: preSleepMs,
        preSleepWaitRemainingMs: remaining
      };
    }
    const markedCount = st.unread.length;
    // 未读清理：**该清的要清干净**，否则会永久滞留并导致重复回答。
    // 只保留本轮唤醒之后新到的（seq > wakeSeqAt）；拿不到水位时保守清空。
    const wakeSeqAt = Number(st.wakeSeqAt) || 0;
    if (wakeSeqAt > 0) {
      st.unread = st.unread.filter((m) => Number(m?.seq) > wakeSeqAt);
    } else {
      st.unread = [];
    }
    // 水位用掉即清，避免下一轮误用它去清刚到的消息。
    st.wakeSeqAt = 0;
    const keptUnread = st.unread.length;
    st.lastActionAt = Date.now();
    st.wakeConfig.noActionCount = 0;
    // 防止“有限潜水被 timeout 唤醒后 sleepUntil 被清空、又 mark_read 收尾”导致无定时器无触发条件的静默态。
    if (!st.wakeConfig.infinite && !st.wakeConfig.sleepUntil) {
      st.wakeConfig.infinite = true;
    }
    ensureWakeableV2(st, { key });
    st.wakeConfig.confirmedAt = Date.now();
    st.wakeConfig.confirmedBy = 'mark_read';
    markReadCalledKeys.add(key);
    saveSocialV2State?.();
    logLine(`[reserved2] 控制台/工具标记 ${key} 未读已读：${markedCount - keptUnread} 条${keptUnread ? `，保留 ${keptUnread} 条待补发唤醒的消息` : ''}，已确认下一次唤醒配置`);
    return {
      ok: true,
      key,
      markedCount,
      wakeGuaranteed: computeWakeSafetyV2(st.wakeConfig).guaranteed,
      wakeSafety: computeWakeSafetyV2(st.wakeConfig),
      wakeConfig: st.wakeConfig
    };
  }

  /** POST /api/socialV2/wake-config */
  function setWakeConfig({ key, body = {} } = {}) {
    const st = getSocialV2State(key);
    const input = body.config && typeof body.config === 'object' && !Array.isArray(body.config) ? body.config : {};
    const current = st.wakeConfig;
    const inputTriggers = input.triggers && typeof input.triggers === 'object' && !Array.isArray(input.triggers) ? input.triggers : {};
    const normalizeTriggerBool = (name, fallback) => {
      if (name in inputTriggers) return inputTriggers[name] === true;
      return fallback;
    };
    const rawKeywords = inputTriggers.keywords;
    const nextKeywords = rawKeywords !== undefined
      ? (Array.isArray(rawKeywords)
          ? rawKeywords.map((k) => String(k ?? '').trim()).filter(Boolean).slice(0, 50).map((k) => k.slice(0, 100))
          : [])
      : (Array.isArray(current.triggers.keywords) ? current.triggers.keywords.slice(0, 50).map((k) => String(k).slice(0, 100)) : []);
    const next = {
      ...current,
      mode: input.mode === 'active' ? 'active' : input.mode === 'diving' ? 'diving' : current.mode,
      infinite: typeof input.infinite === 'boolean' ? input.infinite : current.infinite,
      sleepUntil: current.sleepUntil,
      triggers: {
        ...current.triggers,
        ...inputTriggers,
        atMention: normalizeTriggerBool('atMention', current.triggers.atMention === true),
        nameMention: normalizeTriggerBool('nameMention', current.triggers.nameMention === true),
        question: normalizeTriggerBool('question', current.triggers.question === true),
        anyMessage: normalizeTriggerBool('anyMessage', current.triggers.anyMessage === true),
        poke: normalizeTriggerBool('poke', current.triggers.poke === true),
        keywords: nextKeywords
      },
      batchWindowMs: Number.isFinite(Number(input.batchWindowMs)) && Number(input.batchWindowMs) >= 1000
        ? Math.min(3600000, Math.round(Number(input.batchWindowMs)))
        : current.batchWindowMs
    };
    // 从 active 切回 diving 时，若 AI 没显式保留 anyMessage，则清除，避免“潜水=每条都唤醒”的语义矛盾。
    if (next.mode === 'diving' && !('anyMessage' in inputTriggers)) {
      next.triggers.anyMessage = false;
    }
    if (next.mode === 'active') {
      next.infinite = true;
      next.sleepUntil = null;
      next.triggers.anyMessage = true;
    }
    if (typeof input.infinite === 'boolean' && next.mode !== 'active') next.infinite = input.infinite;
    if (next.infinite) {
      next.sleepUntil = null;
    } else if (input.sleepUntil) {
      const d = new Date(String(input.sleepUntil));
      if (!Number.isNaN(d.getTime())) next.sleepUntil = d.toISOString();
    } else if (Number.isFinite(Number(input.sleepMs))) {
      let ms = Math.max(0, Math.round(Number(input.sleepMs)));
      const minMs = Math.max(0, Number(cfg.socialV2?.wake?.sleepMinMs) || 0);
      const maxMs = Number(cfg.socialV2?.wake?.sleepMaxMs) || 0;
      if (ms < minMs) ms = minMs;
      if (maxMs > 0 && ms > maxMs) ms = maxMs;
      next.sleepUntil = new Date(Date.now() + ms).toISOString();
    } else if (!next.sleepUntil && !next.infinite) {
      // 既没有无限也没有时间：使用推荐默认有限时长
      const recMin = Number(cfg.socialV2?.wake?.recommendedSleepMinMs) || 300000;
      const recMax = Number(cfg.socialV2?.wake?.recommendedSleepMaxMs) || 7200000;
      const ms = recMin + Math.random() * Math.max(0, recMax - recMin);
      next.sleepUntil = new Date(Date.now() + Math.round(ms)).toISOString();
    }
    // 对有限 sleepUntil 也做 min/max clamp，防止绕过 sleepMaxMs
    if (!next.infinite && next.sleepUntil) {
      const maxMs = Number(cfg.socialV2?.wake?.sleepMaxMs) || 0;
      const minMs = Math.max(0, Number(cfg.socialV2?.wake?.sleepMinMs) || 0);
      let until = Date.parse(next.sleepUntil);
      if (Number.isFinite(until)) {
        if (minMs > 0 && until < Date.now() + minMs) until = Date.now() + minMs;
        if (maxMs > 0 && until > Date.now() + maxMs) until = Date.now() + maxMs;
        next.sleepUntil = new Date(until).toISOString();
      }
    }
    // 归一化概率
    if (next.triggers.probability !== undefined) {
      next.triggers.probability = Math.min(1, Math.max(0, Number(next.triggers.probability) || 0));
    }
    // 归一化拍一拍触发（只接受布尔，防脏字符串被当成 true）
    if (input.triggers && typeof input.triggers === 'object' && 'poke' in input.triggers) {
      next.triggers.poke = input.triggers.poke === true;
    }
    // 归一化“指定成员”触发：只保留正整数 QQ 号，去重，限制数量；
    // null/undefined/非法值统一清空，避免“null”被当成有效唤醒条件绕过防永眠。
    next.triggers.speakerIds = normalizeSpeakerIdsV2(next.triggers.speakerIds);
    // 私聊不适用“指定成员发言醒来”：清除以免误导/脏数据（私聊仍按原有逻辑每次消息都唤醒）。
    if (key.startsWith('private:')) {
      next.triggers.speakerIds = [];
    }
    // 防止 AI 永眠：无限期潜水必须至少有一个可触发条件
    if (next.infinite) {
      const tr = next.triggers ?? {};
      const hasTrigger = tr.atMention || tr.nameMention || tr.poke || (Array.isArray(tr.keywords) && tr.keywords.length > 0) || tr.question || tr.anyMessage || (Number(tr.probability) > 0) || (Array.isArray(tr.speakerIds) && tr.speakerIds.length > 0);
      if (!hasTrigger) {
        return { ok: false, status: 400, error: '无限期潜水必须至少保留一个唤醒条件（@/名字/拍一拍/关键词/提问/anyMessage/概率>0），否则 AI 可能永眠' };
      }
    }
    // 硬拦截（与 qq_mark_read 同规则）：未读里有人叫它、而本轮还没回应时，
    // 不允许直接设置潜水/下一次唤醒就走人。判据同样只看 pending。
    if (isSleepingConfigV2(next)) {
      const callerMsgs2 = findCallersV2(key, st);
      if (callerMsgs2.pending.length) {
        const brief2 = callerMsgs2.pending
          .slice(-3)
          .map((m) => `${String(m.sender || '某人')}：${String(m.text || m.plain || '').slice(0, 30)}`)
          .join('；');
        return {
          ok: false,
          status: 400,
          error: `未读里有人在叫你，不能先潜水走人：${brief2}。请先正面回应（优先用 qq_reply；用 qq_send_message 时带 replyToMessageId，桥接才能确认你回的是哪条），回应后再设置下一次唤醒；如果这条你确实办不到，就直接对群友说明办不到的原因——话说给对方听，不要报告自己的处理流程或调度状态。`,
          callers: callerMsgs2.pending.length
        };
      }
    }
    // 沉睡前强制观察窗口：除非对方明确结束、或已经安静/等待足够时间，否则不允许 AI 聊两句就设置潜水。
    if (isSleepingConfigV2(next) && preSleepWaitBlockedV2(st, key)) {
      const preSleepMs = Math.max(0, Number(cfg.socialV2?.wake?.preSleepWaitMs) || 300000);
      const remaining = Math.max(0, preSleepMs - ((st.lastIncomingAt || 0) ? Date.now() - st.lastIncomingAt : 0));
      const remainMin = Math.ceil(remaining / 60000);
      return {
        ok: false,
        status: 400,
        error: `还不能立刻设置潜水/下一次唤醒：还需等待约 ${remainMin} 分钟无新消息，或调用 qq_wait_for_messages(timeoutMs=${preSleepMs}) 完成一次沉睡前观察。如果等待期间有人发新消息，请先查看返回的 newMessages；判断不需要你参与就可以直接设置并沉睡，若你参与了则需下次再等观察窗口。`,
        preSleepWaitMs: preSleepMs,
        preSleepWaitRemainingMs: remaining
      };
    }
    st.wakeConfig = next;
    st.wakeConfig.lastWakeAt = st.wakeConfig.lastWakeAt || 0;
    st.wakeConfig.wakeCount = st.wakeConfig.wakeCount || 0;
    st.wakeConfig.noActionCount = 0;
    st.wakeConfig.confirmedAt = Date.now();
    st.wakeConfig.confirmedBy = 'set_wake_config';
    st.lastActionAt = Date.now();
    // 已成功设置下一次唤醒：本轮沉睡前观察标记作废，下次想再睡需重新走 5 分钟观察。
    st.preSleepWaitSatisfiedAt = 0;
    st.preSleepWaitObservedAt = 0;
    st.preSleepWaitAccumMs = 0;
    saveSocialV2State?.();
    wakeConfigUpdatedKeys.add(key);
    wakeConfigMissCount.delete(key);
    if (st.pendingWakeTimer) {
      clearTimeout(st.pendingWakeTimer);
      st.pendingWakeTimer = null;
    }
    cancelReplyCheckV2(key); // AI 已主动设置新的唤醒配置，取消回复检查
    setupSleepTimerV2(key);
    logLine(`[reserved2] 更新唤醒配置 ${key}: mode=${next.mode} infinite=${next.infinite} sleepUntil=${next.sleepUntil ?? 'null'}`);
    return { ok: true, key, wakeConfig: next, wakeSafety: computeWakeSafetyV2(next) };
  }

  /** POST /api/socialV2/wake：控制台手动唤醒。 */
  function wake({ key, reason } = {}) {
    if (live.currentMode !== 'reserved2') return { ok: false, status: 403, error: '该接口仅 reserved2 模式可用' };
    const keyMatch = /^(group|private):(\d+)$/.exec(key);
    if (!keyMatch) return { ok: false, status: 400, error: 'key 格式应为 group:群号 或 private:QQ号' };
    const kind = keyMatch[1];
    const id = Number(keyMatch[2]);
    if (!Number.isFinite(id) || id <= 0 || typeof modeAllowed !== 'function' || !modeAllowed(key, kind, id, cfg, live.currentMode)) {
      return { ok: false, status: 403, error: '目标不在当前模式允许范围内' };
    }
    const st = getSocialV2State(key);
    if (st.pendingWakeTimer) {
      clearTimeout(st.pendingWakeTimer);
      st.pendingWakeTimer = null;
    }
    if (!st.bootstrapSent) st.bootstrapSent = true;
    saveSocialV2State?.();
    sendWakePromptV2(key, reason, { manual: true });
    logLine(`控制台：手动唤醒 ${key}（${reason}）`);
    return { ok: true, key, reason };
  }

  return { markRead, setWakeConfig, wake };
}
