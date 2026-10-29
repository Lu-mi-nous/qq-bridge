// 控制台路由域：B 站（R4）。
//
// R4.7-3：本文件只做参数/key 解析与 agent 鉴权；读端点（记忆/状态/入群请求/缓存盘点）
// 在 `src/console/read-model/bili.js`，记录/搜索/观看/暂停/手动刷/TTS试听/选路径/
// 缓存清理在 `src/console/commands/bili.js`。
export const id = '14-bili';
export const title = 'B 站';

/** 本模块负责的路由；console-server 据此分派，不必解析 handler 内部。 */
export const routes = [
  ['POST', '/api/socialV2/bili-record', 'exact'],
  ['GET', '/api/socialV2/bili-memory', 'exact'],
  ['POST', '/api/socialV2/bili-search', 'exact'],
  ['POST', '/api/socialV2/bili-watch', 'exact'],
  ['POST', '/api/socialV2/bili-pause', 'exact'],
  ['POST', '/api/socialV2/bili-browse-now', 'exact'],
  ['GET', '/api/socialV2/join-requests', 'exact'],
  ['POST', '/api/socialV2/tts-say', 'exact'],
  ['POST', '/api/socialV2/tts/pick-path', 'exact'],
  ['GET', '/api/socialV2/cache', 'exact'],
  ['POST', '/api/socialV2/cache-purge', 'exact'],
  ['GET', '/api/socialV2/tts-status', 'exact'],
  ['GET', '/api/socialV2/bili-status', 'exact']
];

export async function handle(req, res, url, ctx) {
  const { sendJson, readBody } = ctx;
  const read = ctx.readModels?.bili;
  const commands = ctx.commands?.bili;
  if (!read || !commands) {
    sendJson({ ok: false, error: 'B站读模型/命令未装配' }, 503);
    return;
  }
  const { agentTokenOk, v2SessionAllowed } = ctx;
  const SECURITY_HEADERS = ctx.securityHeaders;
  const reply = (result) => {
    if (!result.ok) {
      const { status, ...rest } = result;
      sendJson({ ...rest, ok: false }, status || 500);
    } else {
      sendJson(result);
    }
  };

  // ── B 站：观看记录与记忆（全局，跨群共用）────────────────────────────
  if (req.method === 'POST' && url.pathname === '/api/socialV2/bili-record') {
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    const token = String(body.token ?? '').trim();
    if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
    if (token && !agentTokenOk(key, token)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
    if (token && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
    reply(commands.record(body));
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/socialV2/bili-memory') {
    const key = String(url.searchParams.get('key') ?? '').trim();
    const token = String(req.headers['x-agent-token'] ?? '').trim();
    if (token && key && !agentTokenOk(key, token)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
    reply(read.memory({
      key,
      limit: url.searchParams.get('limit'),
      likedOnly: url.searchParams.get('liked') === '1',
      query: url.searchParams.get('q')
    }));
    return;
  }

  // ── 现场搜索（模型工具 qq_bili_search 用它）──────────────────────────
  if (req.method === 'POST' && url.pathname === '/api/socialV2/bili-search') {
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    const token = String(body.token ?? '').trim();
    if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
    if (token && !agentTokenOk(key, token)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
    if (token && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
    reply(await commands.search(body));
    return;
  }

  // ── 手动看一条（群友发链接时也可以走这里；模型工具 qq_watch_bili 用它）──
  if (req.method === 'POST' && url.pathname === '/api/socialV2/bili-watch') {
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    const token = String(body.token ?? '').trim();
    if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
    if (token && !agentTokenOk(key, token)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
    if (token && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
    reply(await commands.watch(body));
    return;
  }

  // ── 暂停 / 恢复「自主刷」────────────────────────────────────────────
  if (req.method === 'POST' && url.pathname === '/api/socialV2/bili-pause') {
    const body = await readBody();
    reply(commands.setPaused(body.paused === true));
    return;
  }

  // ── 手动触发一次「自己刷」──────────────────────────────────────────
  if (req.method === 'POST' && url.pathname === '/api/socialV2/bili-browse-now') {
    reply(await commands.browseNow());
    return;
  }

  // 加好友/入群邀请的待决列表（控制台可见）
  if (req.method === 'GET' && url.pathname === '/api/socialV2/join-requests') {
    reply(read.joinRequests());
    return;
  }

  // 控制台试听：合成一句并**以音频返回**（不发群）。
  if (req.method === 'POST' && url.pathname === '/api/socialV2/tts-say') {
    const body = await readBody();
    const r = await commands.ttsSay(body);
    if (!r.ok) { sendJson({ ok: false, error: r.error }, r.status || 500); return; }
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'content-type': 'audio/wav',
      'content-length': String(r.buffer.length),
      'cache-control': 'no-store',
      // 诊断用：这次实际用了哪条参考（同源 fetch 可直接读，不需要 CORS）
      'x-tts-ref': String(r.refId || ''),
      'x-tts-mood': String(r.refMood || '')
    });
    res.end(r.buffer);
    return;
  }

  // 控制台「选择文件/文件夹」：在**运行桥接的这台电脑**上弹原生对话框。
  if (req.method === 'POST' && url.pathname === '/api/socialV2/tts/pick-path') {
    const body = await readBody();
    reply(await commands.pickPath(body));
    return;
  }

  // ── 缓存盘点与清理（2026-10-22 用户要求）──────────────────────────
  // GET 只盘点（算体积）；POST 才真删，且只删 kind='safe' 的项
  // （语音模型/图库/观看记忆一律不动，见 cache-manager.js 顶部说明）。
  if (req.method === 'GET' && url.pathname === '/api/socialV2/cache') {
    reply(read.cache());
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/socialV2/cache-purge') {
    const body = await readBody();
    reply(commands.purge(body));
    return;
  }

  // 语音合成（TTS）状态：给控制台显示"能不能发语音、什么音色、什么概率"。
  if (req.method === 'GET' && url.pathname === '/api/socialV2/tts-status') {
    reply(read.ttsStatus());
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/socialV2/bili-status') {
    reply(read.biliStatus());
    return;
  }
}
