import { clearSessionTracking } from './pipeline/session-tracking.js';
// DSH 上下文超限的识别与恢复。
//
// 背景（2026-10-24 线上）：长寿命群会话的 DSH 历史会涨到模型上限以上，
// 例如实测 session-237cd418...：
//   turn 2575: prompt_too_long: 100001 tokens > 100000 maximum
//   turn 2688: prompt is too long: 1412836 tokens > 1048576 maximum
// 更糟的是 DSH 自己的 compaction/end 也报同一个错——压缩请求本身已经超限，
// 所以它不会自愈，后面每一轮都会继续失败。
//
// 桥接侧能做的不是改 DSH 的压缩器，而是**换掉中毒会话**：
//   1. 摘掉 state.sessions / reverse 里的旧 sessionId；
//   2. 保留 bridge 侧的社交记忆（recentMessages / episodes / 长期记忆），
//      这样新会话仍有人格与上下文；
//   3. 用新会话重投一次当前唤醒；失败就通知管理员并停止，避免无限重试；
//   4. 同一会话加冷却，防止反复轮换。
//
// 本模块只做“判定 + 恢复编排”，真正摘除 bridge 内部 Map 的动作通过
// createContextRecovery(deps) 注入，便于离线测试。
const CONTEXT_OVERFLOW_RE = /CONTEXT_WINDOW_EXCEEDED|context_length_exceeded|prompt_too_long|prompt is too long|request context exceeds the model'?s limit/i;

/**
 * 是否是“上下文超过模型上限”类错误。
 *
 * 只认 DSH/网关的明确错误码或固定文案，不做泛化的 /context/ 匹配——
 * 否则正常的 `request/context` 事件、压缩摘要日志都会被误判。
 */
export function isContextOverflowError(raw) {
  return CONTEXT_OVERFLOW_RE.test(String(raw ?? ''));
}

/**
 * T4：是否该主动轮换。estimatedTokens 是最后一次请求的 input+cacheRead，
 * 达到 modelLimitTokens × rotateAtRatio 就提前换会话。
 */
export function shouldRotateProactive(estimatedTokens, { rotateAtRatio = 0.7, modelLimitTokens = 1048576 } = {}) {
  const est = Number(estimatedTokens) || 0;
  const ratio = Number(rotateAtRatio) > 0 ? Number(rotateAtRatio) : 0.7;
  const limit = Number(modelLimitTokens) > 0 ? Number(modelLimitTokens) : 1048576;
  return est > 0 && est >= limit * ratio;
}

/**
 * 创建上下文超限恢复器。
 *
 * deps:
 *   rotateSession(key, oldSessionId)  摘除旧会话映射与 session 级状态（同步）
 *   buildWakePrompt(key)              重新构造一条紧凑唤醒提示（同步）
 *   deliverPrompt(key, prompt)        投递到新会话（返回 Promise<{ok,...}>）
 *   notifyOwnerOfError(key, title, detail, extra)  私聊管理员
 *   appendActivity(line)              活动流
 *   log(...)                          日志
 *   cooldownMs / retryDelayMs / now   可选，测试用
 */
