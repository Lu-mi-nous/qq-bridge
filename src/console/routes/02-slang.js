// 控制台路由域：黑话学习（R4）。
//
// R4.7-3：本文件只读 body 与转发；库列表在 `src/console/read-model/slang.js`，
// 新增/清空/批量/单条/提取/研究/配置在 `src/console/commands/slang.js`。
// 插件可用性由命令的 available() 统一检查。
export const id = '02-slang';
export const title = '黑话学习';

/** 本模块负责的路由；console-server 据此分派，不必解析 handler 内部。 */
export const routes = [
  ['GET', '/api/slang', 'exact'],
  ['POST', '/api/slang', 'exact'],
  ['POST', '/api/slang/clear', 'exact'],
  ['POST', '/api/slang/batch-delete', 'exact'],
  ['POST', '/api/slang/batch-confirm', 'exact'],
  ['POST', '/api/slang/batch-reject', 'exact'],
  ['POST', '/api/slang/extract', 'exact'],
  ['POST', '/api/slang/research', 'exact'],
  ['POST', '/api/slang/config', 'exact'],
  // 动态路径：PATCH/DELETE /api/slang/:id、POST /api/slang/:id/(confirm|reject)。
  // 模块内用正则再判断；精确路由优先命中，不会抢走 /api/slang/extract 等。
  ['PATCH', '/api/slang/', 'prefix'],
  ['DELETE', '/api/slang/', 'prefix'],
  ['POST', '/api/slang/', 'prefix']
];

export async function handle(req, res, url, ctx) {
  const { sendJson, readBody } = ctx;
  const read = ctx.readModels?.slang;
  const commands = ctx.commands?.slang;
  if (!read || !commands || !commands.available()) {
    sendJson({ ok: false, error: '黑话插件不可用' }, 503);
    return;
  }
  const reply = (result) => {
    if (!result.ok) {
      const { status, ...rest } = result;
      sendJson({ ...rest, ok: false }, status || 500);
    } else {
      sendJson(result);
    }
  };

  // ── 黑话库管理 ──────────────────────────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/api/slang') {
    sendJson(read.list({ status: url.searchParams.get('status') || '' }));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/slang') {
    const body = await readBody();
    reply(commands.create(body));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/slang/clear') {
    const body = await readBody();
    reply(commands.clear(body));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/slang/batch-delete') {
    const body = await readBody();
    reply(commands.batchDelete(body));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/slang/batch-confirm') {
    const body = await readBody();
    reply(commands.batchConfirm(body));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/slang/batch-reject') {
    const body = await readBody();
    reply(commands.batchReject(body));
    return;
  }
  const slangMatch = url.pathname.match(/^\/api\/slang\/([^/]+)(?:\/(confirm|reject))?$/);
  if (req.method === 'PATCH' && slangMatch && !slangMatch[2]) {
    const body = await readBody();
    reply(commands.update(slangMatch[1], body));
    return;
  }
  if (req.method === 'POST' && slangMatch && slangMatch[2] === 'confirm') {
    const body = await readBody();
    reply(commands.confirm(slangMatch[1], body));
    return;
  }
  if (req.method === 'POST' && slangMatch && slangMatch[2] === 'reject') {
    reply(commands.reject(slangMatch[1]));
    return;
  }
  if (req.method === 'DELETE' && slangMatch && !slangMatch[2]) {
    reply(commands.remove(slangMatch[1]));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/slang/extract') {
    const body = await readBody();
    reply(commands.extract(body));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/slang/research') {
    const body = await readBody();
    reply(commands.research(body));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/slang/config') {
    const body = await readBody();
    reply(commands.saveConfig(body));
    return;
  }

  // 前缀路由兜底：/api/slang/<未知子路径> 不能静默挂起（原内联链会落到全局 404）。
  sendJson({ ok: false, error: 'not found' }, 404);
}
