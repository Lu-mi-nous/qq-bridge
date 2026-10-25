// 会话级 Token 熔断（二期 F1）：按自然日累计每个 QQ 会话的用量。
//
// 背景：会话级报表实测消耗高度集中（单个群三天 3.68B，占 46%）。一旦某个群
// 进入「高频唤醒 + 巨大会话历史」的循环，目前没有闸门能拦住。这里在事件流里
// 增量累计，达到 warn/fuse 阈值后由 bridge 的唤醒闸门拦截自动行为。
//
// 口径：默认按「总输入（含缓存）」累计，因为实测 96% 是缓存读，熔断要拦的正是
// 巨大会话历史反复重喂；未缓存可配第二阈值。计数是内存 + 每 5 分钟落盘，
// 重启保留当天状态；自然日（上海时区）切换自动归零。
import fs from 'node:fs';
import path from 'node:path';
import { dayKey, humanTokens } from './token-usage.js';

export const DEFAULT_TOKEN_FUSE = Object.freeze({
  enabled: false,
  warnTokens: 1_000_000_000,
  fuseTokens: 2_000_000_000,
  fuseUncachedTokens: 300_000_000,
  resetOnNewDay: true
});

const FILE_NAME = 'token-fuse-state.json';

function clampInt(raw, dflt, min, max) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.round(n)));
}

export function normalizeTokenFuseOverride(raw = {}) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = {};
  for (const k of ['warnTokens', 'fuseTokens', 'fuseUncachedTokens']) {
    const n = Number(src[k]);
    if (Number.isFinite(n)) out[k] = Math.min(1e15, Math.max(0, Math.round(n)));
  }
  return out;
}

export function normalizeTokenFuseConfig(raw = {}) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const overrides = {};
  for (const [key, value] of Object.entries(src.overrides || {})) {
    if (!/^(group|private):\d+$/.test(key)) continue;
    const o = normalizeTokenFuseOverride(value);
    if (Object.keys(o).length) overrides[key] = o;
  }
  return {
    enabled: src.enabled === true,
    warnTokens: clampInt(src.warnTokens, DEFAULT_TOKEN_FUSE.warnTokens, 0, 1e15),
    fuseTokens: clampInt(src.fuseTokens, DEFAULT_TOKEN_FUSE.fuseTokens, 0, 1e15),
    fuseUncachedTokens: clampInt(src.fuseUncachedTokens, DEFAULT_TOKEN_FUSE.fuseUncachedTokens, 0, 1e15),
    resetOnNewDay: src.resetOnNewDay !== false,
    overrides
  };
}

/** 某会话的生效阈值：per-key 覆盖优先，缺省回退全局。 */
export function effectiveTokenFuseThresholds(config, key) {
  const c = normalizeTokenFuseConfig(config);
  const o = c.overrides[String(key)] || {};
  return {
    warnTokens: o.warnTokens ?? c.warnTokens,
    fuseTokens: o.fuseTokens ?? c.fuseTokens,
    fuseUncachedTokens: o.fuseUncachedTokens ?? c.fuseUncachedTokens,
    overridden: !!c.overrides[String(key)]
  };
}

export function tokenFuseFile(stateDir) {
  return path.join(stateDir, FILE_NAME);
}

function emptyState(day = '') {
  return { version: 1, day, keys: {} };
}

function normalizeBucket(v) {
  const src = v && typeof v === 'object' ? v : {};
  const state = ['warn', 'fused'].includes(src.state) ? src.state : 'normal';
  return {
    totalInput: Math.max(0, Number(src.totalInput) || 0),
    uncached: Math.max(0, Number(src.uncached) || 0),
    calls: Math.max(0, Math.round(Number(src.calls) || 0)),
    state,
    warnedAt: Number(src.warnedAt) || 0,
    fusedAt: Number(src.fusedAt) || 0,
    fusedNotifiedAt: Number(src.fusedNotifiedAt) || 0,
    resetAt: Number(src.resetAt) || 0
  };
}

