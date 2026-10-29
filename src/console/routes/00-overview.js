// 控制台路由域：概览（关于 / 插件清单 / 定时任务 / 工具开关）。
//
// R4.7-3：about/插件清单/管理列表/manifest/插件指南/工具开关/插件配置读在
// `src/console/read-model/overview.js`；插件加载卸载与配置保存在
// `src/console/commands/plugins.js`；任务命令在 `commands/tasks.js`。
export const id = 'overview';
export const title = '概览';

/**
 * @param {ReturnType<import('../router.js').createConsoleRouter>} router
 * @param {object} ctx 由 console-server 注入的静态上下文（root/TOOL_FLAGS 等仅用于兼容）。
 *   所有 handler 从每请求 ctx 取 `readModels.overview` / `commands.*`。
 */
export function register(router, ctx) {
  // 关于页：版本 / 运行环境
  router.get('/api/about', (req, res, url, requestCtx) => {
    requestCtx.sendJson(requestCtx.readModels.overview.about());
  });

  // 最小插件清单（R2.5）：返回 id/name/version/status/error，不暴露内部实现或配置。
  router.get('/api/plugins', (req, res, url, requestCtx) => {
    requestCtx.sendJson(requestCtx.readModels.overview.pluginList());
  });

  // 插件管理（C6）：列出全部插件（含 disabled），加载/卸载写 plugins.disabled，
  // 需要重启桥接后由宿主重新加载。不尝试运行时热卸载（插件定时器/连接无法安全回收）。
  router.get('/api/console/plugins', (req, res, url, requestCtx) => {
    requestCtx.sendJson(requestCtx.readModels.overview.adminPlugins());
  });

  router.postPrefix('/api/console/plugins/', (req, res, url, requestCtx) => {
    const { sendJson } = requestCtx;
    if (req.headers['x-agent-token']) { sendJson({ ok: false, error: '该接口仅控制台可用' }, 403); return; }
    const m = /^\/api\/console\/plugins\/([^/]+)\/(load|unload)$/.exec(url.pathname);
    if (!m) { sendJson({ ok: false, error: '插件操作路径不合法' }, 400); return; }
    const result = requestCtx.commands?.plugins?.setEnabled(decodeURIComponent(m[1]), m[2]);
    if (!result) { sendJson({ ok: false, error: '插件命令未装配' }, 503); return; }
    if (!result.ok) { sendJson({ ok: false, error: result.error }, result.status || 500); return; }
    sendJson(result);
  });

  // 插件配置项 API（每个插件自己注册 get/set，核心只做通用脱敏/保存壳）。
  router.getPrefix('/api/plugins/', async (req, res, url, requestCtx) => {
    const { sendJson } = requestCtx;
    if (req.headers['x-agent-token']) { sendJson({ ok: false, error: '该接口仅控制台可用' }, 403); return; }
    const m = /^\/api\/plugins\/([^/]+)\/config$/.exec(url.pathname);
    if (!m) { sendJson({ ok: false, error: 'not found' }, 404); return; }
    const result = await requestCtx.readModels.overview.pluginConfig(decodeURIComponent(m[1]), {
      reveal: url.searchParams.get('reveal') === '1',
      only: String(url.searchParams.get('key') ?? '').trim()
    });
    if (!result.ok) { sendJson({ ok: false, error: result.error }, result.status || 500); return; }
    sendJson(result);
  });

  router.postPrefix('/api/plugins/', async (req, res, url, requestCtx) => {
    const { sendJson, readBody } = requestCtx;
    if (req.headers['x-agent-token']) { sendJson({ ok: false, error: '该接口仅控制台可用' }, 403); return; }
    const m = /^\/api\/plugins\/([^/]+)\/config$/.exec(url.pathname);
    if (!m) { sendJson({ ok: false, error: 'not found' }, 404); return; }
    const body = await readBody();
    const result = await requestCtx.commands?.plugins?.saveConfig(decodeURIComponent(m[1]), body);
    if (!result) { sendJson({ ok: false, error: '插件命令未装配' }, 503); return; }
    if (!result.ok) { sendJson({ ok: false, error: result.error }, result.status || 500); return; }
    sendJson(result);
  });

  // 控制台清单（C1）：核心卡元数据 + 插件卡元数据。
  // 只返回 JSON 元数据与端点路径，不返回任何插件代码/HTML。
  router.get('/api/console/manifest', (req, res, url, requestCtx) => {
    requestCtx.sendJson(requestCtx.readModels.overview.manifest());
  });

  // 插件开发者文档（C3）：服务端常量 + 实时插件清单。
  router.get('/api/console/plugin-guide', (req, res, url, requestCtx) => {
    requestCtx.sendJson(requestCtx.readModels.overview.pluginGuide());
  });

  // 控制台 iframe panel：Token 报表预览（C4）。
  // 页面只负责展示图片，不接触控制台 DOM；CSP + sandbox 由外壳负责。
  router.get('/api/console/panel/token-report', (req, res, url, requestCtx) => {
    const panel = requestCtx.readModels.overview.tokenReportPanel();
    if (!panel.ok) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('panel not found');
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; frame-ancestors 'self'",
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store'
    });
    res.end(panel.html);
  });

  // 定时任务清单与手动控制（R3-3）。仅控制台可用；Agent 不允许操作任务。
  router.get('/api/tasks', (req, res, url, requestCtx) => {
    requestCtx.sendJson(requestCtx.commands?.tasks?.list?.() ?? { ok: true, tasks: [] });
  });

  router.postPrefix('/api/tasks/', async (req, res, url, requestCtx) => {
    const { sendJson } = requestCtx;
    if (req.headers['x-agent-token']) { sendJson({ ok: false, error: '该接口仅控制台可用' }, 403); return; }
    const m = /^\/api\/tasks\/([^/]+)\/(pause|resume|trigger|start|stop)$/.exec(url.pathname);
    if (!m) { sendJson({ ok: false, error: '任务操作路径不合法' }, 400); return; }
    const result = requestCtx.commands?.tasks
      ? await requestCtx.commands.tasks.apply(decodeURIComponent(m[1]), m[2])
      : { ok: false, status: 404, error: '任务服务未加载' };
    if (!result.ok) { sendJson({ ok: false, error: result.error }, result.status || 500); return; }
    sendJson({ ok: true, action: result.action, task: result.task });
  });

  // 工具开关清单（控制台由此渲染，不再硬编码复选框）。
  // 清单唯一来源是 src/tool-flags.js，前端只负责画。
  router.get('/api/socialV2/tool-flags', (req, res, url, requestCtx) => {
    requestCtx.sendJson(requestCtx.readModels.overview.toolFlags());
  });
}
