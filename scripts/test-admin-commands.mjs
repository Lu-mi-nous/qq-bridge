// 回归测试：管理命令的识别、准入例外与执行。
//
// 背景（2026-10-13 用户要求「检查管理员命令能否正常生效，若不能则修复」）：
// 端到端实测（隔离环境 + 假 SnowLuma 注入 OneBot 事件）确认命令**基本正常**——
// /status /silent /active /role /role X /reset 都能执行并回复。
//
// 但发现一个**静默失败**：处理顺序里「挂起提问/审批」判定在管理命令之前，
// 且条件含 isOwner，于是管理员发 `/status` 时若该会话恰好有挂起的提问，
// 命令会被当成"回答"发给 DSH —— 命令不执行，而管理员收到的回复却是"已回答"，
// 完全不知道命令被吞了。这类只在挂起期间出现的静默失败极难排查。
//
// 修法：管理员发**已知管理命令**时，跳过挂起消费，让命令块处理。
// 判据取「已知管理命令」而非「以 / 开头」——DSH 自己的斜杠命令（/model 等）
// 必须原样转发给 DSH，不能被抢走。
//
// 2026-10-24 重构第 2 步：命令表/准入例外/执行已迁到 src/admin-commands.js。
// 本测试不再从 bridge.js 抽源码文本，直接 import 模块、用假 deps 跑完整行为。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createAdminCommands,
  isAdminCommand,
  canBypassAdmission,
  listAdminCommands
} from '../src/admin-commands.js';

let pass = 0, fail = 0;
const check = (n, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };

// ── 测试替身：只实现命令层需要的副作用 ─────────────────────────────────────
function makeHarness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-admin-cmd-'));
  const configFile = path.join(dir, 'config.json');
  const cfg = { allow: { groups: [10001, 10002] }, allowAllWhenEmpty: false };
  fs.writeFileSync(configFile, JSON.stringify({ allow: { groups: [10001, 10002] }, allowAllWhenEmpty: false }, null, 2));

  const sent = [];
  const calls = [];
  const overrides = {};
  const roleState = { role: '默认', mode: 'active' };
  const sentMessages = {};
  let resetResult = true;
  let failWrite = false;
  let groupListError = false;
  const deleted = [];

  const joinItems = [{ n: 1, requestType: 'friend', userId: 9, nickname: '甲' }];
  const joinQueue = {
    ttlMs: 5 * 60 * 1000,
    list: () => joinItems.slice(),
    take: (n) => {
      if (!joinItems.length) return { ok: false, error: '现在没有待处理的请求' };
      if (n == null && joinItems.length > 1) {
        return { ok: false, error: `现在有 ${joinItems.length} 条待处理，请用编号指定（例如 /yes 1）`, candidates: joinItems.slice() };
      }
      const idx = n == null ? 0 : joinItems.findIndex((it) => it.n === n);
      if (idx < 0) return { ok: false, error: `没有编号 ${n} 的待处理请求`, candidates: joinItems.slice() };
      const [item] = joinItems.splice(idx, 1);
      return { ok: true, item };
    }
  };

  const deps = {
    cfg,
    configFile,
    sendToQQ: async (key, text) => { sent.push({ key, text }); },
    log: (...args) => calls.push(['log', ...args]),
    notifyOwnerOfError: (...args) => calls.push(['notify', ...args]),
    readJsonSafe: (file, fallback, required) => {
      try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
      catch (error) { if (required) throw error; return fallback; }
    },
    atomicWriteJson: (file, obj) => {
      if (failWrite) throw new Error('disk full');
      fs.writeFileSync(file, JSON.stringify(obj, null, 2));
    },
    withTimeout: async (p) => p,
    getGroupList: async () => {
      if (groupListError) throw new Error('SnowLuma offline');
      return [{ group_id: 10001, group_name: '测试群' }, { group_id: 10002, group_name: '二群' }];
    },
    deleteMessage: async (messageId) => {
      if (String(messageId).startsWith('bad')) throw new Error('delete failed');
      deleted.push(messageId);
    },
    getSentMessages: (key) => sentMessages[key] ?? [],
    resetSession: (key) => { calls.push(['reset', key]); return resetResult; },
    getSessionId: (key) => `sess-${key}`,
    isAllowed: () => true,
    roleFor: (key) => overrides[key] ?? roleState.role,
    hasConversationRole: (key) => !!overrides[key],
    getRoleState: () => roleState,
    writeRoleState: (role, mode) => { roleState.role = role; roleState.mode = mode; },
    writeConversationRole: (key, role) => { if (role) overrides[key] = role; else delete overrides[key]; },
    sanitizeRoleName: (name) => String(name ?? '').replace(/[^\w\u4e00-\u9fff\-（）()]/g, ''),
    roleExists: (name) => ['默认', '阿盐'].includes(name),
    getOwnerQQ: () => '123456',
    getJoinQueue: () => joinQueue,
    submitJoinDecision: async () => ({ ok: true }),
    getTokenFuseStatus: () => ({ enabled: true, day: '2026-10-25', keys: [{ key: 'group:1', state: 'fused', totalInput: 1234, uncached: 56 }] }),
    resetTokenFuse: (key) => { calls.push(['resetTokenFuse', key]); return key === 'group:1'; },
    appendActivity: (line) => calls.push(['activity', line])
  };

  return {
    dir, configFile, cfg, sent, calls, overrides, roleState, sentMessages, deleted,
    joinItems, joinQueue, deps,
    setResetResult: (v) => { resetResult = v; },
    setFailWrite: (v) => { failWrite = v; },
    setGroupListError: (v) => { groupListError = v; },
    lastText: () => sent.at(-1)?.text ?? '',
    create: () => createAdminCommands(deps)
  };
}

