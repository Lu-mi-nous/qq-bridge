// 回归测试：剥离模型误写进正文的元标记前缀（见 src/meta-marker.js 的设计说明）。
// 重点在**不误伤**：这是改写用户可见文本的功能，误伤比漏剥严重得多。
import { stripLeadingMetaMarker as strip, stripLeadingMetaMarkers as stripAll } from '../src/meta-marker.js';

let pass = 0, fail = 0;
const check = (n, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };

console.log('── 真实案例（应剥）──');
{
  const real = '[[这是玩笑]]这转发也太抬举我了，我要真能撬开韩国银行，还在这儿陪你们聊抽卡？';
  const out = strip(real);
  check('剥掉 [[这是玩笑]]', out === '这转发也太抬举我了，我要真能撬开韩国银行，还在这儿陪你们聊抽卡？', out.slice(0, 40));
  check('真实案例：不带方括号残留', !out.includes('这是玩笑'), out.slice(0, 30));
}
{
  // 桥接归一化把 [[ 砍成 [ 的情况（splitArrayLiteral 的副作用）
  const afterNormalize = '[这是玩笑]]这转发也太抬举我了';
  const out = strip(afterNormalize);
  check('归一化后的 [这是玩笑]] 也剥干净', out === '这转发也太抬举我了', out);
}
{
  check('单括号 [这是玩笑]', strip('[这是玩笑]哈哈') === '哈哈');
  check('带前导空格', strip('  [[备注]]正文') === '正文');
  check('newline 开头', strip('\n[[内部]]正文') === '正文');
  check('[note]', strip('[note]hello') === 'hello');
  check('[内部提示]', strip('[内部提示]正文') === '正文');
}

console.log('\n── 必须放行（不能剥）──');
{
  const cases = [
    ['[图片]', '[图片]'],
    ['[doge]这个梗我熟', '[doge]这个梗我熟'],
    ['[笑]哈哈哈', '[笑]哈哈哈'],
    ['[[链接]]', '[[链接]]'],                       // Markdown 双链，正常内容
    ['[1] 第一条', '[1] 第一条'],                     // 列表编号
    ['【内部信息不外泄】', '【内部信息不外泄】'],        // 中文方括号是另一套，不碰
    ['这转发也太抬举我了', '这转发也太抬举我了'],        // 无标记
    ['前面有字[这是玩笑]后面', '前面有字[这是玩笑]后面'], // 不在开头，不剥
    ['[这是一个很长的句子内容测试文本超过二十个字了]正文', '[这是一个很长的句子内容测试文本超过二十个字了]正文'], // 超长不剥
    ['[这是玩笑，你别当真]正文', '[这是玩笑，你别当真]正文'], // 含标点=像正常句
  ];
  for (const [input, want] of cases) {
    const out = strip(input);
    check(`放行 ${JSON.stringify(input).slice(0, 30)}`, out === want, out === want ? '' : `得到 ${JSON.stringify(out)}`);
  }
}

console.log('\n── 边界与安全 ──');
{
  check('空串', strip('') === '');
  check('null 不抛', strip(null) === '');
  check('undefined 不抛', strip(undefined) === '');
  check('全是标记 → 剥成空（由上层回退）', strip('[[这是玩笑]]') === '');
  check('只有空格', strip('   ') === '   ');

  // 不剥成空：stripAll 会回退原值
  const all = stripAll(['[[这是玩笑]]', '正常消息']);
  check('stripAll 空结果回退原值', all[0] === '[[这是玩笑]]', JSON.stringify(all[0]));
  check('stripAll 正常剥离', all[1] === '正常消息');
  check('stripAll 不改原数组', (() => {
    const src = ['[[这是玩笑]]a'];
    stripAll(src);
    return src[0] === '[[这是玩笑]]a';
  })());
  check('stripAll 非数组原样返回', stripAll(null) === null);

  // 最多连剥两层，防止把 [[[x]]] 反复剥出奇怪结果
  check('连剥两层封顶', strip('[[这是玩笑]][[内部]]正文') === '正文' || strip('[[这是玩笑]][[内部]]正文') === '[[内部]]正文');
}

console.log('\n── 不该动正文中间（只处理开头）──');
{
  const s = '哈哈[[这是玩笑]]你说得对';
  check('中间的双括号保留', strip(s) === s, strip(s));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
