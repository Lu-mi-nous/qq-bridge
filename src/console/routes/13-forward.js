// 控制台路由域：转发与活跃成员（R4）。
//
// R4.7-2：转发查询/媒体读取/活跃成员都在 `src/console/read-model/forward.js`；
// 本文件只做 key/参数解析并把 agentTokenOk/v2ToolEnabled 传入。
export const id = '13-forward';
export const title = '转发与活跃成员';

/** 本模块负责的路由；console-server 据此分派，不必解析 handler 内部。 */
export const routes = [
  ['GET', '/api/socialV2/forward-message', 'exact'],
  ['POST', '/api/socialV2/forward-media', 'exact'],
  ['GET', '/api/socialV2/active-members', 'exact']
];

export async function handle(req, res, url, ctx) {
  const { sendJson, readBody } = ctx;
  const read = ctx.readModels?.forward;
  if (!read) {
    sendJson({ ok: false, error: '转发读模型未装配' }, 503);
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

  // ── 合并转发消息查询端点（MCP qq_get_forward_msg 走这里） ────────────
  if (req.method === 'GET' && url.pathname === '/api/socialV2/forward-message') {
    reply(await read.forwardMessage({
      key: String(url.searchParams.get('key') ?? '').trim(),
      id: String(url.searchParams.get('id') ?? '').trim(),
      agentToken: String(req.headers['x-agent-token'] ?? '').trim(),
      agentTokenOk,
      toolEnabled: v2ToolEnabled
    }));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/socialV2/forward-media') {
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
    reply(await read.forwardMedia({
      key,
      media: Array.isArray(body.media) ? body.media : [],
      agentToken: String(req.headers['x-agent-token'] ?? '').trim(),
      agentTokenOk,
      toolEnabled: v2ToolEnabled
    }));
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/socialV2/active-members') {
    const key = String(url.searchParams.get('key') ?? '').trim();
    if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
    reply(read.activeMembers({
      key,
      limit: url.searchParams.get('limit'),
      agentToken: String(req.headers['x-agent-token'] ?? '').trim(),
      agentTokenOk,
      toolEnabled: v2ToolEnabled
    }));
    return;
  }
}
