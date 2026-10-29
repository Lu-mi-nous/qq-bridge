// 控制台路由域：二代发送：连发 / 消息 / 戳一戳（R4）。
//
// R4.7-3：本文件只读 body 与转发；三套发送校验/额度预占/引用解析/时间线/失败回滚
// 都在 `src/console/commands/messaging.js`。agentTokenOk/v2ToolEnabled 按请求传入。
export const id = '09-messaging';
export const title = '二代发送：连发 / 消息 / 戳一戳';

/** 本模块负责的路由；console-server 据此分派，不必解析 handler 内部。 */
export const routes = [
  ['POST', '/api/socialV2/send-burst', 'exact'],
  ['POST', '/api/socialV2/send-message', 'exact'],
  ['POST', '/api/socialV2/send-poke', 'exact']
];

export async function handle(req, res, url, ctx) {
  const { sendJson, readBody } = ctx;
  const commands = ctx.commands?.messaging;
  if (!commands) {
    sendJson({ ok: false, error: '发送命令未装配' }, 503);
    return;
  }
  const { agentTokenOk, v2ToolEnabled } = ctx;
  const reply = (result) => {
    if (!result.ok) {
      const { status, ...rest } = result;
      sendJson({ ...rest, ok: false }, status || 500);
    } else {
      sendJson(result);
    }
  };
  const headerToken = String(req.headers['x-agent-token'] ?? '').trim();

  if (req.method === 'POST' && url.pathname === '/api/socialV2/send-burst') {
    const body = await readBody();
    reply(await commands.sendBurst({ body, headerToken, agentTokenOk, toolEnabled: v2ToolEnabled }));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/socialV2/send-message') {
    const body = await readBody();
    reply(await commands.sendMessage({ body, headerToken, agentTokenOk, toolEnabled: v2ToolEnabled }));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/socialV2/send-poke') {
    const body = await readBody();
    reply(await commands.sendPoke({ body, headerToken, agentTokenOk, toolEnabled: v2ToolEnabled }));
    return;
  }
}
