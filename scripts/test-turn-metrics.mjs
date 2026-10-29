// T5：按回合的 Token 效率指标（采集、聚合、派生 KPI、持久化）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTurnMetrics, deriveMetrics, dayKeyOf, hourKeyOf } from '../src/turn-metrics.js';

let pass = 0, fail = 0;
const check = (name, fn) => {
  try { (typeof fn === 'function' ? fn : () => { if (!fn) throw new Error('false'); })(); pass++; console.log(`PASS ${name}`); }
  catch (error) { fail++; console.log(`FAIL ${name}  ${error?.message ?? error}`); }
};
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-turn-metrics-'));
const file = path.join(tmp, 'turn-metrics.json');
let nowMs = Date.parse('2026-10-28T10:00:00+08:00');
const metrics = createTurnMetrics({ file, now: () => nowMs });

console.log('── 1. 基础回合聚合 ──');
{
  metrics.setWakeReason('group:1', 'question');
  metrics.beginTurn('s1', 'group:1', { promptChars: { total: 3000, role: 800, sticker: 100 }, role: '大肥鱼', mode: 'reserved2' });
  metrics.recordAssistantMessage('s1', { inputTokens: 1000, cacheReadTokens: 4000, outputTokens: 200 });
  metrics.recordToolCall('s1', 'mcp__snowluma__qq_get_unread_messages');
  metrics.recordToolResult('s1', 'mcp__snowluma__qq_get_unread_messages', 5000, false);
  metrics.recordSent('group:1');
  metrics.finishTurn('s1');
  const s = metrics.stats({ day: '2026-10-28' });
  check('回合与消息计数', s.totals.turns === 1 && s.totals.sentMessages === 1);
  check('tokens/回合 与 tokens/消息', s.totals.tokensPerTurn === 5200 && s.totals.tokensPerSentMessage === 5200);
  check('输入拆分与缓存命中率', s.totals.uncachedInputPerTurn === 1000 && s.totals.cacheReadPerTurn === 4000
    && s.totals.cacheHitRatio === 0.8);
  check('模型/工具调用与结果字符', s.totals.modelCallsPerTurn === 1 && s.totals.toolCallsPerTurn === 1
    && s.totals.toolResultCharsPerTurn === 5000);
  check('唤醒原因与提示分项均值', s.totals.wakeTurns === 1 && s.totals.wakeReasons.question === 1
    && s.totals.promptCharsPerTurn.role === 800);
  check('按唤醒原因分组', s.totals.byReason.question?.turns === 1
    && s.totals.byReason.question?.input === 1000 && s.totals.byReason.question?.sent === 1);
  check('按工具分组（调用/字符/错误）', s.totals.byTool['mcp__snowluma__qq_get_unread_messages']?.calls === 1
    && s.totals.byTool['mcp__snowluma__qq_get_unread_messages']?.resultChars === 5000
    && s.totals.byTool['mcp__snowluma__qq_get_unread_messages']?.errors === 0);
  check('按小时分组（开始时刻 10 点）', s.totals.byHour['10']?.turns === 1);
  check('按角色与模式分组', s.totals.byRole['大肥鱼']?.turns === 1 && s.totals.byMode.reserved2?.turns === 1);
}

console.log('\n── 2. 无发言唤醒 / 只有 wait / 只有 mark_read ──');
{
  metrics.setWakeReason('group:2', 'anyMessage');
  metrics.beginTurn('s2', 'group:2');
  metrics.recordAssistantMessage('s2', { inputTokens: 200, cacheReadTokens: 300, outputTokens: 50 });
  metrics.recordToolCall('s2', 'mcp__snowluma__qq_wait_for_messages');
  metrics.finishTurn('s2');
  metrics.setWakeReason('group:3', 'replyCheck');
  metrics.beginTurn('s3', 'group:3');
  metrics.recordAssistantMessage('s3', { inputTokens: 100, cacheReadTokens: 0, outputTokens: 0 });
  metrics.recordToolCall('s3', 'mcp__snowluma__qq_mark_read');
  metrics.finishTurn('s3');
  const s = metrics.stats({ day: '2026-10-28' });
  check('无发言唤醒计入 tokens', s.totals.wakeWithoutReply === 2 && s.totals.wakeWithoutReplyTokens === 550 + 100);
  check('只有 wait 的回合', s.totals.turnsWithOnlyWait === 1);
  check('只有 mark_read 的回合', s.totals.turnsWithOnlyMarkRead === 1);
  check('无发言回合不计 sent', s.totals.sentMessages === 1);
  check('按唤醒原因记录无发言 tokens', s.totals.byReason.anyMessage?.noReply === 1
    && s.totals.byReason.anyMessage?.noReplyTokens === 550
    && s.totals.byReason.replyCheck?.noReplyTokens === 100);
  check('按工具记录调用次数', s.totals.byTool['mcp__snowluma__qq_wait_for_messages']?.calls === 1
    && s.totals.byTool['mcp__snowluma__qq_mark_read']?.calls === 1);
}

