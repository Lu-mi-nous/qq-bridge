// 控制台路由域：Agent 回调：授权 / 图片 / 超分回传（R4）。
//
// R4.7-3：本文件只读 body 与转发；旧只读授权/图片查询在
// `src/console/read-model/agent.js`，超分回传/统一发送在
// `src/console/commands/agent.js`。鉴权 helper（agentTokenOk/v2ToolEnabled）按请求传入。
export const id = '17-agent';
export const title = 'Agent 回调：授权 / 图片 / 超分回传';

/** 本模块负责的路由；console-server 据此分派，不必解析 handler 内部。 */
export const routes = [
  ['POST', '/api/authorize/read', 'exact'],
  ['GET', '/api/images/message', 'exact'],
  ['POST', '/api/socialV2/send-upscaled', 'exact'],
  // 统一发送端点（MCP 旧工具）：同一段 handler 里按 pathname 分 group/private/reply。
  ['POST', '/api/send/group', 'exact'],
  ['POST', '/api/send/private', 'exact'],
  ['POST', '/api/send/reply', 'exact']
];

export async function handle(req, res, url, ctx) {
  const { sendJson, readBody } = ctx;
  const read = ctx.readModels?.agent;
  const commands = ctx.commands?.agent;
  if (!read || !commands) {
    sendJson({ ok: false, error: 'Agent 读模型/命令未装配' }, 503);
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

  if (req.method === 'POST' && url.pathname === '/api/authorize/read') {
    const body = await readBody();
    reply(read.authorize({
      key: String(body.key ?? '').trim(),
      token: String(body.token ?? '').trim(),
      agentTokenOk
    }));
    return;
  }
  // ── 图片/表情查询端点（MCP qq_get_message_images 走这里） ────────────
  if (req.method === 'GET' && url.pathname === '/api/images/message') {
    reply(await read.messageImages({
      key: String(url.searchParams.get('key') ?? '').trim(),
      messageId: String(url.searchParams.get('messageId') ?? '').trim(),
      agentToken: String(req.headers['x-agent-token'] ?? '').trim(),
      agentTokenOk,
      toolEnabled: v2ToolEnabled,
      raw: url.searchParams.get('raw') === '1'
    }));
    return;
  }

  // ── 超分结果回传（把放大后的图发给群友）─────────────────────────────
  // 这里要收一张 base64 图片，申请放宽的请求体上限（白名单路由，见 readBody）。
  if (req.method === 'POST' && url.pathname === '/api/socialV2/send-upscaled') {
    const body = await readBody({ route: url.pathname, maxBytes: 8_000_000 });
    reply(await commands.sendUpscaled({
      body,
      headerToken: String(req.headers['x-agent-token'] ?? '').trim(),
      agentTokenOk,
      toolEnabled: v2ToolEnabled
    }));
    return;
  }

  // ── 统一发送端点（MCP 旧发送工具也走这里） ───────────────────────────
  if (req.method === 'POST' && (url.pathname === '/api/send/group' || url.pathname === '/api/send/private' || url.pathname === '/api/send/reply')) {
    const body = await readBody();
    reply(await commands.sendMessage({
      pathname: url.pathname,
      body,
      headerToken: String(req.headers['x-agent-token'] ?? '').trim(),
      agentTokenOk,
      toolEnabled: v2ToolEnabled
    }));
    return;
  }
}