const KEY = 'group:1';
const CTX = { key: KEY, kind: 'group', id: 10001, isOwner: true, roleState: { role: '默认', mode: 'active' } };

console.log('── 1. 命令识别 ──');
{
  const names = listAdminCommands();
  for (const n of ['reset', 'status', 'role', 'silent', 'active', 'recall', 'whitelist', 'join-decision', 'token-fuse']) {
    check(`命令表包含 ${n}`, names.includes(n));
  }
  const yes = ['/status', '/reset', '/new', '/silent', '/quiet', '/active', '/speak',
    '/role', '/role 阿盐', '/role off', '/recall', '/recall 3', '/撤回', '/撤回 2',
    '/wl', '/wl add 1000000001', '/wl del 1000000001', '/白名单',
    '/yes', '/yes 1', '/no 2', '/pending', '/tf', '/tf off group:1'];
  const no = ['/model', '/help', '/compact', '普通消息', '', '/roleplay', '/recallx', '/status extra',
    'status', '/wlsomething', '/白名单列表'];
  for (const c of yes) check(`识别管理命令 ${c}`, isAdminCommand(c) === true);
  for (const c of no) check(`不抢 DSH 命令/普通消息 ${JSON.stringify(c)}`, isAdminCommand(c) === false);
  check('null 不崩', isAdminCommand(null) === false);
}

console.log('\n── 2. 准入例外（只放群聊 owner 的白名单命令）──');
{
  const base = { kind: 'group', mode: 'chat', ownerQQ: '123456', userId: '123456', text: '/wl add 123456' };
  check('群聊 + owner + /wl → 放行', canBypassAdmission(base) === true);
  check('非 owner → 不放行', canBypassAdmission({ ...base, userId: '999' }) === false);
  check('私聊 → 不放行', canBypassAdmission({ ...base, kind: 'private' }) === false);
  check('closed-agent → 不放行', canBypassAdmission({ ...base, mode: 'closed-agent' }) === false);
  check('ownerQQ 为空 → 不放行', canBypassAdmission({ ...base, ownerQQ: '' }) === false);
  check('非白名单命令 → 不放行', canBypassAdmission({ ...base, text: '/status' }) === false);
  check('/wlsomething 不误判', canBypassAdmission({ ...base, text: '/wlsomething' }) === false);
  check('空 ctx 不崩', canBypassAdmission() === false);
}

