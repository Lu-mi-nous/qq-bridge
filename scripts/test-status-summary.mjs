// 回归测试：状态摘要不能只截开头（引用类消息的指令在末尾）。
//
// 事故（2026-10-21，group:100001033）：群友发
//   "[引用 群友D：[图片]]（被引用的这条消息含 1 个图片/表情。要看到它请调用
//    mcp__snowluma__qq_get_message_images，参数 key="…", messageId="…"）@大肥鱼 超分一下"
// 桥接把它判成 atMention 唤醒（判定是对的），但【此刻状态】只显示前 30 字 →
// 模型看到的是"引用…请调用工具…"，**完全看不到「@大肥鱼 超分一下」**，
// 于是输出「群里正聊游戏，没点我」就收尾了。用户感受就是"@它不回"。
//
// 修法：短消息原样；长消息保留开头 24 字 + 末尾 36 字（指令通常在末尾）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0, fail = 0;
const check = (n, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(root, 'src/bridge.js'), 'utf8');

// 复刻实现（与 bridge.js 中 showText / lastSummary 保持一致）
const summarize = (text) => {
  const t = String(text ?? '').trim();
  if (t.length <= 60) return t;
  return `${t.slice(0, 24)}…${t.slice(-36)}`;
};

console.log('── 1. 事故原文必须露出指令 ──');
{
  const real = '[引用 群友D：[图片]]（被引用的这条消息含 1 个图片/表情。要看到它请调用 mcp__snowluma__qq_get_message_images，参数 key="group:100001033", messageId="-1669323357"）@大肥鱼 超分一下';
  const out = summarize(real);
  check('含 @大肥鱼', out.includes('@大肥鱼'), out);
  check('含指令「超分一下」', out.includes('超分一下'));
  check('长度可控（不超过 65）', out.length <= 65, `len=${out.length}`);
  check('旧实现（只截前 30）会丢指令，作为对照', !real.slice(0, 30).includes('超分一下'));
}

console.log('\n── 2. 短消息原样保留，不加省略号 ──');
{
  check('短句原样', summarize('在的') === '在的');
  check('刚好 60 字不截断', summarize('哈'.repeat(60)) === '哈'.repeat(60));
  check('61 字开始截断', summarize('哈'.repeat(61)).includes('…'));
  check('空串安全', summarize('') === '');
  check('null 安全', summarize(null) === '');
  check('首尾空白被 trim', summarize('  你好  ') === '你好');
}

console.log('\n── 3. bridge.js 里两处摘要都用了新逻辑 ──');
{
  check('findCallers 用 showText（保头保尾）', /const showText = \(m\) => \{[\s\S]{0,240}?t\.slice\(-36\)/.test(src));
  check('findCallers 的 fmt 调用 showText', /\$\{showText\(m\)\}/.test(src));
  check('「最近一条」也保头保尾', /const lastSummary = lastText\.length <= 60 \? lastText : `\$\{lastText\.slice\(0, 24\)\}…\$\{lastText\.slice\(-36\)\}`/.test(src));
  check('不再存在"只截开头 30 字"的状态摘要',
    !/statusBits\.push\(`最近一条来自[`][^`]*slice\(0, 30\)/.test(src));
  const oldFmt = /const fmt = \(m\) => `[^`]*slice\(0, 30\)`/.exec(src);
  check('calledBy 的旧 fmt 已移除', !oldFmt, oldFmt ? oldFmt[0].slice(0, 60) : '');
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
