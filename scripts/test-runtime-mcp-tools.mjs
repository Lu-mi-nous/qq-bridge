import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPluginRuntime } from '../src/plugin-runtime.js';
import { createPluginContext } from '../src/plugins/context.js';
import { registerSearchTool } from '../plugins/web-search/mcp-tools.js';

let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log(`PASS ${name}`); };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-runtime-mcp-'));
const runtimes = [];
try {
  const ctx = (permissions, mcpTools) => createPluginContext({ root: tmp, manifest: { id: 'demo', permissions, mcpTools } });
  await check('注册必须有权限及名称声明', () => {
    assert.throws(() => ctx([], ['demo_tool']).mcp.registerTool('demo_tool', 'demo', {}, () => {}), /未声明权限/);
    assert.throws(() => ctx(['mcp:register'], []).mcp.registerTool('demo_tool', 'demo', {}, () => {}), /未声明 MCP/);
    const c = ctx(['mcp:register'], ['demo_tool']); c.mcp.registerTool('demo_tool', 'demo', {}, () => {});
    assert.throws(() => c.mcp.registerTool('demo_tool', 'demo', {}, () => {}), /重复/);
  });
  fs.writeFileSync(path.join(tmp, 'package.json'), '{"type":"module","version":"0.6.0"}');
  const dir = path.join(tmp, 'plugins/demo'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ id: 'demo', version: '1', configPath: 'demo', permissions: ['mcp:register'], mcpTools: ['demo_tool'] }));
  fs.writeFileSync(path.join(dir, 'index.js'), `let serial = 0;
    export function create(ctx) {
      const generation = ++serial;
      ctx.mcp.registerTool('demo_tool', 'fixture', {}, () => ({ generation }), { isEnabled: () => ctx.config.get().enabled !== false });
      return {};
    }`);
  let disabled = [], enabled = true;
  const runtime = createPluginRuntime({ root: tmp, dirs: [path.dirname(dir)], getConfig: () => ({ plugins: { disabled }, demo: { enabled } }) }); runtimes.push(runtime);
  await check('启动前不暴露工具', () => assert.deepEqual(runtime.mcpTools(), []));
  await runtime.start(); const tool = runtime.mcpTools()[0];
  await check('运行时提供描述和有效处理器', () => {
    assert.equal(tool.name, 'demo_tool'); assert.equal(tool.description, 'fixture'); assert.equal(tool.handler().generation, 1);
  });
  disabled = ['demo'];
  await check('宿主禁用同时隐藏并拒绝旧处理器', () => { assert.deepEqual(runtime.mcpTools(), []); assert.equal(tool.handler().isError, true); });
  disabled = []; enabled = false;
  await check('业务关闭同样拒绝旧处理器', () => { assert.deepEqual(runtime.mcpTools(), []); assert.equal(tool.handler().isError, true); });
  enabled = true;
  await runtime.stop();
  await check('停止后旧处理器不可执行', () => assert.equal(tool.handler().isError, true));
  await runtime.start();
  await check('重启后查询新实例', () => assert.equal(tool.handler().generation, 2));
  await runtime.stop();
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ id: 'demo', version: '1', permissions: ['mcp:register'], mcpTools: [] }));
  await runtime.start();
  await check('声明缺失导致加载失败且不暴露工具', () => { assert.equal(runtime.list()[0].status, 'failed'); assert.deepEqual(runtime.mcpTools(), []); assert.equal(tool.handler().isError, true); });
  const absent = createPluginRuntime({ root: tmp, dirs: [path.join(tmp, 'absent')] }); runtimes.push(absent); await absent.start();
  await check('插件目录缺席不产生工具', () => assert.deepEqual(absent.mcpTools(), []));

  const searchCtx = createPluginContext({ root: tmp, manifest: { id: 'web-search', permissions: ['mcp:register'], mcpTools: ['web_search'] } });
  let result = { query: '天气', engine: 'weather', results: [{ title: '天气' }], tried: [] };
  registerSearchTool(searchCtx, { searchWeb: async () => result, sanitizeQuery: q => String(q).trim(), describeEngines: () => 'fixture status' });
  const search = searchCtx.mcp.tools[0];
  await check('搜索参数仍要求字符串', () => { assert.equal(search.inputSchema.query.safeParse('天气').success, true); assert.equal(search.inputSchema.query.safeParse(1).success, false); });
  await check('天气结果保留观测提示', async () => { const r = JSON.parse((await search.handler({ query: '天气' })).content[0].text); assert.equal(r.engine, 'weather'); assert.match(r.note, /观测时间/); });
  await check('空查询不发起搜索', async () => assert.equal((await search.handler({ query: ' ' })).isError, true));
  result = { error: 'fixture empty', results: [], tried: [] };
  await check('无结果返回明确失败与引擎状态', async () => { const r = await search.handler({ query: 'empty' }); assert.equal(r.isError, true); assert.match(r.content[0].text, /fixture status/); });
  console.log(`✅ ${passed} 通过 / 0 失败`);
} finally {
  for (const r of runtimes) await r.stop();
  assert.ok(path.resolve(tmp).startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(tmp, { recursive: true, force: true });
}
