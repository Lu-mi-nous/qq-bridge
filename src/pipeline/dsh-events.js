import { pickPendingWake } from './wake.js';
// DSH 事件泵：按事件类型分派，bridge 只注入状态与副作用。
// currentTurnBySession 是回合归属的唯一判据；v2TurnStartAt 仅兼容既有等待/忙碌计时。
// 普通输出、工具去重、静默摘要、B 站初判及重连清理都在同一条有序事件流中执行。
import { createTurnCollector } from '../dsh-client.js';
import { mdToPlain } from '../md-to-plain.js';
import { isContextOverflowError } from '../context-recovery.js';
import { makeTurnId } from './turn-id.js';

const TURN_EVENTS = new Set(['turn/start', 'turn/end', 'assistant/message', 'assistant/chunk', 'tool/call', 'tool/result']);

export function createDshEventPump(deps) {
  const {
    api,
    reverse,
    collectors,
    currentTurnBySession,
    v2TurnStartAt,
    sendToolSucceededSessions,
    pendingSendToolCalls,
    toolCallNames,
    biliJudgeWaiters,
    biliJudgeCollectors,
    learnerSessions,
    learnerCollectors,
    learnerWaiters,
    getSlangLearnerSessionId,
    getMode,
    cfg,
    social,
    getSocialV2State,
    defaultWakeConfigV2,
    saveSocialV2State,
    pendingWakeKeys,
    wakeConfigUpdatedKeys,
    markReadCalledKeys,
    wakeConfigMissCount,
    activeWaits,
    clearAllPendingWakeLeases,
    armPendingWakeLease,
    disarmPendingWakeLease,
    ensureWakeableV2,
    // T1：发言回合的自动收尾（自动标已读水位 + 保证可唤醒）。桥接注入；缺席时退回提醒。
    autoWrapAfterReply = null,
    deliverPrompt,
    buildWakeReminderPromptV2,
    wakePriorityV2,
    pendingWakeSnapshotFromJournalV2,
    scheduleWakeV2,
    SILENT_TURN_TIMEOUT_MS,
    contextRecovery,
    recordTokenUsage,
    // T5：按回合采集 Token 效率指标；缺失时不影响主流程。
    turnMetrics = null,
    // T4：本回合最后一次请求的上下文估算（sessionId -> input+cacheRead）与主动轮换回调。
    sessionContextTokens = null,
    rotateContextIfNeeded = null,
    recordSessionProcessed,
    contextCfg,
    STATE_DIR,
    appendCompaction,
    contextMetrics,
    redactSensitiveText,
    sanitizeToolArgs,
    appendToolLog,
    isSendToolName,
    KNOWN_AGENT_TOKENS,
    shouldAuditKey,
    SENSITIVE_RE,
    isSilentMarker,
    SILENT_MARKER,
    isSocialEnabled,
    socialState,
    shouldBlockSilentReply,
    planSocialTimeline,
    sendBurstToQQ,
    sendToQQ,
    registerPending,
    handleUpstreamError,
    appendActivity,
    notifyOwnerOfError,
    log,
    sleep,
    now = Date.now
  } = deps;

  function handleCompaction(frame, key) {
    try {
      const d = frame.event.data || {};
      const rawSummary = Array.isArray(d.summary)
        ? d.summary.map((b) => String(b?.text ?? '')).join('\n')
        : String(d.summary ?? '');
      const summary = redactSensitiveText(rawSummary).trim();
      if (summary) {
        const c = contextCfg();
        appendCompaction(STATE_DIR, key, {
          at: now(),
          sessionId: frame.sessionId,
          compactionId: String(d.compactionId || ''),
          summary: summary.slice(0, 4000),
          shadowedTokenCount: Number(d.shadowedTokenCount) || 0,
          provider: String(d.provider || ''),
          model: String(d.model || ''),
          maxTokens: Number(d.maxTokens) || 0
        }, c.compactionKeep);
        const m = contextMetrics.get(key) || {};
        m.lastCompactionAt = now();
        m.lastCompactionNotch = Number(d.shadowedTokenCount) || 0;
        contextMetrics.set(key, m);
        log(`[上下文] ${key} 捕获 DSH 压缩摘要（压掉 ${Math.round((Number(d.shadowedTokenCount) || 0) / 1000)}k tokens）`);
      }
    } catch (error) {
      log(`[上下文] 保存压缩摘要失败：${error?.message ?? error}`);
    }
  }

  function startTurn(frame, key) {
    sendToolSucceededSessions.delete(frame.sessionId);
    pendingSendToolCalls.delete(frame.sessionId);
    const startedAt = now();
    v2TurnStartAt.set(frame.sessionId, startedAt);
    const turnId = makeTurnId(frame.sessionId, frame.event.data?.turn);
    currentTurnBySession.set(frame.sessionId, { turn: frame.event.data?.turn, turnId, startedAt });
    // T5：回合开始即记账（静默摘要回合只标记不计入；提示分项取自最近一次唤醒）。
    const silentQueued = (social.silentTurns.get(frame.sessionId) ?? []).length > 0;
    turnMetrics?.beginTurn(frame.sessionId, key, {
      silent: silentQueued,
      promptChars: contextMetrics.get(key)?.lastPromptSections ?? null
    });
    // B 站 waiter 只认“登记后真正开始的那一个回合”：
    // 登记时正在跑的旧回合不参与，避免把群聊回复当成初判结果。
    const judgeWaiter = biliJudgeWaiters.get(frame.sessionId);
    if (judgeWaiter && judgeWaiter.turn == null) {
      judgeWaiter.turn = frame.event.data?.turn;
      judgeWaiter.turnId = turnId;
      judgeWaiter.collector = createTurnCollector();
      biliJudgeCollectors.set(frame.sessionId, judgeWaiter.collector);
    }
    collectors.set(frame.sessionId, createTurnCollector());
    toolCallNames.delete(frame.sessionId);
  }

  function handleToolCall(frame, key) {
    const toolName = String(frame.event.data?.name ?? '');
    const callId = frame.event.data?.callId;
    const args = sanitizeToolArgs(frame.event.data?.arguments ?? frame.event.data?.input ?? frame.event.data);
    appendToolLog({ type: 'call', time: new Date(now()).toISOString(), key, sessionId: frame.sessionId, tool: toolName, args });
    turnMetrics?.recordToolCall(frame.sessionId, toolName);
    if (callId != null) {
      if (isSendToolName(toolName)) {
        let pending = pendingSendToolCalls.get(frame.sessionId);
        if (!pending) {
          pending = new Set();
          pendingSendToolCalls.set(frame.sessionId, pending);
        }
        pending.add(callId);
      }
      let nameMap = toolCallNames.get(frame.sessionId);
      if (!nameMap) {
        nameMap = new Map();
        toolCallNames.set(frame.sessionId, nameMap);
      }
      nameMap.set(String(callId), toolName);
    }
  }

  function handleToolResult(frame, key) {
    const callId = frame.event.data?.message?.source?.callId;
    const toolName = callId != null ? (toolCallNames.get(frame.sessionId)?.get(String(callId)) ?? '') : '';
    const resultBlock = frame.event.data?.message?.content?.[0];
    const resultError = frame.event.data?.message?.isError === true || resultBlock?.isError === true;
    const errorText = resultError ? String(resultBlock?.text ?? resultBlock?.error ?? frame.event.data?.message?.error ?? '') : '';
    appendToolLog({
      type: 'result',
      time: new Date(now()).toISOString(),
      key,
      sessionId: frame.sessionId,
      tool: toolName,
      ok: !resultError,
      error: errorText ? sanitizeToolArgs(errorText) : null
    });
    // T5：工具结果字符量（文本部分），用于 toolResultCharsPerTurn。
    turnMetrics?.recordToolResult(frame.sessionId, typeof resultBlock?.text === 'string' ? resultBlock.text.length : 0);
    if (callId != null) {
      toolCallNames.get(frame.sessionId)?.delete(String(callId));
      const pending = pendingSendToolCalls.get(frame.sessionId);
      if (pending?.has(callId)) {
        pending.delete(callId);
        if (pending.size === 0) pendingSendToolCalls.delete(frame.sessionId);
        if (!resultError) {
          sendToolSucceededSessions.add(frame.sessionId);
        }
      }
    }
  }

  function collectBiliJudge(frame) {
    const waiter = biliJudgeWaiters.get(frame.sessionId);
    const current = currentTurnBySession.get(frame.sessionId);
    // 登记前已在途的回合、迟到的旧帧，都不能回填初判。
    if (!waiter || !current || waiter.turnId !== current.turnId || waiter.turn !== frame.event.data?.turn) return;
    const ended = biliJudgeCollectors.get(frame.sessionId)?.push(frame.event);
    if (!ended) return;
    biliJudgeCollectors.delete(frame.sessionId);
    if (ended.text.trim()) {
      try { waiter.resolve(ended.text); } catch {}
    } else {
      // 纯工具回合不算初判结果，等待下一次真实 turn/start。
      waiter.turn = null;
      waiter.turnId = null;
      log(`[B站] 初判回合无文本（工具调用），继续等｜reason=${JSON.stringify(ended.reason)?.slice(0, 60)}`);
    }
  }

  async function finishTurn(frame, key, ended) {
    // 回合结束即视为“处理过”：记忆断层用它判断下次唤醒间隔。
    // 失败不影响回合；静默/工具/报错回合也要记，否则重启后会把正常处理误判成断层。
    try { recordSessionProcessed?.(key); } catch { /* 忽略 */ }
    // reserved2 无行动兜底：普通唤醒回合若既没发消息、也没 mark_read / set_wake_config，
    // 则累计 noActionCount；达到阈值后自动重置 WakeConfig，避免 AI 卡死。
    const silentQueueNow = social.silentTurns.get(frame.sessionId) ?? [];
    const isSilentTurn = silentQueueNow.length > 0;
    if (getMode() === 'reserved2' && key && !isSilentTurn) {
      const st = getSocialV2State(key);
      const turnStart = currentTurnBySession.get(frame.sessionId)?.startedAt ?? 0;
      const actionTaken = sendToolSucceededSessions.has(frame.sessionId) || (turnStart > 0 && st.lastActionAt >= turnStart);
      if (actionTaken) {
        st.wakeConfig.noActionCount = 0;
      } else {
        st.wakeConfig.noActionCount = (st.wakeConfig.noActionCount || 0) + 1;
        const limit = Number(cfg.socialV2?.wake?.noActionLimit) || 3;
        if (st.wakeConfig.noActionCount >= limit) {
          log(`[reserved2] ${key} 连续 ${st.wakeConfig.noActionCount} 次唤醒无行动，重置唤醒配置`);
          st.wakeConfig = defaultWakeConfigV2();
          st.bootstrapSent = true;
          st.wakeConfig.noActionCount = 0;
        }
      }
      saveSocialV2State();
    }
    v2TurnStartAt.delete(frame.sessionId);
    {
      const curTurn = currentTurnBySession.get(frame.sessionId);
      if (!curTurn || curTurn.turn === frame.event.data?.turn) currentTurnBySession.delete(frame.sessionId);
    }
    collectors.delete(frame.sessionId);
    const sendToolSucceeded = sendToolSucceededSessions.has(frame.sessionId);
    sendToolSucceededSessions.delete(frame.sessionId);
    pendingSendToolCalls.delete(frame.sessionId);
    toolCallNames.delete(frame.sessionId);
    // 标记本次 turn 是否为“活跃超时退场”发言（用于准确回到观望，避免把旧回复误判为退场）
    const isFarewell = social.exitingSessions.has(frame.sessionId);
    if (isFarewell) social.exitingSessions.delete(frame.sessionId);
    // 摘要投喂触发的 turn：回复静默（不发送到 QQ）。
    // 用 FIFO 时间戳队列 + 超时回收，避免计数残留吞掉后续正常回复。
    const silentQueue = social.silentTurns.get(frame.sessionId) ?? [];
    const silentNow = now();
    while (silentQueue.length && silentNow - silentQueue[0].ts > SILENT_TURN_TIMEOUT_MS) silentQueue.shift();
    if (silentQueue.length > 0) {
      // 静默摘要回合如果也撞上上下文超限，仍要轮换会话；但不重试摘要
      // （摘要不是必须立即完成的事，下一轮正常唤醒会用新会话）。
      if (ended.reason.kind === 'error' && isContextOverflowError(ended.reason.error?.message ?? '')) {
        await contextRecovery.recover({
          key,
          sessionId: frame.sessionId,
          error: ended.reason.error?.message ?? '',
          mode: getMode(),
          silent: true
        });
      }
      silentQueue.shift();
      if (silentQueue.length > 0) social.silentTurns.set(frame.sessionId, silentQueue);
      else social.silentTurns.delete(frame.sessionId);
      log(`摘要投喂 turn 结束，静默 (${key})`);
      return;
    }
    // T4：主动轮换。本回合最后一次请求的上下文估算接近模型上限时，
    // 先持久化（由桥接的 rotateContextIfNeeded 完成 episode），再换会话，
    // 不等到 prompt_too_long 才被动恢复。静默摘要回合已在上方返回，不触发。
    {
      const estimated = sessionContextTokens instanceof Map ? sessionContextTokens.get(frame.sessionId) : 0;
      if (sessionContextTokens instanceof Map) sessionContextTokens.delete(frame.sessionId);
      if (estimated > 0 && typeof rotateContextIfNeeded === 'function') {
        try {
          await rotateContextIfNeeded(key, frame.sessionId, estimated);
        } catch (error) {
          log(`[上下文] ${key} 主动轮换失败：${error?.message ?? error}`);
        }
      }
    }
    // reserved2 防遗忘：每次唤醒回合结束时，若 AI 没有调用 qq_set_wake_config 设置下一次唤醒条件，
    // 则发送提醒；连续未设置达到上限后重置为默认唤醒配置。静默回合已在上方返回，不触发。
    if (pendingWakeKeys.has(key)) {
      pendingWakeKeys.delete(key);
      disarmPendingWakeLease(key);
      if (wakeConfigUpdatedKeys.has(key) || markReadCalledKeys.has(key)) {
        ensureWakeableV2(getSocialV2State(key), { key });
        wakeConfigUpdatedKeys.delete(key);
        markReadCalledKeys.delete(key);
        wakeConfigMissCount.delete(key);
      } else if (sendToolSucceeded && typeof autoWrapAfterReply === 'function') {
        // T1：本回合已经发过言 = 正常收尾。桥接自动标记已读水位并保证下一次可唤醒，
        // 不再投递「未设置唤醒条件」提醒（那是纯额外的一次模型调用/一个回合）。
        // 未答的 @ 由 autoWrapAfterReply 内部保留，不会顺手标读。
        try {
          autoWrapAfterReply(key);
          log(`[reserved2] ${key} 已发言，自动收尾（T1：已读水位 + 唤醒配置）`);
        } catch (error) {
          log(`[reserved2] ${key} 自动收尾失败，回退到提醒: ${error?.message ?? error}`);
          ensureWakeableV2(getSocialV2State(key), { key });
        }
        wakeConfigUpdatedKeys.delete(key);
        markReadCalledKeys.delete(key);
        wakeConfigMissCount.delete(key);
      } else {
        const currentMiss = (wakeConfigMissCount.get(key) ?? 0) + 1;
        const maxReminders = Number(cfg.socialV2?.wake?.maxWakeConfigReminders) || 2;
        if (currentMiss < maxReminders) {
          wakeConfigMissCount.set(key, currentMiss);
          pendingWakeKeys.add(key);
          armPendingWakeLease(key);
          deliverPrompt(key, buildWakeReminderPromptV2(key)).then((result) => {
            if (result && result.ok === false) {
              pendingWakeKeys.delete(key);
              disarmPendingWakeLease(key);
            }
          }).catch((error) => {
            pendingWakeKeys.delete(key);
            disarmPendingWakeLease(key);
            log(`[reserved2] ${key} 唤醒提醒投递失败: ${error?.message ?? error}`);
          });
          log(`[reserved2] ${key} 未设置唤醒条件，发送提醒 (${currentMiss}/${maxReminders})`);
        } else {
          const st = getSocialV2State(key);
          st.wakeConfig = defaultWakeConfigV2();
          saveSocialV2State();
          log(`[reserved2] ${key} 连续未设置唤醒条件，已重置为默认唤醒配置`);
        }
      }
    }
    // 繁忙期间被暂存的唤醒原因：当前 turn 结束后补一次，避免关键 @/提问被漏掉。
    // 但如果触发它的消息已经被 AI 在当前回合处理（unread 中已不存在该 seq），则不再补发。
    // 繁忙期间被暂存的唤醒原因：当前 turn 结束后补一次，避免关键 @/提问被漏掉。
    //
    // ⚠️ 2026-10-11 修：原先只 `shift()` **最旧**一条（FIFO），结果 @ 会被更早的
    // poke/probability 插队——实测群 100002007：用户 16:08:31 @ 机器人（atMention@20893），
    // 但补发取的是更早的 poke@20871，@ 那条一直排在队列里没补，直到 16:10:01 才被处理，
    // 延迟 90 秒。群友感受就是「@ 它不是必回」。
    // 现在改为：**在仍相关的项里挑优先级最高的**（atMention/question 高于 poke/probability），
    // 与 scheduleWakeV2 合并窗口的升级逻辑保持一致。
    {
      const stEnd = getSocialV2State(key);
      if (Array.isArray(stEnd.pendingWakeReasons) && stEnd.pendingWakeReasons.length) {
        // 先剔除「触发它的消息已被本回合处理掉」的项（unread 里已无该 seq）。
        // 注意：这只说明消息被读过，不代表已经回复过——所以只在确实没有更高优先级项时
        // 才用它来收尾，避免把 @ 误判成「已处理」而静默丢弃。
        const unreadSeqs = new Set((Array.isArray(stEnd.unread) ? stEnd.unread : [])
          .map((m) => Number(m && m.seq)).filter((n) => Number.isFinite(n)));
        const all = stEnd.pendingWakeReasons.filter((r) => r && typeof r === 'object');
        if (all.length) {
          const pick = pickPendingWake(all, unreadSeqs, wakePriorityV2);
          // 队列里可能只有 seq，正文已经被 30 条未读/100 条 recent 挤掉；
          // 回合结束时补一份正文快照，下一次唤醒提示直接带上，模型才知道要回什么。
          stEnd.pendingWakeMessage = pick.snapshot
            || pendingWakeSnapshotFromJournalV2(key, pick.seq)
            || stEnd.pendingWakeMessage
            || null;
          stEnd.pendingWakeReasons = [];
          saveSocialV2State();
          log(`[reserved2] ${key} 补发繁忙期间积压的唤醒：${pick.reason}@seq${pick.seq}`
            + (all.length > 1 ? `（队列共 ${all.length} 条，已按优先级选取）` : '')
            + (stEnd.pendingWakeMessage ? '，已保留触发消息正文' : ''));
          scheduleWakeV2(key, pick.reason);
        }
      }
    }
    if (ended.reason.kind === 'completed' && ended.text.trim()) {
      const plain = mdToPlain(ended.text);
      // 纯 Markdown/空白输出按“无文本”处理，避免后续 planSocialTimeline 拿空串崩溃。
      if (!plain.trim()) {
        log(`agent 回复为空（仅格式/空白）(${key})`);
        if (isFarewell) {
          const st = socialState(key);
          if (st.phase === 'exiting') {
            st.phase = 'idle';
            st.activeDeadlineAt = 0;
            st.activeExitAt = 0;
            log(`社交模式：${key} 空退场回合，回到观望`);
          }
        }
        return;
      }
      // 社交模式静默标记：AI 主动选择“潜水/不接话”，不发送到 QQ
      if (isSilentMarker(plain)) {
        log(`社交模式：AI 选择静默（${SILENT_MARKER}）(${key})`);
        if (isFarewell) {
          const st = socialState(key);
          if (st.phase === 'exiting') {
            st.phase = 'idle';
            st.activeDeadlineAt = 0;
            st.activeExitAt = 0;
            log(`社交模式：${key} 退场选择静默，回到观望`);
          }
        }
        return;
      }
      // 本回合已经通过 MCP 发送工具成功发出消息：跳过自动转发，避免重复发送。
      if (sendToolSucceeded) {
        log(`工具已发送消息，跳过自动转发 (${key})`);
        if (isFarewell) {
          const st = socialState(key);
          if (st.phase === 'exiting') {
            st.phase = 'idle';
            st.activeDeadlineAt = 0;
            st.activeExitAt = 0;
            log(`社交模式：${key} 工具发送后退场完成，回到观望`);
          }
        }
        return;
      }
      // 审计（对完整文本执行，避免截断漏判；这里只判断，不发送，避免双重发送）
      const hasKnownToken = [...KNOWN_AGENT_TOKENS].some((t) => t && plain.includes(t));
      if (shouldAuditKey(key) && (SENSITIVE_RE.test(plain) || hasKnownToken)) {
        log(`⚠️ 回复被安全策略拦截 (${key})，疑似包含敏感信息${hasKnownToken ? '（含会话令牌）' : ''}`);
        appendActivity(`${key} agent 回复被拦截（疑似敏感信息${hasKnownToken ? '/会话令牌' : ''}）`);
        // 群内不再提示（会暴露内部机制）；只私聊管理员，附被拦正文便于判断误判。
        notifyOwnerOfError(key, '安全策略拦截了一条回复', plain, {
          原因: hasKnownToken ? '含会话令牌' : '疑似包含敏感信息（路径/凭据）',
          处置: '该条回复未发出，群友看不到'
        });
        if (isFarewell) {
          const st = socialState(key);
          if (st.phase === 'exiting') {
            st.phase = 'idle';
            st.activeDeadlineAt = 0;
            st.activeExitAt = 0;
            log(`社交模式：${key} 退场发言被拦截，回到观望`);
          }
        }
        return;
      }
      // 仿真群友模式：时间线多段发送（主回复 + 可选二次补刀）
      if (isSocialEnabled()) {
        if (shouldBlockSilentReply(key)) {
          log(`静默模式，拦截在途回复 (${key})`);
          appendActivity(`${key} 静默模式，拦截在途回复`);
          if (isFarewell) {
            const st = socialState(key);
            if (st.phase === 'exiting') {
              st.phase = 'idle';
              st.activeDeadlineAt = 0;
              st.activeExitAt = 0;
              log(`社交模式：${key} 静默模式下退场回合被拦截，回到观望`);
            }
          }
          return;
        }
        const timeline = planSocialTimeline(plain, cfg.social);
        const messages = timeline.main;
        log(`agent 回复 (${key}) ${plain.length} 字 → ${messages.length} 条`);
        appendActivity(`${key} agent 回复：${messages[0].slice(0, 80)}${messages.length > 1 ? '（分' + messages.length + '条）' : ''}${messages[0].length > 80 ? '…' : ''}`);
        if (messages.length > 1) {
          await sendBurstToQQ(key, messages, cfg.social);
        } else {
          await sendToQQ(key, messages[0]);
        }
        // 发言后刷新活跃时间，并调度可能的二次补刀
        const st = socialState(key);
        if (isFarewell) {
          // 确认为退场发言：不再刷新活跃时间、不调度补刀，直接进入观望
          st.phase = 'idle';
          st.activeDeadlineAt = 0;
          st.activeExitAt = 0;
          log(`社交模式：${key} 退场发言完成，进入观望`);
        } else if (st.phase === 'exiting') {
          // 退场期间有旧回复恰好完成：照常发出，但不把它当作退场，也不调度补刀
          log(`社交模式：${key} 退场期间旧回复完成，保持退场状态`);
        } else {
          st.lastActiveMessageAt = now();
          st.lastAiReplyAt = now();
          log(`社交模式：发言完成，刷新活跃时间 (${key})`);
        }
      } else if (getMode() === 'reserved2') {
        log(`[reserved2] AI 内部输出（不自动转发）(${key}): ${plain.slice(0, 80)}`);
        appendActivity(`${key} [reserved2] AI 内部输出：${plain.slice(0, 80)}${plain.length > 80 ? '…' : ''}`);
      } else {
        if (shouldBlockSilentReply(key)) {
          log(`静默模式，拦截在途回复 (${key})`);
          appendActivity(`${key} 静默模式，拦截在途回复`);
          return;
        }
        log(`agent 回复 (${key}) ${plain.length} 字`);
        appendActivity(`${key} agent 回复：${plain.slice(0, 80)}${plain.length > 80 ? '…' : ''}`);
        await sendToQQ(key, plain);
      }
    } else if (ended.reason.kind === 'error') {
      const msg = ended.reason.error?.message ?? '未知错误';
      // 上下文超过模型上限：DSH 自己往往也压缩不动（compaction 同样报 prompt_too_long），
      // 必须由桥接换会话，否则这个会话后面每一轮都会继续失败。
      if (isContextOverflowError(msg)) {
        await contextRecovery.recover({
          key,
          sessionId: frame.sessionId,
          error: msg,
          mode: getMode(),
          silent: false
        });
        return;
      }
      // 先让报错拦截器处理「额度/限流」类错误（含私聊管理员详情）。
      // 返回 false 表示不是额度类（如模型输出为空、网络抖动）。
      const handled = await handleUpstreamError(key, msg, { sessionId: ended.sessionId ?? '' })
        .catch((e) => { log(`[报错拦截] 处理失败：${e?.message ?? e}`); return false; });
      // 兜底：不论是否额度类，**一律不再往群里发任何报错字样**（用户要求），
      // 只私聊管理员。群友侧表现为这一轮机器人没说话。
      if (!handled) {
        notifyOwnerOfError(key, 'agent 处理出错', msg, { sessionId: ended.sessionId ?? '' });
      }
      if (isFarewell) {
        const st = socialState(key);
        if (st.phase === 'exiting') {
          st.phase = 'idle';
          st.activeDeadlineAt = 0;
          st.activeExitAt = 0;
          log(`社交模式：${key} 退场发言出错，回到观望`);
        }
      }
    } else if (ended.reason.kind === 'aborted') {
      await sendToQQ(key, '⏹️ 已停止');
      if (isFarewell) {
        const st = socialState(key);
        if (st.phase === 'exiting') {
          st.phase = 'idle';
          st.activeDeadlineAt = 0;
          st.activeExitAt = 0;
          log(`社交模式：${key} 退场发言中止，回到观望`);
        }
      }
    } else if (!ended.text.trim()) {
      // completed 但没文本（纯工具调用回合）
      log(`回合完成但无文本 (${key})`);
      if (isFarewell) {
        const st = socialState(key);
        if (st.phase === 'exiting') {
          st.phase = 'idle';
          st.activeDeadlineAt = 0;
          st.activeExitAt = 0;
          log(`社交模式：${key} 退场回合无文本，回到观望`);
        }
      }
    }
  }

  function handleLearnerEvent(frame) {
    const learnerCollector = learnerCollectors.get(frame.sessionId) ?? createTurnCollector();
    learnerCollectors.set(frame.sessionId, learnerCollector);
    const learnerEnded = learnerCollector.push(frame.event);
    if (learnerEnded) {
      learnerCollectors.delete(frame.sessionId);
      const waiters = learnerWaiters.get(frame.sessionId) ?? [];
      const waiter = waiters.shift();
      if (waiters.length === 0) learnerWaiters.delete(frame.sessionId);
      if (waiter) {
        clearTimeout(waiter.timer);
        if (learnerEnded.reason.kind === 'completed' && learnerEnded.text.trim()) {
          waiter.resolve(learnerEnded.text);
        } else {
          waiter.reject(new Error(`学习会话 turn 未正常完成：${learnerEnded.reason.kind}`));
        }
      }
      // 旧学习会话 turn 结束后从集合移除，避免残留
      if (frame.sessionId !== getSlangLearnerSessionId()) learnerSessions.delete(frame.sessionId);
    }
  }

  function handleAssistantMessage(frame) {
    // 只统计 assistant/message（最终汇总），不统计 assistant/chunk，避免同一份 usage 重复。
    const usage = frame.event.data?.usage;
    if (usage) {
      recordTokenUsage?.(frame.sessionId, usage);
      turnMetrics?.recordAssistantMessage(frame.sessionId, usage);
      // T4：input+cacheRead ≈ 本次请求的上下文大小；留给回合结束判断是否主动轮换。
      const total = Number(usage?.inputTokens ?? usage?.prompt_tokens ?? 0)
        + Number(usage?.cacheReadTokens ?? usage?.cache_read_input_tokens ?? 0);
      if (total > 0 && sessionContextTokens instanceof Map) sessionContextTokens.set(frame.sessionId, total);
    }
  }

  const sessionHandlers = new Map([
    ['turn/start', startTurn],
    ['assistant/message', handleAssistantMessage],
    ['tool/call', handleToolCall],
    ['tool/result', handleToolResult],
    ['compaction/summary', handleCompaction]
  ]);

  async function handleSessionEvent(frame) {
    const key = reverse.get(frame.sessionId);
    if (!key) {
      if (learnerSessions.has(frame.sessionId)) handleLearnerEvent(frame);
      return;
    }
    const event = frame.event;
    const current = currentTurnBySession.get(frame.sessionId);
    // 宽容的传输 schema 允许扩展 data，但回合事件不能缺少归属再猜当前回合。
    if (TURN_EVENTS.has(event.type) && !Number.isInteger(event.data?.turn)) return;
    if (event.type === 'turn/start') {
      // 重复开始不能清掉已收集的文本；旧开始不能覆盖新回合。
      if (event.data.turn < 0 || (current && event.data.turn <= current.turn)) return;
    } else if (event.data?.turn != null && (!current || event.data.turn !== current.turn)) {
      return;
    }
    sessionHandlers.get(event.type)?.(frame, key);
    if (!currentTurnBySession.has(frame.sessionId)) return;
    collectBiliJudge(frame);
    const ended = collectors.get(frame.sessionId)?.push(event);
    if (ended) {
      try {
        await finishTurn(frame, key, ended);
      } finally {
        // T5：无论收尾从哪个分支返回（含静默/报错提前 return），都要关闭回合记账。
        turnMetrics?.finishTurn(frame.sessionId);
      }
    }
  }

  async function handleLearnerRequest(frame, envelope) {
    try {
      if (frame.type === 'question/requested') {
        await api.respond({
          type: 'client-response',
          rpcId: envelope.rpcId,
          result: { ok: true, value: { sessionId: frame.sessionId, answer: { answers: frame.questions.map((q) => ({ id: q.id, selected: [], custom: '' })) } } }
        });
      } else {
        await api.respond({
          type: 'client-response',
          rpcId: envelope.rpcId,
          result: { ok: true, value: { sessionId: frame.sessionId, approvalId: frame.approvalId, outcome: 'rejected' } }
        });
      }
      log('黑话学习会话自动跳过提问/审批');
    } catch (error) {
      log('自动响应学习会话提问/审批失败:', error?.message ?? error);
    }
  }

  async function handleQuestion(frame, envelope) {
    if (learnerSessions.has(frame.sessionId)) return handleLearnerRequest(frame, envelope);
    const key = reverse.get(frame.sessionId);
    if (!key) return;
    const lines = frame.questions.map((q, i) => {
      const qText = String(q.question ?? '');
      const sensitive = shouldAuditKey(key) && SENSITIVE_RE.test(qText);
      if (sensitive) log(`⚠️ 提问文本含敏感信息，已隐藏 (${key})`);
      const safeQuestion = sensitive ? '（含敏感信息，已隐藏）' : qText;
      let s = `${i + 1}. ${safeQuestion}`;
      if (q.options?.length) {
        const opts = q.options.map((o) => {
          const label = String(o.label ?? '');
          const optSensitive = shouldAuditKey(key) && SENSITIVE_RE.test(label);
          if (optSensitive) log(`⚠️ 提问选项含敏感信息，已隐藏 (${key})`);
          return `「${optSensitive ? '（含敏感信息，已隐藏）' : label}」`;
        });
        s += '\n   ' + opts.join(' ');
      }
      return s;
    });
    await sendToQQ(key, '❓ agent 需要你回答：\n' + lines.join('\n') + '\n（直接回复选项文字或输入你的回答）');
    await registerPending(key, { kind: 'question', rpcId: envelope.rpcId, sessionId: frame.sessionId, questions: frame.questions });
  }

  async function handleApproval(frame, envelope) {
    if (learnerSessions.has(frame.sessionId)) return handleLearnerRequest(frame, envelope);
    const key = reverse.get(frame.sessionId);
    if (!key) return;
    const rawReason = frame.reason ?? '';
    const sensitiveReason = shouldAuditKey(key) && SENSITIVE_RE.test(rawReason);
    if (sensitiveReason) log(`⚠️ 审批理由含敏感信息，已隐藏 (${key})`);
    const safeReason = sensitiveReason ? '（含敏感信息，已隐藏）' : rawReason;
    const reason = safeReason ? `\n理由：${safeReason}` : '';
    const rawToolName = frame.toolName ?? '';
    const sensitiveTool = shouldAuditKey(key) && SENSITIVE_RE.test(rawToolName);
    if (sensitiveTool) log(`⚠️ 审批工具名含敏感信息，已隐藏 (${key})`);
    const safeToolName = sensitiveTool ? '（含敏感信息，已隐藏）' : rawToolName;
    await sendToQQ(key, `🔐 agent 请求审批：${safeToolName}${reason}\n回复「通过」或「拒绝」`);
    await registerPending(key, { kind: 'approval', rpcId: envelope.rpcId, sessionId: frame.sessionId, approvalId: frame.approvalId, toolName: frame.toolName });
  }

  const frameHandlers = new Map([
    ['session/event', handleSessionEvent],
    ['question/requested', handleQuestion],
    ['approval/requested', handleApproval],
    ['stream/error', frame => log('事件流错误:', frame.error)]
  ]);

  async function handleEnvelope(envelope) {
    const frame = envelope.payload;
    await frameHandlers.get(frame.type)?.(frame, envelope);
  }

  // 正常关闭和异常退出必须共用清理，否则会话会永久忙碌。
  function resetStreamTracking(reason) {
    const busyKeys = [...pendingWakeKeys];
    collectors.clear(); // 清除旧 turn collector，避免重连后残留导致重复累加
    turnMetrics?.resetActive?.(); // T5：断流后未完成的回合不再计入
    social.silentTurns.clear(); // 清除未消费的摘要静默名额，避免重连后吞掉正常回复
    sendToolSucceededSessions.clear();
    pendingSendToolCalls.clear();
    v2TurnStartAt.clear();
    currentTurnBySession.clear();
    biliJudgeCollectors.clear();
    // B 站 waiter 的 turn/end 已随连接丢失，直接按“没判断出来”结束，别让调用方干等 150s。
    for (const waiter of biliJudgeWaiters.values()) {
      try { waiter.resolve(''); } catch {}
    }
    biliJudgeWaiters.clear();
    toolCallNames.clear();
    pendingWakeKeys.clear();
    clearAllPendingWakeLeases();
    social.exitingSessions.clear();
    wakeConfigUpdatedKeys.clear();
    markReadCalledKeys.clear();
    wakeConfigMissCount.clear();
    // 长轮询占位标记同样要清：断流后残留的等待请求早已失效，留着会让该会话
    // 后续所有 qq_wait_for_messages 都被拒（429「已有一个等待中」）。
    if (activeWaits.size) {
      log(`事件流断开（${reason}），清除等待占位标记：${[...activeWaits].join('、')}`);
      activeWaits.clear();
    }
    // 断流时若有会话正被标记为“唤醒在途”，其 turn/end 已随连接一起丢失，必须就地解除，
    // 否则该会话会被 isConversationBusyV2 判定为永久繁忙。正常情况下这里应为空。
    if (busyKeys.length) log(`事件流断开（${reason}），解除唤醒占用标记：${busyKeys.join('、')}`);
  }

  async function pumpMux({ signal } = {}) {
    while (!signal?.aborted) {
      let streamEnded = false;
      try {
        log('连接 DSH 事件流…');
        for await (const envelope of api.events.mux({}, signal)) {
          await handleEnvelope(envelope);
        }
        streamEnded = true;
      } catch (error) {
        log('事件流中断:', error?.message ?? error);
      } finally {
        resetStreamTracking(streamEnded ? 'WebSocket 正常关闭' : '读取异常');
      }
      if (!signal?.aborted) await sleep(3000);
    }
  }

  return { handleEnvelope, resetStreamTracking, pumpMux };
}
