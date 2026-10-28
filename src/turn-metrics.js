// T5：Token 效率指标（按「回合」采集，按天分桶）。
//
// 为什么不在现有 token-usage 里算：那份数据来自 DSH 转录，只有「每次模型调用」的
// 用量，没有回合边界、工具调用、唤醒原因、是否发言。T5 的 KPI（modelCallsPerTurn、
// turnsWithOnlyWait、wakeWithoutReplyTokens…）必须以回合为单位，所以在事件泵里采。
//
// 口径（与 docs/refactor-t5-acceptance.md 一致）：
//   input       = 未命中缓存的输入（DSH inputTokens / prompt_tokens − cacheRead）
//   cacheRead   = 命中缓存的输入
//   output      = 输出
//   sentMessages= 实际发到 QQ 的消息条数（recordSentMessage 每次成功 +1）
//   turns       = 完成的普通回合（静默摘要回合不计）
//   wakeWithoutReplyTokens = 有唤醒原因、但本回合没发任何消息的回合的 (input+cacheRead+output)
//
// 派生 KPI 见 deriveMetrics()。数值用于趋势对比，不参与计费。
import { createJsonStore } from './state/store.js';

const KEEP_DAYS = 14;

export function dayKeyOf(ts = Date.now()) {
  // 与 token-usage 一致：上海时区，避免 UTC 跨日错位。
  return new Date(ts).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
}

const round = (v, digits = 2) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  const p = 10 ** digits;
  return Math.round(n * p) / p;
};

const emptyBucket = () => ({
  turns: 0,
  modelCalls: 0,
  toolCalls: 0,
  toolResultChars: 0,
  input: 0,
  cacheRead: 0,
  output: 0,
  sentMessages: 0,
  wakeTurns: 0,
  wakeWithoutReply: 0,
  wakeWithoutReplyTokens: 0,
  turnsWithOnlyWait: 0,
  turnsWithOnlyMarkRead: 0,
  promptChars: { total: 0, role: 0, sticker: 0, menu: 0, tokenReport: 0, voice: 0, memory: 0, status: 0 },
  wakeReasons: {}
});

export function deriveMetrics(bucket = {}) {
  const turns = Number(bucket.turns) || 0;
  const input = Number(bucket.input) || 0;
  const cacheRead = Number(bucket.cacheRead) || 0;
  const output = Number(bucket.output) || 0;
  const total = input + cacheRead + output;
  const sent = Number(bucket.sentMessages) || 0;
  const per = (v) => (turns > 0 ? round((Number(v) || 0) / turns) : 0);
  const avgChars = (k) => (turns > 0 ? round((Number(bucket.promptChars?.[k]) || 0) / turns, 1) : 0);
  return {
    turns,
    sentMessages: sent,
    tokensPerTurn: per(total),
    tokensPerSentMessage: sent > 0 ? round(total / sent) : 0,
    modelCallsPerTurn: per(bucket.modelCalls),
    toolCallsPerTurn: per(bucket.toolCalls),
    uncachedInputPerTurn: per(input),
    cacheReadPerTurn: per(cacheRead),
    outputPerTurn: per(output),
    wakeTurns: Number(bucket.wakeTurns) || 0,
    wakeWithoutReply: Number(bucket.wakeWithoutReply) || 0,
    wakeWithoutReplyTokens: Number(bucket.wakeWithoutReplyTokens) || 0,
    turnsWithOnlyWait: Number(bucket.turnsWithOnlyWait) || 0,
    turnsWithOnlyMarkRead: Number(bucket.turnsWithOnlyMarkRead) || 0,
    toolResultCharsPerTurn: per(bucket.toolResultChars),
    cacheHitRatio: input + cacheRead > 0 ? round(cacheRead / (input + cacheRead), 4) : 0,
    promptCharsPerTurn: {
      total: avgChars('total'),
      role: avgChars('role'),
      sticker: avgChars('sticker'),
      menu: avgChars('menu'),
      tokenReport: avgChars('tokenReport'),
      voice: avgChars('voice'),
      memory: avgChars('memory'),
      status: avgChars('status')
    },
    wakeReasons: { ...(bucket.wakeReasons || {}) }
  };
}

