// 回归测试：负面评价识别与换图限流（纯逻辑，不依赖网络）。
import { classifyImageFeedback, createFeedbackGate } from '../plugins/images/lib/image-feedback.js';

let pass = 0, fail = 0;
const check = (n, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };

console.log('── 应当识别为差评（句中带图片指代）──');
const yes = [
  ['不好看', '这图不好看'],
  ['难看', '这张难看死了'],
  ['好丑', '这图好丑啊'],
  ['不是我要的', '这张图不是我要的'],
  ['不是这个', '不是这个，换一张'],
  ['换一张', '这张不行，换一张'],
  ['再来一张别的', '有别的图吗，再来一张'],
  ['不喜欢', '我不喜欢这张图'],
  ['发错', '这图是不是发错了'],
  ['敷衍', '太敷衍了吧这图'],
  ['就这', '这图就这？'],
  ['什么鬼', '这图什么鬼'],
  ['看腻', '这个角色的图看腻了'],
];
for (const [label, text] of yes) {
  const r = classifyImageFeedback(text);
  check(`${label}：${text}`, r.negative === true, r.reason);
}

console.log('── 刚发图窗口内（没提"图"字也算，群里最常见的说法）──');
// 传 recentImageMs 即声明「刚发过图」，此时省略说法默认指向该图
for (const [label, text] of [
  ['换一张', '换一张'], ['不好看', '不好看'], ['一般般', '一般般吧'],
  ['好丑', '好丑'], ['不是我要的', '不是我要的'], ['发错了吧', '发错了吧'],
]) {
  const r = classifyImageFeedback(text, { recentImageMs: 30_000 });
  check(`窗口内 ${label}`, r.negative === true, r.reason);
}

console.log('\n── 不该误判（关键）──');
const no = [
  ['夸好看', '挺好看的'],
  ['明确喜欢', '我喜欢这张'],
  ['反问', '不好看吗？我觉得还行'],
  ['维护', '怎么会不好看，明明很棒'],
  ['道谢', '谢谢，辛苦了'],
  ['无关话题且有差评词但没指图', '这游戏太丑了吧，平衡性也差'],
  ['只是还想要', '再来一张'],
  ['空消息', ''],
  ['纯表情占位', '[表情5]'],
  ['否定词但非差评', '这电影不好看'],
  ['闲聊说不喜欢别的东西', '我不喜欢这个游戏的设定'],
];
for (const [label, text] of no) {
  const r = classifyImageFeedback(text);
  check(`${label}：${text}`, r.negative === false, r.reason);
}

console.log('\n── 边界 ──');
check('丑+图 → 命中', classifyImageFeedback('这图好丑').negative === true);
check('喜欢+图 → 不命中（"不喜欢"不该被子串"喜欢"救回）', classifyImageFeedback('我不喜欢这图').negative === true);
check('夸好看不禁用（"好看"不该被子串误伤）', classifyImageFeedback('这图好看').negative === false);
check('"不好看吗"+窗口内 → 不命中（反问优先）',
  classifyImageFeedback('不好看吗', { recentImageMs: 1000 }).negative === false);
check('光说"再来一张"不命中（未提图且无窗口）', classifyImageFeedback('再来一张').negative === false);

console.log('\n── 换图限流 ──');
{
  let t = 0;
  const g = createFeedbackGate({ cooldownMs: 90_000, now: () => t });
  check('首次允许', g.shouldSwap('group:1').allow === true);
  t += 1000;
  check('1 秒后拒绝', g.shouldSwap('group:1').allow === false);
  check('拒绝时给剩余时间', g.shouldSwap('group:1').retryAfterMs > 80_000);
  check('别的群不受影响', g.shouldSwap('group:2').allow === true);
  t += 90_000;
  check('90 秒后允许', g.shouldSwap('group:1').allow === true);
  check('peek 不改记账', (() => { const before = g.peek('group:1').remainingMs; g.peek('group:1'); return g.peek('group:1').remainingMs === before; })());
  // 时间戳为 0 的边界（同 error-notifier 的坑）
  let t2 = 0;
  const g2 = createFeedbackGate({ cooldownMs: 1000, now: () => t2 });
  check('时间戳 0 时首次允许', g2.shouldSwap('k').allow === true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
