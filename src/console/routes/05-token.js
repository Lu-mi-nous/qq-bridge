// 控制台路由域：Token 用量与报表（R4）。
//
// R4.7-3：本文件只保留参数解析与鉴权（console token / agent token / 工具开关）。
// 读口径在 `src/console/read-model/token.js`，刷新/渲染/发群在 `src/console/commands/token.js`。
// 新增统计字段或发送前置条件时改那两个模块，不要再把 getter 拉回路由。
export const id = '05-token';
export const title = 'Token 用量与报表';

/** 本模块负责的路由；console-server 据此分派，不必解析 handler 内部。 */
export const routes = [
  ['GET', '/api/socialV2/token-usage', 'exact'],
  ['POST', '/api/socialV2/token-usage-refresh', 'exact'],
  ['GET', '/api/socialV2/token-report', 'exact'],
  ['GET', '/api/socialV2/token-report-image', 'exact']
];

export async function handle(req, res, url, ctx) {
  const { sendJson } = ctx;
  const read = ctx.readModels?.token;
  const commands = ctx.commands?.token;
  if (!read || !commands) {
    sendJson({ ok: false, error: 'Token 读模型/命令未装配' }, 503);
    return;
  }
  const { agentTokenOk, v2SessionAllowed, v2ToolEnabled } = ctx;
  const SECURITY_HEADERS = ctx.securityHeaders;

  // Token 用量：控制台读这个拿每日/累计数据。
  //
  // 需求（2026-10-21 用户）：「把 token 记录做成日志，每日更新并且放进控制台」。
  // 读模型只读缓存（state/token-usage.json），不在请求里现算——
  // 全量扫一遍要 13~15 秒，放在 HTTP 请求里会卡住控制台。
  // 需要立刻重算时用下面的 POST 端点（后台跑，不阻塞响应）。
  if (req.method === 'GET' && url.pathname === '/api/socialV2/token-usage') {
    const view = read.usageView(url.searchParams.get('date'));
    if (!view.ok) sendJson({ ok: false, error: view.error }, view.status);
    else sendJson(view.body);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/socialV2/token-usage-refresh') {
    // 后台重算，立刻回 202：全量扫描 13~15 秒，不能同步等
    void commands.refresh({ force: url.searchParams.get('force') === '1' }).catch(() => {});
    sendJson({ ok: true, message: '已在后台开始重新统计（约 15 秒）' });
    return;
  }

  // ── Token 用量报表图（2026-10-21 用户要求）──────────────────────────
  //
  // 「让 bot 能够看到 token 消耗日志，能够以图片形式响应群友要求 token 消耗量
  //   相关问题」——所以这个端点是**给模型用的**（MCP 的 qq_token_report 调它），
  // 一次做完「取数 → 渲染 PNG → 发到当前会话」。
  //
  // 为什么由桥接直接发而不是把图 base64 还给模型：模型没有"发送任意图片"的能力
  // （qq_send_image 只认图库里的图），与功能菜单同一个理由。
  //
  // GET，参数：key（会话）、refresh（可选，1=先重算再出图）
  if (req.method === 'GET' && url.pathname === '/api/socialV2/token-report') {
    const key = String(url.searchParams.get('key') ?? '').trim();
    const keyMatch = /^(group|private):(\d+)$/.exec(key);
    if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
    // agent token 必需（与 send-image / send-feature-menu / github-shot 同规则）：
    // 这是个往群里发东西的写操作，不能靠"控制台没设令牌"就放行。
    if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: '发送 Token 报表必须携带 agent token' }, 403); return; }
    if (!agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
    if (!v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
    if (!v2ToolEnabled('tokenReport')) { sendJson({ ok: false, error: '工具未启用：qq_token_report' }, 403); return; }
    const kind = keyMatch[1];
    const id = Number(keyMatch[2]);
    const result = await commands.sendReport({
      key,
      kind,
      id,
      title: url.searchParams.get('title'),
      refresh: url.searchParams.get('refresh') === '1'
    });
    if (!result.ok) sendJson({ ok: false, error: result.error }, result.status || 500);
    else sendJson(result);
    return;
  }

  // 控制台预览：渲染 Token 报表并以 PNG 返回（**不发群**）。
  //
  // 与 /api/socialV2/token-report 的区别：那个是给模型用的（渲染 + 发到会话），
  // 这个只给控制台看图。分成两个端点而不是加个 flag，是因为权限模型不同：
  // 发群那条必须带 agent token，预览这条走控制台鉴权（本机 + 同源）。
  if (req.method === 'GET' && url.pathname === '/api/socialV2/token-report-image') {
    const r = await commands.renderImage({
      title: url.searchParams.get('title'),
      force: url.searchParams.get('force') === '1',
      refresh: url.searchParams.get('refresh') === '1'
    });
    if (!r.ok) { sendJson({ ok: false, error: r.error }, 500); return; }
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'content-type': 'image/png',
      'content-length': String(r.buffer.length),
      // 内容指纹已在文件名里，但浏览器拿不到——用 no-store 保证看到的是新图
      'cache-control': 'no-store'
    });
    res.end(r.buffer);
    return;
  }
}
