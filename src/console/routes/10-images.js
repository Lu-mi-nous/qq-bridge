// 控制台路由域：图片：预检 / 搜索 / 发图 / 图库（R4）。
//
// R4.7-3：本文件只做参数/agent 鉴权；读口径在 `src/console/read-model/images.js`，
// 发图/收藏/反查/贴表情/拒绝/刷新/表情图/自拍/X 帖在 `src/console/commands/images.js`。
// 业务闸门（模式/暂停/熔断/静默/限频）都在命令层，路由不再解构 deps。
export const id = '10-images';
export const title = '图片：预检 / 搜索 / 发图 / 图库';

const KEY_RE = /^(group|private):(\d+)$/;

/** 本模块负责的路由；console-server 据此分派，不必解析 handler 内部。 */
export const routes = [
  ['GET', '/api/socialV2/image-preflight', 'exact'],
  ['POST', '/api/socialV2/x-auth-check', 'exact'],
  ['POST', '/api/socialV2/fetch-x-posts', 'exact'],
  ['POST', '/api/socialV2/send-image', 'exact'],
  ['POST', '/api/socialV2/archive-image', 'exact'],
  ['GET', '/api/socialV2/reverse-search', 'exact'],
  ['GET', '/api/socialV2/image-source', 'exact'],
  ['POST', '/api/socialV2/react-message', 'exact'],
  ['POST', '/api/socialV2/reject-image', 'exact'],
  ['GET', '/api/socialV2/image-stats', 'exact'],
  ['GET', '/api/socialV2/image-quota', 'exact'],
  ['POST', '/api/socialV2/refresh-image-lib', 'exact'],
  ['GET', '/api/socialV2/sticker-image', 'exact']
];

