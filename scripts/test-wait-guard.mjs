// qq_wait_for_messages 防卡死回归测试。
//
// 背景（2026-10-23 group:100001005 实测）：
//   - 单回合连续 6 次 wait，单次 107~245s，累计 20m56s，整个 turn 跑了 24 分钟；
//   - 期间所有新消息都记成「会话繁忙」，群友的 @ 和 B 站卡片全排队；
//   - 只保留 seq 的 pendingWakeReasons 触发消息正文随后被 30 条未读挤出，模型无法补答。
// 这组测试锁住四个硬约束：单次时长、单回合次数、静默窗口、待回复消息快照。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');

let pass = 0;
let fail = 0;
function check(name, ok) {
  if (ok) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}`); }
}

console.log('── wait 单次与单回合上限 ──');
check('单回合最多 2 次', /const WAIT_TURN_MAX_COUNT = 2;/.test(src));
check('单回合累计最多 120s', /const WAIT_TURN_MAX_MS = 120000;/.test(src));
check('按 DSH turn 记录累计等待', /waitTurnTotals/.test(src) && /v2TurnStartAt\.get\(sid\)/.test(src));
check('超限返回 forceWrapUp', /sendWaitWrapUp\(why\)/.test(src) && /forceWrapUp: true/.test(src));
check('quietMs 单独封顶 15s', /const WAIT_QUIET_CAP_MS = 15000;/.test(src));
check('单次 wait 有绝对截止，不再 timeout+maxQuiet 无限延长',
  /const waitDeadline = start \+ timeoutMs \+ quietMs \+ 1000;/.test(src)
  && /Date\.now\(\) < waitDeadline/.test(src)
  && !/timeoutMs \+ maxQuietMs \+ 5000/.test(src));

console.log('── 繁忙期间待回复消息保真 ──');
check('入队时保存消息快照', /function snapshotWakeMessageV2/.test(src) && /snapshot: snapshotWakeMessageV2\(trigger\)/.test(src));
check('旧队列只有 seq 时从 journal 补正文', /function pendingWakeSnapshotFromJournalV2/.test(src) && /loadContextMessages\(STATE_DIR, key/.test(src));
check('回合结束把快照交给下一次唤醒', /stEnd\.pendingWakeMessage = pick\.snapshot/.test(src));
check('唤醒提示显式列出漏看消息', /此前繁忙期间漏看的消息/.test(src));
check('快照持久化 save/load 成对', (src.match(/pendingWakeMessage:/g) || []).length >= 2);

console.log('── 活跃群沉睡前死锁 ──');
check('已发言超过宽限后不再要求连续静默', /now - lastReply >= graceMs/.test(src));
check('preSleepWaitBlockedV2 接收会话 key', /function preSleepWaitBlockedV2\(st, key = ''\)/.test(src) && /preSleepWaitBlockedV2\(st, key\)/.test(src));
check('唤醒提示明确发言后结束回合', /【回合收尾】/.test(src) && /不要再调用 qq_wait_for_messages 守候/.test(src));
check('引用目标被 recent 挤出时从 journal 兜底', /从完整日志找回 seq=/.test(src) && /loadContextMessages\(STATE_DIR, journalKey/.test(src));
check('单回合上限可配置', /waitCfg\.turnMaxCount/.test(src) && /waitCfg\.turnMaxMs/.test(src));
check('发言后收尾宽限可配置', /preSleepReplyGraceMs/.test(src));

if (fail) {
  console.error(`\n❌ ${pass} 通过 / ${fail} 失败`);
  process.exit(1);
}
console.log(`\n✅ ${pass} 通过 / 0 失败`);
