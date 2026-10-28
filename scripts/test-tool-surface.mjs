// T2：工具面计量（count / 字符 / 估算 token / 最大项）。
import assert from 'node:assert/strict';
import { summarizeToolSurface, toolSchemaChars } from '../src/tool-surface.js';

let pass = 0, fail = 0;
const check = (name, fn) => {
  try { fn(); pass++; console.log(`PASS ${name}`); }
  catch (error) { fail++; console.log(`FAIL ${name}  ${error?.message ?? error}`); }
};

const tools = [
  { name: 'a', description: '短描述', inputSchema: { type: 'object', properties: { x: { type: 'string' } } } },
  { name: 'b', description: '比较长的一段描述'.repeat(10), inputSchema: { type: 'object', properties: {} } },
  { name: 'c', description: '', inputSchema: {} }
];

check('单工具字符包含名字/描述/参数', () => {
  const chars = toolSchemaChars(tools[0]);
  assert.ok(chars > tools[0].description.length);
  assert.equal(chars, JSON.stringify({ name: 'a', description: tools[0].description, inputSchema: tools[0].inputSchema }).length);
});

check('汇总数量与总字符一致', () => {
  const s = summarizeToolSurface(tools);
  assert.equal(s.count, 3);
  assert.equal(s.totalChars, tools.reduce((sum, t) => sum + toolSchemaChars(t), 0));
});

check('估算 token 按 3.2 字符/token 向上取整', () => {
  const s = summarizeToolSurface(tools);
  assert.equal(s.estimatedTokens, Math.ceil(s.totalChars / 3.2));
});

check('按体积降序并给出最大 5 项', () => {
  const s = summarizeToolSurface(tools);
  assert.deepEqual(s.largest.map((x) => x.name), ['b', 'a', 'c']);
  assert.ok(s.largest[0].chars > s.largest[1].chars);
});

check('同体积按名称排序（结果稳定）', () => {
  const same = [{ name: 'z', description: '', inputSchema: {} }, { name: 'a', description: '', inputSchema: {} }];
  assert.deepEqual(summarizeToolSurface(same).tools.map((x) => x.name), ['a', 'z']);
});

check('空输入与非法输入不抛错', () => {
  const empty = summarizeToolSurface([]);
  assert.equal(empty.count, 0); assert.equal(empty.totalChars, 0); assert.equal(empty.estimatedTokens, 0);
  assert.equal(summarizeToolSurface(null).count, 0);
});

console.log(fail ? `❌ ${pass} 通过 / ${fail} 失败` : `✅ ${pass} 通过 / 0 失败`);
process.exit(fail ? 1 : 0);