console.log('\n── 3. 主命令执行 ──');
{
  const h = makeHarness();
  const cmds = h.create();

  check('非管理员已知命令被拦下', await cmds.handleAdminCommand({ ...CTX, plainContent: '/status', isOwner: false }) === true);
  check('非管理员收到明确提示', h.lastText() === '管理命令仅管理员可用。');
  check('非管理员未知 / 命令不消费（交给 DSH）', await cmds.handleAdminCommand({ ...CTX, plainContent: '/model', isOwner: false }) === false);
  check('非管理员普通 / 文本不回复', await cmds.handleAdminCommand({ ...CTX, plainContent: '/今天天气不错', isOwner: false }) === false);
  check('非管理员路径样文本不回复', await cmds.handleAdminCommand({ ...CTX, plainContent: '/usr/local/bin', isOwner: false }) === false);
  check('未知 / 命令交给 DSH（不消费）', await cmds.handleAdminCommand({ ...CTX, plainContent: '/model' }) === false);
  check('非管理员未知命令没有产生回复', h.sent.length === 1);

  check('/status 被消费', await cmds.handleAdminCommand({ ...CTX, plainContent: '/status' }) === true);
  check('/status 回复包含会话/白名单/角色/模式',
    /会话 sess-group:1/.test(h.lastText()) && /白名单 通过/.test(h.lastText())
    && /角色 默认（默认）/.test(h.lastText()) && /模式 active/.test(h.lastText()));

  check('/silent 被消费', await cmds.handleAdminCommand({ ...CTX, plainContent: '/silent' }) === true);
  check('/silent 写入 silent 模式', h.roleState.mode === 'silent');
  check('/silent 回复', /已进入静默模式/.test(h.lastText()));
  check('/active 被消费', await cmds.handleAdminCommand({ ...CTX, plainContent: '/active' }) === true);
  check('/active 写入 active 模式', h.roleState.mode === 'active');
  check('/active 回复', /已退出静默模式/.test(h.lastText()));

  check('/role 阿盐 被消费', await cmds.handleAdminCommand({ ...CTX, plainContent: '/role 阿盐' }) === true);
  check('/role 阿盐 写入本群覆盖', h.overrides[KEY] === '阿盐');
  check('/role 阿盐 回复', /已切换本群角色：阿盐/.test(h.lastText()));
  check('/role 不存在的角色 被消费', await cmds.handleAdminCommand({ ...CTX, plainContent: '/role 不存在' }) === true);
  check('/role 不存在时不改覆盖', h.overrides[KEY] === '阿盐');
  check('/role 不存在时明确报错', /角色「不存在」不存在/.test(h.lastText()));
  check('/role off 清除覆盖', await cmds.handleAdminCommand({ ...CTX, plainContent: '/role off' }) === true);
  check('/role off 删除覆盖', h.overrides[KEY] === undefined);
  check('/role off 回复恢复默认', /已清除本群人格，恢复默认角色：默认/.test(h.lastText()));

  check('/reset 被消费', await cmds.handleAdminCommand({ ...CTX, plainContent: '/reset' }) === true);
  check('/reset 调用 resetSession', h.calls.some((c) => c[0] === 'reset' && c[1] === KEY));
  check('/reset 有会话时回复', /已重置会话/.test(h.lastText()));
  h.setResetResult(false);
  check('/reset 无会话也回复', await cmds.handleAdminCommand({ ...CTX, plainContent: '/new' }) === true && /当前会话还没有上下文，无需重置/.test(h.lastText()));
}

console.log('\n── 3b. /tf Token 熔断 ──');
{
  const h = makeHarness();
  const cmds = h.create();
  await cmds.handleAdminCommand({ ...CTX, plainContent: '/tf' });
  check('列出熔断状态', h.lastText().includes('group:1') && h.lastText().includes('已熔断'), h.lastText());
  await cmds.handleAdminCommand({ ...CTX, plainContent: '/tf off group:1' });
  check('解除熔断', h.calls.some((c) => c[0] === 'resetTokenFuse' && c[1] === 'group:1')
    && h.lastText().includes('已解除'), h.lastText());
}