export async function handle(req, res, url, ctx) {
  const { sendJson, readBody } = ctx;
  const read = ctx.readModels?.images;
  const commands = ctx.commands?.images;
  if (!read || !commands) {
    sendJson({ ok: false, error: '图片读模型/命令未装配' }, 503);
    return;
  }
  const { agentTokenOk, v2SessionAllowed, v2ToolEnabled } = ctx;
  // 命令返回 {ok,status,...}；错误时把 reason 之外的附加字段（needKey/hint/id 等）一并保留。
  const reply = (result) => {
    if (!result.ok) {
      const { status, ...rest } = result;
      sendJson({ ...rest, ok: false }, status || 500);
    } else {
      sendJson(result);
    }
  };

  // ── 图库（reserved2）：按需取图发送 ────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/api/socialV2/image-preflight') {
    const key = String(url.searchParams.get('key') ?? '').trim();
    if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
    if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
    if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
    if (req.headers['x-agent-token'] && !v2ToolEnabled('sendImage')) { sendJson({ ok: false, error: '工具未启用：qq_send_image' }, 403); return; }
    reply(read.preflight({
      key,
      rawTags: url.searchParams.get('tags') ?? '',
      rawSources: url.searchParams.get('sources') ?? ''
    }));
    return;
  }

  // ── X（Twitter）登录自检 ────────────────────────────────────────────
  if (req.method === 'POST' && url.pathname === '/api/socialV2/x-auth-check') {
    if (req.headers['x-agent-token']) { sendJson({ ok: false, error: '该接口仅控制台可用' }, 403); return; }
    reply(await commands.xAuthCheck());
    return;
  }
  // ── 按需拉取 X 帖子并直接发到当前会话 ────────────────────────────────
  if (req.method === 'POST' && url.pathname === '/api/socialV2/fetch-x-posts') {
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    const handleRaw = String(body.handle ?? '').trim();
    if (!key || !handleRaw) { sendJson({ ok: false, error: 'key 和 handle 不能为空' }, 400); return; }
    if (!KEY_RE.test(key)) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
    if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
    if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
    // P0 内容安全止血：即使旧 MCP 会话仍能看到工具，桥接也必须在拉取前拒绝。
    if (!v2ToolEnabled('fetchXPosts')) { sendJson({ ok: false, error: 'X 帖子转发已临时关闭' }, 403); return; }
    reply(await commands.fetchXPosts({ key, body }));
    return;
  }

  // ── 发图（reserved2 工具）─────────────────────────────────────────────
  if (req.method === 'POST' && url.pathname === '/api/socialV2/send-image') {
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
    if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'reserved2 模式发图必须携带 agent token' }, 403); return; }
    if (!agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
    if (!v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
    if (!v2ToolEnabled('sendImage')) { sendJson({ ok: false, error: '工具未启用：qq_send_image' }, 403); return; }
    reply(await commands.sendImage({ key, body }));
    return;
  }

  // ── 收藏原图 ────────────────────────────────────────────────────────
  if (req.method === 'POST' && url.pathname === '/api/socialV2/archive-image') {
    const body = await readBody();
    // 同 refresh-image-lib 的鉴权：管理员可直接调，AI 必须带合法 agent token。
    let allowed = !req.headers['x-agent-token'];
    let vkey = '';
    if (req.headers['x-agent-token']) {
      vkey = String(body.key ?? '').trim();
      allowed = !!vkey && agentTokenOk(vkey, req.headers['x-agent-token']) && v2SessionAllowed(vkey) && v2ToolEnabled('archiveImage');
    }
    if (!allowed) { sendJson({ ok: false, error: '无权收藏图片' }, 403); return; }
    reply(await commands.archive({ key: vkey, id: body.id }));
    return;
  }

  // ── 反向搜图 ────────────────────────────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/api/socialV2/reverse-search') {
    const key = String(url.searchParams.get('key') ?? '').trim();
    if (key && req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
    if (key && req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
    if (key && req.headers['x-agent-token'] && !v2ToolEnabled('reverseSearch')) { sendJson({ ok: false, error: '工具未启用：qq_reverse_search' }, 403); return; }
    reply(await commands.reverseSearch({
      key,
      messageId: url.searchParams.get('messageId') ?? '',
      id: url.searchParams.get('id') ?? ''
    }));
    return;
  }

  // ── 图库条目来源页 ──────────────────────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/api/socialV2/image-source') {
    const key = String(url.searchParams.get('key') ?? '').trim();
    if (key && req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
    if (key && req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
    if (key && req.headers['x-agent-token'] && !v2ToolEnabled('imageSource')) { sendJson({ ok: false, error: '工具未启用：qq_image_source' }, 403); return; }
    reply(read.source({ key, id: url.searchParams.get('id') ?? '' }));
    return;
  }

  // ── 贴表情 ──────────────────────────────────────────────────────────
  if (req.method === 'POST' && url.pathname === '/api/socialV2/react-message') {
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
    // 鉴权同 send-image：reserved2 下 AI 必须带 agent token
    if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'reserved2 模式贴表情必须携带 agent token' }, 403); return; }
    if (!agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
    if (!v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
    if (!v2ToolEnabled('reactMessage')) { sendJson({ ok: false, error: '工具未启用：qq_react_message' }, 403); return; }
    reply(await commands.react({ key, body }));
    return;
  }

  // ── 删除并拒绝图片 ──────────────────────────────────────────────────
  if (req.method === 'POST' && url.pathname === '/api/socialV2/reject-image') {
    const body = await readBody();
    // 同 refresh-image-lib 的鉴权：管理员可直接调，AI 必须带合法 agent token。
    let allowed = !req.headers['x-agent-token'];
    let vkey = '';
    if (req.headers['x-agent-token']) {
      vkey = String(body.key ?? '').trim();
      allowed = !!vkey && agentTokenOk(vkey, req.headers['x-agent-token']) && v2SessionAllowed(vkey) && v2ToolEnabled('rejectImage');
    }
    if (!allowed) { sendJson({ ok: false, error: '无权删除图库图片' }, 403); return; }
    reply(commands.reject({ key: vkey, id: body.id, reason: body.reason }));
    return;
  }

  // ── 图库统计 / 额度 ─────────────────────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/api/socialV2/image-stats') {
    const key = String(url.searchParams.get('key') ?? '').trim();
    if (key && req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
    reply(read.stats());
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/socialV2/image-quota') {
    reply(read.quota());
    return;
  }

  // ── 刷新图库 ────────────────────────────────────────────────────────
  if (req.method === 'POST' && url.pathname === '/api/socialV2/refresh-image-lib') {
    const body = await readBody();
    // 管理员可直接刷；AI 必须带合法 agent token（允许它自己按需补图，但受限频）。
    let allowed = !req.headers['x-agent-token'];
    if (req.headers['x-agent-token']) {
      const key = String(body.key ?? '').trim();
      allowed = !!key && agentTokenOk(key, req.headers['x-agent-token']) && v2SessionAllowed(key) && v2ToolEnabled('refreshImageLib');
    }
    if (!allowed) { sendJson({ ok: false, error: '无权刷新图库' }, 403); return; }
    reply(await commands.refresh({
      key: String(body.key ?? '').trim(),
      body,
      viaAgent: !!req.headers['x-agent-token']
    }));
    return;
  }

  // ── 表情图片 ────────────────────────────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/api/socialV2/sticker-image') {
    const key = String(url.searchParams.get('key') ?? '').trim();
    const stickerId = String(url.searchParams.get('stickerId') ?? '').trim();
    if (!key || !stickerId) { sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400); return; }
    if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
    if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
    if (req.headers['x-agent-token'] && !v2ToolEnabled('getStickerImage')) { sendJson({ ok: false, error: '工具未启用：qq_get_sticker_image' }, 403); return; }
    reply(await commands.stickerImage({ key, stickerId }));
    return;
  }

  // ── 自拍 / 形象图 ───────────────────────────────────────────────────
  if ((req.method === 'GET' || req.method === 'POST') && url.pathname === '/api/socialV2/self-image') {
    if (req.method === 'GET' && url.searchParams.has('publish')) {
      sendJson({ ok: false, error: 'GET 仅用于预览；发布形象图必须使用 POST' }, 405);
      return;
    }
    const body = req.method === 'POST' ? await readBody() : {};
    const key = String(req.method === 'POST' ? body.key : url.searchParams.get('key') ?? '').trim();
    if (!KEY_RE.test(key)) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
    const agentToken = req.headers['x-agent-token'];
    if (req.method === 'POST' && !agentToken) { sendJson({ ok: false, error: '发布形象图必须携带 agent token' }, 403); return; }
    if (agentToken && !agentTokenOk(key, agentToken)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
    if (agentToken && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
    if (agentToken && !v2ToolEnabled('getSelfImage')) { sendJson({ ok: false, error: '工具未启用：qq_get_self_image' }, 403); return; }
    // publish：**顺便把形象图发到当前会话**（用户要求「别人问及自拍时把自拍图片一并发出去」）。
    const publish = req.method === 'POST' && body.publish !== false;
    reply(await commands.selfImage({ key, publish }));
    return;
  }
}
