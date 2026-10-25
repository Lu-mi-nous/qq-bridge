// 回归测试：未读清理与「重复回答同一条」。
//
// 背景（实测事故）：机器人把同一条 @ 回复了 3~4 次，逐条补答早前的请求。
// 根因是 **mark_read 的未读保留逻辑写反了**：
//   `filter((m) => !pendingSeqs.has(seq))` —— 注释说"保留排队中的"，实际把排队的删掉、
//   留下其余全部。于是 11 条未读被反复"保留"，mark_read 每次都报「已读 0 条，保留 11 条」，
//   每轮唤醒模型都看到同一批旧 @，当成待办清单逐条补答。
//
// 修法：用**唤醒水位**（唤醒时未读里最大的 seq）判定——只清 ≤ 水位的（本轮确实看过的），
// 水位之后新到的不动。外加：回复某条后立即把它移出未读。
//
// 这里用纯函数复刻两处逻辑，锁住行为（bridge.js 无法单独 import）。
import fs from 'node:fs';

let pass = 0, fail = 0;
const check = (n, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };

// ── 复刻 mark_read 的清理逻辑（与 bridge.js 里保持一致）──
function cleanupUnread(unread, wakeSeqAt) {
  if (Number(wakeSeqAt) > 0) return unread.filter((m) => Number(m?.seq) > Number(wakeSeqAt));
  return []; // 拿不到水位时保守清空
}

console.log('── 未读清理（核心修复）──');
{
  const unread = [{ seq: 2001 }, { seq: 2002 }, { seq: 2026 }, { seq: 2033 }];
  // 水位 = 唤醒时最大 seq：全部 ≤ 水位 → 全部清掉
  check('水位覆盖全部 → 全清（不再滞留）', cleanupUnread(unread, 2033).length === 0);

  // 水位之后新到的要保留
  const withNew = [...unread, { seq: 2040 }, { seq: 2041 }];
  const kept = cleanupUnread(withNew, 2033);
  check('水位之后新到的不清', kept.length === 2 && kept.every((m) => m.seq > 2033), kept.map((m) => m.seq).join(','));

  // 水位为 0（老状态/异常）→ 保守清空，绝不滞留
  check('无水位时保守清空（防滞留）', cleanupUnread(unread, 0).length === 0);
  check('水位 undefined 也不滞留', cleanupUnread(unread, undefined).length === 0);
  check('空未读返回空', cleanupUnread([], 2033).length === 0);
  check('seq 缺失的条目不误判为新', cleanupUnread([{ seq: 2001 }, {}], 2033).length === 0);
}

console.log('\n── 反例：确认旧逻辑确实是错的 ──');
{
  // 旧实现：filter(m => !pendingSeqs.has(seq))
  const oldCleanup = (unread, pendingSeqs) => pendingSeqs.size
    ? unread.filter((m) => !pendingSeqs.has(Number(m?.seq)))
    : [];
  const unread = [{ seq: 2001 }, { seq: 2002 }, { seq: 2026 }];
  const pending = new Set([2001, 2002]); // 排队中的两条
  const oldKept = oldCleanup(unread, pending);
  // 注释意图是"保留排队中的 2001/2002"，实际保留的是 2026 → 与注释相反
  check('旧逻辑保留下的是非排队的（与注释相反，即 bug）',
    oldKept.length === 1 && oldKept[0].seq === 2026, oldKept.map((m) => m.seq).join(','));
  // 而新逻辑在同场景下把该轮看过的都清掉
  check('新逻辑不再滞留', cleanupUnread(unread, 2026).length === 0);
}

console.log('\n── 回复后立即移出未读 ──');
{
  // 复刻：按 messageId 移除刚回复的那条
  const removeReplied = (unread, repliedMessageId) =>
    unread.filter((m) => String(m?.messageId ?? '') !== String(repliedMessageId));
  const unread = [
    { seq: 2001, messageId: '100002030' },
    { seq: 2002, messageId: '-100002038' },
    { seq: 2026, messageId: '100002039' }
  ];
  const after = removeReplied(unread, '100002030');
  check('被回复的那条被移除', after.length === 2 && !after.some((m) => m.messageId === '100002030'));
  check('其他未读不受影响', after.some((m) => m.messageId === '-100002038'));
  check('数字/字符串 id 都能匹配', removeReplied(unread, 100002039).length === 2);
  check('没有 messageId 时不误删', removeReplied([{ seq: 1 }, { seq: 2 }], '100002030').length === 2);
  check('空列表不抛', removeReplied([], 'x').length === 0);
}

console.log('\n── 唤醒水位计算 ──');
{
  const computeWatermark = (unread) => unread.reduce((mx, m) => Math.max(mx, Number(m?.seq) || 0), 0);
  check('取最大 seq', computeWatermark([{ seq: 10 }, { seq: 30 }, { seq: 20 }]) === 30);
  check('空列表为 0', computeWatermark([]) === 0);
  check('忽略脏数据', computeWatermark([{ seq: 5 }, { seq: 'abc' }, {}]) === 5);
}

console.log('\n── 真实状态快照复盘（若仍在则说明修复前数据）──');
{
  const p = 'state/social-v2.json';
  if (fs.existsSync(p)) {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    const c = j.conversations?.['group:100002005'];
    if (c) {
      const un = (c.unread || []).length;
      const water = Number(c.wakeSeqAt) || 0;
      console.log(`   当前未读 ${un} 条，wakeSeqAt=${water}`);
      // 修复后重启会清掉这批滞留未读；这里只作观察，不做断言
      const last = c.lastAiReplyAt || 0;
      const callers = (c.unread || []).filter((m) => m && !m.isSelf && (m.quoteTargetIsSelf || /@大肥鱼|@dsh/i.test(String(m.text || ''))));
      const answered = callers.filter((m) => (Number(m.time) || 0) <= last + 5000);
      console.log(`   其中 @ 它的 ${callers.length} 条，判定"已答过" ${answered.length} 条`);
    } else {
      console.log('   （该会话不在状态文件里）');
    }
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
