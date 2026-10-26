// 控制台路由域：等待 / 工具日志 / 反馈 / 消息详情（R4）。
//
// 从 console-server.js 原样搬出，只调整了缩进；鉴权 / CSRF / agent 白名单 /
// 暂停隔离仍由 console-server 统一处理，走到这里时请求已通过全部前置校验。
export const id = '12-wait';
export const title = '等待 / 工具日志 / 反馈 / 消息详情';

/** 本模块负责的路由；console-server 据此分派，不必解析 handler 内部。 */
export const routes = [
  ['POST', '/api/socialV2/wait', 'exact'],
  ['POST', '/api/socialV2/check-send', 'exact'],
  ['GET', '/api/socialV2/tool-log', 'exact'],
  ['POST', '/api/socialV2/tool-log/clear', 'exact'],
  ['POST', '/api/socialV2/error-notify-selftest', 'exact'],
  ['GET', '/api/socialV2/feedback', 'exact'],
  ['POST', '/api/socialV2/feedback-clear', 'exact'],
  ['POST', '/api/socialV2/feedback', 'exact'],
  ['GET', '/api/socialV2/my-recent', 'exact'],
  ['POST', '/api/socialV2/record-sent', 'exact'],
  ['GET', '/api/socialV2/message-detail', 'exact']
];

