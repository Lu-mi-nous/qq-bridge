import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPluginRuntime } from '../src/plugin-runtime.js';
import { createStickersApi } from '../src/stickers-api.js';
import { createStickerService } from '../src/sticker-service.js';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-stickers-gateway-'));
fs.writeFileSync(path.join(root, 'package.json'), '{"version":"0.6.0"}');
let disabled = [], passed = 0, requests = 0;
const check = (name, fn) => { fn(); passed++; console.log(`PASS ${name}`); };
const runtime = createPluginRuntime({ root, only: ['stickers'],
  dirs: [fileURLToPath(new URL('../plugins/', import.meta.url))],
  getConfig: () => ({ plugins: { disabled } }) });
const api = createStickersApi({ getCapability: name => runtime.capabilities.get(name) });
const service = createStickerService({ stickerApi: api, cfg: {}, file: path.join(root, 'stickers.json'),
  cacheDir: path.join(root, 'cache'), stateDir: root,
  request: async () => { requests++; return { status: 'ok', retcode: 0, data: [] }; } });
try {
  check('启动前不可用', () => assert.equal(service.enabled(), false));
  await runtime.start();
  await service.sync(true);
  check('启动后同步真实服务路径', () => assert.equal(requests, 1));
  disabled = ['stickers'];
  await service.sync(true);
  check('禁用后不请求 QQ', () => assert.equal(requests, 1));
  check('禁用后不展示缓存列表', () => assert.deepEqual(service.getEntries(), []));
  check('禁用后提示为空', () => assert.equal(api.buildStickerContext([]), ''));
  for (const method of ['setRemark', 'remove', 'collect']) {
    await assert.rejects(() => service[method]('x'), /不可用/);
    passed++; console.log(`PASS 禁用后 ${method} 拒绝`);
  }
  check('禁用后备注拒绝', () => assert.throws(() => service.applyNote('x', 'note'), /不可用/));
  disabled = [];
  await runtime.stop();
  check('停止后不可用', () => assert.equal(api.available(), false));
  await runtime.start();
  check('同一网关重启恢复', () => assert.equal(api.available(), true));
} finally {
  await runtime.stop();
  fs.rmSync(root, { recursive: true, force: true });
}
console.log(`${passed} 通过 / 0 失败`);
