// 一次性回归：验证「群友点单」检测逻辑（不写状态、不联网）
// 直接调用真实导出的点单策略。
import { createContentRequestPolicy } from '../src/pipeline/content-request.js';
const f = createContentRequestPolicy({ getSelfNickname: () => 'dsh' });

const atSelf = { message: [{ type: 'at', data: { qq: '999' } }], self_id: '999' };
const atOther = { message: [{ type: 'at', data: { qq: '123' } }], self_id: '999' };
const none = { message: [], self_id: '999' };

const cases = [
  // 应命中的点单
  ['帮我写个文案', atSelf, false, true],
  ['写一首关于猫的诗', atSelf, false, true],
  ['来个周报模板', atSelf, false, true],
  ['帮我总结一下今天的聊天', atSelf, false, true],
  ['你能帮我生成一个正则吗', atSelf, false, true],
  ['帮我写个文案', none, true, true],        // 引用了机器人
  ['写个 python 脚本', none, false, true],    // 祈使句起手
  ['帮我改改这段', none, false, true],
  // 不该命中的
  ['@张三 帮我写个文案', atOther, false, false], // 明确冲着别人
  ['哈哈哈哈', atSelf, false, false],
  ['今天天气不错', atSelf, false, false],
  ['这个个别产品挺特别', atSelf, false, false],  // 裸「别」不误伤
  ['不用了谢谢', atSelf, false, false],
  ['别写了', atSelf, false, false],
  ['我想写代码', atSelf, false, false],          // 自述，非请求
];

let pass = 0, fail = 0;
for (const [text, ev, quote, want] of cases) {
  const aimed = f.isAimedAtSelfV2(text, ev, quote);
  const got = f.isContentRequestV2(text, aimed);
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  want=${String(want).padEnd(5)} got=${String(got).padEnd(5)} aimed=${String(aimed).padEnd(5)} | ${text}`);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