export async function handle(req, res, url, ctx) {
  const { sendJson, readBody, deps } = ctx;
  const { agentTokenOk, v2SessionAllowed, v2ToolEnabled } = ctx;
  const {
    FEEDBACK_FILE,
    FORCE_WRAPUP_HINT,
    TOOL_LOG_FILE,
    WAIT_QUIET_CAP_MS,
    WAIT_TURN_MAX_COUNT,
    WAIT_TURN_MAX_MS,
    WAIT_WINDOW_MAX,
    WAIT_WINDOW_MS,
    activeWaits,
    appendActivity,
    appendFeedbackEntry,
    atomicWriteJson,
    cancelReplyCheckV2,
    cfg,
    feedbackTimes,
    fs,
    getSocialV2State,
    log,
    looksLikeUnfinished,
    notifyOwnerOfError,
    preSleepWaitBlockedV2,
    readFeedbackEntries,
    readToolLog,
    resolveReplyInfo,
    saveSocialV2State,
    sleep,
    socialV2,
    state,
    suggestQuietMsV2,
    v2TurnStartAt,
    waitTurnStats,
    waitTurnTotals
  } = deps;

  if (req.method === 'POST' && url.pathname === '/api/socialV2/wait') {
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
    if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
    if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
    if (req.headers['x-agent-token'] && !v2ToolEnabled('waitMessages')) { sendJson({ ok: false, error: '工具未启用：qq_wait_for_messages' }, 403); return; }
    if (socialV2.paused) {
      const st = getSocialV2State(key);
      sendJson({ ok: true, key, paused: true, arrived: false, timeout: false, waitedMs: 0, newMessages: [], unreadCount: st.unread.length });
      return;
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
      log(`[reserved2] wait 强制收尾 ${key}（${why}），要求模型立即结束回合`);
      sendJson({
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
      });
    };
    // ── 单回合硬上限（优先于滑动窗口）──────────────────────────────
    // 旧版只有 12 分钟/8 次的跨回合窗口：单回合 6 次、跨度 24 分钟，早期记录
    // 过期后窗口永远凑不满 8 次。这里按 DSH turn 计时，最多 2 次/120s。
    let waitTurnStat = null;
    {
      const sid = state.sessions[key];
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
          sendWaitWrapUp(why);
          return;
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
    // 起初按「单回合内 wait 次数」计数，但活跃群里的循环形态是
    // 「唤醒→wait 60s→收尾结束回合→又被新消息唤醒→再 wait …」，
    // 每个回合都正常 completed，单回合计数每回合重置，永远到不了上限——
    // 表现为群里有人不停催（speak/戳），机器人却一直在「观察→收尾」，消息全排队。
    // 因此改为滑动窗口：不管跨多少个回合，只要「最近 WINDOW 内 wait 满 MAX 次」
    // 就强制收尾，让模型立即结束回合（配 wakeConfig 的潜水设置去过一会儿再看）。
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
        sendWaitWrapUp(why);
        return;
      }
    }
    // 同一会话只允许一个长轮询等待，避免并发挂起耗尽 HTTP handler。
    if (activeWaits.has(key)) {
      sendJson({ ok: false, error: '该会话已有一个等待中的 qq_wait_for_messages，请等待它结束' }, 429);
      return;
    }
    activeWaits.add(key);
    // 占位标记必须用 finally 兜底释放：曾只挂在 req 'close' + 正常返回路径上，
    // 一旦等待循环中途抛异常（消息处理/状态读写出错），标记就永久残留——
    // 之后该会话所有 qq_wait_for_messages 都返回 429「已有一个等待中」，
    // 模型反复重试全失败，表现为「机器人不理人」（实测私聊遇到）。
    // keep-alive 连接下 req 'close' 也可能迟迟不触发，不能只依赖它。
    let finishWait = () => activeWaits.delete(key);
    req.on('close', () => finishWait());
    try {
    const minQuietAfterNewMs = Number.isFinite(Number(waitCfg.minQuietAfterNewMs)) ? Math.max(0, Number(waitCfg.minQuietAfterNewMs)) : 10000;
    const suggestedQuietMs = Math.max(suggestQuietMsV2(st), minQuietAfterNewMs);
    const rawQuietMs = body.quietMs != null ? Number(body.quietMs) : suggestedQuietMs;
    // 收到新消息后至少再等 minQuietAfterNewMs（默认 10 秒），防止抢话；
    // 即使 AI 传了 quietMs=0，也会被抬升到最小静默窗口。
    // quietMs 单独封顶（默认 15s），不能拿 wait.maxMs 当静默上限——
    // 旧实现让 timeout=120s + quietMs=75s 实际跑出 245s 的单次等待。
    const configuredQuietCap = Number.isFinite(Number(waitCfg.maxQuietMs))
      ? Math.max(0, Number(waitCfg.maxQuietMs))
      : WAIT_QUIET_CAP_MS;
    const maxQuietMs = Math.max(minQuietAfterNewMs, Math.min(WAIT_QUIET_CAP_MS, configuredQuietCap || WAIT_QUIET_CAP_MS));
    const quietMs = Math.min(maxQuietMs, Math.max(minQuietAfterNewMs, Math.round(rawQuietMs) || 0));
    if (st.pendingWakeTimer) {
      clearTimeout(st.pendingWakeTimer);
      st.pendingWakeTimer = null;
    }
    cancelReplyCheckV2(key); // AI 正在主动等待，取消回复检查定时器避免重复唤醒
    const baseline = st.lastUnreadSeq || 0;
    const start = Date.now();
    let arrived = false;
    let lastNewAt = 0;
    let aborted = false;
    req.on('close', () => { aborted = true; });
    // 绝对截止：timeout + 一次 quiet 窗口（+1s 余量）。
    // 旧实现允许 timeout + maxQuietMs + 5s，且每次新消息都重置 lastNewAt，
    // 活跃群里单次 wait 可无限逼近 245s。
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
    const preSleepRemainingMs = preSleepWaitBlockedV2(st, key)
      ? Math.max(0, preSleepWaitMs - ((st.lastIncomingAt || 0) ? Date.now() - st.lastIncomingAt : 0))
      : 0;
    const quiet = arrived && quietMs > 0 && (Date.now() - lastNewAt >= quietMs);
    // 判断这次等待是否是“沉睡前观察尝试”：AI 明确请求等满观察窗口（默认 5 分钟）。
    // 只有这种尝试里等到新消息，才会把“已观察并看到新消息”标记下来，允许 AI 看过新消息后直接决定不参与并沉睡。
    const preSleepAttempt = timeoutMs >= preSleepWaitMs;
    // 只有“没等到新消息且总时长达到观察窗口”或“最后一条新消息之后安静满了观察窗口”才算满足沉睡前等待；
    // 不能因为总时长到了但最后一条消息才刚过 10 秒就误判满足。
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
    saveSocialV2State();
    const newMessages = arrived ? (Array.isArray(st.recentMessages) ? st.recentMessages : []).filter((m) => m && !m.isSelf && (m.seq || 0) > baseline) : [];
    const lastNew = newMessages.length ? newMessages[newMessages.length - 1] : null;
    const lastMessageUnfinished = lastNew ? looksLikeUnfinished(String(lastNew.tail || lastNew.plain || lastNew.text || '')) : false;
    finishWait();
    sendJson({
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
    });
    } catch (error) {
      // 等待途中异常：释放占位标记后再回错，避免该会话永久无法再 wait
      log(`qq_wait_for_messages 异常 ${key}: ${error?.message ?? error}`);
      sendJson({ ok: false, error: `等待消息失败：${error?.message ?? error}` }, 500);
    } finally {
      finishWait();
    }
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/socialV2/check-send') {
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    const tool = String(body.tool ?? '').trim();
    const token = String(body.token ?? '').trim();
    if (!key || !tool || !token) {
      sendJson({ ok: false, error: 'key/tool/token 不能为空' }, 400);
      return;
    }
    if (!agentTokenOk(key, token)) {
      sendJson({ ok: false, error: 'agent token 无效' }, 403);
      return;
    }
    if (!v2SessionAllowed(key)) {
      sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
      return;
    }
    const flagMap = { sendGroup: 'sendGroup', sendPrivate: 'sendPrivate', reply: 'reply' };
    const flag = flagMap[tool];
    if (!flag) {
      sendJson({ ok: false, error: 'tool 必须是 sendGroup/sendPrivate/reply' }, 400);
      return;
    }
    if (!v2ToolEnabled(flag)) {
      sendJson({ ok: false, error: `工具未启用：qq_${tool === 'sendGroup' ? 'send_group_message' : tool === 'sendPrivate' ? 'send_private_message' : 'reply'}` }, 403);
      return;
    }
    sendJson({ ok: true, key, tool });
    return;
  }
  // ── 工具调用日志 ─────────────────────────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/api/socialV2/tool-log') {
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 200));
    sendJson({ ok: true, entries: readToolLog(limit) });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/socialV2/tool-log/clear') {
    if (req.headers['x-agent-token']) { sendJson({ ok: false, error: '该接口仅控制台可用' }, 403); return; }
    try { fs.writeFileSync(TOOL_LOG_FILE, '', 'utf8'); } catch {}
    log('控制台：工具调用日志已清空');
    sendJson({ ok: true });
    return;
  }
  // ── 反馈 / 自己消息 / 消息详情 / 活跃成员 ────────────────────────────
  // 自检：在**运行中的桥接进程里**真实跑一次报错通知，验证「群里零消息 + 管理员收到私聊」。
  // 用控制台令牌鉴权（不是 agent 令牌），只发私聊给 owner，不会打扰任何群。
  // 排障用法：curl -H "x-console-token: <token>" "http://127.0.0.1:3100/api/socialV2/error-notify-selftest?key=group:123"
  if (req.method === 'POST' && url.pathname === '/api/socialV2/error-notify-selftest') {
    if (req.headers['x-agent-token']) { sendJson({ ok: false, error: '该接口仅控制台可用' }, 403); return; }
    const body = await readBody();
    const key = String(body.key ?? '').trim() || 'group:0';
    const title = String(body.title ?? '自检报错（可忽略）');
    const detail = String(body.detail ?? '这是一条由控制台触发的自检通知，用于确认「报错只私聊管理员、不进群」的通道正常。');
    const en = cfg.socialV2?.errorNotice ?? {};
    const base = cfg.errorNotify ?? {};
    const ownerQQ = String(cfg.ownerQQ ?? '').trim();
    if (!ownerQQ) { sendJson({ ok: false, error: 'config.ownerQQ 为空，无法通知管理员' }, 400); return; }
    if (en.notifyOwner === false || base.notifyOwner === false) {
      sendJson({ ok: false, error: '管理员报错通知当前被关闭（socialV2.errorNotice.notifyOwner / errorNotify.notifyOwner）' }, 400);
      return;
    }
    notifyOwnerOfError(key, title, detail, { 来源: '控制台自检' });
    sendJson({
      ok: true,
      key,
      sentTo: `private:${ownerQQ}`,
      groupMessagesSent: 0,
      config: { inGroup: en.inGroup === true, notifyOwner: true, windowMs: Number(base.windowMs) || 0 }
    });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/socialV2/feedback') {
    sendJson({ ok: true, entries: readFeedbackEntries() });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/socialV2/feedback-clear') {
    if (req.headers['x-agent-token']) { sendJson({ ok: false, error: '该接口仅控制台可用' }, 403); return; }
    atomicWriteJson(FEEDBACK_FILE, []);
    log('控制台：清空 AI 反馈');
    sendJson({ ok: true });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/socialV2/feedback') {
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    const level = body.level === 'warning' || body.level === 'error' ? body.level : 'info';
    const rawMessage = String(body.message ?? '').trim();
    if (!key || !rawMessage) { sendJson({ ok: false, error: 'key 和 message 不能为空' }, 400); return; }
    if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
    if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
    if (req.headers['x-agent-token'] && !v2ToolEnabled('feedback')) { sendJson({ ok: false, error: '工具未启用：qq_report_feedback' }, 403); return; }
    // 反馈限频：防止持有会话 token 的调用方刷磁盘/日志。
    const fNow = Date.now();
    const fTimes = feedbackTimes.get(key) || [];
    const fRecentMinute = fTimes.filter((t) => fNow - t < 60000).length;
    const fRecentHour = fTimes.filter((t) => fNow - t < 3600000).length;
    if (fRecentMinute >= 5 || fRecentHour >= 20) {
      sendJson({ ok: false, error: '反馈过于频繁，请稍后再试' }, 429);
      return;
    }
    fTimes.push(fNow);
    feedbackTimes.set(key, fTimes.slice(-100));
    const maxLength = Math.max(1, Number(cfg.socialV2?.feedback?.maxLength) || 500);
    const message = rawMessage.slice(0, maxLength);
    appendFeedbackEntry({ id: Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8), key, level, message, time: new Date().toISOString() });
    log(`[reserved2] AI 反馈 (${key}) [${level}]: ${message.slice(0, 80)}`);
    appendActivity(`${key} [reserved2] AI 反馈 [${level}]：${message.slice(0, 80)}`);
    if (cfg.socialV2?.feedback?.notifyOwnerOnError && level === 'error' && cfg.ownerQQ) {
      log(`[reserved2] 错误级反馈，可通知 owner ${cfg.ownerQQ}（当前仅记录日志）`);
    }
    sendJson({ ok: true, key, level, message });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/socialV2/my-recent') {
    const key = String(url.searchParams.get('key') ?? '').trim();
    const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 10));
    if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
    if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
    if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
    if (req.headers['x-agent-token'] && !v2ToolEnabled('getMyRecent')) { sendJson({ ok: false, error: '工具未启用：qq_get_my_recent_messages' }, 403); return; }
    const st = getSocialV2State(key);
    const mine = st.recentMessages.filter((m) => m.isSelf).slice(-limit);
    sendJson({ ok: true, key, messages: mine });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/socialV2/record-sent') {
    // 内部接口不对外开放：防止持有会话 token 的调用方伪造“我说过…”的历史记录。
    sendJson({ ok: false, error: '该接口仅桥接内部使用，不接受外部调用' }, 403);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/socialV2/message-detail') {
    const key = String(url.searchParams.get('key') ?? '').trim();
    const messageId = String(url.searchParams.get('messageId') ?? '').trim();
    if (!key || !messageId) { sendJson({ ok: false, error: 'key 和 messageId 不能为空' }, 400); return; }
    if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
    if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
    if (req.headers['x-agent-token'] && !v2ToolEnabled('getMessageDetail')) { sendJson({ ok: false, error: '工具未启用：qq_get_message_detail' }, 403); return; }
    const keyMatch = /^(group|private):(\d+)$/.exec(key);
    if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
    const kind = keyMatch[1];
    const id = Number(keyMatch[2]);
    try {
      const st = getSocialV2State(key);
      const found = (st.recentMessages || []).find((m) => m && (String(m.seq) === messageId || (m.messageId && String(m.messageId) === messageId)));
      const forwardFields = found ? {
        forwardIds: Array.isArray(found.forwardIds) ? found.forwardIds : [],
        hasForward: !!found.hasForward
      } : {};
      let info = null;
      // 如果入参命中本地 seq 且本地存有真实 messageId，优先按 seq 展示，避免与真实 id 冲突。
      if (found && found.messageId && String(found.messageId) !== messageId) {
        info = {
          sender: String(found.sender || ''),
          text: String(found.text || found.plain || '').slice(0, 200),
          userId: found.userId ? String(found.userId) : null,
          messageId: String(found.messageId),
          seq: found.seq
        };
      } else {
        info = await resolveReplyInfo(kind, id, messageId);
        if (!info && found) {
          info = {
            sender: String(found.sender || ''),
            text: String(found.text || found.plain || '').slice(0, 200),
            userId: found.userId ? String(found.userId) : null,
            messageId: found.messageId ? String(found.messageId) : null,
            seq: found.seq
          };
        }
      }
      // 无论 info 来自本地还是 OneBot，只要本地有 found 就补充转发字段，避免提示词与实现不一致。
      if (info && found) Object.assign(info, forwardFields);
      sendJson({ ok: true, key, messageId, info });
    } catch (error) {
      sendJson({ ok: false, error: `获取消息详情失败：${error?.message ?? error}` }, 500);
    }
    return;
  }
}