export function loadTokenFuseState(stateDir) {
  let data;
  try {
    let text = fs.readFileSync(tokenFuseFile(stateDir), 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    data = JSON.parse(text);
  } catch {
    return emptyState();
  }
  if (!data || typeof data !== 'object') return emptyState();
  const out = emptyState(String(data.day || ''));
  for (const [key, bucket] of Object.entries(data.keys || {})) {
    if (!/^(group|private):\d+$/.test(key)) continue;
    out.keys[key] = normalizeBucket(bucket);
  }
  return out;
}

export function saveTokenFuseState(stateDir, state) {
  const file = tokenFuseFile(stateDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * @param {object} deps
 * - stateDir
 * - getConfig(): socialV2.tokenFuse 原始配置
 * - resolveKey(sessionId): sessionId → QQ key（当前/历史映射）
 * - notifyOwner(key,title,detail,extra)：只私聊管理员
 * - appendActivity(line)
 * - log(...)
 */
export function createTokenFuse({
  stateDir,
  getConfig = () => ({}),
  resolveKey = () => '',
  notifyOwner = () => {},
  appendActivity = () => {},
  log = () => {},
  now = Date.now,
  saveIntervalMs = 5 * 60 * 1000
} = {}) {
  let state = loadTokenFuseState(stateDir);
  let lastSaveAt = 0;
  let dirty = false;

  function cfg() {
    return normalizeTokenFuseConfig(getConfig());
  }

  function ensureDay() {
    const c = cfg();
    const day = dayKey(now());
    if (!day) return;
    if (c.resetOnNewDay && state.day !== day) {
      state = emptyState(day);
      dirty = true;
      log(`[Token熔断] 跨天重置为 ${day}`);
    } else if (!state.day) {
      state.day = day;
      dirty = true;
    }
  }

  function save(force = false) {
    if (!force && !dirty) return;
    try {
      saveTokenFuseState(stateDir, state);
      dirty = false;
      lastSaveAt = now();
    } catch (error) {
      log(`[Token熔断] 状态落盘失败：${error?.message ?? error}`);
    }
  }

  function bucketOf(key) {
    let b = state.keys[key];
    if (!b) {
      b = normalizeBucket({});
      state.keys[key] = b;
    }
    return b;
  }

  function evaluate(key, b, c) {
    const before = b.state;
    const overFuse = (c.fuseTokens > 0 && b.totalInput >= c.fuseTokens)
      || (c.fuseUncachedTokens > 0 && b.uncached >= c.fuseUncachedTokens);
    const overWarn = c.warnTokens > 0 && b.totalInput >= c.warnTokens;
    if (overFuse) b.state = 'fused';
    else if (overWarn) b.state = 'warn';
    if (b.state === before) return;
    if (b.state === 'warn') {
      if (!b.warnedAt) {
        b.warnedAt = now();
        notifyOwner(key, 'Token 用量提醒', `今日总输入 ${humanTokens(b.totalInput)}（未缓存 ${humanTokens(b.uncached)}）已达提醒阈值 ${humanTokens(c.warnTokens)}；自动唤醒仍继续，达到熔断阈值会停止。`, {
          会话: key,
          说明: '这是会话级 Token 熔断的预警，不影响群友当前聊天'
        });
        appendActivity(`${key} [Token] 用量提醒：${humanTokens(b.totalInput)} / ${humanTokens(c.warnTokens)}`);
        log(`[Token熔断] ${key} 进入 warn：${humanTokens(b.totalInput)}`);
      }
    } else if (b.state === 'fused') {
      if (!b.fusedNotifiedAt) {
        b.fusedNotifiedAt = now();
        b.fusedAt = b.fusedAt || now();
        notifyOwner(key, 'Token 已熔断', `今日总输入 ${humanTokens(b.totalInput)}（未缓存 ${humanTokens(b.uncached)}）已达熔断阈值；该会话的自动唤醒与 B 站自主刷已停止。管理员私聊、控制台手动唤醒/手动刷不受影响。解除：控制台 16 卡或 /tf off ${key}`, {
          会话: key,
          说明: '熔断只停自动行为，群里不会收到任何提示'
        });
        appendActivity(`${key} [Token] 已熔断：${humanTokens(b.totalInput)}`);
        log(`[Token熔断] ${key} 进入 fused：${humanTokens(b.totalInput)}`);
      }
    }
    save(true);
  }

  /**
   * 处理一条 assistant/message 的 usage。只统计 assistant/message（最终汇总），
   * 不统计 assistant/chunk，避免同一份 usage 在流式增量里重复。
   */
  function recordUsage(sessionId, usage) {
    const c = cfg();
    if (!c.enabled) return null;
    ensureDay();
    const key = String(resolveKey(sessionId) || '');
    if (!/^(group|private):\d+$/.test(key)) return null;
    const input = Number(usage?.inputTokens ?? usage?.prompt_tokens ?? 0) || 0;
    const cacheRead = Number(usage?.cacheReadTokens ?? usage?.cache_read_input_tokens ?? 0) || 0;
    const totalInput = input + cacheRead;
    if (!totalInput) return null;
    const b = bucketOf(key);
    b.totalInput += totalInput;
    b.uncached += input;
    b.calls += 1;
    dirty = true;
    evaluate(key, b, effectiveTokenFuseThresholds(c, key));
    if (now() - lastSaveAt > saveIntervalMs) save();
    return { ...b };
  }

  function isFused(key) {
    const c = cfg();
    if (!c.enabled) return false;
    ensureDay();
    return state.keys[String(key)]?.state === 'fused';
  }

  function status() {
    ensureDay();
    const c = cfg();
    const keys = Object.entries(state.keys)
      .map(([key, b]) => ({ key, ...b, ...effectiveTokenFuseThresholds(c, key) }))
      .sort((a, b) => b.totalInput - a.totalInput);
    return {
      day: state.day,
      enabled: c.enabled,
      config: c,
      keys,
      fused: keys.filter((x) => x.state === 'fused').length,
      warn: keys.filter((x) => x.state === 'warn').length
    };
  }

  function resetKey(key) {
    ensureDay();
    const k = String(key || '');
    if (!state.keys[k]) return false;
    state.keys[k] = normalizeBucket({ state: 'normal', resetAt: now() });
    dirty = true;
    save(true);
    log(`[Token熔断] ${k} 已解除`);
    return true;
  }

  function sweep() {
    ensureDay();
    save();
  }

  function flush() {
    save(true);
  }

  return { recordUsage, isFused, status, resetKey, sweep, flush };
}
