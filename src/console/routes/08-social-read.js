// 控制台路由域：二代只读：群文件 / 未读 / 唤醒（R4）。
//
// 从 console-server.js 原样搬出，只调整了缩进；鉴权 / CSRF / agent 白名单 /
// 暂停隔离仍由 console-server 统一处理，走到这里时请求已通过全部前置校验。
export const id = '08-social-read';
export const title = '二代只读：群文件 / 未读 / 唤醒';

/** 本模块负责的路由；console-server 据此分派，不必解析 handler 内部。 */
export const routes = [
  ['GET', '/api/socialV2/group-files', 'exact'],
  ['GET', '/api/socialV2/group-file-stats', 'exact'],
  ['GET', '/api/socialV2/unread', 'exact'],
  ['GET', '/api/socialV2/recent', 'exact'],
  ['POST', '/api/socialV2/mark-read', 'exact'],
  ['POST', '/api/socialV2/wake-config', 'exact'],
  ['GET', '/api/socialV2/states', 'exact'],
  ['POST', '/api/socialV2/wake', 'exact']
];

export async function handle(req, res, url, ctx) {
  const { sendJson, readBody, deps } = ctx;
  const { agentTokenOk, v2SessionAllowed, v2ToolEnabled } = ctx;
  const {
    bot,
    cancelReplyCheckV2,
    cfg,
    collectors,
    computeWakeSafetyV2,
    ensureWakeableV2,
    findCallersV2,
    formatSummary,
    getSocialV2State,
    humanSize,
    isConversationBusyV2,
    isSleepingConfigV2,
    log,
    markReadCalledKeys,
    modeAllowed,
    normalizeSpeakerIdsV2,
    pendingWakeKeys,
    preSleepWaitBlockedV2,
    promptQueues,
    saveSocialV2State,
    searchGroupFiles,
    sendWakePromptV2,
    setupSleepTimerV2,
    socialV2,
    state,
    summarizeGroupFiles,
    v2TurnStartAt,
    wakeConfigMissCount,
    wakeConfigUpdatedKeys
  } = deps;

  // ── 群文件只读分类（见 group-files.js）──────────────────────────────
  // 只读：列文件、统计、搜索。**不删除/移动/上传/改名** ——
  // 那些写操作 API 确实存在且会真实执行（已实测 delete_group_file），
  // 但群文件里的 docx/pdf 删了不可恢复，不做进工具。
  if (req.method === 'GET' && url.pathname === '/api/socialV2/group-files') {
    const key = String(url.searchParams.get('key') ?? '').trim();
    const keyMatch = /^group:(\d+)$/.exec(key);
    if (!keyMatch) { sendJson({ ok: false, error: '群文件只适用于群会话（key 格式 group:群号）' }, 400); return; }
    if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: '读取群文件必须携带 agent token' }, 403); return; }
    if (!agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
    if (!v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
    if (!v2ToolEnabled('groupFiles')) { sendJson({ ok: false, error: '工具未启用：qq_list_group_files' }, 403); return; }
    const groupId = Number(keyMatch[1]);
    try {
      // 取列表（走 OneBot，与其它只读查询同一通道）
      // 注意：SDK 的 call() 已经解包（returns response.data）且出错会 throw，
      // 所以这里直接读 .files，不要再套一层 .data（那是原始 HTTP 的形状）。
      const raw = await bot.getGroupRootFiles(groupId);
      const files = (raw && raw.files) || [];
      const mode = String(url.searchParams.get('mode') ?? 'summary');
      if (mode === 'search') {
        const q = {
          keyword: url.searchParams.get('keyword') || '',
          category: url.searchParams.get('category') || '',
          ext: url.searchParams.get('ext') || '',
          uploader: url.searchParams.get('uploader') || '',
          minBytes: Number(url.searchParams.get('minBytes')) || 0,
          maxBytes: Number(url.searchParams.get('maxBytes')) || 0,
          limit: Number(url.searchParams.get('limit')) || 20
        };
        const r = searchGroupFiles(files, q);
        sendJson({ ok: true, key, mode, query: q, ...r });
        return;
      }
      const summary = summarizeGroupFiles(files, { recentDays: Number(url.searchParams.get('recentDays')) || 7 });
      sendJson({ ok: true, key, mode: 'summary', summary, text: formatSummary(summary) });
    } catch (error) {
      log(`群文件读取失败 ${key}: ${error?.message ?? error}`);
      sendJson({ ok: false, error: `群文件读取失败：${error?.message ?? error}` }, 500);
    }
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/socialV2/group-file-stats') {
    const key = String(url.searchParams.get('key') ?? '').trim();
    const keyMatch = /^group:(\d+)$/.exec(key);
    if (!keyMatch) { sendJson({ ok: false, error: '群文件只适用于群会话（key 格式 group:群号）' }, 400); return; }
    if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: '读取群文件必须携带 agent token' }, 403); return; }
    if (!agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
    if (!v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
    if (!v2ToolEnabled('groupFiles')) { sendJson({ ok: false, error: '工具未启用：qq_group_file_stats' }, 403); return; }
    try {
      // 容量信息：让模型能回答"群文件满了吗"这类问题
      const info = await bot.getGroupFileSystemInfo(Number(keyMatch[1]));
      const d = info ?? {};   // SDK 已解包
      const used = Number(d.used_space) || 0;
      const total = Number(d.total_space) || 0;
      sendJson({
        ok: true,
        key,
        fileCount: Number(d.file_count) || 0,
        limitCount: Number(d.limit_count) || 0,
        usedSpace: used,
        totalSpace: total,
        usedText: humanSize(used),
        totalText: humanSize(total),
        usedPercent: total > 0 ? Math.round(used / total * 100) : null
      });
    } catch (error) {
      sendJson({ ok: false, error: `容量读取失败：${error?.message ?? error}` }, 500);
    }
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/socialV2/unread') {
    const key = String(url.searchParams.get('key') ?? '').trim();
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 30));
    if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
    if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
    if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
    if (req.headers['x-agent-token'] && !v2ToolEnabled('getUnread')) { sendJson({ ok: false, error: '工具未启用：qq_get_unread_messages' }, 403); return; }
    const st = getSocialV2State(key);
    sendJson({ ok: true, key, unreadCount: st.unread.length, messages: st.unread.slice(-limit) });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/socialV2/recent') {
    const key = String(url.searchParams.get('key') ?? '').trim();
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 20));
    const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
    if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
    if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
    if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
    if (req.headers['x-agent-token'] && !v2ToolEnabled('getRecent')) { sendJson({ ok: false, error: '工具未启用：qq_get_recent_messages' }, 403); return; }
    const st = getSocialV2State(key);
    const start = Math.max(0, st.recentMessages.length - offset - limit);
    const end = Math.max(0, st.recentMessages.length - offset);
    sendJson({ ok: true, key, messages: st.recentMessages.slice(start, end) });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/socialV2/mark-read') {
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
    if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
    if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
    if (req.headers['x-agent-token'] && !v2ToolEnabled('markRead')) { sendJson({ ok: false, error: '工具未启用：qq_mark_read' }, 403); return; }
    const st = getSocialV2State(key);
    // 硬拦截：未读里有人在叫它（@ 它的任一别名 / 引用它），而它这一轮还没发过言时，
    // 不允许直接已读收尾。实测模型会一边把「@大肥鱼 speak」「@大肥鱼 夸一夸…」当
    // 「没人叫我」忽略掉，一边 wait 完就 mark_read 走人，导致催它的人永远等不到回应
    // （提示词和 preset 都写了「被 @ 必须回」，但它仍会违反，所以必须有桥接侧硬约束）。
    {
      const callerMsgs = findCallersV2(key, st);
      // 只看 pending（还没答过的 @）。answered 是「已经回过的那条 @」——用
      // qq_send_message 不引用回复时它不会被移出未读（只有带 replyToMessageId 的
      // 发送才清理），于是会长期留在列表里。原先判 callerMsgs.length 把这类旧 @
      // 也算成「有人在叫你」，机器人明明已经把话说完了、想收尾时仍被拦下，
      // 只能硬凑一句话。实测 2026-10-12 被逼出这样一条真发进群的：
      //   「这两下 @ 我都应过了，管理员的「在的」、喊口号那个也拒了」
      // —— 只是把自己的调度状态念了一遍。answered 不该构成拦截理由。
      // —— 这里**不能**再叠 `repliedThisTurn`（本轮发过言就放行）。
      // pending 的判定基准是 lastAiReplyAt（最后一次发言时间）：只要 @ 比它晚，
      // 这条 @ 就是没答过的。而 repliedThisTurn 看的是「本轮有没有发过言」，
      // 一个更早的回复也会让它为 true。实测 2026-10-22 20:18:59 的 @ 就是被它
      // 放行的：机器人 20:14:38 发过言（那轮确实发过），20:20:51 wait 结束后
      // mark_read 把这条 @ 一并标读，靠 backfill 4 分钟后才补回，用户以为没理人。
      if (callerMsgs.pending.length) {
        const brief = callerMsgs.pending
          .slice(-3)
          .map((m) => `${String(m.sender || '某人')}：${String(m.text || m.plain || '').slice(0, 30)}`)
          .join('；');
        sendJson({
          ok: false,
          error: `未读里有人在叫你，不能就这样已读收尾：${brief}。请先正面回应（优先用 qq_reply；用 qq_send_message 时带 replyToMessageId，桥接才能确认你回的是哪条）；如果这条你确实办不到，就直接对群友说明办不到的原因——话说给对方听，不要报告自己的处理流程或调度状态。`,
          callers: callerMsgs.pending.length
        }, 400);
        return;
      }
    }
    // 如果当前已经是“潜水”唤醒配置，且最近还有对话/刚被唤醒，不允许用 mark_read 直接回到潜水；
    // 必须先等够沉睡前观察窗口，避免“聊两句又去潜水”。
    if (isSleepingConfigV2(st.wakeConfig) && preSleepWaitBlockedV2(st, key)) {
      const preSleepMs = Math.max(0, Number(cfg.socialV2?.wake?.preSleepWaitMs) || 300000);
      const remaining = Math.max(0, preSleepMs - ((st.lastIncomingAt || 0) ? Date.now() - st.lastIncomingAt : 0));
      const remainMin = Math.ceil(remaining / 60000);
      sendJson({
        ok: false,
        error: `还不能通过 qq_mark_read 直接回到潜水：还需等待约 ${remainMin} 分钟无新消息，或调用 qq_wait_for_messages(timeoutMs=${preSleepMs}) 完成一次沉睡前观察。如果等待期间有人发新消息，请先查看返回的 newMessages；判断不需要你参与就可以直接收尾沉睡，若你参与了则需下次再等观察窗口。`,
        preSleepWaitMs: preSleepMs,
        preSleepWaitRemainingMs: remaining
      }, 400);
      return;
    }
    const markedCount = st.unread.length;
    // 未读清理：**该清的要清干净**，否则会永久滞留并导致重复回答。
    //
    // 历史与两个坑：
    //   1. 原先这里写的是 `filter((m) => !pendingSeqs.has(seq))`——与它自己的注释
    //      （"保留命中排队 seq 的未读"）**正好相反**：它把排队中的消息**删掉**、
    //      留下其余全部。实测后果：11 条未读被反复"保留"，mark_read 每次都报
    //      "已读 0 条，保留 11 条"，于是**每一轮唤醒模型都看到同样那 11 条**，
    //      里面 4 条早前的 @ 被当成待办逐条补答 → 同一条消息被回复 3~4 次。
    //   2. 之所以当初想"保留排队消息"，是为了避免"繁忙期间入队的 @ 被顺手标掉、
    //      补发判定误判成已处理"（确有此事）。但正确做法是**只保留本轮唤醒之后
    //      新到的**——那些才是没被任何回合看过的。
    //
    // 判据用 seq 而不是时间：seq 是本地自增、单调，比时钟可靠。
    // 本轮唤醒后新到的消息 seq 一定大于唤醒时的水位。
    const wakeSeqAt = Number(st.wakeSeqAt) || 0;
    if (wakeSeqAt > 0) {
      st.unread = st.unread.filter((m) => Number(m?.seq) > wakeSeqAt);
    } else {
      // 拿不到水位（老状态/异常）时保守清空：宁可清掉也不让它永久滞留
      // ——滞留的代价是"无限重复回答"，比偶尔漏一条更严重。
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
    saveSocialV2State();
    log(`[reserved2] 控制台/工具标记 ${key} 未读已读：${markedCount - keptUnread} 条${keptUnread ? `，保留 ${keptUnread} 条待补发唤醒的消息` : ''}，已确认下一次唤醒配置`);
    sendJson({ ok: true, key, markedCount, wakeGuaranteed: computeWakeSafetyV2(st.wakeConfig).guaranteed, wakeSafety: computeWakeSafetyV2(st.wakeConfig), wakeConfig: st.wakeConfig });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/socialV2/wake-config') {
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
    if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
    if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
    if (req.headers['x-agent-token'] && !v2ToolEnabled('setWakeConfig')) { sendJson({ ok: false, error: '工具未启用：qq_set_wake_config' }, 403); return; }
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
        sendJson({ ok: false, error: '无限期潜水必须至少保留一个唤醒条件（@/名字/拍一拍/关键词/提问/anyMessage/概率>0），否则 AI 可能永眠' }, 400);
        return;
      }
    }
    // 硬拦截（与 qq_mark_read 同规则）：未读里有人叫它、而本轮还没回应时，
    // 不允许直接设置潜水/下一次唤醒就走人——否则催它的人永远等不到回应。
    // 判据同样只看 pending：已经回过的那条 @ 不构成拦截理由（详见 qq_mark_read 处的说明）。
    if (isSleepingConfigV2(next)) {
      const callerMsgs2 = findCallersV2(key, st);
      // 与 qq_mark_read 同理：pending 已按 lastAiReplyAt 判过，
      // 不能再叠「本轮发过言」——早于新 @ 的回复也会让那个条件成立。
      if (callerMsgs2.pending.length) {
        const brief2 = callerMsgs2.pending
          .slice(-3)
          .map((m) => `${String(m.sender || '某人')}：${String(m.text || m.plain || '').slice(0, 30)}`)
          .join('；');
        sendJson({
          ok: false,
          error: `未读里有人在叫你，不能先潜水走人：${brief2}。请先正面回应（优先用 qq_reply；用 qq_send_message 时带 replyToMessageId，桥接才能确认你回的是哪条），回应后再设置下一次唤醒；如果这条你确实办不到，就直接对群友说明办不到的原因——话说给对方听，不要报告自己的处理流程或调度状态。`,
          callers: callerMsgs2.pending.length
        }, 400);
        return;
      }
    }
    // 沉睡前强制观察窗口：除非对方明确结束、或已经安静/等待足够时间，否则不允许 AI 聊两句就设置潜水。
    if (isSleepingConfigV2(next) && preSleepWaitBlockedV2(st, key)) {
      const preSleepMs = Math.max(0, Number(cfg.socialV2?.wake?.preSleepWaitMs) || 300000);
      const remaining = Math.max(0, preSleepMs - ((st.lastIncomingAt || 0) ? Date.now() - st.lastIncomingAt : 0));
      const remainMin = Math.ceil(remaining / 60000);
      sendJson({
        ok: false,
        error: `还不能立刻设置潜水/下一次唤醒：还需等待约 ${remainMin} 分钟无新消息，或调用 qq_wait_for_messages(timeoutMs=${preSleepMs}) 完成一次沉睡前观察。如果等待期间有人发新消息，请先查看返回的 newMessages；判断不需要你参与就可以直接设置并沉睡，若你参与了则需下次再等观察窗口。`,
        preSleepWaitMs: preSleepMs,
        preSleepWaitRemainingMs: remaining
      }, 400);
      return;
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
    saveSocialV2State();
    wakeConfigUpdatedKeys.add(key);
    wakeConfigMissCount.delete(key);
    if (st.pendingWakeTimer) {
      clearTimeout(st.pendingWakeTimer);
      st.pendingWakeTimer = null;
    }
    cancelReplyCheckV2(key); // AI 已主动设置新的唤醒配置，取消回复检查
    setupSleepTimerV2(key);
    log(`[reserved2] 更新唤醒配置 ${key}: mode=${next.mode} infinite=${next.infinite} sleepUntil=${next.sleepUntil ?? 'null'}`);
    sendJson({ ok: true, key, wakeConfig: next, wakeSafety: computeWakeSafetyV2(next) });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/socialV2/states') {
    const list = [];
    for (const [key, st] of socialV2.conversations) {
      // 诊断：把 isConversationBusyV2 的四个判据分别透出，便于定位「虚假繁忙」卡在哪一项
      const sid = state.sessions[key];
      const q = promptQueues.get(key);
      list.push({
        key,
        wakeConfig: st.wakeConfig,
        unreadCount: st.unread.length,
        recentCount: st.recentMessages.length,
        lastWakeReason: st.lastWakeReason,
        lastAiReplyAt: st.lastAiReplyAt,
        noActionCount: st.wakeConfig.noActionCount || 0,
        busy: isConversationBusyV2(key, st),
        busyBy: {
          pendingWakeTimer: !!st.pendingWakeTimer,
          pendingWakeKeys: pendingWakeKeys.has(key),
          promptQueue: !!(q && (q.running || q.queue.length > 0)),
          promptQueueRunning: !!(q && q.running),
          promptQueueLen: q?.queue?.length ?? 0,
          v2TurnStartAt: !!(sid && v2TurnStartAt.has(sid)),
          collectors: !!(sid && collectors.has(sid))
        }
      });
    }
    sendJson({ ok: true, conversations: list });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/socialV2/wake') {
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    const reason = String(body.reason ?? 'admin').trim() || 'admin';
    if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
    if (deps.live.currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
    const keyMatch = /^(group|private):(\d+)$/.exec(key);
    if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
    const kind = keyMatch[1];
    const id = Number(keyMatch[2]);
    if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, deps.live.currentMode)) {
      sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
      return;
    }
    const st = getSocialV2State(key);
    if (st.pendingWakeTimer) {
      clearTimeout(st.pendingWakeTimer);
      st.pendingWakeTimer = null;
    }
    if (!st.bootstrapSent) st.bootstrapSent = true;
    saveSocialV2State();
    sendWakePromptV2(key, reason, { manual: true });
    log(`控制台：手动唤醒 ${key}（${reason}）`);
    sendJson({ ok: true, key, reason });
    return;
  }
}
