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
// 2026-10-29 细化口径：除总量外，还按
//   唤醒原因（byReason）、工具（byTool）、小时（byHour）、角色（byRole）、模式（byMode）
// 分组记账；每组都带 turns/input/cacheRead/output/发言数/无发言 tokens。
//
// 派生 KPI 见 deriveMetrics()。数值用于趋势对比，不参与计费。
import { createJsonStore } from './state/store.js';

const KEEP_DAYS = 14;

export function dayKeyOf(ts = Date.now()) {
  // 与 token-usage 一致：上海时区，避免 UTC 跨日错位。
  return new Date(ts).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
}

const SHANGHAI_HOUR_FORMATTER = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Shanghai',
  hour: '2-digit',
  hourCycle: 'h23'
});

export function hourKeyOf(ts = Date.now()) {
  // 小时桶必须和 dayKeyOf 使用同一业务时区；不能依赖进程本地时区。
  const hour = SHANGHAI_HOUR_FORMATTER
    .formatToParts(new Date(ts))
    .find((part) => part.type === 'hour')?.value;
  return String(Number(hour ?? 0));
}

const round = (v, digits = 2) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  const p = 10 ** digits;
  return Math.round(n * p) / p;
};

const emptyDim = () => ({
  turns: 0,
  input: 0,
  cacheRead: 0,
  output: 0,
  sent: 0,
  noReply: 0,
  noReplyTokens: 0
});

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
  // 兼容旧字段：与 byReason[*].turns 同义
  wakeReasons: {},
  // 细化分组
  byReason: {},
  byTool: {},
  byHour: {},
  byRole: {},
  byMode: {}
});

function addDim(map, name, turn, totals) {
  const key = String(name || '').trim() || '(unknown)';
  const dim = map[key] || (map[key] = emptyDim());
  dim.turns += 1;
  dim.input += totals.input;
  dim.cacheRead += totals.cacheRead;
  dim.output += totals.output;
  dim.sent += turn.sent;
  if (turn.sent === 0) {
    dim.noReply += 1;
    dim.noReplyTokens += totals.total;
  }
}

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
    // 成本视角：缓存读通常远便宜于未缓存输入，单看 total 会被缓存读淹没。
    effectiveTokensPerTurn: per(input + output),
    effectiveTokensPerSentMessage: sent > 0 ? round((input + output) / sent) : 0,
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
    wakeReasons: { ...(bucket.wakeReasons || {}) },
    // 细化分组（turns/input/cacheRead/output/sent/noReply/noReplyTokens）
    byReason: { ...(bucket.byReason || {}) },
    byTool: { ...(bucket.byTool || {}) },
    byHour: { ...(bucket.byHour || {}) },
    byRole: { ...(bucket.byRole || {}) },
    byMode: { ...(bucket.byMode || {}) }
  };
}

function mergeDimMaps(target, source) {
  for (const [name, dim] of Object.entries(source || {})) {
    const d = target[name] || (target[name] = name === 'byTool' ? { calls: 0, resultChars: 0, errors: 0 } : emptyDim());
    for (const [k, v] of Object.entries(dim)) d[k] = (Number(d[k]) || 0) + (Number(v) || 0);
  }
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
    mergeDimMaps(total.byReason, bucket?.byReason);
    mergeDimMaps(total.byTool, bucket?.byTool);
    mergeDimMaps(total.byHour, bucket?.byHour);
    mergeDimMaps(total.byRole, bucket?.byRole);
    mergeDimMaps(total.byMode, bucket?.byMode);
  }
  return total;
}

export function createTurnMetrics({ file, now = Date.now, log = () => {}, keepDays = KEEP_DAYS } = {}) {
  if (!file) throw new Error('createTurnMetrics: file 不能为空');
  const store = createJsonStore({ file, version: 1, defaults: () => ({ days: {} }), log });
  const active = new Map(); // sessionId -> 进行中的回合
  const wakeReasonByKey = new Map(); // key -> 最近一次唤醒原因

  function readDays() {
    const st = store.read();
    const days = st.days && typeof st.days === 'object' ? st.days : {};
    const names = Object.keys(days).sort();
    let changed = false;
    while (names.length > keepDays) { delete days[names.shift()]; changed = true; }
    if (changed) store.update((draft) => ({ ...draft, days }));
    return days;
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
  }

  function setWakeReason(key, reason) {
    if (!key) return;
    const r = String(reason ?? '').trim();
    if (r) wakeReasonByKey.set(key, r);
  }

  function beginTurn(sessionId, key, { silent = false, promptChars = null, role = '', mode = '' } = {}) {
    if (!sessionId || !key) return;
    active.set(sessionId, {
      key,
      reason: wakeReasonByKey.get(key) ?? '',
      role: String(role || '').trim(),
      mode: String(mode || '').trim(),
      startedAt: now(),
      silent: silent === true,
      modelCalls: 0,
      toolCalls: 0,
      toolNames: new Set(),
      toolStats: new Map(), // name -> { calls, resultChars, errors }
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

  function toolStat(turn, name) {
    const key = String(name || '').trim() || '(unknown)';
    let stat = turn.toolStats.get(key);
    if (!stat) { stat = { calls: 0, resultChars: 0, errors: 0 }; turn.toolStats.set(key, stat); }
    return stat;
  }

  function recordToolCall(sessionId, name) {
    const turn = active.get(sessionId);
    if (!turn) return;
    turn.toolCalls += 1;
    if (name) turn.toolNames.add(String(name));
    toolStat(turn, name).calls += 1;
  }

  function recordToolResult(sessionId, name, chars, isError = false) {
    const turn = active.get(sessionId);
    if (!turn) return;
    const n = Math.max(0, Number(chars) || 0);
    turn.toolResultChars += n;
    const stat = toolStat(turn, name);
    stat.resultChars += n;
    if (isError) stat.errors += 1;
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
    const totals = { input: turn.input, cacheRead: turn.cacheRead, output: turn.output, total: totalTokens };
    const hour = hourKeyOf(turn.startedAt);
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
      // 细化分组（老状态文件没有这些字段，先补空对象，避免升级后首个回合崩）
      bucket.byReason ||= {};
      bucket.byTool ||= {};
      bucket.byHour ||= {};
      bucket.byRole ||= {};
      bucket.byMode ||= {};
      addDim(bucket.byReason, turn.reason, turn, totals);
      addDim(bucket.byHour, hour, turn, totals);
      addDim(bucket.byRole, turn.role, turn, totals);
      addDim(bucket.byMode, turn.mode, turn, totals);
      for (const [name, stat] of turn.toolStats) {
        const t = bucket.byTool[name] || (bucket.byTool[name] = { calls: 0, resultChars: 0, errors: 0 });
        t.calls += stat.calls;
        t.resultChars += stat.resultChars;
        t.errors += stat.errors;
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
