// 控制台路由域：表情 / 功能菜单 / 抓取（R4）。
//
// R4.7-3：本文件只做参数/key 解析与 agent 鉴权；列表读在
// `src/console/read-model/stickers.js`，发送/收藏/抓取/备注/删除在
// `src/console/commands/stickers.js`。业务闸门（reserved2/暂停/熔断/静默/限频）
// 与管理员判定都在命令层。
export const id = '11-stickers';
export const title = '表情 / 功能菜单 / 抓取';

/** 本模块负责的路由；console-server 据此分派，不必解析 handler 内部。 */
export const routes = [
  ['GET', '/api/socialV2/send-feature-menu', 'exact'],
  ['POST', '/api/socialV2/github-shot', 'exact'],
  ['POST', '/api/socialV2/sticker-note', 'exact'],
  ['POST', '/api/socialV2/sticker-delete', 'exact'],
  ['POST', '/api/socialV2/sticker-remark', 'exact'],
  ['POST', '/api/socialV2/send-voice', 'exact'],
  ['POST', '/api/socialV2/send-sticker', 'exact'],
  ['POST', '/api/socialV2/collect-sticker', 'exact'],
  ['POST', '/api/socialV2/crawl', 'exact'],
  ['GET', '/api/socialV2/sticker-list', 'exact'],
  ['GET', '/api/stickers', 'exact'],
  ['POST', '/api/stickers/sync', 'exact'],
  ['POST', '/api/stickers/note', 'exact'],
  ['POST', '/api/stickers/remark', 'exact']
];

const KEY_RE = /^(group|private):(\d+)$/;

