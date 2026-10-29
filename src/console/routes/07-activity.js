// 控制台路由域：活动流 / 二代状态 / 提示词（R4）。
//
// R4.7-3：本文件只做参数校验与 agent 鉴权；读口径在 `src/console/read-model/activity.js`，
// 暂停/重置在 `src/console/commands/activity.js`。POST 重置涉及 20+ 个运行态集合，
// 不再从路由里逐个 delete。
import { buildPromptCompact } from '../read-model/activity.js';

// T3：qq_get_prompt 的 compact 载荷（默认）。保留这个再导出，
// 既有测试与调用方仍从路由模块导入，不需要知道口径搬到了读模型。
export { buildPromptCompact };

export const id = '07-activity';
export const title = '活动流 / 二代状态 / 提示词';

/** 本模块负责的路由；console-server 据此分派，不必解析 handler 内部。 */
export const routes = [
  ['GET', '/api/socialV2/activity', 'exact'],
  ['GET', '/api/socialV2/activity-feed', 'exact'],
  ['POST', '/api/socialV2/activity', 'exact'],
  ['POST', '/api/socialV2/reset', 'exact'],
  ['GET', '/api/socialV2/state', 'exact'],
  ['GET', '/api/socialV2/prompt', 'exact']
];

export async function handle(req, res, url, ctx) {
  const { sendJson, readBody } = ctx;
  const read = ctx.readModels?.activity;
  const commands = ctx.commands?.activity;
  if (!read || !commands) {
    sendJson({ ok: false, error: '活动流读模型/命令未装配' }, 503);
    return;
  }
  const { agentTokenOk, v2SessionAllowed, v2ToolEnabled } = ctx;

  if (req.method === 'GET' && url.pathname === '/api/socialV2/activity') {
    sendJson(read.statusView());
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/socialV2/activity-feed') {
    sendJson(read.feedView(url.searchParams.get('limit')));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/socialV2/activity') {
    const body = await readBody();
    sendJson({ ok: true, ...commands.setPaused(body.paused === true) });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/socialV2/reset') {
    sendJson(commands.reset());
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/socialV2/state') {
    const key = String(url.searchParams.get('key') ?? '').trim();
    if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
    if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
    if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
    if (req.headers['x-agent-token'] && !v2ToolEnabled('socialState')) { sendJson({ ok: false, error: '工具未启用：qq_social_state' }, 403); return; }
    sendJson(read.stateView(key));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/socialV2/prompt') {
    const key = String(url.searchParams.get('key') ?? '').trim();
    if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
    if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
    if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
    if (req.headers['x-agent-token'] && !v2ToolEnabled('getPrompt')) { sendJson({ ok: false, error: '工具未启用：qq_get_prompt' }, 403); return; }
    // T3：默认 compact（角色摘要 + 工具 + 唤醒配置）；detail=full 才返回完整角色卡与
    // 记忆/黑话/表情上下文。唤醒提示里已有的状态信息不再重复。
    sendJson(await read.promptView(key, url.searchParams.get('detail')));
    return;
  }
}