export function aggregateBuckets(keys = {}) {
  const total = emptyBucket();
  for (const bucket of Object.values(keys || {})) {
    for (const field of ['turns', 'modelCalls', 'toolCalls', 'toolResultChars', 'input', 'cacheRead', 'output',
      'sentMessages', 'wakeTurns', 'wakeWithoutReply', 'wakeWithoutReplyTokens', 'turnsWithOnlyWait', 'turnsWithOnlyMarkRead']) {
      total[field] += Number(bucket?.[field]) || 0;
    }
    for (const k of Object.keys(total.promptChars)) total.promptChars[k] += Number(bucket?.promptChars?.[k]) || 0;
    for (const [reason, n] of Object.entries(bucket?.wakeReasons || {})) {
      total.wakeReasons[reason] = (total.wakeReasons[reason] || 0) + (Number(n) || 0);
    }
  }
  return total;
}

export function createTurnMetrics({ file, now = Date.now, log = () => {}, keepDays = KEEP_DAYS } = {}) {
  if (!file) throw new Error('createTurnMetrics: file 不能为空');
  const store = createJsonStore({ file, version: 1, defaults: () => ({ days: {} }), log });
  const active = new Map(); // sessionId -> 进行中的回合
  const wakeReasonByKey = new Map(); // key -> 最近一次唤醒原因
  let statsCache = null; // { at, value } 供控制台轮询时避免反复遍历

  function readDays() {
    const st = store.read();
    const days = st.days && typeof st.days === 'object' ? st.days : {};
    const names = Object.keys(days).sort();
    let changed = false;
    while (names.length > keepDays) { delete days[names.shift()]; changed = true; }
    if (changed) store.update((draft) => ({ ...draft, days }));
    return days;
  }

  function bucketOf(days, day, key, create = false) {
    const dayBucket = days[day] ?? (create ? { keys: {} } : null);
    if (!dayBucket) return null;
    if (!dayBucket.keys) dayBucket.keys = {};
    if (!dayBucket.keys[key] && create) dayBucket.keys[key] = emptyBucket();
    return dayBucket.keys[key] ?? null;
  }

  function mutate(fn) {
    store.update((draft) => {
      const days = draft.days && typeof draft.days === 'object' ? draft.days : {};
      const day = dayKeyOf(now());
      const names = Object.keys(days).sort();
      while (names.length > keepDays) delete days[names.shift()];
      if (!days[day]) days[day] = { keys: {} };
      if (!days[day].keys) days[day].keys = {};
      fn(days[day].keys, day);
      draft.days = days;
      return draft;
    });
    statsCache = null;
  }

  function setWakeReason(key, reason) {
    if (!key) return;
    const r = String(reason ?? '').trim();
    if (r) wakeReasonByKey.set(key, r);
  }

  function beginTurn(sessionId, key, { silent = false, promptChars = null } = {}) {
    if (!sessionId || !key) return;
    active.set(sessionId, {
      key,
      reason: wakeReasonByKey.get(key) ?? '',
      silent: silent === true,
      modelCalls: 0,
      toolCalls: 0,
      toolNames: new Set(),
      toolResultChars: 0,
      input: 0,
      cacheRead: 0,
      output: 0,
      sent: 0,
      promptChars: promptChars && typeof promptChars === 'object' ? { ...promptChars } : null
    });
    wakeReasonByKey.delete(key);
  }

  function recordAssistantMessage(sessionId, usage) {
    const turn = active.get(sessionId);
    if (!turn || !usage) return;
    turn.modelCalls += 1;
    turn.input += Number(usage?.inputTokens ?? usage?.prompt_tokens ?? 0) || 0;
    turn.cacheRead += Number(usage?.cacheReadTokens ?? usage?.cache_read_input_tokens ?? 0) || 0;
    turn.output += Number(usage?.outputTokens ?? usage?.completion_tokens ?? 0) || 0;
  }

  function recordToolCall(sessionId, name) {
    const turn = active.get(sessionId);
    if (!turn) return;
    turn.toolCalls += 1;
    if (name) turn.toolNames.add(String(name));
  }

  function recordToolResult(sessionId, chars) {
    const turn = active.get(sessionId);
    if (!turn) return;
    turn.toolResultChars += Math.max(0, Number(chars) || 0);
  }

  /** 实际发送成功后调用（bridge.recordSentMessage）。key 级计数 + 计入当前回合。 */
  function recordSent(key) {
    if (!key) return;
    const turn = [...active.values()].find((t) => t.key === key);
    if (turn) turn.sent += 1;
    mutate((keys) => {
      const bucket = keys[key] ?? (keys[key] = emptyBucket());
      bucket.sentMessages += 1;
    });
  }

  function finishTurn(sessionId) {
    const turn = active.get(sessionId);
    if (!turn) return;
    active.delete(sessionId);
    if (turn.silent) return;
    const totalTokens = turn.input + turn.cacheRead + turn.output;
    mutate((keys) => {
      const bucket = keys[turn.key] ?? (keys[turn.key] = emptyBucket());
      bucket.turns += 1;
      bucket.modelCalls += turn.modelCalls;
      bucket.toolCalls += turn.toolCalls;
      bucket.toolResultChars += turn.toolResultChars;
      bucket.input += turn.input;
      bucket.cacheRead += turn.cacheRead;
      bucket.output += turn.output;
      if (turn.reason) bucket.wakeTurns += 1;
      if (turn.sent === 0) {
        if (turn.reason) {
          bucket.wakeWithoutReply += 1;
          bucket.wakeWithoutReplyTokens += totalTokens;
        }
        const names = [...turn.toolNames];
        if (names.length > 0 && names.every((n) => n === 'mcp__snowluma__qq_wait_for_messages')) bucket.turnsWithOnlyWait += 1;
        if (names.length > 0 && names.every((n) => n === 'mcp__snowluma__qq_mark_read')) bucket.turnsWithOnlyMarkRead += 1;
      }
      if (turn.reason) bucket.wakeReasons[turn.reason] = (bucket.wakeReasons[turn.reason] || 0) + 1;
      if (turn.promptChars) {
        for (const k of Object.keys(bucket.promptChars)) {
          bucket.promptChars[k] += Number(turn.promptChars[k]) || 0;
        }
      }
    });
  }

  /** 控制台/报表用：某天（默认今天）的汇总 + 每会话明细。 */
  function stats({ day } = {}) {
    const target = String(day || dayKeyOf(now()));
    const days = readDays();
    const keys = days[target]?.keys || {};
    const totals = deriveMetrics(aggregateBuckets(keys));
    const perKey = Object.fromEntries(Object.entries(keys).map(([key, bucket]) => [key, deriveMetrics(bucket)]));
    return {
      ok: true,
      day: target,
      availableDays: Object.keys(days).sort().reverse(),
      totals,
      perKey
    };
  }

  /** 变更后落盘已即时完成；保留 sweep 供任务服务/退出时兜底。 */
  function sweep() {
    statsCache = null;
    return store.flush();
  }

  /** 断流/重连：丢弃进行中的回合计账（它们没有完整的 turn/end）。 */
  function resetActive() {
    active.clear();
  }

  return {
    file,
    setWakeReason,
    beginTurn,
    recordAssistantMessage,
    recordToolCall,
    recordToolResult,
    recordSent,
    finishTurn,
    stats,
    sweep,
    resetActive,
    _activeCount: () => active.size
  };
}
