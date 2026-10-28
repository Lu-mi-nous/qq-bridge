import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPluginRuntime } from '../src/plugin-runtime.js';
import { createSlangApi } from '../src/slang-api.js';
import { handle } from '../src/console/routes/02-slang.js';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-slang-gateway-'));
fs.writeFileSync(path.join(root, 'package.json'), '{"version":"0.6.0"}');
let disabled = [];
let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`PASS ${name}`); };
const runtime = createPluginRuntime({ root, only: ['slang'],
  dirs: [fileURLToPath(new URL('../plugins/', import.meta.url))],
  getConfig: () => ({ plugins: { disabled } }) });
const api = createSlangApi({ getCapability: name => runtime.capabilities.get(name) });
try {
  check('启动前不可用', () => assert.equal(api.available(), false));
  await runtime.start();
  check('启动后可用', () => assert.equal(api.available(), true));
  const file = path.join(root, 'slang.json');
  api.saveSlang(file, [api.createSlangEntry({ content: '测试词' })]);
  check('正常存储可回读', () => assert.equal(api.loadSlang(file).length, 1));
  const before = fs.readFileSync(file, 'utf8');
  disabled = ['slang'];
  api.saveSlang(file, []);
  check('禁用后不改原文件', () => assert.equal(fs.readFileSync(file, 'utf8'), before));
  check('禁用后不提供提示', () => assert.equal(api.buildSlangContext([]), ''));
  let status;
  const ctx = { deps: { pluginHost: runtime.host }, sendJson: (_, code) => { status = code; } };
  await handle({ method: 'GET' }, {}, new URL('http://localhost/api/slang'), ctx);
  check('禁用后控制台拒绝访问', () => assert.equal(status, 503));
  disabled = [];
  status = undefined;
  await handle({ method: 'POST' }, {}, new URL('http://localhost/api/slang'), {
    ...ctx, readBody: async () => { disabled = ['slang']; return {}; }
  });
  check('读取请求期间禁用也拒绝写入', () => assert.equal(status, 503));
  disabled = [];
  await runtime.stop();
  check('停止后不可用', () => assert.equal(api.available(), false));
  await runtime.start();
  check('重启后恢复已有数据', () => assert.equal(api.loadSlang(file).length, 1));
} finally {
  await runtime.stop();
  fs.rmSync(root, { recursive: true, force: true });
}
console.log(`${passed} 通过 / 0 失败`);
