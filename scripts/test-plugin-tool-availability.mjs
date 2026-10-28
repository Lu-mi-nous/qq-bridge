import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { bindPluginToolAvailability } from '../src/plugins/tool-availability.js';
let plugins = [], fail = false, passed = 0;
const server = new McpServer({ name: 'availability-test', version: '1.0.0' });
const sync = bindPluginToolAvailability(server, { readPlugins: async () => {
  if (fail) throw new Error('offline'); return plugins;
}, owners: { test_plugin: 'demo' } });
const core = server.tool('test_core', {}, async () => ({ content: [] }));
const plugin = server.tool('test_plugin', {}, async () => ({ content: [] }));
function check(name, fn) { fn(); passed++; console.log(`PASS ${name}`); }
check('未知运行时默认隐藏插件工具', () => assert.equal(plugin.enabled, false));
check('核心工具保持可用', () => assert.equal(core.enabled, true));
plugins = [{ id: 'demo', available: true, tools: ['test_plugin'] }];
await sync.refresh();
check('运行时可用后显示工具', () => assert.equal(plugin.enabled, true));
plugins = [{ id: 'demo', status: 'started', available: false }];
await sync.refresh();
check('禁用立即撤销工具', () => assert.equal(plugin.enabled, false));
plugins = [{ id: 'demo', available: true, tools: ['test_plugin'] }]; await sync.refresh();
fail = true; await sync.refresh();
check('桥接不可达时隐藏插件工具', () => assert.equal(plugin.enabled, false));
fail = false; await sync.refresh();
check('桥接恢复后同一注册恢复', () => assert.equal(plugin.enabled, true));
plugins = [{ id: 'demo', available: true, tools: [] }]; await sync.refresh();
check('插件可用但未声明工具时隐藏', () => assert.equal(plugin.enabled, false));
plugins = [{ id: 'demo', available: true }]; await sync.refresh();
check('缺少工具声明时默认隐藏', () => assert.equal(plugin.enabled, false));
plugins = [{ id: 'other', available: true, tools: ['test_plugin'] }]; await sync.refresh();
check('其他插件声明同名工具不能授权', () => assert.equal(plugin.enabled, false));
plugins = [{ id: 'demo', available: true, tools: ['test_plugin'] }]; await sync.refresh();
check('重新声明后恢复且核心工具不受影响', () => { assert.equal(plugin.enabled, true); assert.equal(core.enabled, true); });
check('T2 可见工具计量只含启用的工具', () => {
  const names = sync.enabledTools().map((t) => t.name).sort();
  assert.deepEqual(names, ['test_core', 'test_plugin']);
  const row = sync.enabledTools().find((t) => t.name === 'test_core');
  assert.equal(typeof row.inputSchema, 'object');
});
plugins = [{ id: 'demo', available: false }]; await sync.refresh();
check('T2 插件隐藏后计量同步收窄', () => {
  assert.deepEqual(sync.enabledTools().map((t) => t.name), ['test_core']);
});
await server.close();
console.log(`${passed} 通过 / 0 失败`);
