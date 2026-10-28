import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPluginRuntime } from '../src/plugin-runtime.js';
import { createBiliApi } from '../src/bili-api.js';
import { createImagesApi } from '../src/images-api.js';
import { createStickersApi } from '../src/stickers-api.js';
import { createSlangApi } from '../src/slang-api.js';
import { createSharedMemoryApi } from '../src/shared-memory-api.js';
import { createMediaToolsApi } from '../src/media-tools-api.js';
import { createContentReviewApi } from '../src/content-review-api.js';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-gateway-boundary-'));
fs.writeFileSync(path.join(root, 'package.json'), '{"version":"0.6.0"}');
const ids = ['bili', 'images', 'stickers', 'slang', 'shared-memory', 'media-tools', 'content-review'];
let disabled = [...ids], passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`PASS ${name}`); };
const runtime = createPluginRuntime({ root, only: ids,
  dirs: [fileURLToPath(new URL('../plugins/', import.meta.url))],
  getConfig: () => ({ plugins: { disabled } }) });
const options = { getCapability: name => runtime.capabilities.get(name) };
const bili = createBiliApi(options), images = createImagesApi(options);
const stickers = createStickersApi(options), slang = createSlangApi(options);
const shared = createSharedMemoryApi(options), media = createMediaToolsApi(options);
const review = createContentReviewApi({ capabilities: runtime.capabilities });
const store = images.createImageStore({ dir: path.join(root, 'images') });
async function denied(label) {
  for (const id of ids) check(`${label} ${id} 无实例与上下文`, () => {
    assert.equal(runtime.get(id), null); assert.equal(runtime.host.getContext(id), null);
  });
  check(`${label} B站拒绝业务`, () => assert.throws(() => bili.fetchVideoInfo('x'), /不可用/));
  check(`${label} 图源拒绝业务`, () => assert.throws(() => images.fetchFromSources({}), /不可用/));
  check(`${label} 表情空提示`, () => assert.equal(stickers.buildStickerContext([]), ''));
  check(`${label} 黑话空提示`, () => assert.equal(slang.buildSlangContext([]), ''));
  check(`${label} 共享记忆不注入`, () => assert.equal(shared.formatSharedMemoryForWake(root, {}), ''));
  check(`${label} 媒体拒绝生成`, () => assert.throws(() => media.renderFeatureMenu(), /不可用/));
  const result = await review.reviewText('x');
  check(`${label} 审核不可用`, () => assert.equal(result.decision, 'unavailable'));
  check(`${label} 延迟图库无数据`, () => assert.equal(store.count(), 0));
}
try {
  await runtime.start();
  await denied('启动时禁用');
  check('禁用状态不加载入口', () => assert.ok(runtime.list().every(p => p.status === 'disabled')));
  await runtime.stop(); disabled = [];
  await runtime.start();
  for (const id of ids) check(`启用后 ${id} 可用`, () => assert.ok(runtime.get(id)));
  check('启动前构造的图库恢复真实路径', () => assert.equal(store.libDir, path.join(root, 'images')));
  disabled = [...ids];
  await denied('运行中禁用');
  await runtime.stop();
  await denied('停止后');
  for (const mode of ['missing', 'invalid', 'load-failed', 'start-failed']) {
    const dir = path.join(root, mode);
    for (const id of ids) {
      const pluginDir = path.join(dir, id);
      fs.mkdirSync(pluginDir, { recursive: true });
      if (mode === 'missing') continue;
      fs.writeFileSync(path.join(pluginDir, 'manifest.json'), JSON.stringify({ id,
        version: '1', configSchema: 'config.schema.js', permissions: mode === 'invalid' ? ['invalid'] : [] }));
      fs.writeFileSync(path.join(pluginDir, 'index.js'), mode === 'start-failed'
        ? 'export function create() { return { start() { throw Error("start failed"); } }; }'
        : 'throw Error("load failed");');
    }
    const failed = createPluginRuntime({ root, dirs: [dir] });
    await failed.start();
    for (const id of ids) check(`${mode} ${id} 无能力和路由`, () => {
      assert.equal(failed.capabilities.has(`${id}.instance`), false);
      assert.equal(failed.host.getContext(id), null);
      assert.equal(failed.list().find(p => p.id === id)?.status,
        mode === 'missing' ? undefined : mode === 'invalid' ? 'invalid' : 'failed');
      assert.deepEqual(failed.list().find(p => p.id === id)?.console.routes ?? [], []);
    });
    const getCapability = name => failed.capabilities.get(name);
    check(`${mode} 七类网关一致不可用`, () => {
      for (const factory of [createBiliApi, createImagesApi, createStickersApi, createSlangApi, createMediaToolsApi]) {
        assert.equal(factory({ getCapability }).available(), false);
      }
      assert.equal(createSharedMemoryApi({ getCapability }).sharedMemoryStats(root).enabled, false);
      assert.equal(createContentReviewApi({ capabilities: failed.capabilities }).available(), false);
    });
    await failed.stop();
  }
} finally {
  await runtime.stop();
  fs.rmSync(root, { recursive: true, force: true });
}
console.log(`${passed} 通过 / 0 失败`);
