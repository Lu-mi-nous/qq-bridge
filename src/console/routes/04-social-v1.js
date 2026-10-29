// 控制台路由域：一代社交状态与运维通知（R4）。
//
// R4.7-3：本文件只读 body 与转发；社交状态/开发日志读在
// `src/console/read-model/social-v1.js`，阶段/配置/flush/后台提醒在
// `src/console/commands/social-v1.js`。
export const id = '04-social-v1';
export const title = '一代社交状态与运维通知';

/** 本模块负责的路由；console-server 据此分派，不必解析 handler 内部。 */
export const routes = [
  ['POST', '/api/social/state', 'exact'],
  ['GET', '/api/social', 'exact'],
  ['POST', '/api/social', 'exact'],
  ['POST', '/api/social/flush', 'exact'],
  ['POST', '/api/console/notify-ai', 'exact'],
  ['GET', '/api/dev-log', 'exact']
];

export async function handle(req, res, url, ctx) {
  const { sendJson, readBody } = ctx;
  const read = ctx.readModels?.socialV1;
  const commands = ctx.commands?.socialV1;
  if (!read || !commands) {
    sendJson({ ok: false, error: '社交读模型/命令未装配' }, 503);
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

  if (req.method === 'POST' && url.pathname === '/api/social/state') {
    const body = await readBody();
    reply(commands.setPhase(body));
    return;
  }
  // ── 仿真群友模式（社交引擎）配置 ──────────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/api/social') {
    sendJson(read.socialState());
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/social') {
    const body = await readBody();
    reply(commands.saveConfig(body));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/social/flush') {
    const body = await readBody();
    reply(await commands.flush(body));
    return;
  }
  // ── 后台控制端引导：向指定会话的 DSH agent 投递提醒 ──────────────────
  if (req.method === 'POST' && url.pathname === '/api/console/notify-ai') {
    const body = await readBody();
    reply(await commands.notifyAi(body));
    return;
  }
  // ── 开发日志：读取 README 的更新日志章节（只读，不现算大文件） ────────
  if (req.method === 'GET' && url.pathname === '/api/dev-log') {
    reply(read.devLog());
    return;
  }
}
