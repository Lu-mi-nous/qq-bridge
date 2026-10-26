// 回归测试：控制台路由分派（R4）。
//
// 背景：console-server.js 原先把 154 条路由内联在一个请求处理器里，R4 拆成
// src/console/router.js + src/console/routes/*.js。这里用桩依赖真正启动一次
// HTTP 服务，验证：
//   ① 分域路由能命中（GET，以及 postPrefix 形态的任务操作）；
//   ② 概览模块拿到的是**每请求**的 sendJson/readBody（曾因为注册时快照而 500）；
//   ③ 插件注册的控制台路由能转发；
//   ④ 未命中走 404，非 JSON 写请求被 CSRF 拦住。
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOL_FLAGS, groupedToolFlags, toolNamesOf } from '../src/tool-flags.js';
import { createConsoleServer } from '../src/console-server.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'console-router-'));
let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};

const pluginCards = [{ id: 'tts', title: '语音合成', description: '测试卡片', endpoint: '/api/plugins/tts/card' }];
const pluginRoutes = [{
  path: '/api/plugins/tts/card',
  method: 'GET',
  handler: (req, res, url, helpers) => helpers.sendJson({ ok: true, from: 'plugin' })
}];
const pluginHost = {
  list: () => [{
    id: 'tts', name: 'TTS', version: '1.0.0', status: 'started', error: '', dir: '',
    console: { cards: pluginCards, routes: [{ path: pluginRoutes[0].path, method: 'GET' }] }
  }],
  getContext: () => ({
    console: { cards: pluginCards, routes: pluginRoutes },
    config: { get: () => ({}) },
    state: {},
    log: () => {}
  })
};

const deps = {
  fs, http, path,
  ROOT: root,
  STATE_DIR: stateDir,
  TOOL_FLAGS,
  groupedToolFlags,
  toolNamesOf,
  log: () => {},
  cfg: { consoleAuth: false, consolePort: 0, socialV2: { enabled: true, tools: {} }, allow: {}, snowluma: {} },
  state: { sessions: {} },
  social: { states: new Map(), silentTurns: new Map() },
  socialV2: { conversations: new Map(), paused: false },
  live: { currentMode: 'reserved2', closedAgentPreset: '', dshReady: false, friendIds: new Set(), slangEntries: [] },
  canonicalV2Key: (k) => k,
  isSessionAllowedInCurrentMode: () => true,
  readRoleState: () => ({ role: 'test', mode: 'active' }),
  readActivityTail: () => [],
  pluginHost,
  taskService: {
    list: () => [{ name: 't', status: 'running' }],
    pause: () => {},
    get: () => ({ status: 'paused' })
  }
};

const server = createConsoleServer(deps);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

const request = (method, p, { payload, contentType = 'application/json' } = {}) => new Promise((resolve, reject) => {
  const hasBody = method !== 'GET';
  const data = hasBody ? JSON.stringify(payload ?? {}) : '';
  const req = http.request({
    host: '127.0.0.1', port, path: p, method,
    headers: hasBody
      ? { 'content-type': contentType, 'content-length': Buffer.byteLength(data) }
      : {}
  }, (res) => {
    let body = '';
    res.on('data', (c) => { body += c; });
    res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body || '{}') }));
  });
  req.on('error', reject);
  req.end(data);
});

try {
  {
    const r = await request('GET', '/api/about');
    check('概览路由 /api/about 可命中', r.status === 200 && r.body.ok === true && r.body.name === 'QQ Bridge', String(r.status));
  }
  {
    const r = await request('GET', '/api/plugins');
    check('插件清单含控制台卡片元数据',
      r.status === 200 && r.body.plugins?.[0]?.console?.cards?.length === 1);
  }
  {
    const r = await request('GET', '/api/tasks');
    check('任务清单可读', r.status === 200 && r.body.tasks?.[0]?.name === 't');
  }
  {
    const r = await request('GET', '/api/socialV2/tool-flags');
    check('工具开关清单可读且分组', r.status === 200 && Array.isArray(r.body.groups));
  }
  {
    const r = await request('POST', '/api/tasks/t/pause', { payload: {} });
    check('POST 前缀路由可命中并读到 body', r.status === 200 && r.body.action === 'pause', String(r.status));
  }
  {
    const r = await request('GET', '/api/plugins/tts/card');
    check('插件注册的控制台路由被转发', r.status === 200 && r.body.from === 'plugin');
  }
  {
    const r = await request('GET', '/api/status');
    check('内联状态路由仍可用', r.status === 200 && r.body.mode === 'reserved2');
  }
  {
    const r = await request('GET', '/api/does-not-exist');
    check('未命中返回 404', r.status === 404 && r.body.ok === false);
  }
  {
    const r = await request('POST', '/api/tasks/t/pause', { payload: {}, contentType: 'text/plain' });
    check('非 JSON 写请求被 CSRF 拦住', r.status === 415, String(r.status));
  }
  // 动态前缀路由：/api/slang/:id/confirm 必须进到模块（而不是 404 挂起）。
  {
    const r = await request('POST', '/api/slang/nope/confirm', { payload: {} });
    check('黑话动态路由命中模块', r.status === 404 && /黑话不存在/.test(r.body.error || ''), String(r.status));
  }
  {
    const r = await request('PATCH', '/api/slang/nope', { payload: {} });
    check('PATCH 动态路由命中模块', r.status === 404 && /黑话不存在/.test(r.body.error || ''), String(r.status));
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(stateDir, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
