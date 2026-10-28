// T5：按回合的 Token 效率指标（采集、聚合、派生 KPI、持久化）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTurnMetrics, deriveMetrics, dayKeyOf } from '../src/turn-metrics.js';

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
  metrics.beginTurn('s1', 'group:1', { promptChars: { total: 3000, role: 800, sticker: 100 } });
  metrics.recordAssistantMessage('s1', { inputTokens: 1000, cacheReadTokens: 4000, outputTokens: 200 });
  metrics.recordToolCall('s1', 'mcp__snowluma__qq_get_unread_messages');
  metrics.recordToolResult('s1', 5000);
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

console.log('\n── 5. 派生 KPI 纯函数 ──');
{
  const d = deriveMetrics({ turns: 4, sentMessages: 2, input: 400, cacheRead: 1600, output: 400, modelCalls: 8, toolCalls: 12, toolResultChars: 800 });
  check('派生公式', d.tokensPerTurn === 600 && d.tokensPerSentMessage === 1200 && d.modelCallsPerTurn === 2
    && d.toolCallsPerTurn === 3 && d.cacheHitRatio === 0.8 && d.toolResultCharsPerTurn === 200);
  check('无回合时全 0 不除零', deriveMetrics({}).tokensPerTurn === 0 && deriveMetrics({}).cacheHitRatio === 0);
}

check('dayKeyOf 使用上海时区', () => {
  assert.equal(dayKeyOf(Date.parse('2026-10-28T15:59:00Z')), '2026-10-28');
  assert.equal(dayKeyOf(Date.parse('2026-10-28T16:01:00Z')), '2026-10-29');
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(fail ? `❌ ${pass} 通过 / ${fail} 失败` : `✅ ${pass} 通过 / 0 失败`);
process.exit(fail ? 1 : 0);
