// 一次性回归：验证「群友点单」检测逻辑（不写状态、不联网）
// 直接从 bridge.js 抽出正则与判定函数求值，保证测的是真实代码。
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

function grabConst(name) {
  const m = src.match(new RegExp(`const ${name} = /[^\\n]*/[gimsuy]*;`));
  if (!m) throw new Error('const not found: ' + name);
  return m[0];
}
// 抽出整个函数体（到下一个「\n  }」为止，这两个函数内部没有嵌套的同缩进块）
function grabFn(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error('fn not found: ' + name);
  const end = src.indexOf('\n  }\n', start);
  if (end < 0) throw new Error('fn end not found: ' + name);
  return src.slice(start, end + 4);
}

const code = [
  grabConst('COMPLY_REQUEST_RE'),
  grabConst('COMPLY_ARTIFACT_RE'),
  grabConst('COMPLY_NEGATIVE_RE'),
  grabConst('COMPLY_IMPERATIVE_RE'),
  grabConst('COMPLY_SELF_DESC_RE'),
  grabConst('COMPLY_EXPLICIT_RE'),
  grabFn('isAimedAtSelfV2'),
  grabFn('isContentRequestV2'),
].join('\n');

// selfNickname 在真实代码里是闭包变量，这里作为参数注入
const f = new Function('selfNickname', `${code}\nreturn { isContentRequestV2, isAimedAtSelfV2 };`)('dsh');

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
  ['@群友T1 帮我写个文案', atOther, false, false], // 明确冲着别人
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