console.log('\n── 4. /recall 撤回 ──');
{
  const h = makeHarness();
  const cmds = h.create();
  h.sentMessages[KEY] = [{ messageId: 'm1' }, { messageId: 'm2' }, { messageId: 'm3' }];
  const before = h.sent.length;
  check('/recall 2 被消费', await cmds.handleAdminCommand({ ...CTX, plainContent: '/recall 2' }) === true);
  check('/recall 2 只撤最后两条', h.deleted.join(',') === 'm3,m2');
  check('/recall 成功后不刷确认消息', h.sent.length === before);
  check('/recall 从登记里移除已撤条目', h.sentMessages[KEY].length === 1 && h.sentMessages[KEY][0].messageId === 'm1');

  h.sentMessages[KEY] = [];
  await cmds.handleAdminCommand({ ...CTX, plainContent: '/撤回' });
  check('/recall 无记录时明确说明', /没有可撤回的记录/.test(h.lastText()));

  h.sentMessages[KEY] = [{ messageId: 'bad1' }];
  await cmds.handleAdminCommand({ ...CTX, plainContent: '/recall' });
  check('/recall 全失败时通知管理员', h.calls.some((c) => c[0] === 'notify' && /撤回失败/.test(c.slice(1).join(' '))));
  check('/recall 全失败时不发群消息', !/撤回失败/.test(h.lastText()));
}

console.log('\n── 5. /wl 群白名单 ──');
{
  const h = makeHarness();
  const cmds = h.create();

  check('/wl 列表被消费', await cmds.handleAdminCommand({ ...CTX, plainContent: '/wl' }) === true);
  check('/wl 列表显示群名', /群白名单 2 个/.test(h.lastText()) && /测试群/.test(h.lastText()));

  check('/wl add 123456 被消费', await cmds.handleAdminCommand({ ...CTX, plainContent: '/wl add 123456' }) === true);
  check('/wl add 同步内存', h.cfg.allow.groups.includes(123456));
  check('/wl add 写盘', JSON.parse(fs.readFileSync(h.configFile, 'utf8')).allow.groups.includes(123456));
  check('/wl add 回复已加入', /已加入：123456/.test(h.lastText()));

  check('/wl add 重复被消费', await cmds.handleAdminCommand({ ...CTX, plainContent: '/wl add 123456' }) === true);
  check('/wl add 重复不写盘（回复本来就在）', /这些群都已在白名单里/.test(h.lastText()));
  check('/wl add 重复后数量不变', h.cfg.allow.groups.length === 3);

  check('/wl del 123456 被消费', await cmds.handleAdminCommand({ ...CTX, plainContent: '/wl del 123456' }) === true);
  check('/wl del 同步内存', !h.cfg.allow.groups.includes(123456));
  check('/wl del 回复已移出', /已移出：123456/.test(h.lastText()));

  check('/wl del 本群时明确告知', await cmds.handleAdminCommand({ ...CTX, plainContent: '/wl del 10001' }) === true && /本群已被移出/.test(h.lastText()));

  check('/wl 私聊改名单被拒', await cmds.handleAdminCommand({ ...CTX, kind: 'private', plainContent: '/wl add 123456' }) === true && /群白名单只能在群里操作/.test(h.lastText()));
  check('/wl 乱写给用法', await cmds.handleAdminCommand({ ...CTX, plainContent: '/wl xyz' }) === true && /用法：\/wl/.test(h.lastText()));
  check('/wl 无有效群号给用法', await cmds.handleAdminCommand({ ...CTX, plainContent: '/wl add 1234' }) === true && /没看到有效的群号/.test(h.lastText()));

  // 写盘失败：内存不许改
  const beforeGroups = h.cfg.allow.groups.slice();
  h.setFailWrite(true);
  check('/wl 写盘失败被消费', await cmds.handleAdminCommand({ ...CTX, plainContent: '/wl add 654321' }) === true);
  check('/wl 写盘失败不改内存', JSON.stringify(h.cfg.allow.groups) === JSON.stringify(beforeGroups));
  check('/wl 写盘失败通知管理员', h.calls.some((c) => c[0] === 'notify' && /写入失败/.test(c.slice(1).join(' '))));
  h.setFailWrite(false);

  // 删到空：必须说明后果
  h.cfg.allow.groups = [10001];
  fs.writeFileSync(h.configFile, JSON.stringify({ allow: { groups: [10001] }, allowAllWhenEmpty: false }, null, 2));
  await cmds.handleAdminCommand({ ...CTX, plainContent: '/wl del 10001' });
  check('/wl 删到空说明所有群被拦', /所有群都会被拦截/.test(h.lastText()));

  // 群列表失败不影响列表本身
  h.setGroupListError(true);
  h.cfg.allow.groups = [10001, 10002];
  fs.writeFileSync(h.configFile, JSON.stringify({ allow: { groups: [10001, 10002] }, allowAllWhenEmpty: false }, null, 2));
  await cmds.handleAdminCommand({ ...CTX, plainContent: '/wl' });
  check('/wl 群列表失败仍列出群号', /群白名单 2 个/.test(h.lastText()) && h.lastText().includes('1. 10001'));
}

