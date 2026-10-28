import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProcessPluginRuntime } from '../src/plugins/process-runtime.js';
import { createMediaMcpServices } from '../src/plugins/mcp-bridge-services.js';
let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log(`PASS ${name}`); };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-media-mcp-'));
const file = path.join(tmp, 'config.json'), requests = [];
let runtime, response = { ok: true, bytes: 2048, cached: true, summary: 'fixture summary', repo: 'a/b', sent: 1, slices: 2, height: 100, note: '后面一张失败' };
try {
  fs.writeFileSync(path.join(tmp, 'package.json'), '{"version":"0.6.0"}'); fs.writeFileSync(file, '{}');
  runtime = await createProcessPluginRuntime({ root: tmp, only: ['media-tools'], dirs: [fileURLToPath(new URL('../plugins', import.meta.url))],
    services: { mcp: { 'media-tools': createMediaMcpServices(async (url, options) => { requests.push({ url, options }); return response; }) } }
  });
  const tools = Object.fromEntries(runtime.mcpTools().map(t => [t.name, t]));
  await check('真实媒体插件提供三个工具', () => assert.equal(Object.keys(tools).length, 3));
  await check('菜单保持刷新参数、令牌和缓存提示', async () => {
    const r = await tools.qq_send_feature_menu.handler({ key: 'group:1', token: 'fixture', refresh: true });
    const request = requests.at(-1), url = new URL(request.url, 'http://example.invalid');
    assert.equal(url.pathname, '/api/socialV2/send-feature-menu'); assert.equal(url.searchParams.get('refresh'), '1');
    assert.equal(url.searchParams.get('key'), 'group:1'); assert.equal(request.options.timeoutMs, 120000);
    assert.equal(request.options.headers['x-agent-token'], 'fixture'); assert.match(r.content[0].text, /用缓存/);
  });
  await check('报表 fresh 对应刷新并保留同源摘要', async () => {
    const r = await tools.qq_token_report.handler({ key: 'group:1', token: 'fixture', fresh: true });
    assert.match(requests.at(-1).url, /token-report.*refresh=1/);
    assert.equal(requests.at(-1).options.timeoutMs, 180000); assert.match(r.content[0].text, /fixture summary/);
  });
  await check('截图保持固定路径、POST 正文与部分失败提示', async () => {
    const r = await tools.qq_github_shot.handler({ key: 'group:1', token: 'fixture', url: 'a/b' });
    const request = requests.at(-1); assert.equal(request.url, '/api/socialV2/github-shot'); assert.equal(request.options.method, 'POST');
    assert.deepEqual(JSON.parse(request.options.body), { key: 'group:1', url: 'a/b' }); assert.equal(request.options.timeoutMs, 180000);
    assert.match(r.content[0].text, /后面一张失败/);
  });
  response = { ok: false, error: 'fixture failure' };
  await check('三个接口失败均明确返回错误', async () => {
    for (const tool of Object.values(tools)) assert.equal((await tool.handler({ key: 'group:1', token: 'fixture' })).isError, true);
  });
  for (const [name, flag] of [['qq_send_feature_menu', 'getFeatureMenu'], ['qq_token_report', 'tokenReport'], ['qq_github_shot', 'githubShot']]) {
    await check(`${flag} 独立关闭并阻止旧 handler 请求`, async () => {
      fs.writeFileSync(file, JSON.stringify({ socialV2: { tools: { [flag]: false } } }));
      const remaining = runtime.mcpTools(); assert.equal(remaining.length, 2); assert.ok(!remaining.some(t => t.name === name));
      const before = requests.length; assert.equal((await tools[name].handler({})).isError, true); assert.equal(requests.length, before);
    });
  }
  fs.writeFileSync(file, '{"plugins":{"disabled":["media-tools"]}}');
  await check('插件禁用后全部隐藏', () => assert.deepEqual(runtime.mcpTools(), []));
  fs.writeFileSync(file, '{}'); await runtime.stop();
  await check('停止后旧 handler 拒绝执行', async () => assert.equal((await tools.qq_token_report.handler({})).isError, true));
  console.log(`✅ ${passed} 通过 / 0 失败`);
} finally {
  await runtime?.stop(); assert.ok(path.resolve(tmp).startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(tmp, { recursive: true, force: true });
}
