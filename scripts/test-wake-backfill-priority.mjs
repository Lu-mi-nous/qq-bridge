// 回归测试：繁忙期间积压的唤醒，补发时必须**按优先级选**，不能按 FIFO。
//
// 背景（2026-10-11 用户反馈「群里 @ 它不是必回」）：
// 实测群 100002007 的日志——用户 16:08:31 @ 机器人（atMention@seq20893），
// 那一刻会话正忙，唤醒被暂存。但 16:08:46 补发时**只 shift() 最旧一条**，
// 取到了 anyMessage@20779（或 poke@20871），用户的 @ 被留在队列里，
// 直到 16:10:01 才被处理 —— 延迟 90 秒，感受就是「@ 不理人」。
//
// 修法：在「触发消息仍在未读里」的项中，挑**优先级最高**的补发（同级取 seq 最新）；
// 且不再一次只补一条就把其余丢掉。
//
// 为什么这个测试值得写：这是**静默**故障——机器人最终确实回了，只是晚 90 秒，
// 日志里两条「暂存/补发」看着都正常，只有把队列按优先级重排才发现选错了项。

let pass = 0, fail = 0;
const check = (n, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };

import { WAKE_PRIORITY, wakePriorityV2, pickPendingWake as pickHighest } from '../src/pipeline/wake.js';

console.log('── 优先级表（真实模块）──');
{
  check('表里含 atMention', WAKE_PRIORITY.atMention !== undefined, '=' + WAKE_PRIORITY.atMention);
  check('表里含 question', WAKE_PRIORITY.question !== undefined, '=' + WAKE_PRIORITY.question);
  check('@ 高于提问', wakePriorityV2('atMention') > wakePriorityV2('question'));
  check('提问高于 anyMessage', wakePriorityV2('question') > wakePriorityV2('anyMessage'));
  check('@ 高于 anyMessage', wakePriorityV2('atMention') > wakePriorityV2('anyMessage'));
  check('私聊最高', wakePriorityV2('private') >= wakePriorityV2('atMention'));
  // 2026-10-21 更新：`poke` 已进优先级表（35，"拍别人"低于普通消息但高于兜底）。
  // 原因是「拍你」被拆成了独立的 `pokeSelf`(85)——拍别人只是群里热闹，看一眼就好；
  // 而完全未知的原因（如 probability）才是真正的 0。
  check('未知原因（probability）最低', wakePriorityV2('probability') === 0,
    String(wakePriorityV2('probability')));
  check('poke（拍别人）低于普通消息但高于兜底',
    wakePriorityV2('poke') > 0 && wakePriorityV2('poke') < wakePriorityV2('anyMessage'),
    `poke=${wakePriorityV2('poke')} anyMessage=${wakePriorityV2('anyMessage')}`);
  check('拍自己（pokeSelf）仅次于 @',
    wakePriorityV2('pokeSelf') < wakePriorityV2('atMention')
    && wakePriorityV2('pokeSelf') > wakePriorityV2('question'),
    `pokeSelf=${wakePriorityV2('pokeSelf')}`);
  check('带子类型前缀也能识别（keyword:大肥鱼）', wakePriorityV2('keyword:大肥鱼') === wakePriorityV2('keyword'));
}

console.log('\n── 真实故障现场（16:08:46 那一刻的队列）──');
{
  const queue = [
    { reason: 'anyMessage', seq: 20779 },
    { reason: 'poke', seq: 20871 },
    { reason: 'question', seq: 20808 },
    { reason: 'question', seq: 20813 },
    { reason: 'probability', seq: 20815 },
    { reason: 'anyMessage', seq: 20829 },
    { reason: 'probability', seq: 20832 },
    { reason: 'atMention', seq: 20893 },
  ];
  const unread = new Set([...Array(30).keys()].map((i) => 20868 + i));
  const oldPick = queue[0];                        // 旧逻辑：shift() 取最旧
  const newPick = pickHighest(queue, unread);
  check('旧逻辑会取到 anyMessage（复现 bug）', oldPick.reason === 'anyMessage', oldPick.reason);
  check('新逻辑选出 atMention', newPick.reason === 'atMention', `${newPick.reason}@${newPick.seq}`);
  check('新逻辑选中用户 @ 的那条 seq', newPick.seq === 20893, String(newPick.seq));
}

console.log('\n── 优先级排序各种组合 ──');
{
  const cases = [
    [['poke', 'atMention'], 'atMention', '@ 压过拍一拍'],
    [['probability', 'question'], 'question', '提问压过概率'],
    [['anyMessage', 'question'], 'question', '提问压过任意消息'],
    [['replyCheck', 'atMention'], 'atMention', '@ 压过回复检查'],
    // poke(35) 现在高于 probability(0)，所以选 poke。
    // 「同优先级取最新」这条规则本身仍由下面 probability vs 未知原因 的用例覆盖。
    [['poke', 'probability'], 'poke', '拍别人压过未知原因'],
    [['probability', 'unknownReasonX'], 'unknownReasonX', '同为最低优先级时取最新的那条'],
  ];
  for (const [reasons, want, label] of cases) {
    const q = reasons.map((r, i) => ({ reason: r, seq: 100 + i }));
    const got = pickHighest(q, new Set());
    check(label, got.reason === want, `选出 ${got.reason}，期望 ${want}`);
  }
}

console.log('\n── 同级取最新（更能代表当前意图）──');
{
  const q = [{ reason: 'atMention', seq: 100 }, { reason: 'atMention', seq: 200 }];
  check('同优先级取 seq 大的', pickHighest(q, new Set()).seq === 200);
}

console.log('\n── 「被读过」不等于「已回复」，别丢 @ ──');
{
  // seq 10 的 @ 已被本回合读过（移出 unread），但未读里还有 seq 200 的更新消息。
  // 判定「仍相关」用的是「未读里存在 seq >= 该项 seq」——所以 seq=10 仍算相关，
  // 因为话题明显还在继续（后面还有新消息）。这正是修复的目的：
  // 绝不能因为「消息被读过」就把 @ 静默丢掉（旧逻辑就是这么丢的）。
  const q = [{ reason: 'atMention', seq: 10 }, { reason: 'question', seq: 200 }];
  const got = pickHighest(q, new Set([200]));
  check('@ 被读过但话题仍在时，@ 仍参与竞争', got.reason === 'atMention', `选出 ${got.reason}@${got.seq}（seq=200 也在池里）`);
  // 反向：只有已处理项、且未读里没有更新的消息时，才退而选它（不静默丢弃）
  const q2 = [{ reason: 'question', seq: 300 }];
  check('未读里没有更新的消息时仍会补发（不丢弃）', pickHighest(q2, new Set([100]))?.reason === 'question');
}

console.log('\n── 边界 ──');
{
  check('空队列返回 null', pickHighest([], new Set()) === null);
  check('全是已处理项时仍选一个（不静默丢弃）', (() => {
    const q = [{ reason: 'atMention', seq: 1 }];
    return pickHighest(q, new Set([999])) !== null;
  })());
  check('未读为空时不崩', (() => {
    const q = [{ reason: 'atMention', seq: 1 }];
    return pickHighest(q, new Set())?.reason === 'atMention';
  })());
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
