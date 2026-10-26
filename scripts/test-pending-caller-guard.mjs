// 回归测试：沉睡/已读收尾的硬拦截，只能拦「还没答过」的 @。
//
// 背景（2026-10-12 用户第三次反馈，截图原文「这两下 @ 我都应过了，管理员的「在的」、
// 喊口号那个也拒了」）：
// 这条是**被桥接逼出来的**，不是模型自己想总结自己。转录里的完整因果链
// （群 100002015，事件 17398~17410）：
//   1. 模型 qq_wait_for_messages 完成观察窗口
//   2. 模型 qq_set_wake_config 想潜水 → 被拒，报错原文：
//      「未读里有人在叫你，不能先潜水走人：…。请先正面回应…；
//        如果确实没法回应，**也要先发一句说明**」
//   3. 模型照做，发了那条「这两下 @ 我都应过了…」——它能"说明"的只有自己的调度状态
//
// 根因：findCallersV2 把未读里的 @ 分成 answered（已答过）/ pending（还没答），
// 但拦截判的是 **callerMsgs.length（总数）**，没看 pending。拿当时的真实状态复现：
//   unread 中被判定为「在叫我」: 2 条（seq=1220 Lu-mi-nous、seq=1226 小莫姬）
//   answered: 2    pending: 0
//   => 旧判据 callerMsgs.length = 2 → 拦截（明明都答过了）
// 那两条 @ 之所以还在未读里，是因为模型用 qq_send_message 回复时没带
// replyToMessageId，而未读清理只在 quotedInfo?.messageId != null 时才执行
// （bridge.js 的 send 端点）——于是旧 @ 长期滞留，每轮想收尾都被拦。
//
// 这个测试直接 import pipeline/wake.js 的真实实现，避免复制品与产品代码漂移。
import fs from 'node:fs';
import { findPendingCallers } from '../src/pipeline/wake.js';
import { readConsoleSource } from './lib/console-src.mjs';

let pass = 0, fail = 0;
const check = (n, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };

const consoleServer = readConsoleSource();

// ── 1. import 真实判定；只替换别名来源 ──
const findCallersV2 = (_key, st) => findPendingCallers(st, {
  all: ['大肥鱼', ...(st?.wakeConfig?.triggers?.keywords || [])]
});

