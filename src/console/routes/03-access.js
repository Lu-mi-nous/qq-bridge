// 控制台路由域：会话 / 白名单 / 安全 / 控制台令牌（R4）。
//
// R4.7-3：本文件只读 body 与转发；会话/挂起/白名单/安全/令牌状态读在
// `src/console/read-model/access.js`，白名单/安全/令牌/测试发送写在
// `src/console/commands/access.js`。
export const id = '03-access';
export const title = '会话 / 白名单 / 安全 / 控制台令牌';

/** 本模块负责的路由；console-server 据此分派，不必解析 handler 内部。 */
export const routes = [
  ['GET', '/api/sessions', 'exact'],
  ['GET', '/api/pending', 'exact'],
  ['GET', '/api/whitelist', 'exact'],
  ['POST', '/api/whitelist', 'exact'],
  ['GET', '/api/security', 'exact'],
  ['POST', '/api/security', 'exact'],
  ['GET', '/api/console/token', 'exact'],
  ['POST', '/api/console/token', 'exact'],
  ['POST', '/api/test-send', 'exact']
];

export async function handle(req, res, url, ctx) {
  const { sendJson, readBody } = ctx;
  const read = ctx.readModels?.access;
  const commands = ctx.commands?.access;
  if (!read || !commands) {
    sendJson({ ok: false, error: '访问控制读模型/命令未装配' }, 503);
    return;
  }
  const reply = (result) => {
    if (!result.ok) {
      const { status, ...rest } = result;
      sendJson({ ...rest, ok: false }, status || 500);
    } else {
      sendJson(result);
    }
  };

  // ── 会话查看 ──────────────────────────────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/api/sessions') {
    sendJson(await read.sessions());
    return;
  }
  // ── 挂起审批 / 提问 ───────────────────────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/api/pending') {
    sendJson(read.pendingList());
    return;
  }
  // ── 白名单可视化编辑（写 config.json + 热更新内存） ───────────────────
  if (req.method === 'GET' && url.pathname === '/api/whitelist') {
    sendJson(await read.whitelist());
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/whitelist') {
    const body = await readBody();
    reply(commands.saveWhitelist(body));
    return;
  }

  // ── 安全拦截通知设置 ─────────────────────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/api/security') {
    sendJson(read.security());
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/security') {
    const body = await readBody();
    reply(commands.saveSecurity(body));
    return;
  }
  // ── 控制台访问令牌（可手动修改/生成随机） ─────────────────────────────
  if (req.method === 'GET' && url.pathname === '/api/console/token') {
    reply(read.consoleToken({ authState: ctx.authState, port: ctx.port }));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/console/token') {
    const body = await readBody();
    reply(commands.rotateConsoleToken(body, ctx.authState));
    return;
  }
  // ── 测试发送消息（强制走白名单校验） ───────────────────────────────────
  if (req.method === 'POST' && url.pathname === '/api/test-send') {
    const body = await readBody();
    reply(await commands.testSend(body));
    return;
  }
}
