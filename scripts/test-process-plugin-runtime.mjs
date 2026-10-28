import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProcessPluginRuntime } from '../src/plugins/process-runtime.js';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-process-plugin-'));
const dir = path.join(root, 'plugins', 'demo');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(root, 'package.json'), '{"version":"0.6.0","type":"module"}');
fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ id: 'demo', version: '1', configSchema: 'x', permissions: [] }));
fs.writeFileSync(path.join(dir, 'index.js'), 'export function create() { return { value: 42 }; }');
const config = path.join(root, 'config.json');
let runtime, passed = 0;
function check(name, fn) { fn(); passed++; console.log(`PASS ${name}`); }
try {
  await assert.rejects(() => createProcessPluginRuntime({ root }), /only/);
  passed++; console.log('PASS 未明确限定插件时拒绝启动');
  runtime = await createProcessPluginRuntime({ root, only: ['demo'], dirs: [path.join(root, 'plugins')] });
  check('缺少配置时不启动插件', () => assert.equal(runtime.get('demo'), null));
  await runtime.stop();
  fs.writeFileSync(config, '{}');
  runtime = await createProcessPluginRuntime({ root, only: ['demo'], dirs: [path.join(root, 'plugins')] });
  check('有效配置启动宿主插件', () => assert.equal(runtime.get('demo').value, 42));
  fs.writeFileSync(config, '{"plugins":{"disabled":["demo"]}}');
  check('配置禁用立即隐藏能力', () => assert.equal(runtime.get('demo'), null));
  fs.writeFileSync(config, 'broken');
  check('损坏配置保持关闭', () => assert.equal(runtime.get('demo'), null));
  fs.writeFileSync(config, '{}');
  check('有效配置恢复查询', () => assert.equal(runtime.get('demo').value, 42));
  await runtime.stop();
  check('停止后撤销能力', () => assert.equal(runtime.get('demo'), null));
} finally {
  await runtime?.stop();
  fs.rmSync(root, { recursive: true, force: true });
}
console.log(`${passed} 通过 / 0 失败`);
