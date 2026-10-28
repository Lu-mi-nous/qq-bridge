// T4：工具结果预算（按工具裁剪超长文本结果）。
import assert from 'node:assert/strict';
import { capToolResultText, capToolResult, bindToolResultBudget, DEFAULT_TOOL_RESULT_BUDGET, TOOL_RESULT_BUDGETS } from '../src/tool-result-budget.js';

let pass = 0, fail = 0;
const check = (name, fn) => {
  try { fn(); pass++; console.log(`PASS ${name}`); }
  catch (error) { fail++; console.log(`FAIL ${name}  ${error?.message ?? error}`); }
};

check('未超预算原样返回', () => {
  const text = 'x'.repeat(100);
  assert.equal(capToolResultText(text, 200), text);
});

check('超预算保留头尾并标注省略字符数', () => {
  const text = 'A'.repeat(1000) + 'B'.repeat(1000);
  const out = capToolResultText(text, 500);
  assert.ok(out.length < text.length);
  assert.ok(out.startsWith('A'.repeat(100)));
  assert.ok(out.endsWith('B'.repeat(100)));
  assert.match(out, /结果超预算：已省略中间 \d+ 字符/);
  assert.match(out, /需要更多请翻页\/缩小范围/);
});

check('预算下限 200 字符', () => {
  const out = capToolResultText('x'.repeat(500), 10);
  assert.ok(out.length >= 200 && out.length < 500);
});

check('按工具预算裁剪文本、图片不动', () => {
  const big = 'y'.repeat(TOOL_RESULT_BUDGETS.qq_get_unread_messages + 100);
  const image = { type: 'image', mimeType: 'image/png', data: 'BASE64' };
  const result = { content: [{ type: 'text', text: big }, image] };
  const out = capToolResult('qq_get_unread_messages', result);
  assert.ok(out.content[0].text.length < big.length);
  assert.deepEqual(out.content[1], image);
  assert.equal(out.isError, undefined);
});

check('未知工具用默认预算；小结果不动', () => {
  const small = { content: [{ type: 'text', text: 'ok' }] };
  assert.equal(capToolResult('qq_whatever', small), small);
  const big = { content: [{ type: 'text', text: 'z'.repeat(DEFAULT_TOOL_RESULT_BUDGET * 2) }] };
  assert.ok(capToolResult('qq_whatever', big).content[0].text.length < big.content[0].text.length);
});

check('无 content 的结果原样返回', () => {
  assert.deepEqual(capToolResult('qq_x', { ok: false }), { ok: false });
  assert.equal(capToolResult('qq_x', null), null);
});

check('bindToolResultBudget 兼容两种注册签名', async () => {
  const registered = new Map();
  const server = { tool: (name, ...args) => { registered.set(name, args); return { name }; } };
  bindToolResultBudget(server, { budgets: { demo: 300 }, defaultMax: 1000 });
  // 4 参签名
  server.tool('demo', 'desc', { type: 'object' }, async () => ({ content: [{ type: 'text', text: 'a'.repeat(600) }] }));
  const args4 = registered.get('demo');
  assert.equal(args4[0], 'desc');
  const r4 = await args4[2]({});
  assert.ok(r4.content[0].text.length <= 320);
  // 3 参签名
  server.tool('demo2', { type: 'object' }, async () => ({ content: [{ type: 'text', text: 'b'.repeat(2000) }] }));
  const args3 = registered.get('demo2');
  const r3 = await args3[1]({});
  assert.ok(r3.content[0].text.length <= 1020);
});

console.log(fail ? `❌ ${pass} 通过 / ${fail} 失败` : `✅ ${pass} 通过 / 0 失败`);
process.exit(fail ? 1 : 0);