console.log('\n── 3. 静默回合与断流清理 ──');
{
  metrics.beginTurn('s4', 'group:1', { silent: true });
  metrics.recordAssistantMessage('s4', { inputTokens: 9999, cacheReadTokens: 0, outputTokens: 0 });
  metrics.finishTurn('s4');
  const s = metrics.stats({ day: '2026-10-28' });
  check('静默摘要回合不计入', s.totals.turns === 3 && s.totals.uncachedInputPerTurn !== 9999);
  metrics.beginTurn('s5', 'group:1');
  metrics.resetActive();
  check('断流丢弃进行中的回合', metrics._activeCount() === 0 && metrics.stats({ day: '2026-10-28' }).totals.turns === 3);
}

console.log('\n── 4. 持久化与日切/保留期 ──');
{
  const re = createTurnMetrics({ file, now: () => nowMs });
  const s = re.stats({ day: '2026-10-28' });
  check('重新实例化后数据还在', s.totals.turns === 3 && s.totals.sentMessages === 1);
  // 造 15 天历史，保留 14 天
  for (let d = 0; d < 15; d++) {
    nowMs = Date.parse('2026-10-28T10:00:00+08:00') + d * 24 * 3600 * 1000;
    metrics.beginTurn(`sx-${d}`, 'group:9');
    metrics.recordAssistantMessage(`sx-${d}`, { inputTokens: 1, cacheReadTokens: 0, outputTokens: 0 });
    metrics.finishTurn(`sx-${d}`);
  }
  const s2 = metrics.stats();
  check('只保留最近 14 天（最早一天被淘汰）', s2.availableDays.length === 14 && !s2.availableDays.includes('2026-10-28'));
}

console.log('\n── 4b. 老状态文件升级 ──');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-turn-metrics-old-'));
  const oldFile = path.join(dir, 'turn-metrics.json');
  // 旧版 bucket：没有 byReason/byTool/byHour/byRole/byMode
  fs.writeFileSync(oldFile, JSON.stringify({
    version: 1,
    days: { '2026-10-28': { keys: { 'group:9': {
      turns: 1, modelCalls: 1, toolCalls: 0, toolResultChars: 0,
      input: 10, cacheRead: 0, output: 0, sentMessages: 0,
      wakeTurns: 0, wakeWithoutReply: 0, wakeWithoutReplyTokens: 0,
      turnsWithOnlyWait: 0, turnsWithOnlyMarkRead: 0,
      promptChars: { total: 0, role: 0, sticker: 0, menu: 0, tokenReport: 0, voice: 0, memory: 0, status: 0 },
      wakeReasons: {}
    } } } }
  }));
  const old = createTurnMetrics({ file: oldFile, now: () => Date.parse('2026-10-28T10:00:00+08:00') });
  old.beginTurn('so', 'group:9', { role: '测试角色', mode: 'reserved2' });
  old.recordAssistantMessage('so', { inputTokens: 5, cacheReadTokens: 0, outputTokens: 0 });
  old.finishTurn('so');
  const s = old.stats({ day: '2026-10-28' });
  check('老状态文件升级后首回合不崩且补齐维度', s.totals.turns === 2
    && s.totals.byRole['测试角色']?.turns === 1 && s.totals.byMode.reserved2?.turns === 1);
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('\n── 5. 派生 KPI 纯函数 ──');
{
  const d = deriveMetrics({ turns: 4, sentMessages: 2, input: 400, cacheRead: 1600, output: 400, modelCalls: 8, toolCalls: 12, toolResultChars: 800 });
  check('派生公式', d.tokensPerTurn === 600 && d.tokensPerSentMessage === 1200 && d.modelCallsPerTurn === 2
    && d.toolCallsPerTurn === 3 && d.cacheHitRatio === 0.8 && d.toolResultCharsPerTurn === 200);
  check('有效 tokens（未缓存+输出）口径', d.effectiveTokensPerTurn === 200 && d.effectiveTokensPerSentMessage === 400);
  check('无回合时全 0 不除零', deriveMetrics({}).tokensPerTurn === 0 && deriveMetrics({}).cacheHitRatio === 0);
}

check('dayKeyOf 使用上海时区', () => {
  assert.equal(dayKeyOf(Date.parse('2026-10-28T15:59:00Z')), '2026-10-28');
  assert.equal(dayKeyOf(Date.parse('2026-10-28T16:01:00Z')), '2026-10-29');
});
check('hourKeyOf 使用上海时区', () => {
  assert.equal(hourKeyOf(Date.parse('2026-10-28T15:59:00Z')), '23');
  assert.equal(hourKeyOf(Date.parse('2026-10-28T16:01:00Z')), '0');
  assert.equal(hourKeyOf(Date.parse('2026-10-28T02:00:00+08:00')), '2');
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(fail ? `❌ ${pass} 通过 / ${fail} 失败` : `✅ ${pass} 通过 / 0 失败`);
process.exit(fail ? 1 : 0);