export function createContextRecovery(deps) {
  const required = ['rotateSession', 'buildWakePrompt', 'deliverPrompt', 'notifyOwnerOfError', 'appendActivity', 'log'];
  for (const name of required) {
    if (typeof deps?.[name] !== 'function') throw new Error(`context-recovery: 缺少依赖 ${name}()`);
  }
  const cooldownMs = Number.isFinite(Number(deps.cooldownMs)) && Number(deps.cooldownMs) >= 0
    ? Number(deps.cooldownMs)
    : 30 * 60 * 1000;
  const retryDelayMs = Number.isFinite(Number(deps.retryDelayMs)) && Number(deps.retryDelayMs) >= 0
    ? Number(deps.retryDelayMs)
    : 1000;
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const lastRecoveryAt = new Map(); // key -> timestamp

  /**
   * 处理一次上下文超限。
   * @returns {Promise<{handled:boolean, retried:boolean, reason?:string}>}
   */
  async function recover({ key, sessionId, error, mode, silent = false }) {
    const detail = String(error ?? '');
    const at = now();
    const prev = lastRecoveryAt.get(key) ?? 0;
    if (at - prev < cooldownMs) {
      const left = Math.ceil((cooldownMs - (at - prev)) / 1000);
      deps.log(`[上下文] ${key} 上下文超限，但恢复冷却中（${left}s），跳过重复轮换`);
      deps.notifyOwnerOfError(key, '上下文超限（恢复冷却中）', detail, {
        sessionId,
        说明: '本轮不再重复轮换/重试，避免死循环'
      });
      return { handled: true, retried: false, reason: 'cooldown' };
    }
    lastRecoveryAt.set(key, at);

    // 先摘掉旧会话：即使后面重建提示失败，也不能继续把新消息投给中毒会话。
    deps.rotateSession(key, sessionId);
    deps.appendActivity(`${key} [上下文] 会话上下文超限，已轮换会话`);

    const canRetry = mode === 'reserved2' && silent !== true;
    if (!canRetry) {
      const why = silent ? '静默回合' : `模式 ${mode || '未知'}`;
      deps.log(`[上下文] ${key} 上下文超限，已轮换会话（${why}，不重试）`);
      deps.notifyOwnerOfError(key, '上下文超限，已自动轮换会话', detail, {
        sessionId,
        说明: `${why}不自动重试；下一轮正常唤醒会使用新会话`
      });
      return { handled: true, retried: false, reason: silent ? 'silent' : 'mode' };
    }

    let prompt;
    try {
      prompt = deps.buildWakePrompt(key);
    } catch (buildError) {
      deps.log(`[上下文] ${key} 重建唤醒提示失败：${buildError?.message ?? buildError}`);
      deps.notifyOwnerOfError(key, '上下文超限：重建唤醒提示失败', String(buildError?.message ?? buildError), {
        sessionId,
        说明: '旧会话已摘除；下一轮正常唤醒会尝试新建会话'
      });
      return { handled: true, retried: false, reason: 'build-failed' };
    }

    deps.notifyOwnerOfError(key, '上下文超限，已自动轮换会话', detail, {
      sessionId,
      说明: '旧会话历史超过模型上限，已换新会话并重试一次；群友侧无需操作'
    });
    deps.log(`[上下文] ${key} 上下文超限，已轮换会话，${retryDelayMs}ms 后重试一次唤醒（${prompt.length} 字符）`);

    setTimeout(() => {
      Promise.resolve()
        .then(() => deps.deliverPrompt(key, prompt))
        .then((result) => {
          if (result && result.ok === false) {
            deps.log(`[上下文] ${key} 轮换后重试仍失败：${result.error || '未知错误'}`);
            deps.notifyOwnerOfError(key, '上下文超限：轮换后重试仍失败', String(result.error ?? ''), {
              sessionId,
              说明: '新会话仍投递失败，请检查 DSH/网关状态'
            });
          }
        })
        .catch((error) => {
          deps.log(`[上下文] ${key} 轮换后重试异常：${error?.message ?? error}`);
          deps.notifyOwnerOfError(key, '上下文超限：轮换后重试异常', String(error?.message ?? error), { sessionId });
        });
    }, retryDelayMs);

    return { handled: true, retried: true };
  }

  /**
   * T4：主动轮换。预估上下文接近模型上限（60~70%）时提前换会话，
   * 不等到 prompt_too_long。只轮换、不重投、不通知管理员（不是错误）；
   * 与 recover 共用冷却，避免同一会话反复轮换。
   * @returns {Promise<{rotated:boolean, reason?:string}>}
   */
  async function rotateProactive({ key, sessionId, estimatedTokens = 0 } = {}) {
    const at = now();
    const prev = lastRecoveryAt.get(key) ?? 0;
    if (at - prev < cooldownMs) {
      deps.log(`[上下文] ${key} 主动轮换冷却中，跳过（预估 ${estimatedTokens} tokens）`);
      return { rotated: false, reason: 'cooldown' };
    }
    lastRecoveryAt.set(key, at);
    deps.rotateSession(key, sessionId);
    deps.appendActivity(`${key} [上下文] 预估 ${Math.round(Number(estimatedTokens) / 1000)}k tokens 接近模型上限，提前轮换会话`);
    deps.log(`[上下文] ${key} 主动轮换会话（estimatedTokens=${estimatedTokens}）`);
    return { rotated: true };
  }

  return { recover, rotateProactive, isContextOverflowError };
}

// 只摘 session 级状态，保留群聊记忆；独立导出以直接验证轮换行为。
export function rotateContextSession(deps, key, oldSessionId) {
  const {
    state, reverse, sessionPromises, pending,
    cancelPendingEntry, saveState, log, bumpSessionEpoch, recordSessionHistory
  } = deps;
  // 先记映射历史再摘状态：中间崩溃时宁可多一条历史，也不能让旧会话的
  // token 消耗失去归属（历史是累计口径的唯一来源）。
  try { recordSessionHistory?.(oldSessionId, key, 'rotate'); } catch {}
  if (state.sessions[key] === oldSessionId) {
    delete state.sessions[key];
    if (state.sessionMeta) delete state.sessionMeta[key];
    saveState();
  }
  if (reverse.get(oldSessionId) === key) reverse.delete(oldSessionId);
  clearSessionTracking(deps, oldSessionId);
  sessionPromises.delete(key);
  const pe = pending.get(key);
  if (pe && pe.sessionId === oldSessionId) {
    clearTimeout(pe.timer);
    pending.delete(key);
    cancelPendingEntry(pe).catch(() => {});
  }
  // 让任何在途的 ensureSession 结果作废，避免旧会话被重新挂回。
  bumpSessionEpoch();
  log(`[上下文] ${key} 会话 ${oldSessionId} 上下文超限，已摘除映射；bridge 侧社交记忆保留`);
}
