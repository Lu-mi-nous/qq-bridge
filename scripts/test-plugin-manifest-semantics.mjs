import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPluginHost, validatePluginManifest } from '../src/plugins/host.js';
import { PLUGIN_TOOL_OWNERS } from '../src/plugins/tool-owners.js';

let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log(`PASS ${name}`); };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-manifest-semantics-'));
const hosts = [];
try {
  const base = { id: 'demo', version: '1.0.0', permissions: [] };
  await check('最小插件无需伪 schema 声明', () => assert.equal(validatePluginManifest(base).ok, true));
  await check('工具声明拒绝错误类型、重名和非法名称', () => {
    for (const mcpTools of ['tool', ['same', 'same'], [''], ['../bad'], [12]]) {
      assert.equal(validatePluginManifest({ ...base, mcpTools }).ok, false);
    }
    assert.equal(validatePluginManifest({ ...base, mcpTools: ['demo_tool'] }).ok, true);
    assert.equal(validatePluginManifest({ ...base, mcpTools: [] }).ok, true);
  });
  await check('配置参考文件可选且路径受限', () => {
    assert.equal(validatePluginManifest({ ...base, configDocumentation: 'config.reference.js' }).ok, true);
    for (const file of ['', '../outside.js', 'nested/file.js', 'C:\\outside.js', '..', 1]) assert.equal(validatePluginManifest({ ...base, configDocumentation: file }).ok, false);
  });
  fs.writeFileSync(path.join(tmp, 'package.json'), '{"type":"module","version":"0.6.0"}');
  const dir = path.join(tmp, 'plugins', 'demo'); fs.mkdirSync(dir, { recursive: true });
  const manifest = { ...base, configDocumentation: 'config.reference.js' };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(dir, 'config.reference.js'), 'throw new Error("参考文档不可执行");');
  fs.writeFileSync(path.join(dir, 'index.js'), 'export function create() { return { started: false, stopped: false, start() { this.started=true; }, stop() { this.stopped=true; } }; }');
  function host(config = {}, logs = []) {
    const h = createPluginHost({ root: tmp, dirs: [path.join(tmp, 'plugins')], getConfig: () => config, log: line => logs.push(line) }); hosts.push(h); return h;
  }
  await check('无 hooks 声明仍执行实例 start/stop，文档不执行', async () => {
    const h = host(); await h.start(); const instance = h.get('demo');
    assert.equal(instance?.started, true); await h.stop(); assert.equal(instance.stopped, true);
  });
  await check('plugins.disabled 跳过坏入口而不加载', async () => {
    // 新路径防止模块缓存掩盖意外加载。
    const offDir = path.join(tmp, 'disabled-plugins', 'demo'); fs.mkdirSync(offDir, { recursive: true });
    fs.writeFileSync(path.join(offDir, 'manifest.json'), JSON.stringify(manifest));
    fs.writeFileSync(path.join(offDir, 'index.js'), 'throw new Error("禁用插件不可加载");');
    const h = createPluginHost({ root: tmp, dirs: [path.dirname(offDir)], getConfig: () => ({ plugins: { disabled: ['demo'] } }) }); hosts.push(h);
    await h.start(); assert.equal(h.get('demo'), null); assert.equal(h.list()[0].status, 'disabled');
  });
  await check('旧字段兼容但警告，不改变启停来源', async () => {
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ ...manifest, enabledByDefault: false, hooks: [], configSchema: 'missing.js', promptSections: ['unused'] }));
    const logs = [], h = host({}, logs); await h.start();
    assert.ok(h.get('demo')); assert.ok(logs.some(line => line.includes('旧声明不参与运行')));
  });
  await check('内置插件声明无遗留字段且参考文件存在', () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const h = createPluginHost({ root, dirs: [path.join(root, 'plugins')] });
    const found = h.discover(); assert.ok(found.length >= 11);
    for (const { manifest, dir } of found) {
      assert.equal(validatePluginManifest(manifest, { currentVersion: '0.6.0' }).ok, true);
      for (const field of ['enabledByDefault', 'hooks', 'promptSections', 'configSchema']) assert.equal(Object.hasOwn(manifest, field), false, `${manifest.id}.${field}`);
      assert.ok(fs.statSync(path.join(dir, manifest.configDocumentation)).isFile());
      for (const name of manifest.mcpTools || []) assert.equal(PLUGIN_TOOL_OWNERS[name], manifest.id, name);
    }
  });
  await check('内置 manifest 字段全部有运行语义（无未知/伪契约字段）', () => {
    // 白名单 = 宿主实际消费的字段：
    //   id/version/engines 校验；configPath 决定 ctx.config；permissions/secrets 走 ctx 接口；
    //   mcpTools 决定 MCP 注册与可见性；console.cards/routes 供控制台插槽；
    //   configDocumentation 只供阅读，不 import。
    const KNOWN = new Set(['id', 'name', 'version', 'engines', 'configPath', 'permissions', 'secrets', 'mcpTools', 'console', 'configDocumentation']);
    const CONSOLE_KEYS = new Set(['cards', 'routes']);
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const found = createPluginHost({ root, dirs: [path.join(root, 'plugins')] }).discover();
    for (const { manifest } of found) {
      for (const key of Object.keys(manifest)) assert.ok(KNOWN.has(key), `${manifest.id} 未知字段：${key}`);
      for (const key of Object.keys(manifest.console || {})) assert.ok(CONSOLE_KEYS.has(key), `${manifest.id}.console.${key}`);
    }
  });
  console.log(`✅ ${passed} 通过 / 0 失败`);
} finally {
  for (const h of hosts) await h.stop();
  assert.ok(path.resolve(tmp).startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(tmp, { recursive: true, force: true });
}
