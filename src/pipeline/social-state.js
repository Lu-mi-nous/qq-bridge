// 会话社交状态与持久化边界。定时器/存储适配器由 bridge 显式注入。
import crypto from 'node:crypto';
import { sanitizeForwardId } from '../forward.js';

export function canonicalV2Key(key) {
  const m = /^(group|private):(\d+)$/.exec(String(key ?? '').trim());
  if (!m) return null;
  const id = Number(m[2]);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return `${m[1]}:${id}`;
}


export function createSocialStateStore(deps) {
  const { cfg, socialV2, state, v2TurnStartAt, KNOWN_AGENT_TOKENS, seenForwardIds,
    SOCIAL_V2_FILE, readJsonSafe, atomicWriteJson, stateStore, scheduleProactiveCheckV2,
    setupSleepTimerV2, log } = deps;
  function normalizeSpeakerIdsV2(value) {
    if (value === undefined || value === null) return [];
    const rawList = Array.isArray(value) ? value : String(value).split(/[,，\s]+/);
    const seen = new Set();
    const clean = [];
    for (const v of rawList) {
      const s = String(v ?? '').trim();
      if (!/^[1-9]\d*$/.test(s)) continue;
      if (seen.has(s)) continue;
      seen.add(s);
      clean.push(s);
      if (clean.length >= 20) break;
    }
    return clean;
  }

  function defaultWakeConfigV2() {
    const w = cfg.socialV2?.wake ?? {};
    const defaultMode = w.defaultMode === 'active' ? 'active' : 'diving';
    const defaultInfinite = w.recommendedDefaultInfinite !== false;
    const recMin = Number(w.recommendedSleepMinMs) || 300000;
    const recMax = Number(w.recommendedSleepMaxMs) || 7200000;
    let finiteMs = recMin + Math.random() * Math.max(0, recMax - recMin);
    const hardMin = Math.max(0, Number(w.sleepMinMs) || 0);
    const hardMax = Number(w.sleepMaxMs) || 0;
    if (hardMin > 0 && finiteMs < hardMin) finiteMs = hardMin;
    if (hardMax > 0 && finiteMs > hardMax) finiteMs = hardMax;
    return {
      mode: defaultMode,
      infinite: defaultInfinite,
      sleepUntil: defaultInfinite ? null : new Date(Date.now() + Math.round(finiteMs)).toISOString(),
      triggers: {
        atMention: w.recommendedAtMention !== false,
        nameMention: w.recommendedNameMention !== false,
        speakerIds: [],
        keywords: Array.isArray(w.recommendedKeywords) ? w.recommendedKeywords.map(String) : [],
        question: w.recommendedQuestion !== false,
        poke: w.recommendedPoke !== false,
        anyMessage: defaultMode === 'active',
        probability: Math.min(1, Math.max(0, Number(w.recommendedProbability) || 0))
      },
      batchWindowMs: Math.max(1000, Number(w.batchWindowMs) || 8000),
      lastWakeAt: 0,
      wakeCount: 0,
      noActionCount: 0,
      confirmedAt: 0,
      confirmedBy: 'default'
    };
  }

  // 把“仍使用默认唤醒配置”的会话刷新为当前推荐/默认参数。
  // 只有 confirmedBy === 'default' 的会话才会被刷新；AI 或管理员显式设置过的（set_wake_config / mark_read）不会被覆盖。
  function refreshDefaultWakeConfigV2(st) {
    if (!st || !st.wakeConfig) return false;
    if (st.wakeConfig.confirmedBy !== 'default') return false;
    const def = defaultWakeConfigV2();
    const old = st.wakeConfig;
    st.wakeConfig = {
      ...def,
      lastWakeAt: old.lastWakeAt || 0,
      wakeCount: old.wakeCount || 0,
      noActionCount: old.noActionCount || 0,
      confirmedAt: old.confirmedAt || 0,
      confirmedBy: 'default'
    };
    return true;
  }

  // 保存推荐/默认参数后，把所有仍使用默认配置的会话同步到新默认值。
  function refreshAllDefaultWakeConfigsV2() {
    let changed = false;
    for (const st of socialV2.conversations.values()) {
      if (refreshDefaultWakeConfigV2(st)) changed = true;
    }
    if (changed) saveSocialV2State();
    return changed;
  }

  // 沉睡前强制观察窗口：防止 AI 聊两句就立刻潜水。
  // 新规则：每次设置潜水/下一次唤醒前，AI 必须先进入一次“沉睡前观察”（qq_wait_for_messages(timeoutMs=preSleepWaitMs)）。
  // - 观察期间没人说话 → 可以设置唤醒并沉睡（preSleepWaitSatisfiedAt）。
  // - 观察期间有人发了新消息 → 等待工具会把新消息带回给 AI（preSleepWaitObservedAt）；
  //   AI 看过新消息后若判断没必要参与，可以直接沉睡；若参与了（发送/拍一拍），则下次想睡需重新观察。
  const EXPLICIT_END_RE = /(?:不聊了|不说了|晚安|睡了|先睡了|下了|先下了|拜拜|再见|走了|先走|撤了|去忙|忙了|下次再聊|下次聊|散了吧|结束|就到这|先这样|就这样吧|886|88|睡觉了|下班了|去洗澡|去吃饭了)/i;

  function hasExplicitEndV2(st) {
    const recent = Array.isArray(st?.recentMessages) ? st.recentMessages : [];
    const last = [...recent].reverse().find((m) => m && !m.isSelf);
    if (!last) return false;
    return EXPLICIT_END_RE.test(String(last.tail || last.plain || last.text || ''));
  }

  function isSleepingConfigV2(wc) {
    if (!wc) return false;
    if (wc.mode === 'active' || wc.triggers?.anyMessage) return false;
    return true; // diving 且不是 anyMessage 都视为“沉睡/潜水”，需要先观察
  }

  function preSleepWaitBlockedV2(st, key = '') {
    if (!st) return false;
    const w = cfg.socialV2?.wake ?? {};
    if (w.preSleepWaitEnabled === false) return false;
    if (hasExplicitEndV2(st)) return false;
    const waitMs = Math.max(0, Number(w.preSleepWaitMs) || 300000);
    const now = Date.now();
    // 已经连续安静满观察窗口：可以直接设置潜水。
    if ((st.lastIncomingAt || 0) && now - st.lastIncomingAt >= waitMs) return false;
    // 已经完整等过观察窗口且之后没有新消息：放行。
    if (st.preSleepWaitSatisfiedAt && (!st.lastIncomingAt || st.lastIncomingAt <= st.preSleepWaitSatisfiedAt)) return false;
    // 已经做过一次沉睡前观察（可能等到了新消息并已把新消息返回给 AI），只要 AI 之后没有参与、也没有更新的消息，就允许直接沉睡。
    if (st.preSleepWaitObservedAt && (!st.lastIncomingAt || st.lastIncomingAt <= st.preSleepWaitObservedAt)) return false;
    // 活跃群死锁兜底：本回合已经发过言、且距最后一次发言已过 30 秒，就不再要求
    // 连续 60 秒静默。否则群里一直有人说话 → 观察窗口永远重置 → 模型只能反复 wait，
    // 单个回合拖到几十分钟（2026-10-23 group:100002007 实测 24 分钟）。
    if (key) {
      const sid = state.sessions[key];
      const turnStart = sid ? (Number(v2TurnStartAt.get(sid)) || 0) : 0;
      const lastReply = Number(st.lastAiReplyAt) || 0;
      const graceMs = Math.max(0, Math.min(300000, Math.round(Number(w.preSleepReplyGraceMs) || 30000)));
      if (turnStart && lastReply >= turnStart && now - lastReply >= graceMs) return false;
    }
    return true;
  }

  function computeWakeSafetyV2(wc) {
    const tr = wc?.triggers || {};
    const hard = wc?.mode === 'active' || tr.anyMessage || tr.atMention || tr.nameMention || tr.question || tr.poke ||
      (Array.isArray(tr.keywords) && tr.keywords.length > 0) ||
      normalizeSpeakerIdsV2(tr.speakerIds).length > 0;
    const timed = !wc?.infinite && wc?.sleepUntil && Date.parse(wc.sleepUntil) > Date.now();
    const soft = Number(tr.probability) > 0;
    const guaranteed = hard || timed || soft;
    const confirmedNum = Number(wc?.confirmedAt);
    const stale = !wc?.confirmedAt || !Number.isFinite(confirmedNum) || Date.now() - confirmedNum > 24 * 60 * 60 * 1000;
    return { hard, timed, soft, guaranteed, stale };
  }

  // 防“永眠”：检查当前 WakeConfig 是否至少有一个可触发唤醒的途径；没有则重置为默认配置。
  // opts.skipSave=true 用于加载状态阶段，避免中途落盘覆盖尚未加载的会话。
  function ensureWakeableV2(st, opts = {}) {
    if (!st || !st.wakeConfig) return;
    const key = opts.key || st.key;
    const wc = st.wakeConfig;
    if (!wc.triggers || typeof wc.triggers !== 'object') wc.triggers = {};
    const tr = wc.triggers;
    // 掉垃圾数据只留有效 QQ 号，避免“null”/对象等脏值被当成可唤醒条件绕过防永眠。
    tr.speakerIds = normalizeSpeakerIdsV2(tr.speakerIds);
    const timed = !wc.infinite && wc.sleepUntil && Number.isFinite(Date.parse(wc.sleepUntil)) && Date.parse(wc.sleepUntil) > Date.now();
    const wakeable = wc.mode === 'active' || tr.anyMessage || tr.atMention || tr.nameMention || tr.poke ||
      (Array.isArray(tr.keywords) && tr.keywords.length > 0) || tr.question || Number(tr.probability) > 0 ||
      tr.speakerIds.length > 0 || timed;
    if (!wakeable) {
      if (st.sleepTimer) {
        clearTimeout(st.sleepTimer);
        st.sleepTimer = null;
      }
      st.wakeConfig = defaultWakeConfigV2();
      if (!opts.skipSave) saveSocialV2State();
      if (key) setupSleepTimerV2(key);
      log(`[reserved2] 唤醒配置无任何触发条件，已重置为默认配置，避免永眠`);
    }
  }

  function getSocialV2State(key) {
    // 只允许内部约定的会话 key 格式，并统一成无前导零的正整数形式，防止同一会话分裂成多个状态。
    const canonical = canonicalV2Key(key);
    if (!canonical) {
      const err = new Error(`无效的会话 key：${String(key ?? '')}`);
      err.statusCode = 400;
      throw err;
    }
    key = canonical;
    let st = socialV2.conversations.get(key);
    if (!st) {
      st = {
        wakeConfig: defaultWakeConfigV2(),
        recentMessages: [],
        unread: [],
        lastWakeReason: '',
        lastAiReplyAt: 0,
        // 明确引用回复过的消息 seq。mark_read 只认这个集合，
        // 不再按"回复时间晚于 @ 时间"推断——那会把同一批里没答的 @ 一起标掉。
        answeredSeqs: [],
        lastActionAt: 0,
        agentToken: crypto.randomBytes(16).toString('hex'),
        bootstrapSent: false,
        wakeTimes: [],
        sendTimes: [],
        stickerCollectTimes: [],
        crawlTimes: [],
        stickerAddTimes: [],
        pendingWakeTimer: null,
        sleepTimer: null,
        replyCheckTimer: null,
        proactiveTimer: null,
        lastIncomingAt: 0,
        preSleepWaitSatisfiedAt: 0,
        preSleepWaitObservedAt: 0,
        preSleepWaitAccumMs: 0,
        lastUnreadSeq: 0,
        // 本轮唤醒的未读水位（唤醒时未读里最大的 seq）。mark_read 只清 ≤ 它的消息，
        // 水位之后新到的不动。0 = 没有在途回合（如启动初期）。
        wakeSeqAt: 0,
        lastComplyRollAt: 0,
        pendingComply: null,
        complyTimes: [],
        activeTopics: [],
        pendingThoughts: [],
        memberImpressions: {},
        // 表情包主动要求的频率账（见 saveSocialV2State 里的说明）
        lastStickerAt: 0,
        recentStickers: [],
        stickerNudgeTimes: []
      };
      KNOWN_AGENT_TOKENS.add(st.agentToken);
      socialV2.conversations.set(key, st);
      scheduleProactiveCheckV2(key);
      setupSleepTimerV2(key);
    }
    return st;
  }

  function loadSocialV2State() {
    try {
      const raw = stateStore ? stateStore.read() : readJsonSafe(SOCIAL_V2_FILE, null);
      socialV2.paused = raw?.paused === true;
      if (raw && typeof raw.conversations === 'object') {
        const seenTokens = new Set();
        for (const [key, val] of Object.entries(raw.conversations)) {
          if (!val || typeof val !== 'object') continue;
          if (!/^(group|private):\d+$/.test(key)) continue;
          const defaultWc = defaultWakeConfigV2();
          let agentToken = String(val.agentToken || crypto.randomBytes(16).toString('hex'));
          if (!agentToken || seenTokens.has(agentToken)) {
            agentToken = crypto.randomBytes(16).toString('hex');
          }
          seenTokens.add(agentToken);
          const st = {
            wakeConfig: {
              ...defaultWc,
              ...(val.wakeConfig ?? {}),
              triggers: { ...defaultWc.triggers, ...((val.wakeConfig?.triggers) ?? {}) }
            },
            recentMessages: Array.isArray(val.recentMessages) ? val.recentMessages : [],
            unread: Array.isArray(val.unread) ? val.unread : [],
            lastWakeReason: String(val.lastWakeReason ?? ''),
            lastAiReplyAt: Number(val.lastAiReplyAt) || 0,
            lastAutoAt: Number(val.lastAutoAt) || 0,
            autoAtTimes: Array.isArray(val.autoAtTimes) ? val.autoAtTimes.slice(-100) : [],
            pendingWakeReasons: Array.isArray(val.pendingWakeReasons)
              ? val.pendingWakeReasons.filter(r => r && typeof r === 'object').slice(-20)
              : [],
            answeredSeqs: Array.isArray(val.answeredSeqs)
              ? val.answeredSeqs.map(Number).filter(Number.isFinite).slice(-200)
              : [],
            lastActionAt: Number(val.lastActionAt) || 0,
            agentToken,
            bootstrapSent: !!val.bootstrapSent,
            wakeTimes: Array.isArray(val.wakeTimes) ? val.wakeTimes : [],
            sendTimes: Array.isArray(val.sendTimes) ? val.sendTimes : [],
            stickerCollectTimes: Array.isArray(val.stickerCollectTimes) ? val.stickerCollectTimes : [],
            crawlTimes: Array.isArray(val.crawlTimes) ? val.crawlTimes : [],
            stickerAddTimes: Array.isArray(val.stickerAddTimes) ? val.stickerAddTimes : [],
            // 表情包主动要求的频率账（与 saveSocialV2State 的白名单成对出现：
            // 只存不读 = 重启后限制失效；只读不存 = 一直为 0，等于没限制）
            lastStickerAt: Number(val.lastStickerAt) || 0,
            recentStickers: Array.isArray(val.recentStickers) ? val.recentStickers : [],
            stickerNudgeTimes: Array.isArray(val.stickerNudgeTimes) ? val.stickerNudgeTimes : [],
            pendingWakeMessage: (val.pendingWakeMessage && typeof val.pendingWakeMessage === 'object')
              ? val.pendingWakeMessage
              : null,
            pendingWakeTimer: null,
            sleepTimer: null,
            replyCheckTimer: null,
            proactiveTimer: null,
            lastIncomingAt: Number(val.lastIncomingAt) || 0,
            // 管理员身份判定依赖这两个字段（isOwnerTurn）。
            // 原来**只存不读**：重启后 lastRequesterId 恒为空，管理员的所有
            // 写操作（删表情等）都会被判成"不是管理员"——这本身就让人以为
            // "删不掉"。现在补上读取，并加了 ownerSpokeAt 时间窗。
            lastRequesterId: String(val.lastRequesterId || ''),
            lastRequesterRole: String(val.lastRequesterRole || ''),
            ownerSpokeAt: Number(val.ownerSpokeAt) || 0,
            preSleepWaitSatisfiedAt: Number(val.preSleepWaitSatisfiedAt) || 0,
            preSleepWaitObservedAt: Number(val.preSleepWaitObservedAt) || 0,
            preSleepWaitAccumMs: Number(val.preSleepWaitAccumMs) || 0,
            lastComplyRollAt: Number(val.lastComplyRollAt) || 0,
            pendingComply: (val.pendingComply && typeof val.pendingComply === 'object') ? val.pendingComply : null,
            complyTimes: Array.isArray(val.complyTimes) ? val.complyTimes : [],
            lastUnreadSeq: Number(val.lastUnreadSeq) || 0,
            wakeSeqAt: Number(val.wakeSeqAt) || 0,
            activeTopics: Array.isArray(val.activeTopics) ? val.activeTopics : [],
            pendingThoughts: Array.isArray(val.pendingThoughts) ? val.pendingThoughts : [],
            memberImpressions: (() => {
              const rawImp = (val.memberImpressions && typeof val.memberImpressions === 'object') ? val.memberImpressions : {};
              const clean = {};
              for (const [k, v] of Object.entries(rawImp)) {
                if (['__proto__', 'constructor', 'prototype'].includes(k)) continue;
                clean[k] = v;
              }
              return clean;
            })()
          };
          // 旧状态没有 answeredSeqs：把“上次发过言之前”的未读视为历史已答，
          // 避免升级后突然把所有旧 @ 都当成待回复；比 lastAiReplyAt 新的仍保持待答。
          if (!Array.isArray(val.answeredSeqs)) {
            st.answeredSeqs = (st.unread || [])
              .filter((m) => m && !m.isSelf && Number(m.time) && st.lastAiReplyAt
                && Number(m.time) <= st.lastAiReplyAt + 5000)
              .map((m) => Number(m.seq))
              .filter(Number.isFinite)
              .slice(-200);
          }
          // 旧状态/异常状态里的指定成员名单也统一归一化，防止“null”/非法值污染。
          if (st.wakeConfig?.triggers && typeof st.wakeConfig.triggers === 'object') {
            st.wakeConfig.triggers.speakerIds = normalizeSpeakerIdsV2(st.wakeConfig.triggers.speakerIds);
            if (key.startsWith('private:')) st.wakeConfig.triggers.speakerIds = [];
          }
          // 仍使用默认唤醒配置的会话，在重启加载时同步到当前推荐/默认参数。
          refreshDefaultWakeConfigV2(st);
          KNOWN_AGENT_TOKENS.add(st.agentToken);
          socialV2.conversations.set(key, st);
          // 重启后从已持久化的消息与 seenForwardIds 字段重建“本会话见过的 forward id”
          {
            const rebuilt = new Set();
            if (Array.isArray(val.seenForwardIds)) {
              for (const fid of val.seenForwardIds) {
                const safe = sanitizeForwardId(fid);
                if (safe) rebuilt.add(safe);
              }
            }
            for (const m of [...(st.recentMessages || []), ...(st.unread || [])]) {
              if (Array.isArray(m?.forwardIds)) {
                for (const fid of m.forwardIds) {
                  const safe = sanitizeForwardId(fid);
                  if (safe) rebuilt.add(safe);
                }
              }
            }
            if (rebuilt.size) seenForwardIds.set(key, rebuilt);
          }
          ensureWakeableV2(st, { skipSave: true, key });
          scheduleProactiveCheckV2(key);
        }
        // 加载阶段统一落盘一次，避免 ensureWakeableV2 中途写盘覆盖未加载会话。
        saveSocialV2State();
      }
    } catch (error) {
      log('读取 socialV2 状态失败:', error?.message ?? error);
    }
  }

  function saveSocialV2State() {
    try {
      const obj = { paused: socialV2.paused, conversations: Object.create(null) };
      for (const [key, st] of socialV2.conversations) {
        obj.conversations[key] = {
          wakeConfig: st.wakeConfig,
          recentMessages: st.recentMessages.slice(-200),
          unread: st.unread.slice(-100),
          lastWakeReason: st.lastWakeReason,
          lastAiReplyAt: st.lastAiReplyAt,
          answeredSeqs: Array.isArray(st.answeredSeqs) ? st.answeredSeqs.slice(-200) : [],
          lastActionAt: st.lastActionAt,
          agentToken: st.agentToken,
          bootstrapSent: st.bootstrapSent,
          wakeTimes: st.wakeTimes.slice(-200),
          sendTimes: st.sendTimes.slice(-500),
          stickerCollectTimes: Array.isArray(st.stickerCollectTimes) ? st.stickerCollectTimes.slice(-500) : [],
          crawlTimes: Array.isArray(st.crawlTimes) ? st.crawlTimes.slice(-200) : [],
          stickerAddTimes: Array.isArray(st.stickerAddTimes) ? st.stickerAddTimes.slice(-200) : [],
          lastIncomingAt: st.lastIncomingAt || 0,
          // 最近一条入站消息的发送者：管理员专属工具据此判请求者身份。
          // ⚠️ 这个序列化是**白名单式**的（只写这里列举的字段）——
          // 新加会话字段时必须在这里补一行，否则赋值后会立刻丢失
          // （实测踩过：加了赋值但没加这行，文件里始终没有该字段）。
          lastRequesterId: st.lastRequesterId || '',
          lastRequesterRole: st.lastRequesterRole || '',
          // 管理员最后一次发言的时间：isOwnerTurn 的时间窗判据依赖它。
          // 不持久化的话重启后就没了，管理员刚下的命令会立刻失效。
          ownerSpokeAt: st.ownerSpokeAt || 0,
          preSleepWaitSatisfiedAt: st.preSleepWaitSatisfiedAt || 0,
          preSleepWaitObservedAt: st.preSleepWaitObservedAt || 0,
          preSleepWaitAccumMs: st.preSleepWaitAccumMs || 0,
          lastComplyRollAt: st.lastComplyRollAt || 0,
          pendingComply: st.pendingComply ?? null,
          complyTimes: Array.isArray(st.complyTimes) ? st.complyTimes.slice(-50) : [],
          lastUnreadSeq: st.lastUnreadSeq || 0,
          // 自动 @ 的额度：冷却与每小时上限都依赖它，必须持久化
          // （否则每次重启都清零，冷却失效 → 可能连着重启连着重启都 @）。
          lastAutoAt: st.lastAutoAt || 0,
          autoAtTimes: Array.isArray(st.autoAtTimes) ? st.autoAtTimes.slice(-100) : [],
          // 表情包主动要求的频率控制（2026-10-22）：
          //   stickerNudgeTimes = "要求过几次"（掷中即记，不论模型是否真发）
          //   lastStickerAt / recentStickers = "真发过"的时间与 id
          // 两笔账分开，是因为"掷中但模型跳过"不该占用真发出的间隔。
          // 不持久化的话每次重启频率限制清零 → 重启几次后可能连着刷表情。
          lastStickerAt: st.lastStickerAt || 0,
          recentStickers: Array.isArray(st.recentStickers) ? st.recentStickers.slice(-10) : [],
          stickerNudgeTimes: Array.isArray(st.stickerNudgeTimes) ? st.stickerNudgeTimes.slice(-100) : [],
          // 繁忙期间暂存的唤醒原因（内存里产生、回合结束后补发）。
          // 不持久化的话**回合中途重启就全丢**：典型场景是群里 @ 它、
          // 它正在处理上一轮 → 记进 pendingWakeReasons → 这时重启/崩溃 → @ 永远不回。
          // 启动补投只兜底"未读还没被 mark_read"的情况，救不了已被标记已读的那些。
          pendingWakeReasons: Array.isArray(st.pendingWakeReasons)
            ? st.pendingWakeReasons.filter((r) => r && typeof r === 'object').slice(-20)
            : [],
          // 繁忙期间触发消息的正文快照：队列里的 seq 会先于回合结束被未读窗口挤掉。
          pendingWakeMessage: (st.pendingWakeMessage && typeof st.pendingWakeMessage === 'object')
            ? st.pendingWakeMessage
            : null,
          // 必须持久化：回合跨重启时水位丢了会导致 mark_read 走保守清空分支，
          // 虽然安全但会清掉本轮刚到的未读，所以能存就存。
          wakeSeqAt: st.wakeSeqAt || 0,
          activeTopics: Array.isArray(st.activeTopics) ? st.activeTopics.slice(-50) : [],
          pendingThoughts: Array.isArray(st.pendingThoughts) ? st.pendingThoughts.slice(-50) : [],
          memberImpressions: st.memberImpressions && typeof st.memberImpressions === 'object' ? st.memberImpressions : {},
          seenForwardIds: Array.from(seenForwardIds.get(key) || []).slice(-1000)
        };
      }
      if (stateStore) stateStore.write(obj);
      else atomicWriteJson(SOCIAL_V2_FILE, obj);
    } catch (error) {
      log('保存 socialV2 状态失败:', error?.message ?? error);
    }
  }


  return { normalizeSpeakerIdsV2, defaultWakeConfigV2, refreshDefaultWakeConfigV2, refreshAllDefaultWakeConfigsV2, hasExplicitEndV2, isSleepingConfigV2, preSleepWaitBlockedV2, computeWakeSafetyV2, ensureWakeableV2, getSocialV2State, loadSocialV2State, saveSocialV2State };
}
