import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProcessPluginRuntime } from '../src/plugins/process-runtime.js';
import {
  createTtsMcpServices, createUpscaleMcpServices, createXPostsMcpServices
} from '../src/plugins/mcp-bridge-services.js';
import { registerUpscaleTools } from '../plugins/upscale/mcp-tools.js';
let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log(`PASS ${name}`); };
const pluginsDir = fileURLToPath(new URL('../plugins', import.meta.url));

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-voice-upscale-x-'));
// 1×1 PNG：让超分 handler 取到可读尺寸，随后因缺少 upscayl-bin 明确失败（不起进程）。
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

try {
  // ── A. TTS：可用时输出工具，但独立宿主不建引擎/不预热 ──
  {
    const root = fs.mkdtempSync(path.join(tmpRoot, 'tts-'));
    fs.writeFileSync(path.join(root, 'package.json'), '{"version":"0.6.0"}');
    // 假 GPT-SoVITS 目录：probeSovits 只 stat 文件，不会加载模型。
    const sovits = path.join(root, 'sovits');
    for (const f of [
      'GPT_SoVITS/configs/tts_infer.yaml',
      'GPT_SoVITS/dania-e15.ckpt',
      'GPT_SoVITS/dania_e16_s2192.pth',
      'GPT_SoVITS/output/slicer_opt/output.wav_0009342720_0009558400.wav'
    ]) { fs.mkdirSync(path.dirname(path.join(sovits, f)), { recursive: true }); fs.writeFileSync(path.join(sovits, f), 'fixture'); }
    for (const d of ['GPT_SoVITS/pretrained_models/chinese-hubert-base', 'GPT_SoVITS/pretrained_models/chinese-roberta-wwm-ext-large']) {
      fs.mkdirSync(path.join(sovits, d), { recursive: true });
    }
    const config = path.join(root, 'config.json');
    fs.writeFileSync(config, JSON.stringify({ socialV2: { tts: { enabled: true, dir: sovits } } }));
    const requests = [];
    const runtime = await createProcessPluginRuntime({ root, only: ['tts'], dirs: [pluginsDir], services: {
      mcp: { tts: createTtsMcpServices(async (url, options = {}) => {
        requests.push({ url, options });
        if (options.__fail) throw Error('fixture denied');
        return { ok: true, durSec: 1.2, cached: true };
      }) }
    } });
    try {
      const tools = Object.fromEntries(runtime.mcpTools().map(t => [t.name, t]));
      await check('TTS 可用时输出 qq_send_voice', () => assert.ok(tools.qq_send_voice));
      await check('独立宿主不创建合成引擎/不预热', () => {
        const tts = runtime.get('tts');
        assert.equal(tts.engine, null);
        assert.equal(tts.available(), false);
        assert.ok(tts.probe?.ok, '探测仍应记录可用性');
      });
      await check('发语音保留正文/令牌与长超时', async () => {
        const r = await tools.qq_send_voice.handler({ key: 'group:1', token: 'fixture', text: '你好呀' });
        const req = requests.at(-1);
        assert.equal(req.url, '/api/socialV2/send-voice');
        assert.deepEqual(JSON.parse(req.options.body), { key: 'group:1', text: '你好呀' });
        assert.equal(req.options.headers['x-agent-token'], 'fixture');
        assert.equal(req.options.timeoutMs, 180000);
        assert.equal(JSON.parse(r.content[0].text).durSec, 1.2);
      });
      await check('失败时提醒不要假装已发', async () => {
        const failing = createTtsMcpServices(async () => { throw Error('fixture denied'); });
        const svcRuntime = await createProcessPluginRuntime({ root, only: ['tts'], dirs: [pluginsDir], services: { mcp: { tts: failing } } });
        try {
          const tool = svcRuntime.mcpTools().find(t => t.name === 'qq_send_voice');
          const r = await tool.handler({ key: 'group:1', token: 'fixture', text: 'hi' });
          assert.equal(r.isError, true);
          assert.match(r.content[0].text, /不要假装语音已发出/);
        } finally { await svcRuntime.stop(); }
      });
      fs.writeFileSync(config, JSON.stringify({ socialV2: { tts: { enabled: false, dir: sovits } } }));
      await check('TTS 未启用时工具不注册', () => assert.deepEqual(runtime.mcpTools(), []));
      fs.writeFileSync(config, JSON.stringify({ socialV2: { tts: { enabled: true, dir: path.join(root, 'missing') } } }));
      await check('目录缺失时工具不注册（不挂必然失败的工具）', () => assert.deepEqual(runtime.mcpTools(), []));
    } finally { await runtime.stop(); }
  }

  // ── B. 超分：没装 Upscayl 时工具不注册；handler 对动图/取图失败给明确原因 ──
  {
    const root = fs.mkdtempSync(path.join(tmpRoot, 'upscale-'));
    fs.writeFileSync(path.join(root, 'package.json'), '{"version":"0.6.0"}');
    const missingBin = path.join(root, 'no-upscayl-here', 'bin');
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ socialV2: { upscale: { binDir: missingBin } } }));
    const runtime = await createProcessPluginRuntime({ root, only: ['upscale'], dirs: [pluginsDir] });
    try {
      await check('没装 Upscayl 时 qq_upscale_image 不注册', () => assert.deepEqual(runtime.mcpTools(), []));
    } finally { await runtime.stop(); }

    // handler 逻辑用假 ctx 直接跑（绕过 isEnabled，模拟真实可用时的分支）。
    const requests = [];
    let imagesMode = 'static';
    const tools = new Map();
    const ctx = {
      // 与真实 ctx 一致：get() 是 socialV2.upscale 段；工具开关走 toolFlag。
      config: { get: () => ({ enabled: true, binDir: missingBin }), toolFlag: () => undefined },
      mcp: {
        registerTool: (name, description, inputSchema, handler, options) => tools.set(name, { name, description, inputSchema, handler, ...options }),
        callService: async (name, payload) => {
          requests.push({ name, payload });
          if (name === 'publish') return { ok: true };
          if (imagesMode === 'throw') throw Error('fixture denied');
          if (imagesMode === 'empty') return { ok: true, images: [] };
          if (imagesMode === 'animated') return { ok: true, images: [{ data: PNG_1PX, mimeType: 'image/png', animated: true }] };
          return { ok: true, images: [{ data: PNG_1PX, mimeType: 'image/png' }] };
        }
      }
    };
    registerUpscaleTools(ctx);
    const tool = tools.get('qq_upscale_image');
    await check('超分工具注册并保留参数 schema', () => {
      assert.ok(tool);
      assert.ok(tool.inputSchema.publish && tool.inputSchema.model && tool.inputSchema.messageId);
    });
    await check('显式传 publish=false 也可调用（取原始像素）', async () => {
      const r = await tool.handler({ key: 'group:1', messageId: -5, publish: false });
      assert.equal(requests.at(-1).name, 'messageImage');
      assert.equal(requests.at(-1).payload.messageId, -5);
      // 原实现里「超分未执行」不是错误，是让模型按原图作答的说明（不带 isError）。
      assert.notEqual(r.isError, true);
      assert.match(r.content[0].text, /超分未执行：本机没找到 Upscayl 的 upscayl-bin/);
    });
    await check('动图明确拒绝而不是乱超分', async () => {
      imagesMode = 'animated';
      const r = await tool.handler({ key: 'group:1', messageId: 1 });
      assert.match(r.content[0].text, /这是动图.*超分不处理动图/);
      assert.equal(requests.filter(x => x.name === 'publish').length, 0);
      imagesMode = 'static';
    });
    await check('消息里没有图时显式失败', async () => {
      imagesMode = 'empty';
      const r = await tool.handler({ key: 'group:1', messageId: 1 });
      assert.equal(r.isError, true);
      assert.match(r.content[0].text, /没有可取到的图片/);
      imagesMode = 'static';
    });
    await check('索引越界时显式失败', async () => {
      const r = await tool.handler({ key: 'group:1', messageId: 1, index: 2 });
      assert.equal(r.isError, true);
      assert.match(r.content[0].text, /第 2 个媒体取不到图像内容（共 1 个）/);
    });
    await check('取图服务失败时返回超分失败', async () => {
      imagesMode = 'throw';
      const r = await tool.handler({ key: 'group:1', messageId: 1 });
      assert.equal(r.isError, true);
      assert.match(r.content[0].text, /超分失败：fixture denied/);
      imagesMode = 'static';
    });
  }

  // ── C. X 帖子：内容安全开关关闭时不注册 ──
  {
    const root = fs.mkdtempSync(path.join(tmpRoot, 'x-'));
    fs.writeFileSync(path.join(root, 'package.json'), '{"version":"0.6.0"}');
    const config = path.join(root, 'config.json');
    const requests = [];
    fs.writeFileSync(config, '{}');
    const runtime = await createProcessPluginRuntime({ root, only: ['x-posts'], dirs: [pluginsDir], services: {
      mcp: { 'x-posts': createXPostsMcpServices(async (url, options = {}) => {
        requests.push({ url, options }); return { ok: true, posts: [{ link: 'https://example.invalid/p/1' }] };
      }) }
    } });
    try {
      const tools = Object.fromEntries(runtime.mcpTools().map(t => [t.name, t]));
      await check('工具开关未显式关闭时输出 qq_fetch_x_posts', () => assert.ok(tools.qq_fetch_x_posts));
      await check('拉取保留账号/条数/时间参数与长超时', async () => {
        const r = await tools.qq_fetch_x_posts.handler({ key: 'group:1', token: 'fixture', handle: 'sama', count: 3, lastHours: 24 });
        const req = requests.at(-1);
        assert.equal(req.url, '/api/socialV2/fetch-x-posts');
        assert.deepEqual(JSON.parse(req.options.body), { key: 'group:1', handle: 'sama', count: 3, lastHours: 24 });
        assert.equal(req.options.headers['x-agent-token'], 'fixture');
        assert.equal(req.options.timeoutMs, 180000);
        assert.equal(JSON.parse(r.content[0].text).posts.length, 1);
      });
      fs.writeFileSync(config, JSON.stringify({ socialV2: { tools: { fetchXPosts: false } } }));
      await check('内容安全开关关闭时工具不注册', () => assert.deepEqual(runtime.mcpTools(), []));
    } finally { await runtime.stop(); }
  }

  console.log(`✅ ${passed} 通过 / 0 失败`);
} finally {
  assert.ok(path.resolve(tmpRoot).startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}
