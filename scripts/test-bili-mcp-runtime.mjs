import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProcessPluginRuntime } from '../src/plugins/process-runtime.js';
import { createBiliMcpServices } from '../src/plugins/mcp-bridge-services.js';
let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log(`PASS ${name}`); };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-bili-mcp-'));
const file = path.join(tmp, 'config.json'), requests = [];
let runtime, failure = false;
try {
  fs.writeFileSync(path.join(tmp, 'package.json'), '{"version":"0.6.0"}'); fs.writeFileSync(file, '{}');
  runtime = await createProcessPluginRuntime({ root: tmp, only: ['bili'], dirs: [fileURLToPath(new URL('../plugins', import.meta.url))], services: {
    mcp: { bili: createBiliMcpServices(async (url, options) => {
      requests.push({ url, options }); if (failure) throw Error('fixture denied');
      if (url.endsWith('bili-watch')) return { ok: true, info: { bvid: 'BVfixture' }, hint: 'fixture hint', images: [{ data: 'page1', mimeType: 'image/png' }, { data: 'page2', mimeType: 'image/jpeg' }] };
      if (url.endsWith('bili-search')) return { ok: true, query: 'fixture', videos: [{ title: 'fixture title', bvid: 'BVfixture', owner: 'owner', durationSec: 1 }] };
      return { ok: true, video: { liked: false }, taste: { count: 1 } };
    }) }
  } });
  const tools = Object.fromEntries(runtime.mcpTools().map(t => [t.name, t]));
  await check('真实插件输出四个工具', () => assert.equal(Object.keys(tools).length, 4));
  await check('记录保留真实负面偏好及鉴权字段', async () => {
    const r = await tools.qq_bili_record.handler({ key: 'group:1', token: 'fixture', liked: false, interest: 10, notes: '无聊' });
    const req = requests.at(-1), body = JSON.parse(req.options.body);
    assert.equal(req.url, '/api/socialV2/bili-record'); assert.equal(body.liked, false); assert.equal(body.interest, 10);
    assert.equal(body.token, 'fixture'); assert.equal(req.options.headers['x-agent-token'], 'fixture');
    assert.equal(JSON.parse(r.content[0].text).recorded.liked, false);
  });
  await check('记忆查询保留过滤和编码', async () => {
    await tools.qq_bili_memory.handler({ key: 'group:1', token: 'fixture', likedOnly: true, q: '猫 &狗' });
    const url = new URL(requests.at(-1).url, 'http://example.invalid');
    assert.equal(url.pathname, '/api/socialV2/bili-memory'); assert.equal(url.searchParams.get('liked'), '1');
    assert.equal(url.searchParams.get('limit'), '10'); assert.equal(url.searchParams.get('q'), '猫 &狗');
  });
  await check('观看返回全部分页和原类型，保留超时', async () => {
    const r = await tools.qq_watch_bili.handler({ key: 'group:1', token: 'fixture', url: 'BVfixture', seconds: 5, frames: 4 });
    assert.deepEqual(r.content.filter(x => x.type === 'image').map(x => [x.data, x.mimeType]), [['page1', 'image/png'], ['page2', 'image/jpeg']]);
    assert.equal(requests.at(-1).options.timeoutMs, 180000); assert.equal(JSON.parse(requests.at(-1).options.body).frames, 4);
  });
  await check('搜索保留链接和推荐提醒', async () => {
    const r = await tools.qq_bili_search.handler({ key: 'group:1', token: 'fixture', query: '猫', count: 2, order: 'pubdate' });
    assert.match(r.content[0].text, /https:\/\/www.bilibili.com\/video\/BVfixture/); assert.match(r.content[0].text, /标题和链接必须原样使用/);
    assert.equal(requests.at(-1).options.timeoutMs, 60000); assert.equal(JSON.parse(requests.at(-1).options.body).order, 'pubdate');
  });
  failure = true;
  await check('四项桥接失败均返回明确错误', async () => { for (const tool of Object.values(tools)) assert.equal((await tool.handler({ key: 'group:1', token: 'fixture' })).isError, true); });
  failure = false;
  fs.writeFileSync(file, '{"socialV2":{"bili":{"enabled":false}}}');
  await check('业务关闭隐藏并阻止旧处理器', async () => {
    assert.deepEqual(runtime.mcpTools(), []); const before = requests.length;
    for (const tool of Object.values(tools)) assert.equal((await tool.handler({})).isError, true);
    assert.equal(requests.length, before);
  });
  fs.writeFileSync(file, '{"plugins":{"disabled":["bili"]}}');
  await check('插件禁用不输出工具', () => assert.deepEqual(runtime.mcpTools(), []));
  fs.writeFileSync(file, '{}'); await runtime.stop();
  await check('停止后旧处理器拒绝执行', async () => assert.equal((await tools.qq_watch_bili.handler({})).isError, true));
  console.log(`✅ ${passed} 通过 / 0 失败`);
} finally {
  await runtime?.stop(); assert.ok(path.resolve(tmp).startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(tmp, { recursive: true, force: true });
}
