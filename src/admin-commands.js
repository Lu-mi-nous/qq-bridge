// 管理命令的识别、准入例外与执行。
//
// 为什么要单独成模块（2026-10-24 重构第 2 步）：
// 管理命令原来散在 bridge.js 的三处——handleIncoming 里的 adminCmd 判定、
// 命令块实现、以及准入闸门里的 /wl 例外。加一条命令要同时改三处，
// 漏一处就是静默失败（最典型：挂起提问期间管理员发 /status 被当成“回答”吞掉）。
// 现在收敛为三张表：
//   1. COMMANDS      —— 已知管理命令（识别 + 执行），是 adminCmd 的唯一事实源；
//   2. JOIN_COMMANDS —— 加好友/入群裁决指令（必须在挂起判定之前处理）；
//   3. PRE_ADMISSION —— 尚未授权也能执行的命令例外（目前只有群聊 owner 的 /wl）。
//
// 本模块只做“命令层”：需要碰 bridge 内部状态的副作用（重置会话、写角色、
// 撤回消息等）通过 createAdminCommands(deps) 显式注入，不在模块里抓闭包。
import { parseJoinCommand, describeJoinRequest, DEFAULT_TTL_MS as JOIN_TTL_MS } from './join-request.js';

// ── 群白名单命令的解析与增删（纯函数）──────────────────────────────────────
//
// 语义与 allowed() 保持一致（**这是最容易写错的地方**）：
//   - allow.groups 为空 且 allowAllWhenEmpty=true  → 等于“全部放行”，此时删到空不会锁群；
//   - allow.groups 为空 且 allowAllWhenEmpty=false → 等于“全部拦截”，**删到空会把所有群关掉**。
// 所以「删最后一条」要显式提醒，而不是静默生效。
// 主命令 `/wl`（whitelist 缩写），同时接受中文 `/白名单`。
// 刻意不占用 `/allow` 这类泛化词：adminCmd 的判定优先于 DSH 斜杠命令，
// 名字越泛越容易在将来与 DSH 自带命令撞车，撞了就是“管理员命令把 DSH 命令吃了”。
const WHITELIST_CMD_RE = /^\/(?:wl|白名单)(?:\s|$)/i;

// 解析 `/wl` 系列命令；不是该命令返回 null，让调用方继续走别的分支。
//   /wl                          列当前白名单
//   /wl add 123456               加群
//   /wl del 123456               移出群
//   /wl add 123456 654321        一次多个（空格/逗号/顿号都认）
export function parseWhitelistCommand(text) {
  const s = String(text ?? '').trim();
  if (!WHITELIST_CMD_RE.test(s)) return null;
  const rest = s.replace(/^\/(?:wl|白名单)/i, '').trim();
  if (!rest) return { action: 'list', ids: [] };
  const m = /^(删除|移除|去掉|add|delete|remove|del|rm|加|删)(?:\s+([\s\S]*))?$/i.exec(rest);
  if (!m) {
    // 只写了一个群号（`/wl 123456`）时按「加」处理——管理员手快时最常见的写法。
    if (/^[\d\s,，、]+$/.test(rest)) {
      return { action: 'add', ids: extractIdList(rest) };
    }
    return { action: 'help', ids: [] };
  }
  const action = /^(add|加)$/i.test(m[1]) ? 'add' : 'del';
  return { action, ids: extractIdList(m[2]) };
}

