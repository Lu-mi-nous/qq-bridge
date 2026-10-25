// 一次性回归：验证消息输入归一化（含「内层直引号未转义」这一线上事故的修复）。
// 2026-10-24 第 3 步：实现已抽到 src/pipeline/text-normalize.js，bridge 与 MCP 共用；
// 本测试直接 import 模块做行为断言，不再从两个源文件抽源码求值。
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { normalizeMessagesInput } from '../src/pipeline/text-normalize.js';

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  const ok = g === w;
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`        got=${g}\n       want=${w}`);
};

const root = fileURLToPath(new URL('..', import.meta.url));

const mcpSrc = fs.readFileSync(root + 'src/mcp-snowluma-safe.js', 'utf8');

console.log('── 0. 两个入口共用同一实现 ──');
{
  
  check('MCP 引入 text-normalize',
    /from '\.\/pipeline\/text-normalize\.js'/.test(mcpSrc), true);
}

console.log('\n── 1. 归一化行为 ──');
{
  // 1) 线上事故原文：内层直引号未转义 → JSON.parse 必失败
  const incident = '["搜不到呀，B站那个链接我打不开，只看到个标题","而且这名字好怪，"Extreme Gen6"听着像爆料号自己编的，你直接说重点吧，是不是又想让我夸这芯片"]';
  const r1 = normalizeMessagesInput(incident);
  check('事故原文 → 拆成 2 条（不再整串发出）', r1.length, 2);
  check('  第 1 条内容正确', r1[0], '搜不到呀，B站那个链接我打不开，只看到个标题');
  check('  第 2 条含未转义引号原文', r1[1].includes('"Extreme Gen6"'), true);

  // 2) 正常 JSON 数组字符串
  check('合法数组字符串 → 2 条', normalizeMessagesInput('["在的","叫我干嘛"]'), ['在的', '叫我干嘛']);

  // 3) 单条 JSON 字符串
  check('单条转义字符串 → 1 条', normalizeMessagesInput('"你好"'), ['你好']);

  // 4) 已经是数组
  check('数组入参原样', normalizeMessagesInput(['a', 'b']), ['a', 'b']);

  // 5) 纯文本
  check('纯文本 → 1 条', normalizeMessagesInput('就一句话'), ['就一句话']);

  // 6) 空值
  check('null → 空', normalizeMessagesInput(null), []);
  check('空串 → 空', normalizeMessagesInput('   '), []);

  // 7) 数组含空元素被过滤
  check('过滤空元素', normalizeMessagesInput(['a', '', '  ', 'b']), ['a', 'b']);

  // 8) 斜杠/转义等特殊字符不被破坏
  check('斜杠保留', normalizeMessagesInput('["路径 C:\\\\tmp","a/b"]'), ['路径 C:\\tmp', 'a/b']);

  // 9) 三条 + 内层未转义引号
  const r9 = normalizeMessagesInput('["一","他说"二"了","三"]');
  check('3 条含未转义引号', r9.length, 3);

  // 10) 中文逗号不应被当作分隔
  check('中文逗号不误切', normalizeMessagesInput('["你好，世界","第二条"]'), ['你好，世界', '第二条']);

  // 11) 以 `[` 开头的**正常正文**不能被当成 JSON 数组字面量。
  // 2026-10-09 用真实端点验证时抓到的静默数据损坏：容错分支原先只看"以 [ 开头"，
  // 把任何方括号开头的文本都切成了数组 —— `[图片]` 变成 `图片`、`[doge]…` 变成 `doge]…`。
  // 判据补上「必须含引号」后修复（真数组字面量的元素一定带引号）。这些用例防回归。
  check('[图片] 原样保留', normalizeMessagesInput('[图片]'), ['[图片]']);
  check('[doge] 原样保留', normalizeMessagesInput('[doge]这个梗我熟'), ['[doge]这个梗我熟']);
  check('[[这是玩笑]]正文 原样保留', normalizeMessagesInput('[[这是玩笑]]正文'), ['[[这是玩笑]]正文']);
  check('[笑] 原样保留', normalizeMessagesInput('[笑]哈哈哈'), ['[笑]哈哈哈']);
  check('[1] 保留', normalizeMessagesInput('[1]'), ['[1]']);
  check('[a,b] 无引号不拆', normalizeMessagesInput('[a,b]'), ['[a,b]']);
  check('含括号的数组元素仍正确', normalizeMessagesInput('["[图片]","接上"]'), ['[图片]', '接上']);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