// ── 2. 断言两处拦截都只看 pending ──────────────────────────────────────────
// 直接检查源码：拦截条件里不得再出现 callerMsgs.length / callerMsgs2.length
{
  const badMark = /if\s*\(\s*callerMsgs\.length\s*&&/.test(consoleServer);
  const badWake = /if\s*\(\s*callerMsgs2\.length\s*&&/.test(consoleServer);
  check('qq_mark_read 拦截条件不再用 callerMsgs.length', !badMark);
  check('qq_set_wake_config 拦截条件不再用 callerMsgs2.length', !badWake);
  check('qq_mark_read 拦截改用 callerMsgs.pending.length',
    /if\s*\(\s*callerMsgs\.pending\.length\b/.test(consoleServer));
  check('qq_set_wake_config 拦截改用 callerMsgs2.pending.length',
    /if\s*\(\s*callerMsgs2\.pending\.length\b/.test(consoleServer));
  // 2026-10-22 回归：pending 已按 lastAiReplyAt 判定「答没答过」，不能再叠
  // “本轮发过言”这种更宽的判据——早于新 @ 的回复也会让它成立，导致 @ 被标读。
  check('拦截条件不再依赖 repliedThisTurn（回复早于新 @ 时也必须拦）',
    !/!\s*repliedThisTurn2?\b/.test(consoleServer));
}

// 诱导性措辞必须已从两处报错里移除（它正是"总结自己"的诱因）
{
  const occurrences = (consoleServer.match(/也要先发一句说明/g) || []).length;
  check('报错里不再出现「也要先发一句说明」（诱导来源）', occurrences === 0, `出现 ${occurrences} 次`);
  check('报错改为要求「说给对方听，不要报告处理流程」',
    (consoleServer.match(/不要报告自己的处理流程或调度状态/g) || []).length >= 2,
    `出现 ${(consoleServer.match(/不要报告自己的处理流程或调度状态/g) || []).length} 次`);
}


// answeredSeqs 往返/旧格式恢复由 test-social-state.mjs 覆盖。
// ── 3. 用真实故障现场的数据验证判定 ────────────────────────────────────────
const RE = 1791782044023;                 // 真实 lastAiReplyAt（13:14:04 那条发送）
const msg = (seq, text, time, extra = {}) => ({
  seq, text, plain: text, time, sender: '群友', isSelf: false, ...extra
});

console.log('\n── 真实故障现场（群 100002015，unread 快照）──');
{
  // 复刻当时的两条 @：都在 lastAiReplyAt 之前 → 都算 answered
  const st = {
    lastAiReplyAt: RE,
    wakeConfig: { triggers: { keywords: [] } },
    unread: [
      msg(1220, '@大肥鱼', RE - 60000),
      msg(1226, '@大肥鱼', RE - 50000),
    ]
  };
  const c = findCallersV2('group:1', st);
  check('两条 @ 都被识别为「在叫我」', c.length === 2, String(c.length));
  check('两条都算 answered（都回过）', c.answered.length === 2, `answered=${c.answered.length}`);
  check('pending 为空', c.pending.length === 0, `pending=${c.pending.length}`);

  // 这就是 bug：旧判据用总长度 → 拦截；新判据用 pending → 放行
  const oldBlocked = c.length > 0;
  const newBlocked = c.pending.length > 0;
  check('旧判据会拦截（复现 bug）', oldBlocked === true);
  check('新判据不再拦截（修复生效）', newBlocked === false);
}

console.log('\n── 还有人没答时必须仍然拦截（别把拦截改没了）──');
{
  const st = {
    lastAiReplyAt: RE,
    wakeConfig: { triggers: { keywords: [] } },
    unread: [
      msg(1220, '@大肥鱼', RE - 60000),          // 已答过
      msg(1240, '@大肥鱼 在吗', RE + 30000),     // 新来的，还没答
    ]
  };
  const c = findCallersV2('group:1', st);
  check('已答过的进 answered', c.answered.length === 1, `answered=${c.answered.length}`);
  check('没答的进 pending', c.pending.length === 1, `pending=${c.pending.length}`);
  check('仍然拦截（pending 非空）', c.pending.length > 0);
  check('报错里点名的是没答的那条', String(c.pending[0].text).includes('在吗'));
}

console.log('\n── 2026-10-22：本轮早先发过言，之后才来新 @（repliedThisTurn 放行 bug）──');
{
  // 真实时间线：20:14:38 发过言 → 20:18:59 群友 @ 它 → 20:20:51 wait 结束想 mark_read。
  const lastReply = RE;                       // 20:14:38 的发言
  const wakeAt = RE - 240000;                 // 本轮唤醒早于发言
  const atTime = RE + 261000;                 // 20:18:59 的新 @
  const st = {
    lastAiReplyAt: lastReply,
    lastActionAt: lastReply,
    wakeConfig: { lastWakeAt: wakeAt, triggers: { keywords: [] } },
    unread: [msg(8071, '@大肥鱼 从 aigengtu 找几张 DeepSeek 娘的表情包存起来', atTime, { atSelf: true })]
  };
  const c = findCallersV2('group:100002004', st);
  check('新 @ 在 lastAiReplyAt 之后 → pending', c.pending.length === 1, `pending=${c.pending.length}`);
  const oldRepliedThisTurn = !!st.lastActionAt && st.lastActionAt >= (st.wakeConfig.lastWakeAt || 0);
  check('旧判据的 repliedThisTurn 为 true（复现放行）', oldRepliedThisTurn === true);
  check('旧组合判据 pending && !repliedThisTurn 不拦截（复现 bug）',
    (c.pending.length > 0 && !oldRepliedThisTurn) === false);
  check('新判据只凭 pending 拦截（修复生效）', c.pending.length > 0);
}

console.log('\n── 2026-10-23：引用回复了 A，不代表更新的 B 答过了 ──');
{
  // 真实时间线：16:13:24 引用回复 seq7061；owner 16:13:18 的「查下来源」
  // seq7064 时间更早、但序号更新。旧时间判据把它算 answered，mark_read 标掉。
  const replyAt = RE;
  const st = {
    lastAiReplyAt: replyAt,
    answeredSeqs: [7061],
    wakeConfig: { triggers: { keywords: [] } },
    unread: [
      msg(7061, '@大肥鱼 自慰', replyAt - 14000),
      msg(7064, '@大肥鱼 查下来源', replyAt - 6000),
      msg(7066, '@大肥鱼 继续学吗', replyAt + 10000)
    ]
  };
  const c = findCallersV2('group:100002005', st);
  check('引用目标 7061 算 answered', c.answered.some((m) => m.seq === 7061));
  check('更新的 7064 仍算 pending（引用回复没答它）', c.pending.some((m) => m.seq === 7064));
  check('回复之后才到的 7066 也算 pending', c.pending.some((m) => m.seq === 7066));
  check('旧时间判据会把 7064 误判已答（复现 bug）',
    (replyAt && (replyAt - 6000) <= replyAt + 5000) === true);
  check('新判据只认明确引用回复的 seq，7064 仍待答', c.pending.some((m) => m.seq === 7064));
  // 严格模式：answeredSeqs 存在（哪怕是空数组）时，不再用时间猜。
  const strict = findCallersV2('group:100002005', { ...st, answeredSeqs: [] });
  check('answeredSeqs 为空时所有未答 @ 都 pending', strict.pending.length === 3, `pending=${strict.pending.length}`);
}

console.log('\n── 边界：从来没有过发言（lastAiReplyAt=0）──');
{
  const st = {
    lastAiReplyAt: 0,
    wakeConfig: { triggers: { keywords: [] } },
    unread: [msg(1, '@大肥鱼', Date.now() - 1000)]
  };
  const c = findCallersV2('group:1', st);
  check('没发过言时 @ 一律算 pending（必须拦）', c.pending.length === 1 && c.answered.length === 0,
    `pending=${c.pending.length} answered=${c.answered.length}`);
}

console.log('\n── 拍一拍不算「在叫你」（历史坑，防回归）──');
{
  const st = {
    lastAiReplyAt: RE,
    wakeConfig: { triggers: { keywords: [] } },
    unread: [msg(1300, '[拍一拍] 群友B 戳了戳 你', RE - 10000)]
  };
  const c = findCallersV2('group:1', st);
  check('拍一拍不进 callers', c.length === 0, String(c.length));
}

console.log('\n── 引用机器人自己的消息算 pending（明确在跟你说话）──');
{
  const st = {
    lastAiReplyAt: RE,
    wakeConfig: { triggers: { keywords: [] } },
    unread: [msg(1310, '这句怎么说', RE + 10000, { quoteTargetIsSelf: true })]
  };
  const c = findCallersV2('group:1', st);
  check('引用自己 → 算在叫我', c.length === 1);
  check('引用自己且未答 → pending', c.pending.length === 1);
}

console.log('\n── 别名来自唤醒关键词也算 ──');
{
  const st = {
    lastAiReplyAt: RE,
    wakeConfig: { triggers: { keywords: ['小鲸鱼'] } },
    unread: [msg(1320, '@小鲸鱼 出来', RE + 10000)]
  };
  const c = findCallersV2('group:1', st);
  check('关键词别名被识别', c.pending.length === 1, `pending=${c.pending.length}`);
}

console.log('\n── 时钟容差 5 秒（回复与消息同刻不应算 pending）──');
{
  const st = {
    lastAiReplyAt: RE,
    wakeConfig: { triggers: { keywords: [] } },
    unread: [msg(1330, '@大肥鱼', RE + 3000)]     // 在容差内
  };
  const c = findCallersV2('group:1', st);
  check('容差内的算已答', c.answered.length === 1 && c.pending.length === 0,
    `answered=${c.answered.length} pending=${c.pending.length}`);
  const st2 = {
    lastAiReplyAt: RE,
    wakeConfig: { triggers: { keywords: [] } },
    unread: [msg(1331, '@大肥鱼', RE + 6000)]     // 超出容差
  };
  const c2 = findCallersV2('group:2', st2);
  check('超出容差的算 pending', c2.pending.length === 1);
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
