// 控制台路由域：等待 / 工具日志 / 反馈 / 消息详情（R4）。
//
// R4.7-3：本文件只做参数/key 解析与 agent 鉴权；长轮询等待与反馈/日志写命令在
// `src/console/commands/wait.js`，列表/消息详情读在 `src/console/read-model/wait.js`。
// 等待的单回合硬上限、跨回合滑动窗口、quiet 窗口、占位释放都在命令层。
export const id = '12-wait';
export const title = '等待 / 工具日志 / 反馈 / 消息详情';

/** 本模块负责的路由；console-server 据此分派，不必解析 handler 内部。 */
export const routes = [
  ['POST', '/api/socialV2/wait', 'exact'],
  ['POST', '/api/socialV2/check-send', 'exact'],
  ['GET', '/api/socialV2/tool-log', 'exact'],
  ['POST', '/api/socialV2/tool-log/clear', 'exact'],
  ['POST', '/api/socialV2/error-notify-selftest', 'exact'],
  ['GET', '/api/socialV2/feedback', 'exact'],
  ['POST', '/api/socialV2/feedback-clear', 'exact'],
  ['POST', '/api/socialV2/feedback', 'exact'],
  ['GET', '/api/socialV2/my-recent', 'exact'],
  ['POST', '/api/socialV2/record-sent', 'exact'],
  ['GET', '/api/socialV2/message-detail', 'exact']
];

export async function handle(req, res, url, ctx) {
  const { sendJson, readBody } = ctx;
  const read = ctx.readModels?.wait;
  const commands = ctx.commands?.wait;
  if (!read || !commands) {
    sendJson({ ok: false, error: '等待读模型/命令未装配' }, 503);
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

  if (req.method === 'POST' && url.pathname === '/api/socialV2/wait') {
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
    if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
    if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
    if (req.headers['x-agent-token'] && !v2ToolEnabled('waitMessages')) { sendJson({ ok: false, error: '工具未启用：qq_wait_for_messages' }, 403); return; }
    reply(await commands.waitForMessages({ key, body, req }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/socialV2/check-send') {
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    const tool = String(body.tool ?? '').trim();
    const token = String(body.token ?? '').trim();
    if (!key || !tool || !token) {
      sendJson({ ok: false, error: 'key/tool/token 不能为空' }, 400);
      return;
    }
    if (!agentTokenOk(key, token)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
    if (!v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
    const flagMap = { sendGroup: 'sendGroup', sendPrivate: 'sendPrivate', reply: 'reply' };
    const flag = flagMap[tool];
    if (!flag) { sendJson({ ok: false, error: 'tool 必须是 sendGroup/sendPrivate/reply' }, 400); return; }
    if (!v2ToolEnabled(flag)) {
      sendJson({ ok: false, error: `工具未启用：qq_${tool === 'sendGroup' ? 'send_group_message' : tool === 'sendPrivate' ? 'send_private_message' : 'reply'}` }, 403);
      return;
    }
    sendJson({ ok: true, key, tool });
    return;
  }

  // ── 工具调用日志 ─────────────────────────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/api/socialV2/tool-log') {
    reply(read.toolLog(url.searchParams.get('limit')));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/socialV2/tool-log/clear') {
    if (req.headers['x-agent-token']) { sendJson({ ok: false, error: '该接口仅控制台可用' }, 403); return; }
    reply(commands.clearToolLog());
    return;
  }

  // ── 反馈 / 自己消息 / 消息详情 ────────────────────────────────────────
  // 自检：在**运行中的桥接进程里**真实跑一次报错通知，验证「群里零消息 + 管理员收到私聊」。
  if (req.method === 'POST' && url.pathname === '/api/socialV2/error-notify-selftest') {
    if (req.headers['x-agent-token']) { sendJson({ ok: false, error: '该接口仅控制台可用' }, 403); return; }
    const body = await readBody();
    reply(commands.errorNotifySelftest({ key: body.key, title: body.title, detail: body.detail }));
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/socialV2/feedback') {
    reply(read.feedback());
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/socialV2/feedback-clear') {
    if (req.headers['x-agent-token']) { sendJson({ ok: false, error: '该接口仅控制台可用' }, 403); return; }
    reply(commands.clearFeedback());
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/socialV2/feedback') {
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    const rawMessage = String(body.message ?? '').trim();
    if (!key || !rawMessage) { sendJson({ ok: false, error: 'key 和 message 不能为空' }, 400); return; }
    if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
    if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
    if (req.headers['x-agent-token'] && !v2ToolEnabled('feedback')) { sendJson({ ok: false, error: '工具未启用：qq_report_feedback' }, 403); return; }
    reply(commands.setFeedback({ key, level: body.level, message: rawMessage }));
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/socialV2/my-recent') {
    const key = String(url.searchParams.get('key') ?? '').trim();
    if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
    if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
    if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
    if (req.headers['x-agent-token'] && !v2ToolEnabled('getMyRecent')) { sendJson({ ok: false, error: '工具未启用：qq_get_my_recent_messages' }, 403); return; }
    reply(read.myRecent({ key, rawLimit: url.searchParams.get('limit') }));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/socialV2/record-sent') {
    // 内部接口不对外开放：防止持有会话 token 的调用方伪造“我说过…”的历史记录。
    sendJson({ ok: false, error: '该接口仅桥接内部使用，不接受外部调用' }, 403);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/socialV2/message-detail') {
    const key = String(url.searchParams.get('key') ?? '').trim();
    const messageId = String(url.searchParams.get('messageId') ?? '').trim();
    if (!key || !messageId) { sendJson({ ok: false, error: 'key 和 messageId 不能为空' }, 400); return; }
    if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
    if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
    if (req.headers['x-agent-token'] && !v2ToolEnabled('getMessageDetail')) { sendJson({ ok: false, error: '工具未启用：qq_get_message_detail' }, 403); return; }
    reply(await read.messageDetail({ key, messageId }));
    return;
  }
}
