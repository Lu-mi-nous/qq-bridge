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
const pluginConsoleCard = {
  id: 'tts',
  kind: 'plugin',
  pluginId: 'tts',
  title: '语音合成',
  sections: [{ type: 'text', label: '状态', bind: 'st.enabled' }]
};
const pluginRoutes = [{
  path: '/api/plugins/tts/card',
  method: 'GET',
  handler: (req, res, url, helpers) => helpers.sendJson({ ok: true, from: 'plugin' })
}];
let testSecret = '';
const pluginConfigItems = [{
  key: 'testSecret',
  label: '测试凭据',
  group: '凭据',
  kind: 'secret',
  restart: false,
  doc: '测试说明：这是插件自己注册的凭据。',
  get: () => testSecret,
  set: (value) => { testSecret = String(value || ''); }
}];
const pluginConfigMeta = pluginConfigItems.map(({ get, set, ...meta }) => meta);
let pluginAvailable = true;
const pluginHost = {
  capabilities: { get: name => name === 'slang.instance' ? {} : null },
  list: () => [{
    id: 'tts', name: 'TTS', version: '1.0.0', status: 'started', error: '', dir: '',
    console: { cards: pluginCards, routes: [{ path: pluginRoutes[0].path, method: 'GET' }], configItems: pluginConfigMeta },
    consoleCard: pluginConsoleCard
  }],
  getContext: () => pluginAvailable ? ({
    console: { cards: pluginCards, routes: pluginRoutes, configItems: pluginConfigItems },
    config: { get: () => ({}) },
    state: {},
    log: () => {}
  }) : null
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

const request = (method, p, { payload, contentType = 'application/json', headers = {} } = {}) => new Promise((resolve, reject) => {
  const hasBody = method !== 'GET';
  const data = hasBody ? JSON.stringify(payload ?? {}) : '';
  const req = http.request({
    host: '127.0.0.1', port, path: p, method,
    headers: hasBody
      ? { ...headers, 'content-type': contentType, 'content-length': Buffer.byteLength(data) }
      : headers
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
    check('概览路由 /api/about 可命中', r.status === 200 && r.body.ok === true && r.body.name === 'WhaleTalk', String(r.status));
  }
  {
    const r = await request('GET', '/api/plugins');
    check('插件清单含控制台卡片元数据',
      r.status === 200 && r.body.plugins?.[0]?.console?.cards?.length === 1);
  }
  {
    const r = await request('GET', '/api/console/manifest');
    check('控制台清单 v2 分区返回', r.status === 200 && r.body.ok === true
      && r.body.contractVersion === 'v2'
      && Array.isArray(r.body.core?.cards)
      && Array.isArray(r.body.plugins?.groups));
    check('基础功能 19 张、无插件卡', r.body.core.cards.length === 19
      && r.body.core.cards.every((c) => c.owner === 'core' && !c.pluginId));
    check('顶层不再混排 cards', !Array.isArray(r.body.cards));
    check('插件组有卡片且归 plugin owner',
      r.body.plugins.groups?.[0]?.id === 'tts'
      && r.body.plugins.groups[0].cards.length === 2
      && r.body.plugins.groups[0].cards[0].owner === 'plugin'
      && r.body.plugins.groups[0].cards[0].pluginId === 'tts');
    check('插件归属卡优先使用核心模块', r.body.plugins.groups[0].cards[0].render === 'module'
      && r.body.plugins.groups[0].cards[0].module === '/console/cards/18-tts.js');
    check('插件配置卡自动追加', r.body.plugins.groups[0].cards[1].render === 'module'
      && r.body.plugins.groups[0].cards[1].module === '/console/cards/config-panel.js'
      && r.body.plugins.groups[0].cards[1].configEndpoint === '/api/plugins/tts/config');
    check('控制台工具分组存在', r.body.plugins.groups.some((g) => g.id === 'console-tools'
      && g.builtin === true
      && g.cards?.[0]?.configEndpoint === '/api/socialV2/credentials'));
    check('试点卡 10/11/13 为声明式', ['10', '11', '13'].every((id) => r.body.core.cards.find((c) => c.id === id)?.render === 'declarative'));
    check('清单不返回插件代码/HTML', !/console\.panel|<!doctype|<script/i.test(JSON.stringify(r.body)));
  }
  {
    const previous = deps.cfg.plugins;
    deps.cfg.plugins = { disabled: ['tts'] };
    const r = await request('GET', '/api/console/manifest');
    check('配置已卸载的插件不再返回菜单卡', r.status === 200
      && r.body.plugins.groups.length === 1
      && r.body.plugins.groups[0].id === 'console-tools');
    deps.cfg.plugins = previous;
  }
  {
    const r = await request('GET', '/api/console/plugin-guide');
    check('插件开发文档端点', r.status === 200 && r.body.ok === true
      && r.body.contractVersion === 'v1'
      && r.body.cardContract?.fields?.includes('switch')
      && r.body.plugins?.[0]?.id === 'tts');
  }
  {
    const r = await request('GET', '/api/console/plugins');
    check('插件管理清单可读', r.status === 200 && r.body.plugins?.[0]?.id === 'tts'
      && typeof r.body.plugins[0].disabled === 'boolean');
  }
  {
    const r = await request('GET', '/api/tasks');
    check('任务清单可读', r.status === 200 && r.body.tasks?.[0]?.name === 't');
  }
  {
    // R4.7：Token / 活动流路由改吃 facets；平铺 deps 仍由 ensureConsoleServices 兼容分组。
    const r = await request('GET', '/api/socialV2/token-usage');
    check('Token 读模型经 facets 接线', r.status === 200 && r.body.ok === true && r.body.ready === false);
    const a = await request('GET', '/api/socialV2/activity');
    check('活动流读模型经 facets 接线', a.status === 200 && a.body.ok === true && a.body.paused === false);
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
    pluginAvailable = false;
    for (const [method, endpoint] of [['GET', 'card'], ['GET', 'config'], ['POST', 'config']]) {
      const r = await request(method, `/api/plugins/tts/${endpoint}`, { payload: { key: 'testSecret', value: 'blocked' } });
      check(`不可用插件拒绝 ${method} ${endpoint}`, r.status === 404);
    }
    check('被拒绝的配置写入无副作用', testSecret === '');
    pluginAvailable = true;
    const old = pluginRoutes[0];
    pluginRoutes[0] = { ...old, handler: (req, res, url, helpers) => helpers.sendJson({ from: 'restarted' }) };
    const r = await request('GET', '/api/plugins/tts/card');
    check('恢复后取当前处理器', r.body.from === 'restarted');
    pluginRoutes[0] = old;
  }
  {
    const r = await request('GET', '/api/plugins/tts/config');
    check('插件配置项 GET 可用', r.status === 200
      && r.body.items?.length === 1
      && r.body.items[0].key === 'testSecret'
      && r.body.items[0].configured === false);
  }
  {
    const r = await request('POST', '/api/plugins/tts/config', { payload: { key: 'testSecret', value: 'secret123' } });
    check('插件配置项 POST 交给插件 set', r.status === 200 && r.body.ok === true && testSecret === 'secret123');
  }
  {
    const r = await request('GET', '/api/plugins/tts/config');
    const item = r.body.items?.[0] || {};
    check('插件配置项默认只回脱敏预览', r.status === 200
      && item.configured === true
      && item.value === ''
      && /^se••••••23$|^se.*23$/.test(item.preview));
  }
  {
    const r = await request('GET', '/api/plugins/tts/config?reveal=1&key=testSecret');
    check('插件配置项 reveal 单条给明文', r.status === 200 && r.body.items?.[0]?.value === 'secret123');
  }
  {
    const r = await request('GET', '/api/plugins/tts/config?reveal=1');
    check('插件配置项 reveal 必须带 key', r.status === 400);
  }
  {
    const r = await request('GET', '/api/plugins/tts/config', { headers: { 'x-agent-token': 'fake' } });
    check('插件配置项拒绝 agent token', r.status === 403);
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
  // C0 静态资源：/console/* 直出；只允许 public/console 下的白名单扩展名。
  {
    const getRaw = (p) => new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: p }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      }).on('error', reject);
    });
    const js = await getRaw('/console/shell.js');
    check('静态资源 /console/shell.js 可直出',
      js.status === 200 && /javascript/.test(js.headers['content-type'] || '') && js.body.includes('CONTRACT_VERSION'));
    const cssFiles = ['base.css', 'cards.css', 'components.css'];
    let cssOk = true;
    for (const f of cssFiles) {
      const css = await getRaw('/console/styles/' + f);
      if (css.status !== 200 || !/text\/css/.test(css.headers['content-type'] || '')) cssOk = false;
    }
    check('静态资源 CSS 可直出（三份）', cssOk);
    const trav = await getRaw('/console/%2e%2e%2fsrc%2fbridge.js');
    check('静态资源拒绝路径穿越', trav.status === 404, String(trav.status));
    const miss = await getRaw('/console/nope.js');
    check('静态资源未命中 404', miss.status === 404, String(miss.status));
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
