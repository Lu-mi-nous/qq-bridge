// 控制台路由域：概览（关于 / 插件清单 / 定时任务 / 工具开关）。
//
// 只搬代码、不改语义：这些接口原先内联在 console-server.js 的请求处理器里，
// 鉴权、CSRF、agent 白名单、暂停/模式隔离仍由 console-server 统一处理，
// 走到这里时请求已经通过全部前置校验。
import fs from 'node:fs';
import path from 'node:path';

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
