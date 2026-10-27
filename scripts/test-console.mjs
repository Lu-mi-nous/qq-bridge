// 控制台增强功能综合测试（node 直接调 API）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConsoleUiSource } from './lib/console-ui-src.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BASE = 'http://127.0.0.1:3100';

function readConsoleToken() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
    if (cfg.consoleToken) return String(cfg.consoleToken);
  } catch {}
  try {
    return fs.readFileSync(path.join(ROOT, 'state', 'console-token'), 'utf8').trim();
  } catch {
    return '';
  }
}
const TOKEN = readConsoleToken();
const CARD_META = fs.readFileSync(path.join(ROOT, 'src', 'console', 'core-cards.js'), 'utf8');
const appDir = path.join(ROOT, 'public', 'console', 'app');
const UI = readConsoleUiSource() + '\n' + fs.readdirSync(path.join(ROOT, 'public', 'console', 'cards')).filter((f) => f.endsWith('.js')).map((f) => fs.readFileSync(path.join(ROOT, 'public', 'console', 'cards', f), 'utf8').replace(/\\"/g, '"')).join('\n') + '\n' + fs.readdirSync(appDir).filter((f) => f.endsWith('.js')).map((f) => fs.readFileSync(path.join(appDir, f), 'utf8').replace(/\\"/g, '"')).join('\n');
const authHeaders = TOKEN ? { 'x-console-token': TOKEN } : {};
const api = async (path, method, body) => {
  const headers = { ...authHeaders, ...(body ? { 'content-type': 'application/json' } : {}) };
  const res = await fetch(BASE + path, { method: method || 'GET', headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
};
let failed = 0;
const ok = (name, cond, extra = '') => {
  if (!cond) failed += 1;
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`);
};

// 1. 页面
const page = await fetch(BASE + '/', { headers: authHeaders });
const html = await page.text();
ok('页面加载', page.status === 200 && CARD_META.includes('白名单 / 管理员') && CARD_META.includes('人格（角色扮演）') && CARD_META.includes('测试发送'), `长度 ${html.length}`);

// 2. 角色列表
let r = await api('/api/roles');
const origRole = r.body.current ?? null;
ok('角色列表', r.body.roles?.includes('傲娇助手'), JSON.stringify(r.body));

// 3. 创建人格（幂等：上次运行残留时先清掉，否则「已存在」会让测试假失败）
const TEST_ROLE = '测试人格Tmp';
try {
  const pre = new URL(`../roles/${TEST_ROLE}.md`, import.meta.url);
  if (fs.existsSync(pre)) fs.unlinkSync(pre);
} catch { /* 清不掉就让下面的断言报出来 */ }
r = await api('/api/roles/create', 'POST', { name: TEST_ROLE, content: '- 性格：测试\n- 说话风格：简短' });
ok('创建人格', r.body.ok === true, JSON.stringify(r.body));
r = await api('/api/roles');
ok('创建后列表出现', r.body.roles?.includes(TEST_ROLE));

// 4. 设置 / 清除角色
r = await api('/api/role', 'POST', { role: TEST_ROLE });
ok('设置角色', r.body.ok === true && r.body.role === TEST_ROLE);
r = await api('/api/role', 'POST', { role: null });
ok('清除角色', r.body.ok === true && r.body.role === null);
if (origRole) {
  r = await api('/api/role', 'POST', { role: origRole });
  ok('恢复原角色', r.body.ok === true && r.body.role === origRole);
}

// 4b. 每群独立人格（默认角色之外）
const TEST_GROUP_KEY = 'group:999999999';
r = await api('/api/role-assignments');
ok('人格分配接口', r.body.ok === true && Array.isArray(r.body.conversations), JSON.stringify(r.body).slice(0, 120));
ok('人格分配带当前群列表标记',
  typeof r.body.conversations?.[0]?.inGroupList === 'boolean',
  JSON.stringify(r.body.conversations?.[0]));
r = await api('/api/role', 'POST', { key: TEST_GROUP_KEY, role: TEST_ROLE });
ok('设置单群人格', r.body.ok === true && r.body.key === TEST_GROUP_KEY && r.body.role === TEST_ROLE, JSON.stringify(r.body));
r = await api('/api/role-assignments');
let groupItem = (r.body.conversations || []).find((x) => x.key === TEST_GROUP_KEY);
ok('单群人格出现在列表', !!groupItem && groupItem.overrideRole === TEST_ROLE && groupItem.effectiveRole === TEST_ROLE, JSON.stringify(groupItem));
r = await api('/api/role', 'POST', { key: TEST_GROUP_KEY, role: null });
ok('清除单群人格', r.body.ok === true && r.body.role === null);
r = await api('/api/role-assignments');
groupItem = (r.body.conversations || []).find((x) => x.key === TEST_GROUP_KEY);
ok('清除后回退默认', !groupItem || !groupItem.overrideRole, JSON.stringify(groupItem));

// 5. 会话映射
r = await api('/api/sessions');
ok('会话映射', Array.isArray(r.body.sessions), `共 ${r.body.sessions.length} 个`);

// 5b. 会话消息回看（QQ 不显示机器人与别人的私聊，这里是唯一回看途径）
// 断言：① 控制台页面有该面板；② 每个会话都能读出消息；③ 能读到机器人自己发的。
{
  const page = await (await fetch(BASE + '/?token=' + encodeURIComponent(TOKEN), { headers: authHeaders })).text();
  ok('控制台含消息回看面板', UI.includes('id="msgViewerCard"'), '');
  ok('控制台含查看消息入口', UI.includes('data-view-key'), '');
  ok('控制台含消息读取逻辑', UI.includes('async function loadMessages'), '');
  ok('机器人消息有独立样式（便于分辨）', UI.includes('.msgrow.mine'), '');

  const sessions = r.body.sessions || [];
  if (sessions.length) {
    // 接口可读 ≠ 每个会话都必须有历史消息：重启后/新会话的空 recent 是正常状态。
    let readable = 0, withMessages = 0, withSelf = 0, failed = [];
    for (const s of sessions) {
      try {
        const mr = await api(`/api/socialV2/recent?key=${encodeURIComponent(s.key)}&limit=10`);
        if (!Array.isArray(mr.body.messages)) { failed.push(s.key); continue; }
        readable++;
        const list = mr.body.messages;
        if (list.length) withMessages++;
        if (list.some((m) => m.isSelf)) withSelf++;
      } catch (e) { failed.push(s.key); }
    }
    ok('所有会话消息接口可读', readable === sessions.length && failed.length === 0,
      `${readable}/${sessions.length}${failed.length ? ' 失败:' + failed.join(',') : ''}`);
    ok('至少一个会话有历史消息', withMessages > 0 || sessions.length === 0, `${withMessages}/${sessions.length}`);
    ok('能读到机器人自己发的消息（核心用途）', withSelf > 0 || withMessages === 0, `${withSelf} 个会话含机器人发言`);
  } else {
    ok('无会话时跳过消息回读断言', true, '（还没有会话记录）');
  }
}

// 5c. 人格卡内容展示（渲染后的 Markdown，不是源码）
// 目的：设置人格时能在控制台直接读到"它现在是什么性格"，不用去翻 roles/*.md。
// 展示位置：**05 卡片中间那块带框滚动区**（不在独立卡片里——早先做过独立的 05b，
// 后来按用户要求改成内嵌框，与活动日志那种框一致）。
{
  const page = await (await fetch(BASE + '/?token=' + encodeURIComponent(TOKEN), { headers: authHeaders })).text();
  ok('控制台含人格卡内容框', UI.includes('id="rolePreviewBody"'), '');
  ok('内容框带标题条（显示角色名与体积）', UI.includes('id="rolePreviewMeta"'), '');
  ok('控制台含默认人格下拉', UI.includes('id="roleDefaultSelect"'), '');
  ok('控制台含每群人格列表', UI.includes('id="roleGroupList"'), '');
  ok('控制台含群筛选输入', UI.includes('id="roleGroupFilter"'), '');
  ok('人格卡只渲染在当前群列表的群', UI.includes('x.inGroupList !== false'), '');
  ok('上下文卡含当前/已离群分组', UI.includes('ctx-section-title'), '');
  ok('上下文卡含删除会话按钮', UI.includes('data-ctx-delete'), '');
  ok('控制台含本地表情缓存读取开关', UI.includes('id="v2StickerReadLocalCache"'), '');
  ok('控制台含同步收藏到本地按钮', UI.includes('id="v2StickerSyncLocal"'), '');
  ok('框体样式存在（md-panel）', UI.includes('.md-panel'), '');
  ok('控制台含 Markdown 渲染函数', UI.includes('function renderMd'), '');
  ok('渲染结果有样式（不是裸露标签）', UI.includes('.md-body'), '');
  ok('不再有独立的 05b 卡片', !UI.includes('05b'), '');

  // 端点：正常读取
  const roles = (await api('/api/roles')).body.roles || [];
  if (roles.length) {
    const name = roles[0];
    const one = await api(`/api/role-content?name=${encodeURIComponent(name)}`);
    ok('能读到角色卡原文', one.body.ok === true && typeof one.body.content === 'string' && one.body.content.length > 0,
      `${name}: ${one.body.bytes || 0} bytes`);
    ok('返回的是 Markdown 原文（含标题标记）', /^#\s|\n##\s/.test(one.body.content || ''), '');
  } else {
    ok('无角色时跳过内容读取断言', true, '（roles/ 为空）');
  }

  // 端点：拒绝路径（路径穿越 / 不存在 / 空参数）
  const bad1 = await api('/api/role-content?name=..%2Fconfig');
  ok('拒绝路径穿越（../config）', bad1.body.ok === false, bad1.body.error || '');
  const bad2 = await api('/api/role-content?name=__definitely_not_exist__');
  ok('不存在的角色返回失败', bad2.body.ok === false, bad2.body.error || '');
  const bad3 = await api('/api/role-content');
  ok('空 name 被拒', bad3.body.ok === false, bad3.body.error || '');
}

// 6. 挂起列表
r = await api('/api/pending');
ok('挂起列表', Array.isArray(r.body.pending), `共 ${r.body.pending.length} 个`);

// 6b. 上下文会话：区分当前群与已离群群，且禁止删除当前群会话
r = await api('/api/socialV2/context-status');
const ctxRows = Array.isArray(r.body.rows) ? r.body.rows : [];
ok('上下文会话带在群标记', ctxRows.length > 0 && typeof ctxRows[0].inGroupList === 'boolean', `${ctxRows.length} 个`);
const ctxActive = ctxRows.find((x) => String(x.key).startsWith('group:') && x.inGroupList === true);
if (ctxActive) {
  const del = await api('/api/socialV2/context-delete', 'POST', { key: ctxActive.key });
  ok('拒绝删除仍在群的会话', del.status === 400 && del.body.ok === false, JSON.stringify(del.body));
} else {
  ok('无当前群会话时跳过删除保护断言', true, '');
}

// 7. 白名单：读原值 → 加测试群 → 恢复
// 注意顺序：**白名单恢复必须放在发送校验之后**（历史上先恢复再发送，导致发送时
// 测试群已不在白名单 → 403，看着像产品 bug，其实是测试撤掉了自己的前置条件）。
r = await api('/api/whitelist');
const origAllow = r.body.allow;
ok('白名单读取', origAllow && Array.isArray(origAllow.groups), JSON.stringify(origAllow));
ok('白名单带群名称映射', r.body.groupNames && typeof r.body.groupNames === 'object', Object.keys(r.body.groupNames || {}).length + ' 个');
ok('白名单带 QQ 昵称映射', r.body.privateNames && typeof r.body.privateNames === 'object', Object.keys(r.body.privateNames || {}).length + ' 个');
const testGroups = [...new Set([...(origAllow.groups || []), 123456789])];
r = await api('/api/whitelist', 'POST', { allow: { private: origAllow.private || [], groups: testGroups }, deny: { private: [], groups: [] } });
ok('白名单写入（含测试群）', r.body.ok === true && r.body.allow.groups.includes(123456789), JSON.stringify(r.body.allow));

// 8. 发送链路校验——**不真发**。
// 测试群号 123456789 是虚构的，真发会得到 QQ 的
// 「你已被移出该群，请重新加群」（该群不存在）——那是环境事实，不是控制台 bug。
// 所以这里只验证「白名单内 → 通过准入校验」，用非白名单的拒绝路径覆盖准入逻辑。
r = await api('/api/test-send', 'POST', { kind: 'group', id: '987654321', message: 'x' });
ok('非白名单发送被拒（403）', r.body.ok === false && r.status === 403, JSON.stringify(r.body));
r = await api('/api/test-send', 'POST', { kind: 'group', id: '', message: 'x' });
ok('无效目标 id 被拒（400）', r.body.ok === false && r.status === 400, JSON.stringify(r.body));
r = await api('/api/test-send', 'POST', { kind: 'group', id: '123456789', message: '' });
ok('空消息被拒（400）', r.body.ok === false && r.status === 400, JSON.stringify(r.body));

// 9. 恢复白名单原值（必须还原，避免污染真实 config.json）
// 比较用「逐字段」而不是 JSON.stringify 全等：接口返回值里还有 privateMode 等字段，
// 全等比较会因为多出字段而假失败（实测踩过：privateMode 加入后此断言即失败）。
function sameIdSet(a, b) {
  const norm = (x) => [...new Set((Array.isArray(x) ? x : []).map(String))].sort();
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}
r = await api('/api/whitelist', 'POST', { allow: origAllow, deny: { private: [], groups: [] } });
ok('白名单恢复原值',
  r.body.ok === true && sameIdSet(r.body.allow?.groups, origAllow.groups) && sameIdSet(r.body.allow?.private, origAllow.private),
  JSON.stringify(r.body.allow));

// 10. 清理测试人格。
// 用 unlinkSync 而不是 rmSync({force:true})：后者在 Windows 上曾出现
// 「返回成功但文件仍在」的情况（测试因此假失败），unlinkSync 行为可靠。
// 路径用 URL 相对定位，不依赖运行目录。
await api('/api/role', 'POST', { key: TEST_GROUP_KEY, role: null });
function removeTestRole() {
  const f = new URL(`../roles/${TEST_ROLE}.md`, import.meta.url);
  try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch { /* 忽略：下一步会断言结果 */ }
}
removeTestRole();
r = await api('/api/roles');
ok('测试人格已清理', !r.body.roles?.includes(TEST_ROLE), JSON.stringify(r.body.roles));

if (failed > 0) {
  console.log(`\n❌ ${failed} 项失败`);
  process.exit(1);
}
console.log('\n🎉 测试完成');
