import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCapabilityRegistry } from '../src/plugins/capabilities.js';
import { createPluginRuntime } from '../src/plugin-runtime.js';

let passed = 0;
function check(name, fn) { fn(); passed++; console.log(`PASS ${name}`); }
const registry = createCapabilityRegistry({ isAvailable: () => true });
const scope = registry.scope('demo');
const release = scope.api.provide('demo.value', 42);
check('注册能力可读', () => assert.equal(registry.reader.get('demo.value'), 42));
check('跨命名空间被拒绝', () => assert.throws(() => scope.api.provide('other.value', 1)));
check('重复注册被拒绝', () => assert.throws(() => scope.api.provide('demo.value', 1)));
scope.close();
check('关闭后不可注册', () => assert.throws(() => scope.api.provide('demo.value', 1)));
const next = registry.scope('demo');
next.api.provide('demo.value', 43);
release(); scope.close();
check('旧撤销句柄不影响新一轮', () => assert.equal(registry.reader.get('demo.value'), 43));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-capabilities-'));
function plugin(id, code, extra = {}) {
  const dir = path.join(tmp, 'plugins', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ id, version: '1', configSchema: 'config.schema.js', permissions: [], ...extra }));
  fs.writeFileSync(path.join(dir, 'index.js'), code);
}
try {
  fs.writeFileSync(path.join(tmp, 'package.json'), '{"type":"module","version":"0.6.0"}');
  plugin('demo', `export function create(ctx) {
    const value = { starts: 0, stops: 0, ctx,
      async start() { this.starts++; await Promise.resolve(); },
      async stop() { this.stops++; }
    }; ctx.capabilities.provide('demo.value', value); return value;
  }`);
  plugin('broken', `export function create(ctx) {
    ctx.capabilities.provide('broken.value', {}); throw Error('factory failure');
  }`);
  plugin('failed', `export function create(ctx) {
    const value = { start() { throw Error('start failure'); }, stop() { throw Error('cleanup failure'); } };
    ctx.capabilities.provide('failed.value', value); return value;
  }`);
  plugin('off', `throw Error('disabled module must not be evaluated');`);
  plugin('invalid', '', { permissions: ['invalid'] });
  let disabled = ['off'];
  const options = { root: tmp, dirs: [path.join(tmp, 'plugins')], getConfig: () => ({ plugins: { disabled } }) };
  const runtime = createPluginRuntime(options);
  await runtime.host.load();
  check('仅加载不暴露能力', () => assert.equal(runtime.capabilities.get('demo.value'), null));
  await Promise.all([runtime.start(), runtime.start()]);
  const first = runtime.get('demo');
  check('并发启动仅启动一次', () => assert.equal(first.starts, 1));
  check('自动实例与显式能力一致', () => assert.equal(runtime.capabilities.get('demo.value'), first));
  check('缺失和失败能力均不可用', () => {
    for (const id of ['missing', 'broken', 'failed', 'off', 'invalid']) {
      assert.equal(runtime.get(id), null);
      assert.equal(runtime.capabilities.get(`${id}.value`), null);
      assert.equal(runtime.host.getContext(id), null);
    }
    assert.equal(runtime.list().find(p => p.id === 'off').status, 'disabled');
  });
  disabled.push('demo');
  check('配置禁用立即隐藏查询结果', () => {
    assert.equal(runtime.get('demo'), null);
    assert.deepEqual(runtime.capabilities.list(), []);
  });
  disabled = ['off'];
  await Promise.all([runtime.stop(), runtime.stop()]);
  check('重复停止只清理一次并撤销能力', () => {
    assert.equal(first.stops, 1); assert.equal(runtime.get('demo'), null);
    assert.throws(() => first.ctx.capabilities.provide('demo.late', {}));
  });
  await runtime.start();
  check('重启创建新实例', () => assert.notEqual(runtime.get('demo'), first));
  const second = runtime.get('demo');
  await runtime.stop();
  await Promise.all([runtime.start(), runtime.stop()]);
  check('启动与停止按调用顺序完成', () => assert.equal(runtime.get('demo'), null));
  const isolated = createPluginRuntime(options);
  await isolated.start();
  check('不同运行时能力相互隔离', () => {
    assert.notEqual(isolated.get('demo'), second); assert.equal(runtime.get('demo'), null);
  });
  await isolated.stop();
  // 控制异步清理的完成时间，验证撤销发生在等待 stop 结束之前。
  const pending = createPluginRuntime({ ...options, only: ['demo'] });
  await pending.start();
  const pendingInstance = pending.get('demo');
  let finishStop, signalEntered;
  const entered = new Promise(resolve => { signalEntered = resolve; });
  pendingInstance.stop = () => { signalEntered(); return new Promise(resolve => { finishStop = resolve; }); };
  const stopping = pending.stop();
  await entered;
  check('异步停止等待期间能力已不可用', () => assert.equal(pending.capabilities.get('demo.value'), null));
  finishStop(); await stopping;
  const lateDisable = createPluginRuntime(options);
  await lateDisable.host.load(); disabled.push('demo');
  await lateDisable.start();
  check('加载后启动前禁用不启动插件', () => assert.equal(lateDisable.list().find(p => p.id === 'demo').status, 'disabled'));
  await lateDisable.stop();
} finally {
  // tmp 是本脚本以固定前缀创建的独立临时目录。
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`${passed} 通过 / 0 失败`);