// 从任意分隔的文字里抠出 QQ 号/群号；非数字的整词忽略（不报错，让上层统一提示）。
export function extractIdList(text) {
  const out = [];
  for (const raw of String(text ?? '').split(/[\s,，、;；]+/)) {
    const t = raw.trim();
    if (!t) continue;
    if (!/^\d{5,12}$/.test(t)) continue;
    const n = Number(t);
    if (!Number.isSafeInteger(n) || n <= 0) continue;
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

// 增删白名单数组，返回新数组与“实际发生了什么”。纯函数，不改入参。
export function applyWhitelistChange(list, action, ids) {
  // 只收正整数：`Number(null)` / `Number('')` 都是 0，光用 Number.isFinite 会把脏值放进来。
  const toId = (v) => {
    const n = Number(String(v ?? '').trim());
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  };
  const before = (Array.isArray(list) ? list : []).map(toId).filter((n) => n !== null);
  const set = new Set(before);
  const added = [];
  const removed = [];
  const missing = [];
  if (action === 'add') {
    for (const id of ids) {
      if (set.has(id)) { missing.push(id); continue; }
      set.add(id);
      added.push(id);
    }
  } else if (action === 'del') {
    for (const id of ids) {
      if (!set.has(id)) { missing.push(id); continue; }
      set.delete(id);
      removed.push(id);
    }
  }
  return { next: [...set], added, removed, unchanged: missing };
}

// `allow.groups` 被删空时会发生什么——命令里要如实说出来，别让管理员以为“处理了”。
export function describeEmptyWhitelistRisk(allowAllWhenEmpty) {
  return allowAllWhenEmpty
    ? '注意：群白名单已空，但 allowAllWhenEmpty=true，仍是所有群都放行。'
    : '注意：群白名单已空，且 allowAllWhenEmpty=false，现在所有群都会被拦截（包括本群）。重新加入本群可直接发 /wl add <本群号>。';
}

// 只取消息里的纯文本段（不解析 @ / 引用，便宜且同步）。
// 用途：准入闸门在解析整条消息之前就要判断“是不是白名单命令”——
// 否则新群（还没进白名单）发的 /wl add 会在闸门处被丢掉，永远到不了命令处理。
export function rawTextOfMessage(segments) {
  if (typeof segments === 'string') return segments.trim();
  return (segments ?? [])
    .filter((s) => s?.type === 'text')
    .map((s) => s?.data?.text ?? '')
    .join('')
    .trim();
}

export function isWhitelistCommand(text) {
  return parseWhitelistCommand(text) !== null;
}

// ── 命令表 ────────────────────────────────────────────────────────────────
//
// 每条命令只在这里定义一次：match 负责识别，run 负责执行。
// 新增命令时只改这一张表；test-admin-commands 会直接 import 本模块做交叉验证。
const RECALL_RE = /^\/(?:recall|撤回)(?:\s+\d+)?$/i;
const TOKEN_FUSE_RE = /^\/tf(?:\s+([\s\S]*))?$/i;

const COMMANDS = [
  {
    name: 'reset',
    match: (s) => s === '/reset' || s === '/new',
    run: handleReset
  },
  {
    name: 'status',
    match: (s) => s === '/status',
    run: handleStatus
  },
  {
    name: 'role',
    match: (s) => s === '/role' || s.startsWith('/role '),
    run: handleRole
  },
  {
    name: 'silent',
    match: (s) => s === '/silent' || s === '/quiet',
    run: handleSilent
  },
  {
    name: 'active',
    match: (s) => s === '/active' || s === '/speak',
    run: handleActive
  },
  {
    name: 'recall',
    match: (s) => RECALL_RE.test(s),
    run: handleRecall
  },
  {
    name: 'whitelist',
    match: (s) => isWhitelistCommand(s),
    run: handleWhitelist
  },
  {
    name: 'token-fuse',
    match: (s) => TOKEN_FUSE_RE.test(s),
    run: handleTokenFuse
  }
];

// 加好友/入群裁决单独一张表：它们必须在挂起提问判定**之前**执行，
// 否则管理员回 /yes 时若该会话恰好有挂起提问，会被当成“回答”吞掉。
const JOIN_COMMANDS = [
  {
    name: 'join-decision',
    match: (s) => parseJoinCommand(s) !== null,
    run: handleJoinDecision
  }
];

/**
 * 是否是已知管理命令。
 *
 * 判据取“已知命令”而不是“以 / 开头”：DSH 自己的斜杠命令（/model 等）
 * 必须原样转发给 DSH，不能被这里抢走。这个函数同时用于：
 *   - handleIncoming 的 adminCmd（挂起提问期间优先执行管理命令）；
 *   - handleAdminCommand 的分发。
 */
export function isAdminCommand(text) {
  const s = String(text ?? '');
  if (!s.startsWith('/')) return false;
  return COMMANDS.some((cmd) => cmd.match(s)) || JOIN_COMMANDS.some((cmd) => cmd.match(s));
}

/** 命令表里的命令名（测试用于确认每条命令都有处理器）。 */
export function listAdminCommands() {
  return [...COMMANDS.map((cmd) => cmd.name), ...JOIN_COMMANDS.map((cmd) => cmd.name)];
}

/**
 * 准入闸门的例外表。
 *
 * 为什么必须有：管理员想「从这个新群把群加进白名单」时，消息在准入闸门就被丢掉，
 * 永远走不到命令块——那这条命令就只能对已经在白名单里的群生效，等于没法加新群。
 * 条件收得很窄：仅群聊、仅 ownerQQ、且文本确实是白名单命令；
 * 群友发同样的话照旧被丢弃（命令层还有一次 isOwner 校验）。
 * closed-agent 模式不例外（该模式只认管理员私聊，开了口子等于破模式）。
 */
const PRE_ADMISSION = [
  {
    name: 'owner-group-whitelist',
    test: ({ kind, mode, ownerQQ, userId, text }) => kind === 'group'
      && mode !== 'closed-agent'
      && !!String(ownerQQ ?? '').trim()
      && String(userId) === String(ownerQQ)
      && isWhitelistCommand(text)
  }
];

/** 这条消息是否命中准入例外（供 bridge 的 modeAllowed 闸门调用）。 */
export function canBypassAdmission(ctx) {
  return PRE_ADMISSION.some((rule) => rule.test(ctx ?? {}));
}

// ── 命令实现 ──────────────────────────────────────────────────────────────
//
// 所有实现都只通过 deps 访问 bridge 的副作用，不直接抓 bridge 的闭包变量。
// 这样测试可以用假 deps 跑完整命令行为，不必启动 WS/HTTP 栈。

async function handleReset({ deps, key }) {
  const hadSession = await deps.resetSession(key);
  await deps.sendToQQ(key, hadSession
    ? '已重置会话，下次消息将开新上下文'
    : '当前会话还没有上下文，无需重置。');
}

async function handleStatus({ deps, key, kind, id }) {
  const rs = deps.getRoleState();
  const effective = deps.roleFor(key);
  const isOverride = deps.hasConversationRole(key);
  await deps.sendToQQ(key, `会话 ${deps.getSessionId(key) ?? '未创建'}；白名单 ${deps.isAllowed(kind, id) ? '通过' : '拦截'}；角色 ${effective ?? '无'}${effective ? (isOverride ? '（本群单独）' : '（默认）') : ''}；模式 ${rs.mode}`);
}

async function handleRole({ deps, key, text }) {
  const name = deps.sanitizeRoleName(text.slice(5).trim());
  if (!name || name === 'off' || name === 'clear') {
    deps.writeConversationRole(key, null);
    const fallback = deps.roleFor(key);
    await deps.sendToQQ(key, `已清除本群人格${fallback ? `，恢复默认角色：${fallback}` : '，当前无默认角色'}。`);
    return;
  }
  if (!deps.roleExists(name)) {
    await deps.sendToQQ(key, `角色「${name}」不存在。角色文件放 qq-bridge/roles/ 目录。`);
    return;
  }
  deps.writeConversationRole(key, name);
  await deps.sendToQQ(key, `已切换本群角色：${name}。`);
}

async function handleSilent({ deps, key, roleState }) {
  deps.writeRoleState(roleState.role, 'silent');
  await deps.sendToQQ(key, '已进入静默模式：群友消息不再回复，仅管理员可对话。');
}

async function handleActive({ deps, key, roleState }) {
  deps.writeRoleState(roleState.role, 'active');
  await deps.sendToQQ(key, '已退出静默模式，恢复正常回复。');
}

async function handleRecall({ deps, key, text }) {
  const n = Math.min(10, Math.max(1, Number(text.match(/(\d+)/)?.[1]) || 1));
  const arr = deps.getSentMessages(key) ?? [];
  if (!arr.length) {
    await deps.sendToQQ(key, '没有可撤回的记录（本会话自启动以来还没有发出过消息）。');
    return;
  }
  const targets = arr.splice(Math.max(0, arr.length - n)).reverse();
  let ok = 0;
  const errs = [];
  for (const t of targets) {
    try {
      await deps.deleteMessage(t.messageId);
      ok += 1;
    } catch (error) {
      errs.push(`${String(t.messageId).slice(0, 20)}: ${error?.message ?? error}`);
    }
  }
  deps.log(`管理命令 /recall (${key}): 请求 ${targets.length} 条，成功 ${ok} 条${errs.length ? `，失败 ${errs.length} 条` : ''}`);
  // 静默撤回：成功不发确认消息（管理员要求，撤回动作本身可见）。
  // 一条都没撤成时把原因私聊给管理员——撤回失败属于报错，按「报错不进群」处理。
  if (ok === 0) {
    deps.notifyOwnerOfError(key, '撤回失败（一条都没撤成）', errs[0] ?? '未知错误', {
      说明: `请求撤回 ${targets.length} 条，成功 0 条`,
      可能原因: 'QQ 对撤回有时限（约 2 分钟）/权限限制'
    });
  }
}

async function handleWhitelist({ deps, key, kind, id, text }) {
  const wl = parseWhitelistCommand(text);
  if (!wl) return;
  if (wl.action === 'help') {
    await deps.sendToQQ(key, '用法：/wl 查看群白名单；/wl add 群号 [群号...] 加入；/wl del 群号 [群号...] 移除。');
    return;
  }
  // 白名单只对群生效：私聊有独立的 privateMode 三态（白名单/好友放行/全放开），
  // 在这里改私聊名单会把那套语义搅乱，所以明确不做。
  if (kind === 'private' && wl.action !== 'list') {
    await deps.sendToQQ(key, '群白名单只能在群里操作（私聊准入用 allow.privateMode）。');
    return;
  }
  let file;
  try {
    // fail-fast：配置损坏时直接报错，绝不回写，避免把整个 config 清成只剩 allow/deny。
    file = deps.readJsonSafe(deps.configFile, null, true);
  } catch (error) {
    deps.notifyOwnerOfError(key, '群白名单读取失败，未做任何修改', String(error?.message ?? error));
    return;
  }
  const current = Array.isArray(file.allow?.groups) ? file.allow.groups.map(Number).filter(Number.isFinite) : deps.cfg.allow.groups;
  if (wl.action === 'list') {
    // 群名只是锦上添花：查不到（SnowLuma 未连/接口异常）就只列群号，绝不让列表本身失败。
    const names = await (async () => {
      const map = new Map();
      try {
        const list = await deps.withTimeout(deps.getGroupList(), 5000, '获取群列表');
        for (const g of Array.isArray(list) ? list : (list?.data ?? [])) {
          const gid = Number(g?.group_id);
          if (Number.isFinite(gid)) map.set(gid, String(g?.group_name ?? g?.group_remark ?? '').trim());
        }
      } catch (error) {
        deps.log(`[白名单] 获取群列表失败（仅影响显示群名）：${error?.message ?? error}`);
      }
      return map;
    })();
    const lines = current.length
      ? current.map((gid, i) => `${i + 1}. ${gid}${names.get(gid) ? `（${names.get(gid)}）` : ''}`)
      : ['（空）'];
    const tail = current.length ? '' : `\n${describeEmptyWhitelistRisk(deps.cfg.allowAllWhenEmpty)}`;
    await deps.sendToQQ(key, `群白名单 ${current.length} 个：\n${lines.join('\n')}${tail}`);
    return;
  }
  if (!wl.ids.length) {
    await deps.sendToQQ(key, '没看到有效的群号（5~12 位数字）。用法：/wl add 群号 [群号...] 或 /wl del 群号 [群号...]。');
    return;
  }
  const { next, added, removed, unchanged } = applyWhitelistChange(current, wl.action, wl.ids);
  // 没变化就不写盘：避免“看到回复以为重启后生效了”，实际什么都没改。
  if (!added.length && !removed.length) {
    await deps.sendToQQ(key, `${wl.action === 'add' ? '这些群都已在白名单里' : '这些群本来就不在白名单里'}：${unchanged.join(', ')}`);
    return;
  }
  file.allow = {
    ...(file.allow ?? {}),
    groups: next
  };
  try {
    deps.atomicWriteJson(deps.configFile, file);
  } catch (error) {
    // 写盘失败**不能**改内存：否则进程内看似生效、重启即丢，症状比报错更迷惑。
    deps.notifyOwnerOfError(key, '群白名单写入失败，改动未生效', String(error?.message ?? error), {
      尝试: `${wl.action} ${wl.ids.join(',')}`,
      结果: 'config.json 未改动，内存也未改'
    });
    return;
  }
  deps.cfg.allow.groups = next;
  deps.log(`管理命令 /wl ${wl.action} (${key}): 加入 ${added.join(',') || '无'}，移除 ${removed.join(',') || '无'}，现有 ${next.length} 个`);
  const parts = [];
  if (added.length) parts.push(`已加入：${added.join(', ')}`);
  if (removed.length) parts.push(`已移出：${removed.join(', ')}`);
  if (unchanged.length) parts.push(`未变：${unchanged.join(', ')}`);
  parts.push(`当前群白名单 ${next.length} 个${next.length ? `：${next.join(', ')}` : ''}`);
  // 移出当前群 = 这条消息是它在白名单里的最后一次发言，必须说清楚“之后不会再来”。
  const removedSelf = removed.includes(Number(id));
  if (removedSelf) parts.push('本群已被移出，之后这个群的消息不再处理。要加回就在本群发 /wl add ' + String(id) + '（仅管理员有效）。');
  if (!next.length && wl.action === 'del') parts.push(describeEmptyWhitelistRisk(deps.cfg.allowAllWhenEmpty));
  await deps.sendToQQ(key, parts.join('\n'));
}

async function handleJoinDecision({ deps, key, text }) {
  const cmd = parseJoinCommand(text);
  if (!cmd) return false;
  // 只认管理员私聊：群里的“同意”可能是别人说的（账号级权限变更不能这么随便）
  const owner = String(deps.getOwnerQQ() ?? '').trim();
  if (!owner || key !== `private:${owner}`) {
    // 不是管理员：不消费，让消息走正常流程（它在群里说“同意”不该被当成指令）
    return false;
  }

  const joinQueue = deps.getJoinQueue();
  if (cmd.action === 'list') {
    const all = joinQueue.list();
    if (!all.length) {
      deps.sendToQQ(key, '现在没有待处理的好友/入群请求。').catch(() => {});
    } else {
      const mins = Math.round((joinQueue.ttlMs || JOIN_TTL_MS) / 60000);
      deps.sendToQQ(key, `待处理 ${all.length} 条（${mins} 分钟内有效）：\n\n`
        + all.map((it) => `#${it.n}　${describeJoinRequest(it)}`).join('\n\n')
        + `\n\n用 /yes 编号 或 /no 编号 处理。`).catch(() => {});
    }
    return true;
  }

  const taken = joinQueue.take(cmd.index);
  if (!taken.ok) {
    const extra = Array.isArray(taken.candidates) && taken.candidates.length
      ? `\n\n当前待处理：\n${taken.candidates.map((it) => `#${it.n}　${describeJoinRequest(it).replace(/\n/g, ' ')}`).join('\n')}`
      : '';
    deps.sendToQQ(key, `${taken.error}${extra}`).catch(() => {});
    return true;
  }

  const item = taken.item;
  const approve = cmd.action === 'approve';
  const res = await deps.submitJoinDecision(item, approve);
  const what = item.requestType === 'friend' ? '好友请求' : '入群邀请';
  let reply;
  if (res.ok && res.alreadyJoined) {
    // 不是失败：QQ 已经替我们同意了（或对方已在群里），没必要再操作
    reply = `#${item.n} 已经处理过了：机器人已在群里，不需要再${approve ? '同意' : '拒绝'}。`;
  } else if (res.ok) {
    reply = `已${approve ? '同意' : '拒绝'} #${item.n}（${what}，${item.nickname || item.userId}${item.groupId ? ` → ${item.groupId}` : ''}）`;
  } else if (res.expired) {
    reply = `#${item.n} 的请求已经失效（QQ 侧可能已自动同意或过期），请到 QQ 侧确认一下。`;
  } else {
    reply = `#${item.n} 的裁决提交失败，请稍后在 QQ 侧手动处理（${what}）`;
  }
  deps.sendToQQ(key, reply).catch(() => {});
  deps.appendActivity(`[加入请求] 管理员${approve ? '同意' : '拒绝'} #${item.n}`);
  return true;
}

async function handleTokenFuse({ deps, key, text }) {
  const status = deps.getTokenFuseStatus();
  const arg = String(text ?? '').replace(/^\/tf\s*/i, '').trim();
  if (/^(off|解除|reset)(?:\s|$)/i.test(arg)) {
    const target = (/(?:group|private):\d+/.exec(arg) || [])[0] || (/^(?:group|private):\d+$/.test(arg) ? arg : '');
    if (!target) {
      await deps.sendToQQ(key, '用法：/tf off group:群号 或 /tf off private:QQ号');
      return;
    }
    const ok = deps.resetTokenFuse(target);
    await deps.sendToQQ(key, ok ? `已解除 ${target} 的 Token 熔断，当日计数归零。` : `没有找到 ${target} 的熔断计数。`);
    return;
  }
  const fmt = (n) => Number(n || 0).toLocaleString('en-US');
  const lines = (status.keys || []).slice(0, 20).map((x) => {
    const state = x.state === 'fused' ? '已熔断' : x.state === 'warn' ? '提醒' : '正常';
    return `${x.key}　${state}　总输入 ${fmt(x.totalInput)}（未缓存 ${fmt(x.uncached)}）`;
  });
  await deps.sendToQQ(key, `Token 熔断：${status.enabled ? '已开启' : '已关闭'}｜${status.day || '—'}\n`
    + (lines.length ? lines.join('\n') : '今天还没有会话计数。')
    + (status.enabled ? '\n解除：/tf off group:群号' : '\n开启：控制台 16 卡「会话级 Token 熔断」'));
}

// ── 对外工厂 ──────────────────────────────────────────────────────────────

/**
 * 创建管理命令执行器。
 *
 * deps 是 bridge 显式注入的副作用集合；命令实现只通过这些函数访问状态，
 * 不直接改 bridge 的闭包变量。新增命令若需要新的副作用，就在这里加一个依赖，
 * 让“命令需要什么”保持可见。
 */
export function createAdminCommands(deps) {
  const requiredFunctions = [
    'sendToQQ', 'log', 'notifyOwnerOfError', 'readJsonSafe', 'atomicWriteJson',
    'withTimeout', 'getGroupList', 'deleteMessage', 'getSentMessages',
    'resetSession', 'getSessionId', 'isAllowed', 'roleFor', 'hasConversationRole',
    'getRoleState', 'writeRoleState', 'writeConversationRole', 'sanitizeRoleName',
    'roleExists', 'getOwnerQQ', 'getJoinQueue', 'submitJoinDecision', 'appendActivity',
    'getTokenFuseStatus', 'resetTokenFuse'
  ];
  for (const name of requiredFunctions) {
    if (typeof deps?.[name] !== 'function') {
      throw new Error(`admin-commands: 缺少依赖 ${name}()`);
    }
  }
  if (!deps.cfg || typeof deps.cfg !== 'object') throw new Error('admin-commands: 缺少 cfg');
  if (typeof deps.configFile !== 'string' || !deps.configFile) throw new Error('admin-commands: 缺少 configFile');

  /**
   * 执行主管理命令块。
   * @returns {Promise<boolean>} true = 已消费这条消息，bridge 应直接 return
   */
  async function handleAdminCommand({ key, kind, id, plainContent, isOwner, roleState }) {
    const text = String(plainContent ?? '');
    if (!text.startsWith('/')) return false;
    // 只拦截「已知管理命令」：普通以 / 开头的句子（路径、DSH 自己的
    // /model 等斜杠命令）不是管理指令，交给 DSH 正常处理，不能统一回复
    // 「管理命令仅管理员可用」——那会把正常对话也打断。
    if (!isOwner) {
      if (!isAdminCommand(text)) return false;
      await deps.sendToQQ(key, '管理命令仅管理员可用。');
      return true;
    }
    const ctx = { deps, key, kind, id, text, roleState };
    for (const cmd of COMMANDS) {
      if (!cmd.match(text)) continue;
      await cmd.run(ctx);
      return true;
    }
    // 未知 / 命令交给 DSH（例如 /model）
    return false;
  }

  /**
   * 执行加好友/入群裁决指令。
   * @returns {Promise<boolean>} true = 已消费这条消息
   */
  async function handleJoinDecisionCommand(key, text) {
    const cmd = JOIN_COMMANDS.find((c) => c.match(String(text ?? '')));
    if (!cmd) return false;
    return cmd.run({ deps, key, text: String(text ?? '') });
  }

  return { handleAdminCommand, handleJoinDecisionCommand };
}
