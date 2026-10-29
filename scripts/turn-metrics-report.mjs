// T5：Token 效率指标报表（读 state/turn-metrics.json，按天/会话输出 KPI）。
//
// 用法：
//   node scripts/turn-metrics-report.mjs                 # 今天
//   node scripts/turn-metrics-report.mjs --day 2026-10-28
//   node scripts/turn-metrics-report.mjs --all           # 全部可用日期
//   node scripts/turn-metrics-report.mjs --compare 2026-10-27,2026-10-28
//   node scripts/turn-metrics-report.mjs --json
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTurnMetrics } from '../src/turn-metrics.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name, fallback = '') => {
  const i = args.indexOf(name);
  return i >= 0 ? String(args[i + 1] ?? fallback) : fallback;
};
const has = (name) => args.includes(name);

const metrics = createTurnMetrics({ file: path.join(root, 'state', 'turn-metrics.json') });
const today = metrics.stats().day;

const pick = (s) => ({
  day: s.day,
  turns: s.totals.turns,
  sent: s.totals.sentMessages,
  tokensPerTurn: s.totals.tokensPerTurn,
  effectiveTokensPerTurn: s.totals.effectiveTokensPerTurn,
  tokensPerSentMessage: s.totals.tokensPerSentMessage,
  effectiveTokensPerSentMessage: s.totals.effectiveTokensPerSentMessage,
  modelCallsPerTurn: s.totals.modelCallsPerTurn,
  toolCallsPerTurn: s.totals.toolCallsPerTurn,
  uncachedInputPerTurn: s.totals.uncachedInputPerTurn,
  cacheReadPerTurn: s.totals.cacheReadPerTurn,
  outputPerTurn: s.totals.outputPerTurn,
  wakeWithoutReply: s.totals.wakeWithoutReply,
  wakeWithoutReplyTokens: s.totals.wakeWithoutReplyTokens,
  turnsWithOnlyWait: s.totals.turnsWithOnlyWait,
  turnsWithOnlyMarkRead: s.totals.turnsWithOnlyMarkRead,
  toolResultCharsPerTurn: s.totals.toolResultCharsPerTurn,
  cacheHitRatio: s.totals.cacheHitRatio,
  promptCharsPerTurn: s.totals.promptCharsPerTurn
});

if (has('--json')) {
  const day = flag('--day', '');
  const out = has('--all')
    ? metrics.stats().availableDays.map((d) => pick(metrics.stats({ day: d })))
    : [pick(metrics.stats({ day: day || undefined }))];
  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
}

const printOne = (s, title) => {
  const t = s.totals;
  console.log(`\n== ${title || s.day} ==`);
  console.log(`回合 ${t.turns} ｜ 发送消息 ${t.sentMessages} ｜ 唤醒 ${t.wakeTurns}（无发言 ${t.wakeWithoutReply}）`);
  console.log(`tokens/回合 ${t.tokensPerTurn} ｜ 有效(未缓存+输出)/回合 ${t.effectiveTokensPerTurn} ｜ tokens/消息 ${t.tokensPerSentMessage} ｜ 缓存命中 ${(t.cacheHitRatio * 100).toFixed(1)}%`);
  console.log(`模型调用/回合 ${t.modelCallsPerTurn} ｜ 工具调用/回合 ${t.toolCallsPerTurn} ｜ 工具结果字符/回合 ${t.toolResultCharsPerTurn}`);
  console.log(`未缓存输入/回合 ${t.uncachedInputPerTurn} ｜ 缓存读/回合 ${t.cacheReadPerTurn} ｜ 输出/回合 ${t.outputPerTurn}`);
  console.log(`无发言唤醒 tokens ${t.wakeWithoutReplyTokens} ｜ 只有 wait 的回合 ${t.turnsWithOnlyWait} ｜ 只有 mark_read 的回合 ${t.turnsWithOnlyMarkRead}`);
  console.log(`提示分项/回合 ${JSON.stringify(t.promptCharsPerTurn)}`);
};

const totalOf = (d) => (Number(d?.input) || 0) + (Number(d?.cacheRead) || 0) + (Number(d?.output) || 0);
const printDimTable = (map, label, { tool = false } = {}) => {
  const rows = Object.entries(map || {})
    .sort((a, b) => totalOf(b[1]) - totalOf(a[1]))
    .slice(0, 12);
  if (!rows.length) return;
  console.log(`\n${label}`);
  for (const [name, d] of rows) {
    if (tool) {
      console.log(`  ${name}: 调用 ${d.calls} ｜ 结果 ${d.resultChars} 字符 ｜ 错误 ${d.errors}`);
    } else {
      console.log(`  ${name}: 回合 ${d.turns} ｜ 输入(未缓存) ${d.input} / 缓存读 ${d.cacheRead} / 输出 ${d.output} ｜ 发言 ${d.sent} ｜ 无发言 ${d.noReply}（${d.noReplyTokens} tokens）`);
    }
  }
};
const printDetails = (s) => {
  const t = s.totals;
  printDimTable(t.byReason, '按唤醒原因');
  printDimTable(t.byRole, '按角色');
  printDimTable(t.byMode, '按模式');
  printDimTable(t.byHour, '按小时（回合开始）');
  printDimTable(t.byTool, '按工具', { tool: true });
};

const compare = flag('--compare', '');
if (compare) {
  const [a, b] = compare.split(',').map((x) => x.trim()).filter(Boolean);
  const pickDelta = (from, to) => {
    const keys = ['tokensPerTurn', 'effectiveTokensPerTurn', 'tokensPerSentMessage', 'effectiveTokensPerSentMessage', 'modelCallsPerTurn', 'toolCallsPerTurn', 'uncachedInputPerTurn', 'cacheReadPerTurn', 'outputPerTurn', 'toolResultCharsPerTurn', 'cacheHitRatio'];
    const out = {};
    for (const k of keys) {
      const delta = Number(to[k]) - Number(from[k]);
      out[k] = { before: from[k], after: to[k], delta: Math.round(delta * 100) / 100, pct: Number(from[k]) > 0 ? Math.round((delta / from[k]) * 1000) / 10 : null };
    }
    return out;
  };
  const one = pick(metrics.stats({ day: a }));
  const two = pick(metrics.stats({ day: b }));
  console.log(JSON.stringify({ compare: { before: one, after: two, delta: pickDelta(one, two) } }, null, 2));
  process.exit(0);
}

if (has('--all')) {
  for (const d of metrics.stats().availableDays) printOne(metrics.stats({ day: d }));
} else {
  const one = metrics.stats({ day: flag('--day', '') || undefined });
  printOne(one, flag('--day', '') || today);
  if (has('--detail')) printDetails(one);
}
