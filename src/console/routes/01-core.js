// 控制台路由域：核心状态 / 模式 / 人格（R4）。
//
// R4.7-3：本文件只读 body 与转发；状态/预设/人格列表/角色正文读在
// `src/console/read-model/core.js`，模式切换/角色设置/角色卡保存/创建在
// `src/console/commands/core.js`。写盘失败不改内存、先备份再原子写都在命令层。
export const id = '01-core';
export const title = '核心状态 / 模式 / 人格';

/** 本模块负责的路由；console-server 据此分派，不必解析 handler 内部。 */
export const routes = [
  ['GET', '/api/status', 'exact'],
  ['GET', '/api/presets', 'exact'],
  ['POST', '/api/mode', 'exact'],
  ['POST', '/api/role', 'exact'],
  ['POST', '/api/role-mode', 'exact'],
  ['GET', '/api/roles', 'exact'],
  ['GET', '/api/role-assignments', 'exact'],
  ['GET', '/api/role-content', 'exact'],
  ['POST', '/api/role-content', 'exact'],
  ['POST', '/api/roles/create', 'exact']
];

export async function handle(req, res, url, ctx) {
  const { sendJson, readBody } = ctx;
  const read = ctx.readModels?.core;
  const commands = ctx.commands?.core;
  if (!read || !commands) {
    sendJson({ ok: false, error: '核心读模型/命令未装配' }, 503);
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

  if (req.method === 'GET' && url.pathname === '/api/status') {
    sendJson(read.status());
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/presets') {
    sendJson(await read.presets());
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/mode') {
    const body = await readBody();
    reply(commands.setMode(body));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/role') {
    const body = await readBody();
    reply(commands.setRole(body));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/role-mode') {
    const body = await readBody();
    reply(commands.setRoleMode(body));
    return;
  }
  // ── 人格管理 ──────────────────────────────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/api/roles') {
    sendJson(read.roles());
    return;
  }
  // 控制台「人格」卡片：默认角色 + 每个群的独立人格配置。
  if (req.method === 'GET' && url.pathname === '/api/role-assignments') {
    reply(await read.roleAssignments());
    return;
  }
  // 读取单个角色的 Markdown 原文（控制台用来在卡片里渲染人格内容）。
  // 直接读文件而不是维护副本：角色卡是热更新的（改完下次读就生效）。
  if (req.method === 'GET' && url.pathname === '/api/role-content') {
    reply(read.roleContent({ name: String(url.searchParams.get('name') ?? '').trim() }));
    return;
  }
  // 控制台直接修改人格卡正文（角色卡热更新，保存后下一轮对话即生效）。
  if (req.method === 'POST' && url.pathname === '/api/role-content') {
    const body = await readBody();
    reply(commands.saveRoleContent(body));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/roles/create') {
    const body = await readBody();
    reply(commands.createRole(body));
    return;
  }
}
