import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProcessPluginRuntime } from '../src/plugins/process-runtime.js';
import { createStickersMcpServices } from '../src/plugins/mcp-bridge-services.js';
let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log(`PASS ${name}`); };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-stickers-mcp-'));
const file = path.join(tmp, 'config.json'), requests = [];
let runtime, failure = false, emptyImage = false, notGone = false;
try {
  fs.writeFileSync(path.join(tmp, 'package.json'), '{"version":"0.6.0"}');
  fs.writeFileSync(file, '{}');
  runtime = await createProcessPluginRuntime({ root: tmp, only: ['stickers'], dirs: [fileURLToPath(new URL('../plugins', import.meta.url))], services: {
    mcp: { stickers: createStickersMcpServices(async (url, options = {}) => {
      requests.push({ url, options }); if (failure) throw Error('fixture denied');
      if (url.includes('sticker-list')) return { ok: true, stickers: [{ id: 'e1', desc: 'fixture' }] };
      if (url.includes('sticker-image')) return emptyImage ? { ok: true, error: 'fixture empty' } : { ok: true, sticker: { id: 'e1', desc: 'fixture' }, image: { mimeType: 'image/png', data: 'aW1n' } };
      if (url.includes('send-sticker')) return { ok: true, sent: true };
      if (url.includes('collect-sticker')) return { ok: true, collected: { md5: 'abcdef0123456789' } };
      if (url.includes('sticker-note')) return { ok: true, note: 'fixture' };
      if (url.includes('sticker-delete')) return { ok: true, deleted: { desc: '旧表情', md5: 'abcdef0123456789' }, verifiedGone: !notGone };
      if (url.includes('sticker-remark')) return { ok: true, desc: '新备注' };
      return {};
    }) }
  } });
  const tools = Object.fromEntries(runtime.mcpTools().map(t => [t.name, t]));
  await check('真实插件输出七个表情工具', () => assert.equal(Object.keys(tools).length, 7));
  await check('列表保留搜索/条数/刷新', async () => {
    await tools.qq_list_stickers.handler({ key: 'group:1', token: 'fixture', query: '猫 & 狗', count: 5, refresh: true });
    const url = new URL(requests.at(-1).url, 'http://example.invalid');
    assert.equal(url.pathname, '/api/socialV2/sticker-list');
    assert.equal(url.searchParams.get('query'), '猫 & 狗');
    assert.equal(url.searchParams.get('count'), '5');
    assert.equal(url.searchParams.get('refresh'), '1');
    assert.equal(requests.at(-1).options.headers['x-agent-token'], 'fixture');
  });
  await check('看图返回图像内容与备注', async () => {
    const r = await tools.qq_get_sticker_image.handler({ key: 'group:1', token: 'fixture', stickerId: 'e1' });
    assert.equal(requests.at(-1).options.timeoutMs, 180000);
    assert.deepEqual(r.content[1], { type: 'image', mimeType: 'image/png', data: 'aW1n' });
    assert.match(r.content[0].text, /备注：fixture/);
  });
  await check('看图无数据时显式失败', async () => {
    emptyImage = true;
    const r = await tools.qq_get_sticker_image.handler({ key: 'group:1', token: 'fixture', stickerId: 'e1' });
    emptyImage = false;
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /表情没有可返回的图片：fixture empty/);
  });
  await check('发表情保留引用/@ 与长超时', async () => {
    await tools.qq_send_sticker.handler({ key: 'group:1', token: 'fixture', stickerId: 'e1', replyToMessageId: 'latest', atUserId: 10001 });
    const body = JSON.parse(requests.at(-1).options.body);
    assert.equal(requests.at(-1).url, '/api/socialV2/send-sticker');
    assert.equal(body.stickerId, 'e1'); assert.equal(body.replyToMessageId, 'latest'); assert.equal(body.atUserId, 10001);
    assert.equal(requests.at(-1).options.timeoutMs, 300000);
  });
  await check('收藏保留消息与备注', async () => {
    await tools.qq_collect_sticker.handler({ key: 'group:1', token: 'fixture', messageId: '-77', remark: '好图' });
    const body = JSON.parse(requests.at(-1).options.body);
    assert.equal(requests.at(-1).url, '/api/socialV2/collect-sticker');
    assert.equal(body.messageId, '-77'); assert.equal(body.remark, '好图');
    assert.equal(requests.at(-1).options.timeoutMs, 60000);
  });
  await check('本地笔记只在传值时带上（不覆盖已有字段）', async () => {
    await tools.qq_sticker_note.handler({ key: 'group:1', token: 'fixture', stickerId: 'e1', note: '含义' });
    let body = JSON.parse(requests.at(-1).options.body);
    assert.equal(body.note, '含义');
    assert.equal('tags' in body, false); assert.equal('usage' in body, false);
    await tools.qq_sticker_note.handler({ key: 'group:1', token: 'fixture', stickerId: 'e1', tags: ['嘲讽', '笑哭'], usage: '怼人用' });
    body = JSON.parse(requests.at(-1).options.body);
    assert.deepEqual(body.tags, ['嘲讽', '笑哭']); assert.equal(body.usage, '怼人用');
  });
  await check('删除成功文案含备注与 md5 前缀', async () => {
    const r = await tools.qq_delete_sticker.handler({ key: 'group:1', token: 'fixture', stickerId: 'e1' });
    assert.equal(requests.at(-1).url, '/api/socialV2/sticker-delete');
    assert.match(r.content[0].text, /已删除收藏表情「旧表情」（abcdef01）/);
    assert.doesNotMatch(r.content[0].text, /回读时它似乎还在/);
  });
  await check('删除回读不一致时提示', async () => {
    notGone = true;
    const r = await tools.qq_delete_sticker.handler({ key: 'group:1', token: 'fixture', stickerId: 'e1' });
    notGone = false;
    assert.match(r.content[0].text, /回读时它似乎还在/);
  });
  await check('改官方备注保留目标与新备注', async () => {
    await tools.qq_set_sticker_remark.handler({ key: 'group:1', token: 'fixture', stickerId: 'e1', remark: '新备注' });
    const body = JSON.parse(requests.at(-1).options.body);
    assert.equal(requests.at(-1).url, '/api/socialV2/sticker-remark');
    assert.equal(body.stickerId, 'e1'); assert.equal(body.remark, '新备注');
  });
  failure = true;
  await check('七项桥接失败均返回明确错误', async () => {
    for (const tool of Object.values(tools)) {
      const r = await tool.handler({ key: 'group:1', token: 'fixture', stickerId: 'e1', messageId: '1' });
      assert.equal(r.isError, true); assert.match(r.content[0].text, /失败/);
    }
  });
  failure = false;
  fs.writeFileSync(file, JSON.stringify({ socialV2: { sticker: { enabled: false } } }));
  await check('业务关闭隐藏并阻止旧处理器', async () => {
    assert.deepEqual(runtime.mcpTools(), []);
    const before = requests.length;
    for (const tool of Object.values(tools)) assert.equal((await tool.handler({})).isError, true);
    assert.equal(requests.length, before);
  });
  fs.writeFileSync(file, JSON.stringify({ socialV2: { tools: { deleteSticker: false, setStickerRemark: false } } }));
  await check('单个写工具开关只隐藏自己', () => {
    const names = runtime.mcpTools().map(t => t.name).sort();
    assert.deepEqual(names, ['qq_collect_sticker', 'qq_get_sticker_image', 'qq_list_stickers', 'qq_send_sticker', 'qq_sticker_note']);
  });
  fs.writeFileSync(file, JSON.stringify({ plugins: { disabled: ['stickers'] } }));
  await check('插件禁用不输出工具', () => assert.deepEqual(runtime.mcpTools(), []));
  fs.writeFileSync(file, '{}');
  await runtime.stop();
  await check('停止后旧处理器拒绝执行', async () => assert.equal((await tools.qq_send_sticker.handler({ key: 'group:1', token: 'fixture', stickerId: 'e1' })).isError, true));
  console.log(`✅ ${passed} 通过 / 0 失败`);
} finally {
  await runtime?.stop();
  assert.ok(path.resolve(tmp).startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(tmp, { recursive: true, force: true });
}
