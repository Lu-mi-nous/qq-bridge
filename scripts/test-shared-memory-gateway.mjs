import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPluginRuntime } from '../src/plugin-runtime.js';
import { createSharedMemoryApi } from '../src/shared-memory-api.js';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-shared-gateway-'));
let count = 0;
const check = (name, fn) => { fn(); count++; console.log(`PASS ${name}`); };
let disabled = [];
fs.writeFileSync(path.join(root, 'package.json'), '{"version":"0.6.0"}');
const runtime = createPluginRuntime({ root,
  dirs: [fileURLToPath(new URL('../plugins/', import.meta.url))], only: ['shared-memory'],
  getConfig: () => ({ plugins: { disabled } }) });
const api = createSharedMemoryApi({ getCapability: name => runtime.capabilities.get(name) });
const state = path.join(root, 'state');
try {
  check('未启动时无共享记忆', () => assert.equal(api.sharedMemoryStats(state).enabled, false));
  await runtime.start();
  check('真实插件启动后可查询', () => assert.equal(api.sharedMemoryStats(state).enabled, true));
  api.saveSharedMemory(state, api.emptySharedMemory());
  const file = api.sharedMemoryFile(state);
  check('正常写入使用真实插件', () => assert.equal(fs.existsSync(file), true));
  const before = fs.readFileSync(file, 'utf8');
  disabled = ['shared-memory'];
  check('禁用后注入为空', () => assert.equal(api.formatSharedMemoryForWake(state, {}), ''));
  api.saveSharedMemory(state, { people: { bad: {} } });
  check('禁用后写入无副作用', () => assert.equal(fs.readFileSync(file, 'utf8'), before));
  check('禁用后清空不执行', () => assert.equal(api.clearSharedMemory(state), false));
  disabled = [];
  await runtime.stop();
  check('停止后查询关闭', () => assert.equal(api.sharedMemoryStats(state).enabled, false));
  await runtime.start();
  check('同一网关重启后恢复', () => assert.equal(api.sharedMemoryStats(state).enabled, true));
  check('独立网关不会借用全局实例', () => assert.equal(createSharedMemoryApi().sharedMemoryStats(state).enabled, false));
} finally {
  await runtime.stop();
  fs.rmSync(root, { recursive: true, force: true });
}
console.log(`${count} 通过 / 0 失败`);
