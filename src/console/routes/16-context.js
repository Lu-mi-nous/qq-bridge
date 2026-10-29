// 控制台路由域：共享记忆 / Token 熔断 / 上下文 / 黑话查询（R4）。
//
// R4.7-3：本文件只做 key/参数校验与 agent 鉴权；读口径在
// `src/console/read-model/context.js`，写动作在 `src/console/commands/context.js`。
// 配置写盘、运行态集合清理、episode 生成、黑话入库都不再散在路由里。
export const id = '16-context';
export const title = '共享记忆 / Token 熔断 / 上下文 / 黑话查询';

/** 本模块负责的路由；console-server 据此分派，不必解析 handler 内部。 */
export const routes = [
  ['GET', '/api/socialV2/shared-memory', 'exact'],
  ['POST', '/api/socialV2/shared-memory-config', 'exact'],
  ['POST', '/api/socialV2/shared-memory-forget', 'exact'],
  ['POST', '/api/socialV2/shared-memory-clear', 'exact'],
  ['GET', '/api/socialV2/token-fuse', 'exact'],
  ['POST', '/api/socialV2/token-fuse-config', 'exact'],
  ['POST', '/api/socialV2/token-fuse-override', 'exact'],
  ['POST', '/api/socialV2/token-fuse-reset', 'exact'],
  ['GET', '/api/socialV2/context-memory', 'exact'],
  ['POST', '/api/socialV2/context-rebuild-memory', 'exact'],
  ['POST', '/api/socialV2/context-summarize', 'exact'],
  ['POST', '/api/socialV2/context-catchup', 'exact'],
  ['POST', '/api/socialV2/context-rebuild-index', 'exact'],
  ['POST', '/api/socialV2/context-clear', 'exact'],
  ['POST', '/api/socialV2/context-delete', 'exact'],
  ['GET', '/api/socialV2/slang/query', 'exact'],
  ['POST', '/api/socialV2/slang/submit', 'exact']
];

const KEY_RE = /^(group|private):\d+$/;

export async function handle(req, res, url, ctx) {
  const { sendJson, readBody } = ctx;
  const read = ctx.readModels?.context;
  const commands = ctx.commands?.context;
  if (!read || !commands) {
    sendJson({ ok: false, error: '上下文读模型/命令未装配' }, 503);
    return;
  }
  const { agentTokenOk, v2SessionAllowed, v2ToolEnabled } = ctx;
  const reply = (result) => {
    if (!result.ok) sendJson({ ok: false, error: result.error }, result.status || 500);
    else sendJson(result);
  };

  // ── P2 跨会话人物记忆（控制台 24 卡）──────────────────────────────
  // 只返回结构化人物资料（QQ/昵称审计/偏好），绝不返回消息原文或 episode。
  // 全部 console-only：不在 AGENT_ALLOWED_PATHS 里，Agent 默认拒绝。
  if (req.method === 'GET' && url.pathname === '/api/socialV2/shared-memory') {
    reply(read.sharedMemoryView({
      q: url.searchParams.get('q'),
      limit: url.searchParams.get('limit')
    }));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/socialV2/shared-memory-config') {
    const body = await readBody();
    reply(commands.updateSharedMemoryConfig(body));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/socialV2/shared-memory-forget') {
    const body = await readBody();
    const id = String(body.id ?? '').trim();
    if (!/^\d{5,12}$/.test(id)) { sendJson({ ok: false, error: 'id 应为 QQ 号' }, 400); return; }
    reply(commands.forgetPerson(id));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/socialV2/shared-memory-clear') {
    reply(commands.clearPeople());
    return;
  }
  // ── 会话级 Token 熔断（二期 F3）──────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/api/socialV2/token-fuse') {
    reply(read.tokenFuseView());
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/socialV2/token-fuse-config') {
    const body = await readBody();
    reply(commands.saveTokenFuseConfig(body));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/socialV2/token-fuse-override') {
    const body = await readBody();
    reply(commands.saveTokenFuseOverride(body));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/socialV2/token-fuse-reset') {
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    if (!KEY_RE.test(key)) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
    reply(commands.resetTokenFuseCount(key));
    return;
  }
  // 长期记忆详情（控制台 24 号卡「长期」按钮）
  if (req.method === 'GET' && url.pathname === '/api/socialV2/context-memory') {
    const key = String(url.searchParams.get('key') ?? '').trim();
    if (!KEY_RE.test(key)) { sendJson({ ok: false, error: 'key 非法' }, 400); return; }
    reply(read.contextMemoryView(key));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/socialV2/context-rebuild-memory') {
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    if (!KEY_RE.test(key)) { sendJson({ ok: false, error: 'key 非法' }, 400); return; }
    reply(commands.rebuildMemory(key));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/socialV2/context-summarize') {
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    if (!KEY_RE.test(key)) { sendJson({ ok: false, error: '会话不存在' }, 404); return; }
    reply(await commands.summarize(key, body));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/socialV2/context-catchup') {
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    if (!KEY_RE.test(key)) { sendJson({ ok: false, error: '会话不存在' }, 404); return; }
    reply(await commands.catchup(key, body));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/socialV2/context-rebuild-index') {
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    if (key && !KEY_RE.test(key)) { sendJson({ ok: false, error: 'key 非法' }, 400); return; }
    reply(commands.rebuildIndex(key));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/socialV2/context-clear') {
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    if (key !== '*' && !KEY_RE.test(key)) { sendJson({ ok: false, error: 'key 非法（用会话 key 或 *）' }, 400); return; }
    reply(commands.clearContext(key));
    return;
  }
  // 删除一个已离群/失效会话的全部本地状态（控制台 24 号卡「已不在当前群列表」用）。
  // 只允许删当前群列表里没有的群，避免误删正在用的会话。
  if (req.method === 'POST' && url.pathname === '/api/socialV2/context-delete') {
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    if (!/^group:\d+$/.test(key)) { sendJson({ ok: false, error: '只允许删除群会话（group:群号）' }, 400); return; }
    reply(commands.deleteSession(key));
    return;
  }
  // ── 二代黑话学习（reserved2）：AI 查询/提交黑话候选 ─────────────────
  if (req.method === 'GET' && url.pathname === '/api/socialV2/slang/query') {
    const key = String(url.searchParams.get('key') ?? '').trim();
    const q = String(url.searchParams.get('q') ?? '').trim();
    if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
    if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
    if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
    if (req.headers['x-agent-token'] && !v2ToolEnabled('slangQuery')) { sendJson({ ok: false, error: '工具未启用：qq_slang_query' }, 403); return; }
    reply(read.slangQueryView({ key, q }));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/socialV2/slang/submit') {
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
    if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
    if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
    if (req.headers['x-agent-token'] && !v2ToolEnabled('slangSubmit')) { sendJson({ ok: false, error: '工具未启用：qq_slang_submit' }, 403); return; }
    reply(await commands.submitSlang({ key, content: body.content, context: body.context }));
    return;
  }
}
