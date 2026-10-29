// 控制台路由域：二代只读：群文件 / 未读 / 唤醒（R4）。
//
// R4.7-3：本文件只做 key/agent 鉴权；群文件/未读/最近/状态读在
// `src/console/read-model/social-read.js`，标记已读/唤醒配置/手动唤醒在
// `src/console/commands/social-read.js`。
export const id = '08-social-read';
export const title = '二代只读：群文件 / 未读 / 唤醒';

/** 本模块负责的路由；console-server 据此分派，不必解析 handler 内部。 */
export const routes = [
  ['GET', '/api/socialV2/group-files', 'exact'],
  ['GET', '/api/socialV2/group-file-stats', 'exact'],
  ['GET', '/api/socialV2/unread', 'exact'],
  ['GET', '/api/socialV2/recent', 'exact'],
  ['POST', '/api/socialV2/mark-read', 'exact'],
  ['POST', '/api/socialV2/wake-config', 'exact'],
  ['GET', '/api/socialV2/states', 'exact'],
  ['POST', '/api/socialV2/wake', 'exact']
];

export async function handle(req, res, url, ctx) {
  const { sendJson, readBody } = ctx;
  const read = ctx.readModels?.socialRead;
  const commands = ctx.commands?.socialRead;
  if (!read || !commands) {
    sendJson({ ok: false, error: '二代只读读模型/命令未装配' }, 503);
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

  // ── 群文件只读分类（见 group-files.js）──────────────────────────────
  // 只读：列文件、统计、搜索。**不删除/移动/上传/改名**。
  if (req.method === 'GET' && url.pathname === '/api/socialV2/group-files') {
    const key = String(url.searchParams.get('key') ?? '').trim();
    if (!/^group:(\d+)$/.test(key)) { sendJson({ ok: false, error: '群文件只适用于群会话（key 格式 group:群号）' }, 400); return; }
    if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: '读取群文件必须携带 agent token' }, 403); return; }
    if (!agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
    if (!v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
    if (!v2ToolEnabled('groupFiles')) { sendJson({ ok: false, error: '工具未启用：qq_list_group_files' }, 403); return; }
    reply(await read.groupFiles({
      key,
      mode: String(url.searchParams.get('mode') ?? 'summary'),
      recentDays: Number(url.searchParams.get('recentDays')) || 7,
      search: {
        keyword: url.searchParams.get('keyword'),
        category: url.searchParams.get('category'),
        ext: url.searchParams.get('ext'),
        uploader: url.searchParams.get('uploader'),
        minBytes: url.searchParams.get('minBytes'),
        maxBytes: url.searchParams.get('maxBytes'),
        limit: url.searchParams.get('limit')
      }
    }));
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/socialV2/group-file-stats') {
    const key = String(url.searchParams.get('key') ?? '').trim();
    if (!/^group:(\d+)$/.test(key)) { sendJson({ ok: false, error: '群文件只适用于群会话（key 格式 group:群号）' }, 400); return; }
    if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: '读取群文件必须携带 agent token' }, 403); return; }
    if (!agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
    if (!v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
    if (!v2ToolEnabled('groupFiles')) { sendJson({ ok: false, error: '工具未启用：qq_group_file_stats' }, 403); return; }
    reply(await read.groupFileStats({ key }));
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/socialV2/unread') {
    const key = String(url.searchParams.get('key') ?? '').trim();
    if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
    if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
    if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
    if (req.headers['x-agent-token'] && !v2ToolEnabled('getUnread')) { sendJson({ ok: false, error: '工具未启用：qq_get_unread_messages' }, 403); return; }
    reply(read.unread({ key, limit: url.searchParams.get('limit') }));
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/socialV2/recent') {
    const key = String(url.searchParams.get('key') ?? '').trim();
    if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
    if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
    if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
    if (req.headers['x-agent-token'] && !v2ToolEnabled('getRecent')) { sendJson({ ok: false, error: '工具未启用：qq_get_recent_messages' }, 403); return; }
    reply(read.recent({ key, limit: url.searchParams.get('limit'), offset: url.searchParams.get('offset') }));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/socialV2/mark-read') {
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
    if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
    if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
    if (req.headers['x-agent-token'] && !v2ToolEnabled('markRead')) { sendJson({ ok: false, error: '工具未启用：qq_mark_read' }, 403); return; }
    reply(commands.markRead({ key }));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/socialV2/wake-config') {
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
    if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
    if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
    if (req.headers['x-agent-token'] && !v2ToolEnabled('setWakeConfig')) { sendJson({ ok: false, error: '工具未启用：qq_set_wake_config' }, 403); return; }
    reply(commands.setWakeConfig({ key, body }));
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/socialV2/states') {
    reply(read.states());
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/socialV2/wake') {
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    const reason = String(body.reason ?? 'admin').trim() || 'admin';
    if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
    reply(commands.wake({ key, reason }));
    return;
  }
}