console.log('\n── 6. 加好友/入群裁决 ──');
{
  const h = makeHarness();
  const cmds = h.create();

  check('非管理员私聊 /yes 不消费', await cmds.handleJoinDecisionCommand('private:999', '/yes 1') === false);
  check('群里 owner /yes 不消费', await cmds.handleJoinDecisionCommand(KEY, '/yes 1') === false);

  check('/pending 被消费', await cmds.handleJoinDecisionCommand('private:123456', '/pending') === true);
  check('/pending 列出待处理', /待处理 1 条/.test(h.lastText()) && /甲/.test(h.lastText()));

  check('/yes 1 被消费', await cmds.handleJoinDecisionCommand('private:123456', '/yes 1') === true);
  check('/yes 1 回复同意', /已同意 #1/.test(h.lastText()));
  check('/yes 1 记录活动', h.calls.some((c) => c[0] === 'activity' && /管理员同意 #1/.test(c[1])));

  h.joinItems.push({ n: 2, requestType: 'group', groupId: 888, userId: 10, nickname: '乙' });
  check('/no 2 被消费', await cmds.handleJoinDecisionCommand('private:123456', '/no 2') === true);
  check('/no 2 回复拒绝', /已拒绝 #2/.test(h.lastText()));

  // 多条待决时不带编号：队列返回错误
  h.joinItems.push({ n: 3, requestType: 'friend', userId: 11, nickname: '丙' });
  h.joinItems.push({ n: 4, requestType: 'friend', userId: 12, nickname: '丁' });
  await cmds.handleJoinDecisionCommand('private:123456', '/yes');
  check('多条待决不带编号时提示指定编号', /请用编号指定/.test(h.lastText()));
  check('错误里附带候选列表', /当前待处理/.test(h.lastText()));

  // 已处理/过期/失败三种结果
  h.joinItems.push({ n: 5, requestType: 'friend', userId: 13, nickname: '戊' });
  h.deps.submitJoinDecision = async () => ({ ok: true, alreadyJoined: true });
  await cmds.handleJoinDecisionCommand('private:123456', '/yes 5');
  check('已处理分支回复', /已经处理过了/.test(h.lastText()));

  h.joinItems.push({ n: 6, requestType: 'friend', userId: 14, nickname: '己' });
  h.deps.submitJoinDecision = async () => ({ ok: false, expired: true });
  await cmds.handleJoinDecisionCommand('private:123456', '/yes 6');
  check('过期分支回复', /已经失效/.test(h.lastText()));

  h.joinItems.push({ n: 7, requestType: 'friend', userId: 15, nickname: '庚' });
  h.deps.submitJoinDecision = async () => ({ ok: false });
  await cmds.handleJoinDecisionCommand('private:123456', '/yes 7');
  check('提交失败分支回复', /裁决提交失败/.test(h.lastText()));

  h.joinItems.length = 0;
  await cmds.handleJoinDecisionCommand('private:123456', '/pending');
  check('无待处理时明确说明', /现在没有待处理/.test(h.lastText()));
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
