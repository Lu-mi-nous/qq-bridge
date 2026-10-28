import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPluginRuntime } from '../src/plugin-runtime.js';
import { createMediaToolsApi } from '../src/media-tools-api.js';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-media-gateway-'));
fs.writeFileSync(path.join(root, 'package.json'), '{"version":"0.6.0"}');
let disabled = [], passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`PASS ${name}`); };
const runtime = createPluginRuntime({ root, only: ['media-tools'],
  dirs: [fileURLToPath(new URL('../plugins/', import.meta.url))],
  getConfig: () => ({ plugins: { disabled } }) });
const api = createMediaToolsApi({ getCapability: name => runtime.capabilities.get(name) });
try {
  check('启动前拒绝生成', () => assert.throws(() => api.renderFeatureMenu(), /不可用/));
  await runtime.start();
  check('真实插件解析可用', () => assert.ok(api.parseGitHubUrl('https://github.com/example/demo')));
  disabled = ['media-tools'];
  check('禁用后解析为空', () => assert.equal(api.parseGitHubUrl('https://github.com/example/demo'), null));
  for (const method of ['screenshotGitHubRepo', 'renderFeatureMenu', 'buildFeatureMenuHtml', 'buildTokenReport', 'renderTokenReport']) {
    check(`禁用后 ${method} 被拒绝`, () => assert.throws(() => api[method](), /不可用/));
  }
  check('禁用后不清理缓存', () => assert.equal(api.pruneTokenReportCache(root), 0));
  disabled = [];
  await runtime.stop();
  check('停止后不可用', () => assert.equal(api.available(), false));
  await runtime.start();
  check('重启后同一网关恢复', () => assert.ok(api.parseGitHubUrl('https://github.com/example/demo')));
  check('独立网关无全局实例', () => assert.equal(createMediaToolsApi().available(), false));
} finally {
  await runtime.stop();
  fs.rmSync(root, { recursive: true, force: true });
}
console.log(`${passed} 通过 / 0 失败`);