export async function handle(req, res, url, ctx) {
  const { sendJson, readBody } = ctx;
  const read = ctx.readModels?.stickers;
  const commands = ctx.commands?.stickers;
  if (!read || !commands) {
    sendJson({ ok: false, error: '表情读模型/命令未装配' }, 503);
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

  // 功能菜单图：群友问「你会啥/能干嘛」时，渲染并**直接发到当前会话**。
  // 为什么由桥接发而不是把 base64 还给模型：模型没有"发送任意图片"的能力
  // （qq_send_image 只认图库里的图，拿不到这张实时渲染的菜单）。
  if (req.method === 'GET' && url.pathname === '/api/socialV2/send-feature-menu') {
    const key = String(url.searchParams.get('key') ?? '').trim();
    if (!KEY_RE.test(key)) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
    // agent token 是**必需**的，不是可选（与 send-image 同规则）。
    if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: '发送功能菜单必须携带 agent token' }, 403); return; }
    if (!agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
    if (!v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
    if (!v2ToolEnabled('getFeatureMenu')) { sendJson({ ok: false, error: '工具未启用：qq_send_feature_menu' }, 403); return; }
    reply(await commands.sendFeatureMenu({ key, refresh: url.searchParams.get('refresh') === '1' }));
    return;
  }

  // GitHub 仓库首页截图：解析链接、分段截图并发送。
  if (req.method === 'POST' && url.pathname === '/api/socialV2/github-shot') {
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    const raw = String(body.url ?? body.text ?? '').trim();
    if (!KEY_RE.test(key)) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
    // agent token 必需（与 send-image / send-feature-menu 同规则）。
    if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'GitHub 截图必须携带 agent token' }, 403); return; }
    if (!agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
    if (!v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
    if (!v2ToolEnabled('githubShot')) { sendJson({ ok: false, error: '工具未启用：qq_github_shot' }, 403); return; }
    reply(await commands.githubShot({ key, raw }));
    return;
  }

  // 表情本地认知（note/tags/usage）与 QQ 备注/删除。
  if (req.method === 'POST' && url.pathname === '/api/socialV2/sticker-note') {
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    const stickerId = String(body.stickerId ?? '').trim();
    if (!key || !stickerId) { sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400); return; }
    if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
    if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
    if (req.headers['x-agent-token'] && !v2ToolEnabled('stickerNote')) { sendJson({ ok: false, error: '工具未启用：qq_sticker_note' }, 403); return; }
    const note = body.note !== undefined && body.note !== null ? String(body.note).trim().slice(0, 200) : undefined;
    const tags = body.tags !== undefined && body.tags !== null ? (Array.isArray(body.tags) ? body.tags.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 20) : []) : undefined;
    const usage = body.usage !== undefined && body.usage !== null ? String(body.usage).trim().slice(0, 200) : undefined;
    reply(commands.applyNote({ key, stickerId, note, tags, usage }));
    return;
  }
  // 删除收藏表情（写操作，默认关闭 —— 与 set-sticker-remark 同级）。
  // 之所以默认关：上游 delete_custom_face 不校验 emoji_id，
  // 开放后模型一旦传错就会静默删掉别的表情（详见 deleteStickerV2 注释）。
  // 开启方式：config.json 的 socialV2.tools.deleteSticker = true。
  if (req.method === 'POST' && url.pathname === '/api/socialV2/sticker-delete') {
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    const stickerId = String(body.stickerId ?? '').trim();
    if (!key || !stickerId) { sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400); return; }
    if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
    if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
    if (req.headers['x-agent-token'] && !v2ToolEnabled('deleteSticker')) { sendJson({ ok: false, error: '工具未启用：qq_delete_sticker' }, 403); return; }
    reply(await commands.deleteSticker({ key, stickerId }));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/socialV2/sticker-remark') {
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    const stickerId = String(body.stickerId ?? '').trim();
    if (!key || !stickerId) { sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400); return; }
    if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
    if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
    if (req.headers['x-agent-token'] && !v2ToolEnabled('setStickerRemark')) { sendJson({ ok: false, error: '工具未启用：qq_set_sticker_remark' }, 403); return; }
    reply(await commands.setRemark({ key, stickerId, remark: body.remark }));
    return;
  }

  // 语音消息（GPT-SoVITS）：模型主动发一条语音。
  // 与"概率语音"共用一个引擎与缓存；这里**不受概率限制**，但仍受每小时上限约束。
  if (req.method === 'POST' && url.pathname === '/api/socialV2/send-voice') {
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    const text = String(body.text ?? '').trim();
    if (!key || !text) { sendJson({ ok: false, error: 'key 和 text 不能为空' }, 400); return; }
    if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: '发送语音必须携带 agent token' }, 403); return; }
    if (!agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
    if (!v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
    if (!v2ToolEnabled('sendVoice')) { sendJson({ ok: false, error: '工具未启用：qq_send_voice' }, 403); return; }
    reply(await commands.sendVoice({ key, text }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/socialV2/send-sticker') {
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    const stickerId = String(body.stickerId ?? '').trim();
    if (!key || !stickerId) { sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400); return; }
    if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
    if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
    if (req.headers['x-agent-token'] && !v2ToolEnabled('sendSticker')) { sendJson({ ok: false, error: '工具未启用：qq_send_sticker' }, 403); return; }
    if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return; }
    reply(await commands.sendSticker({ key, body }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/socialV2/collect-sticker') {
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    const messageRef = String(body.messageId ?? body.seq ?? '').trim();
    const remark = String(body.remark ?? '').trim();
    if (!key || !messageRef) { sendJson({ ok: false, error: 'key 和 messageId/seq 不能为空' }, 400); return; }
    if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
    if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
    if (req.headers['x-agent-token'] && !v2ToolEnabled('collectSticker')) { sendJson({ ok: false, error: '工具未启用：qq_collect_sticker' }, 403); return; }
    reply(await commands.collectSticker({ key, messageRef, remark }));
    return;
  }

  // 按需抓网页 / 找图 / 把图片存成 QQ 收藏表情：模型侧工具 qq_crawl_web。
  // 所有抓取走 safe-fetch（禁内网、逐跳校验重定向），不绕过登录/验证码。
  if (req.method === 'POST' && url.pathname === '/api/socialV2/crawl') {
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
    if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
    if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
    if (req.headers['x-agent-token'] && !v2ToolEnabled('crawl')) { sendJson({ ok: false, error: '工具未启用：qq_crawl_web' }, 403); return; }
    reply(await commands.crawlWeb({ key, body }));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/socialV2/sticker-list') {
    const key = String(url.searchParams.get('key') ?? '').trim();
    if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
    if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
    if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
    if (req.headers['x-agent-token'] && !v2ToolEnabled('listStickers')) { sendJson({ ok: false, error: '工具未启用：qq_list_stickers' }, 403); return; }
    reply(await read.list({
      key,
      query: String(url.searchParams.get('query') ?? '').trim(),
      rawCount: url.searchParams.get('count'),
      refresh: url.searchParams.get('refresh') === '1' || url.searchParams.get('refresh') === 'true',
      agent: !!req.headers['x-agent-token']
    }));
    return;
  }

  // 管理端表情库接口（控制台）
  if (req.method === 'GET' && url.pathname === '/api/stickers') {
    reply(await read.adminList({
      query: String(url.searchParams.get('query') ?? '').trim(),
      rawCount: url.searchParams.get('count'),
      refresh: url.searchParams.get('refresh') === '1' || url.searchParams.get('refresh') === 'true'
    }));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/stickers/sync') {
    reply(await commands.syncStickers());
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/stickers/note') {
    const body = await readBody();
    const stickerId = String(body.stickerId ?? '').trim();
    const note = body.note !== undefined && body.note !== null ? String(body.note).trim().slice(0, 200) : undefined;
    const tags = body.tags !== undefined && body.tags !== null ? (Array.isArray(body.tags) ? body.tags.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 20) : []) : undefined;
    const usage = body.usage !== undefined && body.usage !== null ? String(body.usage).trim().slice(0, 200) : undefined;
    reply(commands.adminNote({ stickerId, note, tags, usage }));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/stickers/remark') {
    const body = await readBody();
    reply(await commands.adminRemark({ stickerId: String(body.stickerId ?? '').trim(), remark: body.remark }));
    return;
  }
}
