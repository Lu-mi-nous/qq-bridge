// 消息管线 · 纯计算层：身份标记、发送者/群角色、媒体提示、入站提示拼装。
//
// 这些函数原来散在 bridge.js 的 handleIncoming 和多个 prompt 构造函数里。
// 它们不碰任何 Map/Set/网络，只吃显式参数、返回字符串/布尔值，所以适合先抽出来：
//   - 可以用普通 import 做行为测试，不必启动桥接；
//   - 以后调整人格注入/媒体提示时，改动面集中在一个文件。
//
// 状态重的部分（准入、挂起、时间线落库、reserved2 派发）仍留在 bridge.js。

/**
 * 身份标记：后台管理员 / 群主 / 群管理员。
 *
 * 三者必须分开：
 *   isOwner       = config.ownerQQ（唯一能执行管理命令/写操作）
 *   isGroupOwner  = sender.role === 'owner'
 *   isGroupAdmin  = sender.role === 'admin'
 * 群主/群管理员**不是**后台管理员，反之亦然。群主优先于群管理员（同一人不会两者兼具）。
 */
export function identityTagOf(m) {
  if (!m || typeof m !== 'object') return '';
  const tags = [];
  if (m.isOwner) tags.push('【管理员】');
  if (m.isGroupOwner) tags.push('【群主】');
  else if (m.isGroupAdmin) tags.push('【群管理员】');
  return tags.join('');
}

/**
 * 消息发送者的展示名。
 * 群聊优先群名片/昵称，私聊优先昵称/群名片，最后退回号码。
 * 私聊取不到名字时用「私聊」，避免模型把号码当成人名。
 */
export function senderDisplayName(event, kind) {
  if (kind === 'group') {
    return event?.sender?.card || event?.sender?.nickname || String(event?.user_id ?? '');
  }
  return event?.sender?.nickname || event?.sender?.card || '私聊';
}

/** 群内身份（owner/admin/member）；私聊一律空字符串。 */
export function groupRoleOf(event, kind) {
  return kind === 'group' ? String(event?.sender?.role ?? '').trim().toLowerCase() : '';
}

/** 消息发送者是不是后台管理员（ownerQQ）。 */
export function isOwnerSender(event, ownerQQ) {
  return String(event?.user_id ?? '') === String(ownerQQ ?? '');
}

/**
 * 当前这一轮请求是不是管理员发起的（用于「仅管理员可用」的写操作）。
 *
 * 两层判据：最近一条入站消息是管理员，或管理员在时间窗内说过话。
 * 后者是 2026-10-22 修「删不掉表情包」时加的：管理员说完话后别人插一句，
 * lastRequesterId 会被覆盖，只看最近一条会把管理员请求误判成普通群友。
 *
 * 纯函数版本；bridge 里保留同名薄包装，注入 cfg / getSocialV2State / Date.now。
 */
export function isOwnerTurn({ ownerQQ, state, windowMs = 5 * 60 * 1000, now = Date.now() } = {}) {
  const owner = String(ownerQQ ?? '').trim();
  if (!owner) return false;
  const requester = String(state?.lastRequesterId ?? '').trim();
  if (requester && requester === owner) return true;
  const win = Math.max(0, Number(windowMs ?? 5 * 60 * 1000));
  const spokeAt = Number(state?.ownerSpokeAt) || 0;
  return win > 0 && spokeAt > 0 && now - spokeAt <= win;
}

/**
 * 图片/表情提示：告诉模型这条消息里有几个媒体、怎么按需查看。
 *
 * reserved2 不自动内联图片，所以必须给出工具名、key、messageId；
 * 其他模式图片本就自动内联，只报事实，避免让模型多调一次工具。
 */
export function buildMediaHint({ mode, key, messageRef, mediaList } = {}) {
  if (!Array.isArray(mediaList) || mediaList.length === 0 || !messageRef) return '';
  if (mode === 'reserved2') {
    return `\n【图片/表情】本条消息包含 ${mediaList.length} 个图片/表情（消息ID=${messageRef}）。如需要查看/识别，请调用 mcp__snowluma__qq_get_message_images，参数 key="${key}", messageId="${messageRef}"。`;
  }
  return `\n【图片/表情】本条消息包含 ${mediaList.length} 个图片/表情（消息ID=${messageRef}）。`;
}

/**
 * 拼一条入站提示：人格卡 + 身份标记 + 发送者/正文 + 媒体提示。
 *
 * 群聊带「发送者：正文」，私聊不带发送者前缀（私聊对面就是当前人）；
 * 后台管理员/群主/群管理员标记对所有模式都生效。
 */
export function buildIncomingPrompt({
  roleHint = '',
  isOwner = false,
  groupRole = '',
  kind = 'group',
  sender = '',
  userId = '',
  textContent = '',
  mediaHint = ''
} = {}) {
  const prefix = roleHint ? `${roleHint}\n\n` : '';
  const identity = identityTagOf({
    isOwner,
    isGroupOwner: groupRole === 'owner',
    isGroupAdmin: groupRole === 'admin'
  });
  const body = kind === 'group'
    ? `${sender || userId}：${textContent}`
    : textContent;
  return prefix + identity + body + mediaHint;
}
