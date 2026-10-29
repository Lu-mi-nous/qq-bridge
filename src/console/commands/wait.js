// R4.7-3：等待/反馈/日志命令。
//
// 长轮询等待（qq_wait_for_messages）原先直接写在路由 handler 里，依赖 20+ 个运行态
// Map/Set 与等待配置。这里原样保留单回合硬上限、跨回合滑动窗口、quiet 静默窗口、
// 沉睡前观察判定和 activeWaits 占位释放；路由只做鉴权与转发。
//
// 反馈写入、工具日志/反馈清空、报错自检也在这里；读列表在 read-model/wait.js。

export function createWaitCommands({
  config = {},
  operations = {},
  sessions = {},
  social = {},
  state = {}
} = {}) {
  const {
    cfg = {},
    FORCE_WRAPUP_HINT,
    WAIT_QUIET_CAP_MS,
    WAIT_TURN_MAX_COUNT,
    WAIT_TURN_MAX_MS,
    WAIT_WINDOW_MAX,
    WAIT_WINDOW_MS,
    TOOL_LOG_FILE,
    FEEDBACK_FILE,
    fs,
    atomicWriteJson,
    log,
    notifyOwnerOfError
  } = config;
  const { socialV2 = { conversations: new Map() } } = sessions;
  const {
    activeWaits,
    waitTurnStats,
    waitTurnTotals,
    v2TurnStartAt,
    state: runtimeState,
    feedbackTimes
  } = state;
  const {
    getSocialV2State,
    saveSocialV2State,
    cancelReplyCheckV2,
    suggestQuietMsV2,
    preSleepWaitBlockedV2
  } = social;
  const { looksLikeUnfinished, sleep, appendActivity, appendFeedbackEntry } = operations;
  const logLine = (message) => { try { log?.(message); } catch { /* 日志失败不影响主流程 */ } };
  const onClose = (req, cb) => { try { req?.on?.('close', cb); } catch { /* 无 req 的测试环境忽略 */ } };

  /**
   * POST /api/socialV2/wait：长轮询等待新消息。
   * 返回体与旧路由逐字段一致；`req` 只用于 close 中止与 finally 释放占位。
   */
  async function waitForMessages({ key, body = {}, req } = {}) {
    if (socialV2.paused) {
      const st = getSocialV2State(key);
      return { ok: true, key, paused: true, arrived: false, timeout: false, waitedMs: 0, newMessages: [], unreadCount: st.unread.length };
    }
    const waitCfg = cfg.socialV2?.wait ?? {};
    const minNew = Math.max(1, Math.round(Number(body.minNewMessages) || 1));
    const defaultMs = Number(waitCfg.defaultMs) || 30000;
    const minMs = Math.max(100, Number(waitCfg.minMs) || 5000);
    const maxMs = Math.max(minMs, Number(waitCfg.maxMs) || 600000);
    const timeoutMs = Math.min(maxMs, Math.max(minMs, Math.round(Number(body.timeoutMs) || defaultMs)));
    const waitTurnMaxCount = Math.max(1, Math.min(20, Math.round(Number(waitCfg.turnMaxCount) || WAIT_TURN_MAX_COUNT)));
    const waitTurnMaxMs = Math.max(5000, Math.min(600000, Math.round(Number(waitCfg.turnMaxMs) || WAIT_TURN_MAX_MS)));
    const st = getSocialV2State(key);
    const sendWaitWrapUp = (why) => {
      logLine(`[reserved2] wait 强制收尾 ${key}（${why}），要求模型立即结束回合`);
      return {
        ok: true,
        key,
        arrived: false,
        quiet: true,
        quietMs: 0,
        suggestedQuietMs: 0,
        speakerLikelyDone: true,
        lastMessageUnfinished: false,
        timeout: true,
        waitedMs: 0,
        preSleepWaitSatisfied: false,
        preSleepWaitObserved: false,
        preSleepWaitMs: 0,
        preSleepWaitRemainingMs: 0,
        newMessages: [],
        unreadCount: st.unread.length,
        forceWrapUp: true,
        wrapUpHint: `${FORCE_WRAPUP_HINT}（触发原因：${why}）`
      };
    };
    // ── 单回合硬上限（优先于滑动窗口）──────────────────────────────
    // 旧版只有 12 分钟/8 次的跨回合窗口：单回合 6 次、跨度 24 分钟，早期记录
    // 过期后窗口永远凑不满 8 次。这里按 DSH turn 计时，最多 2 次/120s。
    let waitTurnStat = null;
    {
      const sid = runtimeState.sessions?.[key];
      const turnStart = sid ? (Number(v2TurnStartAt.get(sid)) || 0) : 0;
      if (sid && turnStart) {
        let stat = waitTurnTotals.get(sid);
        if (!stat || stat.turnStart !== turnStart) {
          stat = { turnStart, count: 0, totalMs: 0 };
          waitTurnTotals.set(sid, stat);
        }
        if (stat.count >= waitTurnMaxCount || stat.totalMs >= waitTurnMaxMs) {
          const why = stat.totalMs >= waitTurnMaxMs
            ? `本回合等待累计 ${Math.round(stat.totalMs / 1000)}s`
            : `本回合已等待 ${stat.count} 次`;
          waitTurnTotals.delete(sid);
          return sendWaitWrapUp(why);
        }
        stat.count += 1;
        waitTurnStat = stat;
      }
      // 有界清理：避免长进程里 Map 无限增长
      if (waitTurnTotals.size > 200) {
        const nowTs = Date.now();
        for (const [sid2, stat2] of waitTurnTotals) {
          if (!stat2 || nowTs - Number(stat2.turnStart) > 30 * 60 * 1000) waitTurnTotals.delete(sid2);
        }
      }
    }
    // ── 值班循环硬上限（跨回合滑动窗口）───────────────────────────
    // 活跃群里的循环形态是「唤醒→wait 60s→收尾结束回合→又被新消息唤醒→再 wait」，
    // 单回合计数每回合重置，永远到不了上限；所以按最近 WINDOW 内 wait 次数判定。
    {
      const nowTs = Date.now();
      const hist = (waitTurnStats.get(key) ?? []).filter((t) => nowTs - t < WAIT_WINDOW_MS);
      hist.push(nowTs);
      waitTurnStats.set(key, hist);
      // 顺带清理过期条目，防止 Map 无限增长
      if (waitTurnStats.size > 200) {
        for (const [k, arr] of waitTurnStats) {
          if (!arr.some((t) => nowTs - t < WAIT_WINDOW_MS)) waitTurnStats.delete(k);
        }
      }
      if (hist.length > WAIT_WINDOW_MAX) {
        const why = `最近 ${Math.round(WAIT_WINDOW_MS / 60000)} 分钟内已等待 ${hist.length - 1} 次`;
        // 重置窗口：给下一轮一个干净起点，避免刚结束就再次触发
        waitTurnStats.set(key, []);
        return sendWaitWrapUp(why);
      }
    }
    // 同一会话只允许一个长轮询等待，避免并发挂起耗尽 HTTP handler。
    if (activeWaits.has(key)) {
      return { ok: false, status: 429, error: '该会话已有一个等待中的 qq_wait_for_messages，请等待它结束' };
    }
    activeWaits.add(key);
    // 占位标记必须用 finally 兜底释放：曾只挂在 req 'close' + 正常返回路径上，
    // 一旦等待循环中途抛异常，标记就永久残留，之后该会话所有 wait 都 429。
    let finishWait = () => activeWaits.delete(key);
    onClose(req, () => finishWait());
    try {
      const minQuietAfterNewMs = Number.isFinite(Number(waitCfg.minQuietAfterNewMs)) ? Math.max(0, Number(waitCfg.minQuietAfterNewMs)) : 10000;
      const suggestedQuietMs = Math.max(suggestQuietMsV2?.(st) || 0, minQuietAfterNewMs);
      const rawQuietMs = body.quietMs != null ? Number(body.quietMs) : suggestedQuietMs;
      // 收到新消息后至少再等 minQuietAfterNewMs（默认 10 秒），防止抢话；
      // 即使 AI 传了 quietMs=0，也会被抬升到最小静默窗口。
      const configuredQuietCap = Number.isFinite(Number(waitCfg.maxQuietMs))
        ? Math.max(0, Number(waitCfg.maxQuietMs))
        : WAIT_QUIET_CAP_MS;
      const maxQuietMs = Math.max(minQuietAfterNewMs, Math.min(WAIT_QUIET_CAP_MS, configuredQuietCap || WAIT_QUIET_CAP_MS));
      const quietMs = Math.min(maxQuietMs, Math.max(minQuietAfterNewMs, Math.round(rawQuietMs) || 0));
      if (st.pendingWakeTimer) {
        clearTimeout(st.pendingWakeTimer);
        st.pendingWakeTimer = null;
      }
      cancelReplyCheckV2?.(key); // AI 正在主动等待，取消回复检查定时器避免重复唤醒
      const baseline = st.lastUnreadSeq || 0;
      const start = Date.now();
      let arrived = false;
      let lastNewAt = 0;
      let aborted = false;
      onClose(req, () => { aborted = true; });
      // 绝对截止：timeout + 一次 quiet 窗口（+1s 余量）。
      const waitDeadline = start + timeoutMs + quietMs + 1000;
      while (Date.now() - start < timeoutMs && !aborted) {
        let nowSeq = st.lastUnreadSeq || 0;
        if (nowSeq - baseline >= minNew) {
          arrived = true;
          lastNewAt = Date.now();
          // 已等到新消息：继续等到“最后一条新消息之后 quietMs 内不再有新消息”再返回。
          // 但总时长绝不超过 waitDeadline，防止活跃群把 handler 无限挂起。
          while (Date.now() - lastNewAt < quietMs && Date.now() < waitDeadline && !aborted) {
            if ((st.lastUnreadSeq || 0) > nowSeq) {
              nowSeq = st.lastUnreadSeq || 0;
              lastNewAt = Date.now();
            }
            await sleep(200);
          }
          break;
        }
        await sleep(300);
      }
      const waitedMs = Date.now() - start;
      if (waitTurnStat) waitTurnStat.totalMs += waitedMs;
      const preSleepWaitMs = Math.max(0, Number(cfg.socialV2?.wake?.preSleepWaitMs) || 300000);
      const preSleepRemainingMs = preSleepWaitBlockedV2?.(st, key)
        ? Math.max(0, preSleepWaitMs - ((st.lastIncomingAt || 0) ? Date.now() - st.lastIncomingAt : 0))
        : 0;
      const quiet = arrived && quietMs > 0 && (Date.now() - lastNewAt >= quietMs);
      // 判断这次等待是否是“沉睡前观察尝试”：AI 明确请求等满观察窗口（默认 5 分钟）。
      const preSleepAttempt = timeoutMs >= preSleepWaitMs;
      // 只有“没等到新消息且总时长达到观察窗口”或“最后一条新消息之后安静满了观察窗口”才算满足。
      const preSleepSatisfiedNow = !arrived
        ? waitedMs >= preSleepWaitMs
        : (quiet && (Date.now() - lastNewAt) >= preSleepWaitMs);
      if (preSleepSatisfiedNow) {
        st.preSleepWaitSatisfiedAt = Date.now();
        st.preSleepWaitObservedAt = 0;
        st.preSleepWaitAccumMs = 0;
      } else if (!arrived) {
        // 短等待不累计：必须单次等满观察窗口（或实际安静时间已足够时由 preSleepWaitBlockedV2 放行）
        st.preSleepWaitAccumMs = 0;
      } else {
        // 等待期间有新消息：
        // - 如果这是一次 5 分钟沉睡前观察尝试，则标记“已观察”，AI 看过 newMessages 后可自行决定是否参与；
        // - 否则只清空累计，不算完成沉睡前观察。
        if (preSleepAttempt) {
          st.preSleepWaitObservedAt = Date.now();
        }
        st.preSleepWaitAccumMs = 0;
      }
      saveSocialV2State?.();
      const newMessages = arrived ? (Array.isArray(st.recentMessages) ? st.recentMessages : []).filter((m) => m && !m.isSelf && (m.seq || 0) > baseline) : [];
      const lastNew = newMessages.length ? newMessages[newMessages.length - 1] : null;
      const lastMessageUnfinished = lastNew ? looksLikeUnfinished?.(String(lastNew.tail || lastNew.plain || lastNew.text || '')) : false;
      finishWait();
      return {
        ok: true,
        key,
        arrived,
        quiet,
        quietMs,
        suggestedQuietMs,
        speakerLikelyDone: quiet,
        lastMessageUnfinished,
        timeout: !arrived || (quietMs > 0 && !quiet && Date.now() - start >= timeoutMs),
        waitedMs,
        preSleepWaitSatisfied: preSleepSatisfiedNow,
        preSleepWaitObserved: !!st.preSleepWaitObservedAt,
        preSleepWaitMs,
        preSleepWaitRemainingMs: preSleepRemainingMs,
        newMessages,
        unreadCount: st.unread.length
      };
    } catch (error) {
      // 等待途中异常：释放占位标记后再回错，避免该会话永久无法再 wait
      logLine(`qq_wait_for_messages 异常 ${key}: ${error?.message ?? error}`);
      return { ok: false, status: 500, error: `等待消息失败：${error?.message ?? error}` };
    } finally {
      finishWait();
    }
  }

  /** POST /api/socialV2/feedback：反馈限频与入库。 */
  function setFeedback({ key, level, message } = {}) {
    const normalizedLevel = level === 'warning' || level === 'error' ? level : 'info';
    const rawMessage = String(message ?? '').trim();
    if (!key || !rawMessage) return { ok: false, status: 400, error: 'key 和 message 不能为空' };
    // 反馈限频：防止持有会话 token 的调用方刷磁盘/日志。
    const now = Date.now();
    const times = feedbackTimes.get(key) || [];
    const recentMinute = times.filter((t) => now - t < 60000).length;
    const recentHour = times.filter((t) => now - t < 3600000).length;
    if (recentMinute >= 5 || recentHour >= 20) {
      return { ok: false, status: 429, error: '反馈过于频繁，请稍后再试' };
    }
    times.push(now);
    feedbackTimes.set(key, times.slice(-100));
    const maxLength = Math.max(1, Number(cfg.socialV2?.feedback?.maxLength) || 500);
    const clipped = rawMessage.slice(0, maxLength);
    appendFeedbackEntry?.({
      id: Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
      key, level: normalizedLevel, message: clipped, time: new Date().toISOString()
    });
    logLine(`[reserved2] AI 反馈 (${key}) [${normalizedLevel}]: ${clipped.slice(0, 80)}`);
    appendActivity?.(`${key} [reserved2] AI 反馈 [${normalizedLevel}]：${clipped.slice(0, 80)}`);
    if (cfg.socialV2?.feedback?.notifyOwnerOnError && normalizedLevel === 'error' && cfg.ownerQQ) {
      logLine(`[reserved2] 错误级反馈，可通知 owner ${cfg.ownerQQ}（当前仅记录日志）`);
    }
    return { ok: true, key, level: normalizedLevel, message: clipped };
  }

  function clearToolLog() {
    try { fs.writeFileSync(TOOL_LOG_FILE, '', 'utf8'); } catch { /* 日志文件可能不存在 */ }
    logLine('控制台：工具调用日志已清空');
    return { ok: true };
  }

  function clearFeedback() {
    atomicWriteJson(FEEDBACK_FILE, []);
    logLine('控制台：清空 AI 反馈');
    return { ok: true };
  }

  /**
   * POST /api/socialV2/error-notify-selftest：在运行中的桥接进程里真实跑一次报错通知，
   * 验证「群里零消息 + 管理员收到私聊」。只发私聊给 owner，不会打扰任何群。
   */
  function errorNotifySelftest({ key, title, detail } = {}) {
    const targetKey = String(key ?? '').trim() || 'group:0';
    const noticeTitle = String(title ?? '自检报错（可忽略）');
    const noticeDetail = String(detail ?? '这是一条由控制台触发的自检通知，用于确认「报错只私聊管理员、不进群」的通道正常。');
    const en = cfg.socialV2?.errorNotice ?? {};
    const base = cfg.errorNotify ?? {};
    const ownerQQ = String(cfg.ownerQQ ?? '').trim();
    if (!ownerQQ) return { ok: false, status: 400, error: 'config.ownerQQ 为空，无法通知管理员' };
    if (en.notifyOwner === false || base.notifyOwner === false) {
      return { ok: false, status: 400, error: '管理员报错通知当前被关闭（socialV2.errorNotice.notifyOwner / errorNotify.notifyOwner）' };
    }
    notifyOwnerOfError?.(targetKey, noticeTitle, noticeDetail, { 来源: '控制台自检' });
    return {
      ok: true,
      key: targetKey,
      sentTo: `private:${ownerQQ}`,
      groupMessagesSent: 0,
      config: { inGroup: en.inGroup === true, notifyOwner: true, windowMs: Number(base.windowMs) || 0 }
    };
  }

  return { waitForMessages, setFeedback, clearToolLog, clearFeedback, errorNotifySelftest };
}
