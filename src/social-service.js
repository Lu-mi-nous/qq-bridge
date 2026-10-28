// 社交唤醒调度（R3-2）：唤醒合并窗口、回复检查、有限睡眠与主动机会。
//
// 只负责「什么时候该唤醒」；真正投递 prompt 仍由 bridge 的 sendWakePromptV2 完成。
// 所有状态、配置、发送与忙碌判断都显式注入，便于测试与后续继续拆分。
import { wakePriorityV2 } from './pipeline/wake.js';

const MAX_TIMEOUT_MS = 2147483647;

export function createSocialService({
  cfg,
  socialV2,
  getState,
  getMode,
  isSessionAllowed,
  isBusy,
  isFused,
  queuePendingWakeReason,
  ensureWakeable,
  sendWakePrompt,
  appendActivity = () => {},
  log = () => {},
  now = Date.now,
  random = Math.random,
  setTimer = setTimeout,
  clearTimer = clearTimeout
} = {}) {
  if (!cfg || !socialV2) throw new Error('createSocialService: cfg/socialV2 不能为空');
  if (typeof getState !== 'function') throw new Error('createSocialService: getState 不能为空');

  function enabled() {
    return cfg.socialV2?.enabled !== false;
  }

  function paused() {
    return socialV2.paused === true;
  }

  function cancelReplyCheck(key) {
    const st = socialV2.conversations.get(key);
    if (!st || !st.replyCheckTimer) return;
    clearTimer(st.replyCheckTimer);
    st.replyCheckTimer = null;
  }

  function scheduleReplyCheck(key) {
    if (!enabled()) return;
    if (paused() || getMode() !== 'reserved2') return;
    const st = getState(key);
    if (st.pendingWakeTimer || st.sleepTimer || st.replyCheckTimer) return;
    let delay = Math.max(1000, Number(cfg.socialV2?.autoReplyCheckMs) || 30000);
    const recent = Array.isArray(st.recentMessages) ? st.recentMessages : [];
    const recentSelf = recent.filter((m) => m && m.isSelf && now() - Number(m.time || 0) < 15000);
    const askedQuestion = recentSelf.some((m) => /[?？吗呢怎么有没有能不能]/.test(String(m.text || m.plain || '')));
    if (askedQuestion) delay = Math.round(delay * 1.5);
    if (recentSelf.length >= 3) delay = Math.round(delay * 1.3);
    // T1：记录排程时刻，到时只对「这之后到达的未读」唤醒。
    const since = now();
    st.replyCheckTimer = setTimer(() => {
      st.replyCheckTimer = null;
      // T1：没人接话时不再无条件叫醒模型（那是一次纯浪费的模型调用）。
      // 已经有别的唤醒在排队/睡眠定时器时也跳过，避免一条消息两次唤醒。
      const fresh = getState(key);
      if (fresh.pendingWakeTimer || fresh.sleepTimer) {
        log(`[reserved2] 回复检查 ${key}：已有待处理唤醒，跳过`);
        return;
      }
      const unread = Array.isArray(fresh.unread) ? fresh.unread : [];
      const hasNew = unread.some((m) => Number(m?.time || 0) >= since);
      if (!hasNew) {
        log(`[reserved2] 回复检查 ${key}：无新消息，跳过唤醒`);
        return;
      }
      void sendWakePrompt(key, 'replyCheck').catch((error) => log(`[reserved2] replyCheck 唤醒异常 ${key}:`, error?.message ?? error));
    }, delay);
    st.replyCheckTimer.unref?.();
    log(`[reserved2] 已安排回复检查唤醒 ${key}，${Math.round(delay / 1000)}s 后检查`);
  }

  function scheduleStartupBackfill() {
    if (!enabled() || paused()) return;
    const pending = [];
    for (const [key, st] of socialV2.conversations) {
      const unread = Array.isArray(st.unread) ? st.unread.length : 0;
      if (!unread) continue;
      if (!isSessionAllowed(key)) continue;
      pending.push({ key, unread });
    }
    if (!pending.length) return;
    log(`[reserved2] 启动补投：${pending.length} 个会话有积压未读（${pending.map((p) => `${p.key}×${p.unread}`).join('、')}）`);
    pending.forEach((p, i) => {
      const delay = 6000 + i * 6000;
      setTimer(() => {
        const st = socialV2.conversations.get(p.key);
        if (!st) return;
        if (!isBusy(p.key, st)) {
          log(`[reserved2] 启动补投唤醒 ${p.key}（积压 ${p.unread} 条未读）`);
          scheduleWake(p.key, 'startupBackfill');
        } else {
          log(`[reserved2] 启动补投跳过 ${p.key}（会话正忙）`);
        }
      }, delay).unref?.();
    });
  }

  function scheduleWake(key, reason) {
    if (!enabled() || paused()) return;
    if (!isSessionAllowed(key)) {
      log(`[reserved2] 跳过计划唤醒 ${key}（${reason}）：会话已不在当前模式允许范围内`);
      return;
    }
    if (isFused(key)) {
      log(`[Token熔断] 跳过计划唤醒 ${key}（${reason}）：会话已熔断`);
      appendActivity(`${key} [Token] 熔断中，已跳过计划唤醒（${reason}）`);
      return;
    }
    const st = getState(key);
    if (st.pendingWakeTimer) {
      const cur = st.pendingWakeReason || reason;
      if (wakePriorityV2(reason) > wakePriorityV2(cur)) {
        st.pendingWakeReason = reason;
        log(`[reserved2] 合并窗口内升级唤醒原因 ${key}: ${cur} -> ${reason}`);
      }
      return;
    }
    if (isBusy(key, st)) {
      const seq = st.lastUnreadSeq || 0;
      queuePendingWakeReason(st, key, reason, seq);
      log(`[reserved2] 会话繁忙，暂存唤醒原因 ${key}（${reason}@seq${seq}）`);
      return;
    }
    cancelReplyCheck(key);
    if (st.sleepTimer) {
      clearTimer(st.sleepTimer);
      st.sleepTimer = null;
    }
    st.pendingWakeReason = reason;
    const batchMsDefault = Math.max(1000, Number(st.wakeConfig?.batchWindowMs) || 8000);
    const isHighPriority = wakePriorityV2(reason) >= 80;
    const batchMs = isHighPriority ? Math.min(batchMsDefault, 1500) : batchMsDefault;
    st.pendingWakeTimer = setTimer(() => {
      st.pendingWakeTimer = null;
      const finalReason = st.pendingWakeReason || reason;
      st.pendingWakeReason = null;
      void sendWakePrompt(key, finalReason).catch((error) => log(`[reserved2] 计划唤醒异常 ${key}:`, error?.message ?? error));
    }, batchMs);
    log(`[reserved2] 计划唤醒 ${key}（${reason}），${Math.round(batchMs / 1000)}s 后发送${isHighPriority && batchMs < batchMsDefault ? '（高优先级，已缩短等待）' : ''}`);
  }

  function setupSleepTimer(key) {
    if (!enabled() || !isSessionAllowed(key)) return;
    const st = getState(key);
    cancelReplyCheck(key);
    if (st.sleepTimer) {
      clearTimer(st.sleepTimer);
      st.sleepTimer = null;
    }
    if (paused()) return;
    const wc = st.wakeConfig;
    if (!wc || wc.infinite || !wc.sleepUntil) return;
    const until = Date.parse(wc.sleepUntil);
    if (!Number.isFinite(until)) return;
    const delay = until - now();
    if (delay <= 0) {
      void sendWakePrompt(key, 'timeout').catch((error) => log(`[reserved2] 睡眠到期唤醒异常 ${key}:`, error?.message ?? error));
      return;
    }
    if (delay > MAX_TIMEOUT_MS) {
      st.sleepTimer = setTimer(() => {
        st.sleepTimer = null;
        setupSleepTimer(key);
      }, MAX_TIMEOUT_MS);
      st.sleepTimer.unref?.();
      log(`[reserved2] 设置远未来有限潜水定时器 ${key}，首段 ${Math.round(MAX_TIMEOUT_MS / 86400000)} 天后续期`);
      return;
    }
    st.sleepTimer = setTimer(() => {
      st.sleepTimer = null;
      void sendWakePrompt(key, 'timeout').catch((error) => log(`[reserved2] 睡眠到期唤醒异常 ${key}:`, error?.message ?? error));
    }, delay);
    st.sleepTimer.unref?.();
    log(`[reserved2] 设置有限潜水定时器 ${key}，剩余 ${Math.round(delay / 1000)}s`);
  }

  function cancelProactiveCheck(key) {
    const st = socialV2.conversations.get(key);
    if (!st || !st.proactiveTimer) return;
    clearTimer(st.proactiveTimer);
    st.proactiveTimer = null;
  }

  function scheduleProactiveCheck(key) {
    if (cfg.socialV2?.proactive?.enabled === false) return;
    if (paused() || getMode() !== 'reserved2') return;
    if (!isSessionAllowed(key)) return;
    const st = getState(key);
    if (st.proactiveTimer) return;
    const p = cfg.socialV2?.proactive ?? {};
    const min = Math.max(60 * 1000, Number(p.checkIntervalMinMs) || 30 * 60 * 1000);
    const max = Math.max(min, Number(p.checkIntervalMaxMs) || 90 * 60 * 1000);
    const delay = Math.floor(min + random() * (max - min));
    st.proactiveTimer = setTimer(() => {
      st.proactiveTimer = null;
      ensureWakeable(st, { key });
      const idleThreshold = Number(p.idleThresholdMs) || 15 * 60 * 1000;
      const idle = now() - (st.lastIncomingAt || 0);
      const probBase = Number(p.probability);
      let prob = Math.min(1, Math.max(0, Number.isFinite(probBase) ? probBase : 0.4));
      const pendingThoughts = Array.isArray(st.pendingThoughts) ? st.pendingThoughts.filter((t) => t && (!t.expiresAt || now() < Number(t.expiresAt))).length : 0;
      if (pendingThoughts > 0) prob = Math.min(1, prob * 1.4);
      if (st.lastAiReplyAt && now() - Number(st.lastAiReplyAt) < 30 * 60 * 1000) prob *= 0.5;
      const hour = new Date(now()).getHours();
      if (hour >= 23 || hour < 8) prob *= 0.3;
      const recent = Array.isArray(st.recentMessages) ? st.recentMessages : [];
      const aiCount = recent.filter((m) => m && m.isSelf && now() - Number(m.time || 0) < 60 * 60 * 1000).length;
      if (aiCount >= 5) prob *= 0.3;
      if (idle >= idleThreshold && random() < prob && !isBusy(key, st)) {
        void sendWakePrompt(key, 'proactiveCheck').catch((error) => log(`[reserved2] proactive 唤醒异常 ${key}:`, error?.message ?? error));
      }
      scheduleProactiveCheck(key);
    }, delay);
    st.proactiveTimer.unref?.();
    log(`[reserved2] 已安排主动机会检查 ${key}，约 ${Math.round(delay / 60000)}min 后`);
  }

  function clearTimers(key) {
    const st = socialV2.conversations.get(key);
    if (!st) return;
    if (st.pendingWakeTimer) { clearTimer(st.pendingWakeTimer); st.pendingWakeTimer = null; }
    st.pendingWakeReason = null;
    if (st.sleepTimer) { clearTimer(st.sleepTimer); st.sleepTimer = null; }
    if (st.replyCheckTimer) { clearTimer(st.replyCheckTimer); st.replyCheckTimer = null; }
    if (st.proactiveTimer) { clearTimer(st.proactiveTimer); st.proactiveTimer = null; }
    if (Array.isArray(st.pendingWakeReasons)) st.pendingWakeReasons.length = 0;
  }

  function clearAllTimers() {
    for (const key of socialV2.conversations.keys()) clearTimers(key);
  }

  return {
    cancelReplyCheck,
    scheduleReplyCheck,
    scheduleStartupBackfill,
    scheduleWake,
    setupSleepTimer,
    cancelProactiveCheck,
    scheduleProactiveCheck,
    clearTimers,
    clearAllTimers
  };
}
