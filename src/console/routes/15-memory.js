// 控制台路由域：记忆 / 召回（R4）。
//
// R4.7-3：本文件只做 key/参数解析与 agent 鉴权；记忆/召回/上下文状态读在
// `src/console/read-model/memory.js`，追加/编辑/删除/清空在
// `src/console/commands/memory.js`。
export const id = '15-memory';
export const title = '记忆 / 召回';

/** 本模块负责的路由；console-server 据此分派，不必解析 handler 内部。 */
export const routes = [
  ['POST', '/api/socialV2/memory-append', 'exact'],
  ['POST', '/api/socialV2/memory-update', 'exact'],
  ['GET', '/api/socialV2/memory', 'exact'],
  ['POST', '/api/socialV2/memory-remove', 'exact'],
  ['POST', '/api/socialV2/memory-clear', 'exact'],
  ['GET', '/api/socialV2/recall', 'exact'],
  ['GET', '/api/socialV2/context-status', 'exact']
];

export async function handle(req, res, url, ctx) {
  const { sendJson, readBody } = ctx;
  const read = ctx.readModels?.memory;
  const commands = ctx.commands?.memory;
  if (!read || !commands) {
    sendJson({ ok: false, error: '记忆读模型/命令未装配' }, 503);
    return;
  }
  const { agentTokenOk, v2SessionAllowed, v2ToolEnabled } = ctx;
  const reply = (result) => {
    if (!result.ok) {
      const { status, ...rest } = result;
      sendJson({ ...rest, ok: false }, status || 500);
    } else {
      sendJson(result);
    }
  };
  // 记忆写/查的共同鉴权：可选 agent token，带 token 时校验会话、准入与工具开关。
  const authMemory = (key, toolFlag = 'memory') => {
    if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) return { ok: false, status: 403, error: 'agent token 无效' };
    if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) return { ok: false, status: 403, error: '目标不在当前模式允许范围内' };
    if (req.headers['x-agent-token'] && !v2ToolEnabled(toolFlag)) {
      return { ok: false, status: 403, error: `工具未启用：${toolFlag === 'recallMemory' ? 'qq_recall_memory' : 'qq_memory_*'}` };
    }
    return null;
  };

  if (req.method === 'POST' && url.pathname === '/api/socialV2/memory-append') {
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    const denied = authMemory(key);
    if (denied) { sendJson({ ok: false, error: denied.error }, denied.status); return; }
    reply(commands.append(body));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/socialV2/memory-update') {
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    const denied = authMemory(key);
    if (denied) { sendJson({ ok: false, error: denied.error }, denied.status); return; }
    reply(commands.update(body));
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/socialV2/memory') {
    const key = String(url.searchParams.get('key') ?? '').trim();
    if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
    const denied = authMemory(key);
    if (denied) { sendJson({ ok: false, error: denied.error }, denied.status); return; }
    sendJson(read.memoryView({ key, category: String(url.searchParams.get('category') ?? '').trim() }));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/socialV2/memory-remove') {
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    const denied = authMemory(key);
    if (denied) { sendJson({ ok: false, error: denied.error }, denied.status); return; }
    reply(commands.remove(body));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/socialV2/memory-clear') {
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    const denied = authMemory(key);
    if (denied) { sendJson({ ok: false, error: denied.error }, denied.status); return; }
    reply(commands.clear(body));
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/socialV2/recall') {
    const key = String(url.searchParams.get('key') ?? '').trim();
    if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
    const denied = authMemory(key, 'recallMemory');
    if (denied) { sendJson({ ok: false, error: denied.error }, denied.status); return; }
    sendJson(read.recall({
      key,
      query: url.searchParams.get('q') ?? url.searchParams.get('query') ?? '',
      limit: url.searchParams.get('limit'),
      from: url.searchParams.get('from'),
      to: url.searchParams.get('to')
    }));
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/socialV2/context-status') {
    sendJson(read.contextStatus());
    return;
  }
}
