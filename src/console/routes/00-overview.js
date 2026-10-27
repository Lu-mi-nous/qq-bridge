// 控制台路由域：概览（关于 / 插件清单 / 定时任务 / 工具开关）。
//
// 只搬代码、不改语义：这些接口原先内联在 console-server.js 的请求处理器里，
// 鉴权、CSRF、agent 白名单、暂停/模式隔离仍由 console-server 统一处理，
// 走到这里时请求已经通过全部前置校验。
import fs from 'node:fs';
import path from 'node:path';
import { CONSOLE_CONTRACT_VERSION, CONSOLE_GROUPS, coreManifestCards, pluginOwnedManifestCards } from '../core-cards.js';
import { PLUGIN_PERMISSIONS } from '../../plugins/host.js';
import { maskValue } from '../../credentials-doc.js';

export const id = 'overview';
export const title = '概览';

/**
 * @param {ReturnType<import('../router.js').createConsoleRouter>} router
 * @param {object} ctx 由 console-server 每请求注入：{ req, res, url, sendJson, readBody,
 *   deps, cfg, root, TOOL_FLAGS, groupedToolFlags, toolNamesOf }
 */
export function register(router, ctx) {
  const { deps, cfg, root, sendJson, TOOL_FLAGS, groupedToolFlags, toolNamesOf } = ctx;

  // 关于页：版本 / 运行环境
  router.get('/api/about', (req, res, url, ctx) => {
    const { sendJson } = ctx;
    let version = '';
    let snowlumaVersion = '';
    try { version = String(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version || ''); } catch {}
    try {
      const home = String(cfg.snowluma?.homeDir || '').trim();
      if (home) snowlumaVersion = String(JSON.parse(fs.readFileSync(path.join(home, 'package.json'), 'utf8')).version || '');
    } catch {}
    sendJson({
      ok: true,
      name: 'QQ Bridge',
      version,
      snowlumaVersion,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      repo: 'https://github.com/Lu-mi-nous/qq-bridge'
    });
  });

  // 最小插件清单（R2.5）：返回 id/name/version/status/error，不暴露内部实现或配置。
  router.get('/api/plugins', (req, res, url, ctx) => {
    const { sendJson } = ctx;
    sendJson({ ok: true, plugins: deps.pluginHost?.list?.() ?? [] });
  });

  // 插件管理（C6）：列出全部插件（含 disabled），加载/卸载写 plugins.disabled，
  // 需要重启桥接后由宿主重新加载。不尝试运行时热卸载（插件定时器/连接无法安全回收）。
  router.get('/api/console/plugins', (req, res, url, ctx) => {
    const { sendJson } = ctx;
    const disabled = new Set((cfg.plugins?.disabled || []).map(String));
    sendJson({
      ok: true,
      plugins: (deps.pluginHost?.list?.() ?? []).map((plugin) => ({
        id: plugin.id,
        name: plugin.name || plugin.id,
        version: plugin.version || '',
        description: plugin.consoleCard?.description || plugin.console?.cards?.[0]?.description || '',
        status: plugin.status || 'unknown',
        error: plugin.error || '',
        // disabled 只表示「配置要求卸载」；运行时是否已卸载看 status。
        // 两者不一致时控制台显示“待重启”，不能让 status=disabled 盖掉配置态。
        disabled: disabled.has(plugin.id),
        cardCount: Array.isArray(plugin.console?.cards) ? plugin.console.cards.length : 0
      }))
    });
  });

  router.postPrefix('/api/console/plugins/', async (req, res, url, ctx) => {
    const { sendJson } = ctx;
    if (req.headers['x-agent-token']) { sendJson({ ok: false, error: '该接口仅控制台可用' }, 403); return; }
    const m = /^\/api\/console\/plugins\/([^/]+)\/(load|unload)$/.exec(url.pathname);
    if (!m) { sendJson({ ok: false, error: '插件操作路径不合法' }, 400); return; }
    const id = decodeURIComponent(m[1]);
    const action = m[2];
    const known = (deps.pluginHost?.list?.() ?? []).some((plugin) => plugin.id === id);
    if (!known) { sendJson({ ok: false, error: `未知插件：${id}` }, 404); return; }
    try {
      const file = path.join(root, 'config.json');
      const config = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!config.plugins || typeof config.plugins !== 'object') config.plugins = {};
      const disabled = new Set((config.plugins.disabled || []).map(String));
      if (action === 'unload') disabled.add(id); else disabled.delete(id);
      config.plugins.disabled = [...disabled].sort();
      fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
      if (!cfg.plugins || typeof cfg.plugins !== 'object') cfg.plugins = {};
      cfg.plugins.disabled = config.plugins.disabled;
      sendJson({
        ok: true,
        id,
        disabled: action === 'unload',
        restartRequired: true,
        message: action === 'unload' ? '已卸载，重启桥接后生效' : '已恢复加载，重启桥接后生效'
      });
    } catch (error) {
      sendJson({ ok: false, error: `保存插件状态失败：${error?.message ?? error}` }, 500);
    }
  });

  // 插件配置项 API（每个插件自己注册 get/set，核心只做通用脱敏/保存壳）。
  for (const plugin of deps.pluginHost?.list?.() ?? []) {
    const pctx = deps.pluginHost?.getContext?.(plugin.id);
    const items = Array.isArray(pctx?.console?.configItems) ? pctx.console.configItems : [];
    if (!items.length) continue;
    const configPath = `/api/plugins/${plugin.id}/config`;

    router.get(configPath, async (req, res, url, requestCtx) => {
      const { sendJson } = requestCtx;
      if (req.headers['x-agent-token']) { sendJson({ ok: false, error: '该接口仅控制台可用' }, 403); return; }
      const reveal = url.searchParams.get('reveal') === '1';
      const only = String(url.searchParams.get('key') ?? '').trim();
      if (reveal && !only) { sendJson({ ok: false, error: 'reveal 必须指定单条 key' }, 400); return; }
      const selected = only ? items.filter((item) => item.key === only) : items;
      const out = [];
      for (const item of selected) {
        let value = '';
        let error = '';
        try {
          const got = await item.get();
          value = got == null ? '' : String(got);
        } catch (e) {
          error = String(e?.message ?? e);
        }
        const secret = item.kind === 'secret';
        out.push({
          key: item.key,
          label: item.label,
          group: item.group || '配置',
          kind: item.kind,
          restart: item.restart === true,
          doc: item.doc || '',
          ...(Array.isArray(item.options) ? { options: item.options } : {}),
          configured: !!value,
          value: secret ? ((reveal && only) ? value : '') : value,
          preview: secret && value ? maskValue(value) : '',
          ...(error ? { error } : {})
        });
      }
      sendJson({ ok: true, pluginId: plugin.id, items: out });
    });

    router.post(configPath, async (req, res, url, requestCtx) => {
      const { sendJson, readBody } = requestCtx;
      if (req.headers['x-agent-token']) { sendJson({ ok: false, error: '该接口仅控制台可用' }, 403); return; }
      const body = await readBody();
      const key = String(body.key ?? '').trim();
      const item = items.find((x) => x.key === key);
      if (!item) { sendJson({ ok: false, error: `未知配置项：${key}` }, 400); return; }
      if (body.value === undefined) { sendJson({ ok: false, error: '缺少 value' }, 400); return; }
      const value = typeof body.value === 'string' ? body.value.replace(/[\r\n]+/g, '').trim() : body.value;
      try {
        await item.set(value);
        let next = '';
        try { const got = await item.get(); next = got == null ? '' : String(got); } catch {}
        deps.log?.(`[插件配置] ${plugin.id}/${key} 已更新${typeof value === 'string' ? `（${value.length} 字符）` : ''}`);
        sendJson({
          ok: true,
          key,
          configured: !!next,
          preview: item.kind === 'secret' && next ? maskValue(next) : '',
          restart: item.restart === true,
          applied: item.restart !== true
        });
      } catch (error) {
        sendJson({ ok: false, error: `保存失败：${error?.message ?? error}` }, 400);
      }
    });
  }

  // 控制台清单（C1）：核心卡元数据 + 插件卡元数据。
  // 只返回 JSON 元数据与端点路径，不返回任何插件代码/HTML。
  router.get('/api/console/manifest', (req, res, url, ctx) => {    const { sendJson } = ctx;
    const plugins = deps.pluginHost?.list?.() ?? [];
    const disabledPlugins = new Set((cfg.plugins?.disabled || []).map(String));
    const coreCards = coreManifestCards();
    const ownedCards = pluginOwnedManifestCards();
    const pluginGroups = [];
    plugins.forEach((plugin, pluginIndex) => {
      // 配置已卸载的插件不再贡献菜单卡片；即使进程还没重启也立刻从插件功能页消失。
      if (disabledPlugins.has(plugin.id)) return;
      const registered = Array.isArray(plugin.console?.cards) ? plugin.console.cards : [];
      const declarative = plugin.consoleCard && typeof plugin.consoleCard === 'object' ? plugin.consoleCard : null;
      // 功能归属该插件的核心模块卡（08/15/17/18）优先；与插件自己的 console.card.json 合并为一张。
      const owned = ownedCards.filter((card) => card.pluginId === plugin.id);
      const list = [...(owned.length ? owned : (declarative ? [declarative] : registered))];
      const configItems = Array.isArray(plugin.console?.configItems) ? plugin.console.configItems : [];
      if (configItems.length) {
        list.push({
          id: 'config',
          kind: 'plugin',
          owner: 'plugin',
          pluginId: plugin.id,
          title: '配置 / 连接',
          description: `${configItems.length} 个可配置项（凭据、代理或连接参数）。`,
          render: 'module',
          module: '/console/cards/config-panel.js',
          configEndpoint: `/api/plugins/${plugin.id}/config`
        });
      }
      if (!list.length) return;
      const group = {
        id: plugin.id,
        title: plugin.name || plugin.id,
        status: plugin.status || 'unknown',
        enabled: plugin.status === 'started',
        error: plugin.error || plugin.consoleCardError || '',
        cards: []
      };
      list.forEach((card, cardIndex) => {
        const id = `plugin:${plugin.id}:${card.id || cardIndex}`;
        const ownedCard = card.owner === 'plugin';
        const entry = {
          id,
          kind: 'plugin',
          owner: 'plugin',
          pluginId: plugin.id,
          pluginName: plugin.name || plugin.id,
          pluginStatus: plugin.status || 'unknown',
          enabled: plugin.status === 'started',
          title: card.title || card.id || plugin.id,
          description: card.description || '',
          endpoint: card.endpoint || '',
          order: 1000 + pluginIndex * 100 + cardIndex,
          render: ownedCard ? (card.render || 'module') : (declarative ? 'declarative' : 'legacy'),
          ...(ownedCard ? {
            ...(card.data ? { data: card.data } : {}),
            ...(card.sections ? { sections: card.sections } : {}),
            ...(card.poll ? { poll: card.poll } : {}),
            ...(card.module ? { module: card.module } : {}),
            ...(card.panel ? { panel: card.panel } : {}),
            ...(card.configEndpoint ? { configEndpoint: card.configEndpoint } : {})
          } : (declarative ? {
            contractVersion: declarative.contractVersion || 'v1',
            ...(declarative.data ? { data: declarative.data } : {}),
            ...(declarative.sections ? { sections: declarative.sections } : {}),
            ...(declarative.poll ? { poll: declarative.poll } : {}),
            ...(declarative.panel ? { panel: declarative.panel } : {})
          } : {}))
        };
        group.cards.push(entry);
      });
      pluginGroups.push(group);
    });
    // 控制台自己的连接配置（SnowLuma / 控制台令牌）不属于任何插件，单独成组。
    pluginGroups.push({
      id: 'console-tools',
      title: '控制台工具',
      status: 'builtin',
      enabled: true,
      builtin: true,
      error: '',
      cards: [{
        id: 'console-tools:credentials',
        kind: 'plugin',
        owner: 'plugin',
        pluginId: 'console-tools',
        pluginName: '控制台工具',
        pluginStatus: 'builtin',
        enabled: true,
        title: '核心连接配置',
        description: 'SnowLuma accessToken 与控制台访问令牌；插件凭据已移到各自插件卡。',
        order: 9000,
        render: 'module',
        module: '/console/cards/config-panel.js',
        configEndpoint: '/api/socialV2/credentials'
      }]
    });
    sendJson({
      ok: true,
      contractVersion: 'v2',
      core: { title: '基础功能', cards: coreCards },
      plugins: { title: '插件功能', groups: pluginGroups },
      groups: CONSOLE_GROUPS,
      pluginList: plugins.map((plugin) => ({
        id: plugin.id,
        name: plugin.name || plugin.id,
        version: plugin.version || '',
        status: plugin.status || 'unknown',
        error: plugin.error || '',
        cardCount: Array.isArray(plugin.console?.cards) ? plugin.console.cards.length : 0
      }))
    });
  });

  // 插件开发者文档（C3）：服务端常量 + 实时插件清单。
  router.get('/api/console/plugin-guide', (req, res, url, ctx) => {
    const { sendJson } = ctx;
    sendJson({
      ok: true,
      contractVersion: CONSOLE_CONTRACT_VERSION,
      cardContract: {
        kinds: ['declarative', 'iframe'],
        fields: ['text', 'input', 'number', 'switch', 'select', 'textarea', 'table', 'list', 'progress', 'custom-note', 'actions'],
        security: [
          '插件只能提交 JSON 元数据，不能提交 HTML/JS 片段',
          '动作路径必须位于 /api/plugins/<id>/ 下',
          'iframe panel 必须 sandbox="allow-scripts"（不带 allow-same-origin）',
          '插件缺席时卡片不占位，控制台不报错'
        ]
      },
      configItemContract: {
        fields: ['key', 'label', 'group', 'kind', 'restart', 'doc', 'options'],
        kinds: ['secret', 'text', 'switch', 'number', 'select', 'textarea'],
        endpoint: 'GET/POST /api/plugins/<id>/config',
        security: [
          'secret 项必须声明 secrets 权限',
          'GET 默认只回脱敏预览，reveal=1&key= 才回单条明文',
          'set(value) 由插件自己校验和保存；错误原样反馈',
          '凭据文件必须列进 manifest.secrets 白名单'
        ]
      },
      permissions: PLUGIN_PERMISSIONS,
      example: {
        file: 'plugins/<id>/console.card.json',
        json: {
          id: '<id>',
          kind: 'plugin',
          pluginId: '<id>',
          title: '插件卡片标题',
          order: 110,
          data: [{ source: '/api/plugins/<id>/card', as: 'st' }],
          sections: [
            { type: 'text', label: '状态', bind: 'st.enabled', map: { true: '已启用', false: '未启用' } },
            { type: 'switch', label: '启用', bind: 'st.enabled' }
          ]
        }
      },
      plugins: (deps.pluginHost?.list?.() ?? []).map((plugin) => ({
        id: plugin.id,
        name: plugin.name || plugin.id,
        version: plugin.version || '',
        status: plugin.status || 'unknown',
        error: plugin.error || plugin.consoleCardError || '',
        cardCount: plugin.consoleCard ? 1 : (Array.isArray(plugin.console?.cards) ? plugin.console.cards.length : 0),
        hasDeclarativeCard: !!plugin.consoleCard,
        tools: Array.isArray(plugin.tools) ? plugin.tools.length : undefined
      }))
    });
  });

  // 控制台 iframe panel：Token 报表预览（C4）。
  // 页面只负责展示图片，不接触控制台 DOM；CSP + sandbox 由外壳负责。
  router.get('/api/console/panel/token-report', (req, res) => {
    try {
      const file = path.join(root, 'public', 'console', 'panels', 'token-report.html');
      const html = fs.readFileSync(file);
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; frame-ancestors 'self'",
        'x-content-type-options': 'nosniff',
        'cache-control': 'no-store'
      });
      res.end(html);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('panel not found');
    }
  });

  // 定时任务清单与手动控制（R3-3）。仅控制台可用；Agent 不允许操作任务。
  router.get('/api/tasks', (req, res, url, ctx) => {
    const { sendJson } = ctx;
    sendJson({ ok: true, tasks: deps.taskService?.list?.() ?? [] });
  });

  router.postPrefix('/api/tasks/', async (req, res, url, ctx) => {
    const { sendJson } = ctx;
    if (req.headers['x-agent-token']) { sendJson({ ok: false, error: '该接口仅控制台可用' }, 403); return; }
    const m = /^\/api\/tasks\/([^/]+)\/(pause|resume|trigger|start|stop)$/.exec(url.pathname);
    if (!m) { sendJson({ ok: false, error: '任务操作路径不合法' }, 400); return; }
    const name = decodeURIComponent(m[1]);
    const action = m[2];
    const svc = deps.taskService;
    if (!svc) { sendJson({ ok: false, error: '任务服务未加载' }, 404); return; }
    try {
      if (action === 'trigger') await svc.trigger(name);
      else if (action === 'pause') svc.pause(name);
      else if (action === 'resume') svc.resume(name);
      else if (action === 'start') svc.start(name);
      else if (action === 'stop') svc.stop(name);
      sendJson({ ok: true, action, task: svc.get(name)?.status ? {
        name, status: svc.get(name).status, runCount: svc.get(name).runCount, lastError: svc.get(name).lastError
      } : null });
    } catch (error) {
      sendJson({ ok: false, error: `任务操作失败：${error?.message ?? error}` }, 500);
    }
  });

  // 工具开关清单（控制台由此渲染，不再硬编码复选框）。
  // 清单唯一来源是 src/tool-flags.js，前端只负责画。
  router.get('/api/socialV2/tool-flags', (req, res, url, ctx) => {
    const { sendJson } = ctx;
    const tools = cfg.socialV2?.tools ?? {};
    const groups = groupedToolFlags((flag) => tools[flag] !== false);
    sendJson({
      ok: true,
      total: TOOL_FLAGS.length,
      toolCount: toolNamesOf().length,
      enabledCount: TOOL_FLAGS.filter((x) => x.fixed !== true && tools[x.flag] !== false).length,
      groups
    });
  });
}
