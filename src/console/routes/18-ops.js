// 控制台路由域：重置与重启（R4）。
//
// R4.7-3：本文件只解析 body；会话重置、工作区清空、detached 自重启都在
// `src/console/commands/ops.js`。鉴权 / CSRF / agent 白名单仍由 console-server 统一处理。
export const id = '18-ops';
export const title = '重置与重启';

/** 本模块负责的路由；console-server 据此分派，不必解析 handler 内部。 */
export const routes = [
  ['POST', '/api/session/reset', 'exact'],
  ['POST', '/api/workspace/reset', 'exact'],
  ['POST', '/api/restart', 'exact']
];

export async function handle(req, res, url, ctx) {
  const { sendJson, readBody } = ctx;
  const commands = ctx.commands?.ops;
  if (!commands) {
    sendJson({ ok: false, error: '运维命令未装配' }, 503);
    return;
  }
  const reply = (result) => {
    if (!result.ok) sendJson({ ok: false, error: result.error }, result.status || 500);
    else sendJson(result);
  };

  // ── 清除上下文 / 清空工作区 ──────────────────────────────────────────
  if (req.method === 'POST' && url.pathname === '/api/session/reset') {
    const body = await readBody();
    reply(await commands.resetSession(String(body.key ?? '')));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/workspace/reset') {
    reply(await commands.resetWorkspace());
    return;
  }
  // ── 重启桥接（detached 子进程自重启） ──────────────────────────────────
  if (req.method === 'POST' && url.pathname === '/api/restart') {
    reply(commands.scheduleRestart());
    return;
  }
  sendJson({ ok: false, error: 'not found' }, 404);
}
