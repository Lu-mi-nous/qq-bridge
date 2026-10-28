import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProcessPluginRuntime } from '../src/plugins/process-runtime.js';
import { createImagesMcpServices } from '../src/plugins/mcp-bridge-services.js';
let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log(`PASS ${name}`); };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-images-mcp-'));
const file = path.join(tmp, 'config.json'), requests = [];
let runtime, failure = false;
try {
  fs.writeFileSync(path.join(tmp, 'package.json'), '{"version":"0.6.0"}');
  fs.writeFileSync(file, JSON.stringify({ socialV2: { images: { enabled: true } } }));
  runtime = await createProcessPluginRuntime({ root: tmp, only: ['images'], dirs: [fileURLToPath(new URL('../plugins', import.meta.url))], services: {
    mcp: { images: createImagesMcpServices(async (url, options = {}) => {
      requests.push({ url, options }); if (failure) throw Error('fixture denied');
      if (url.includes('image-preflight')) return { ok: true, willWait: false, localCount: 2 };
      if (url.includes('image-source')) return { ok: true, sourcePage: 'https://example.invalid/p/1', originUrl: 'https://example.invalid/origin' };
      if (url.includes('reverse-search')) return { ok: true, results: [{ similarity: 91, creator: 'fixture' }] };
      if (url.includes('archive-image')) return { ok: true, path: 'collected/fixture.png' };
      if (url.includes('reject-image')) return { ok: true, rejected: 'safebooru:1' };
      if (url.includes('send-image')) return { ok: true, id: 'safebooru:1', tookMs: 5 };
      if (url.includes('refresh-image-lib')) return { ok: true, added: 3, total: 10 };
      return {};
    }) }
  } });
  const tools = Object.fromEntries(runtime.mcpTools().map(t => [t.name, t]));
  await check('真实插件输出七个图库工具', () => assert.equal(Object.keys(tools).length, 7));
  await check('预检保留标签/图源与超时', async () => {
    await tools.qq_check_image.handler({ key: 'group:1', token: 'fixture', tags: 'cat,dog', sources: 'pixiv' });
    const url = new URL(requests.at(-1).url, 'http://example.invalid');
    assert.equal(url.pathname, '/api/socialV2/image-preflight');
    assert.equal(url.searchParams.get('key'), 'group:1');
    assert.equal(url.searchParams.get('tags'), 'cat,dog');
    assert.equal(url.searchParams.get('sources'), 'pixiv');
    assert.equal(requests.at(-1).options.timeoutMs, 20000);
    assert.equal(requests.at(-1).options.headers['x-agent-token'], 'fixture');
  });
  await check('发图保留标签/图源/模式/引用与超时', async () => {
    const r = await tools.qq_send_image.handler({ key: 'group:1', token: 'fixture', tags: ['cat'], sources: ['pixiv'], mode: 'daily', replyToMessageId: 42 });
    const body = JSON.parse(requests.at(-1).options.body);
    assert.equal(requests.at(-1).url, '/api/socialV2/send-image');
    assert.deepEqual(body.tags, ['cat']); assert.deepEqual(body.sources, ['pixiv']);
    assert.equal(body.mode, 'daily'); assert.equal(body.replyToMessageId, 42);
    assert.equal(requests.at(-1).options.timeoutMs, 180000);
    assert.equal(JSON.parse(r.content[0].text).id, 'safebooru:1');
  });
  await check('发图未传标签时默认空数组', async () => {
    await tools.qq_send_image.handler({ key: 'group:1', token: 'fixture' });
    assert.deepEqual(JSON.parse(requests.at(-1).options.body).tags, []);
  });
  await check('归档保留 id 与长超时；不传 id 时不带该键', async () => {
    await tools.qq_archive_image.handler({ key: 'group:1', token: 'fixture', id: 'safebooru:9' });
    let body = JSON.parse(requests.at(-1).options.body);
    assert.equal(requests.at(-1).url, '/api/socialV2/archive-image');
    assert.equal(body.id, 'safebooru:9'); assert.equal(requests.at(-1).options.timeoutMs, 120000);
    await tools.qq_archive_image.handler({ key: 'group:1', token: 'fixture' });
    body = JSON.parse(requests.at(-1).options.body);
    assert.equal('id' in body, false);
  });
  await check('来源查询保留 id', async () => {
    const r = await tools.qq_image_source.handler({ key: 'group:1', token: 'fixture', id: 'pixiv:7' });
    const url = new URL(requests.at(-1).url, 'http://example.invalid');
    assert.equal(url.pathname, '/api/socialV2/image-source');
    assert.equal(url.searchParams.get('id'), 'pixiv:7');
    assert.equal(requests.at(-1).options.timeoutMs, 20000);
    assert.match(r.content[0].text, /sourcePage/);
  });
  await check('反查保留 messageId/id 与长超时', async () => {
    await tools.qq_reverse_search.handler({ key: 'group:1', token: 'fixture', messageId: '-123', id: 'safebooru:1' });
    const url = new URL(requests.at(-1).url, 'http://example.invalid');
    assert.equal(url.pathname, '/api/socialV2/reverse-search');
    assert.equal(url.searchParams.get('messageId'), '-123');
    assert.equal(url.searchParams.get('id'), 'safebooru:1');
    assert.equal(requests.at(-1).options.timeoutMs, 90000);
  });
  await check('差评删图保留 id/reason；不传时不带该键', async () => {
    await tools.qq_reject_image.handler({ key: 'group:1', token: 'fixture', id: 'safebooru:2', reason: '角色不对' });
    let body = JSON.parse(requests.at(-1).options.body);
    assert.equal(requests.at(-1).url, '/api/socialV2/reject-image');
    assert.equal(body.id, 'safebooru:2'); assert.equal(body.reason, '角色不对');
    await tools.qq_reject_image.handler({ key: 'group:1', token: 'fixture' });
    body = JSON.parse(requests.at(-1).options.body);
    assert.equal('id' in body, false); assert.equal('reason' in body, false);
  });
  await check('补图保留 key 与长超时', async () => {
    const r = await tools.qq_refresh_image_lib.handler({ key: 'group:1', token: 'fixture' });
    const body = JSON.parse(requests.at(-1).options.body);
    assert.equal(requests.at(-1).url, '/api/socialV2/refresh-image-lib');
    assert.equal(body.key, 'group:1');
    assert.equal(requests.at(-1).options.timeoutMs, 180000);
    assert.equal(JSON.parse(r.content[0].text).added, 3);
  });
  failure = true;
  await check('七项桥接失败均返回明确错误', async () => {
    for (const tool of Object.values(tools)) {
      const r = await tool.handler({ key: 'group:1', token: 'fixture', tags: 'x', messageId: '1' });
      assert.equal(r.isError, true); assert.match(r.content[0].text, /失败/);
    }
  });
  failure = false;
  fs.writeFileSync(file, JSON.stringify({ socialV2: { images: { enabled: false } } }));
  await check('图库关闭时只留反查（原实现即如此），其余旧处理器被阻止', async () => {
    // 反查作用于任意消息图片，不依赖图库，原注册条件也只有 tools.reverseSearch。
    assert.deepEqual(runtime.mcpTools().map(t => t.name), ['qq_reverse_search']);
    const before = requests.length;
    for (const name of ['qq_check_image', 'qq_archive_image', 'qq_image_source', 'qq_reject_image', 'qq_send_image', 'qq_refresh_image_lib']) {
      assert.equal((await tools[name].handler({})).isError, true, name);
    }
    assert.equal(requests.length, before);
  });
  fs.writeFileSync(file, JSON.stringify({ socialV2: { images: { enabled: true }, tools: { sendImage: false } } }));
  await check('关闭发图只隐藏发图族，反查/补图仍在', () => {
    const names = runtime.mcpTools().map(t => t.name).sort();
    assert.deepEqual(names, ['qq_refresh_image_lib', 'qq_reverse_search']);
  });
  fs.writeFileSync(file, JSON.stringify({ plugins: { disabled: ['images'] } }));
  await check('插件禁用不输出工具', () => assert.deepEqual(runtime.mcpTools(), []));
  fs.writeFileSync(file, JSON.stringify({ socialV2: { images: { enabled: true } } }));
  await runtime.stop();
  await check('停止后旧处理器拒绝执行', async () => assert.equal((await tools.qq_send_image.handler({ key: 'group:1', token: 'fixture' })).isError, true));
  console.log(`✅ ${passed} 通过 / 0 失败`);
} finally {
  await runtime?.stop();
  assert.ok(path.resolve(tmp).startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(tmp, { recursive: true, force: true });
}
