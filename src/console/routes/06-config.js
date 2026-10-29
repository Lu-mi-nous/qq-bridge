// 控制台路由域：配置与凭据（R4）。
//
// R4.7-3：本文件只读 body 与转发；凭据列表/配置读取在
// `src/console/read-model/config.js`，凭据保存/socialV2 配置保存在
// `src/console/commands/config.js`。
export const id = '06-config';
export const title = '配置与凭据';

/** 本模块负责的路由；console-server 据此分派，不必解析 handler 内部。 */
export const routes = [
  ['GET', '/api/socialV2/credentials', 'exact'],
  ['POST', '/api/socialV2/credentials', 'exact'],
  ['GET', '/api/socialV2/config', 'exact'],
  ['POST', '/api/socialV2/config', 'exact']
];

export async function handle(req, res, url, ctx) {
  const { sendJson, readBody } = ctx;
  const read = ctx.readModels?.config;
  const commands = ctx.commands?.config;
  if (!read || !commands) {
    sendJson({ ok: false, error: '配置读模型/命令未装配' }, 503);
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

  // 插件清单 / 定时任务 / 工具开关：见 src/console/routes/00-overview.js（R4）
  if (req.method === 'GET' && url.pathname === '/api/socialV2/credentials') {
    sendJson(read.credentials({
      reveal: url.searchParams.get('reveal') === '1',
      only: String(url.searchParams.get('key') ?? '').trim()
    }));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/socialV2/credentials') {
    const body = await readBody();
    reply(commands.saveCredential(body));
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/socialV2/config') {
    sendJson(read.socialConfig());
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/socialV2/config') {
    const body = await readBody();
    reply(commands.saveSocialConfig(body));
    return;
  }
}
