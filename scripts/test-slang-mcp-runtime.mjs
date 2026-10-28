import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createProcessPluginRuntime } from '../src/plugins/process-runtime.js';
import { createSlangMcpServices } from '../src/plugins/mcp-bridge-services.js';
import { createPluginContext } from '../src/plugins/context.js';
import { bindPluginToolAvailability } from '../src/plugins/tool-availability.js';

let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log(`PASS ${name}`); };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-slang-mcp-'));
const config = path.join(tmp, 'config.json');
const requests = [];
let runtime, fail = false;
const server = new McpServer({ name: 'slang-runtime-test', version: '1' });
try {
  fs.writeFileSync(path.join(tmp, 'package.json'), '{"version":"0.6.0"}');
  fs.writeFileSync(config, '{}');
  runtime = await createProcessPluginRuntime({ root: tmp, only: ['slang'],
    dirs: [fileURLToPath(new URL('../plugins', import.meta.url))],
    services: { mcp: { slang: createSlangMcpServices(async (url, options) => {
      if (fail) throw Error('fixture denied'); requests.push({ url, options }); return { ok: true };
    }) } }
  });
  const descriptors = runtime.mcpTools();
  await check('真实黑话插件输出两个工具', () => assert.deepEqual(descriptors.map(t => t.name), ['qq_slang_query', 'qq_slang_submit']));
  let bridge = runtime.list();
  const sync = bindPluginToolAvailability(server, { readPlugins: async () => bridge });
  const handles = descriptors.map(t => server.tool(t.name, t.description, t.inputSchema, t.handler));
  await check('SDK 初始隐藏，桥接确认后显示', async () => {
    assert.ok(handles.every(h => !h.enabled)); await sync.refresh(); assert.ok(handles.every(h => h.enabled));
  });
  const query = descriptors[0], submit = descriptors[1];
  await check('查询保留参数编码和令牌头', async () => {
    assert.equal(JSON.parse((await query.handler({ key: 'group:1', token: 'fixture-token', q: '梗 &词' })).content[0].text).ok, true);
    const request = requests.at(-1), url = new URL(request.url, 'http://example.invalid');
    assert.equal(url.pathname, '/api/socialV2/slang/query'); assert.equal(url.searchParams.get('key'), 'group:1');
    assert.equal(url.searchParams.get('q'), '梗 &词'); assert.equal(request.options.headers['x-agent-token'], 'fixture-token');
  });
  await check('提交保持固定路径方法、令牌和正文', async () => {
    await submit.handler({ key: 'group:1', token: 'fixture-token', content: '词' });
    const r = requests.at(-1); assert.equal(r.url, '/api/socialV2/slang/submit'); assert.equal(r.options.method, 'POST');
    assert.deepEqual(JSON.parse(r.options.body), { key: 'group:1', content: '词', context: '' });
    assert.equal(r.options.headers['x-agent-token'], 'fixture-token');
  });
  await check('查询 schema 仍拒绝空令牌', () => assert.equal(query.inputSchema.token.safeParse('').success, false));
  fail = true;
  await check('桥接拒绝返回工具失败', async () => assert.equal((await query.handler({ key: 'group:1', token: 'fixture-token' })).isError, true));
  fail = false;
  fs.writeFileSync(config, '{"plugins":{"disabled":["slang"]}}');
  await check('配置禁用后旧描述也不能发请求', async () => {
    const before = requests.length; assert.deepEqual(runtime.mcpTools(), []);
    assert.equal((await submit.handler({ key: 'group:1', content: '词' })).isError, true); assert.equal(requests.length, before);
  });
  bridge = [{ id: 'slang', available: true, tools: [] }]; await sync.refresh();
  await check('桥接撤销声明后 SDK 隐藏工具', () => assert.ok(handles.every(h => !h.enabled)));
  fs.writeFileSync(config, '{}'); await runtime.stop();
  await check('停止后旧描述拒绝执行', async () => assert.equal((await query.handler({})).isError, true));
  await check('服务注入按插件和操作隔离', () => {
    const c = createPluginContext({ root: tmp, manifest: { id: 'other', permissions: ['mcp:register'] }, services: { mcp: { slang: { query: () => 1 } } } });
    assert.throws(() => c.mcp.callService('query', {}), /未注入/);
    assert.throws(() => c.mcp.callService('constructor', {}), /未注入/);
    const d = createPluginContext({ root: tmp, manifest: { id: 'slang', permissions: [] } });
    assert.throws(() => d.mcp.callService('query', {}), /未声明权限/);
  });
  console.log(`✅ ${passed} 通过 / 0 失败`);
} finally {
  await server.close(); await runtime?.stop();
  assert.ok(path.resolve(tmp).startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(tmp, { recursive: true, force: true });
}
