// 非白名单群的 @ 提示。
//
// 需求（2026-10-23 用户）：「当不在白名单的群里被 @ 时能够让它返回管理员 QQ 号
// 并且让群友去找他」；同日补充：「不要调用 DSH，以免消耗 token，回几个预设消息
// 中的一条即可」。
//
// 所以这里只做三件事：识别 @、挑一条预设话术、做群级限频；实际发送由桥接用
// OneBot HTTP 直接完成，**不经过 DSH / 模型**。

export const DEFAULT_WHITELIST_NOTICE_MESSAGES = [
  '这个群还没加进我的白名单，我暂时不能在这里聊天。想让我来的话，去找管理员（QQ {ownerQQ}）说一声，把群号 {groupId} 发给他就行。',
  '我还没被这个群的白名单收进来，现在只能潜水。要加的话找管理员 QQ {ownerQQ}，报一下群号 {groupId}。',
  '这个群不在我的白名单里，我回不了话。想让我常驻的话，联系管理员 QQ {ownerQQ}（群号 {groupId}）。'
];

/** 消息段里是否有 @机器人 的 at 段（不依赖群名片/别名表）。 */
export function isAtBotInMessage(message, selfId) {
  const self = String(selfId ?? '');
  if (!self || !Array.isArray(message)) return false;
  return message.some((seg) => seg?.type === 'at' && String(seg?.data?.qq ?? '') === self);
}

/**
 * 从预设话术里挑一条并替换占位符。
 * @returns {{text:string,index:number}|null} ownerQQ 为空时返回 null（没有可提供的联系方式）
 */
export function buildWhitelistNotice({
  ownerQQ,
  groupId,
  groupName = '',
  messages,
  random = Math.random,
  excludeIndex = -1
} = {}) {
  const owner = String(ownerQQ ?? '').trim();
  if (!owner) return null;
  let list = Array.isArray(messages)
    ? messages.filter((m) => typeof m === 'string' && m.trim())
    : [];
  if (!list.length) list = DEFAULT_WHITELIST_NOTICE_MESSAGES.slice();
  let idx = Math.floor(Number(random()) * list.length);
  if (!Number.isFinite(idx) || idx < 0 || idx >= list.length) idx = 0;
  // 避免同一群连续两次收到同一句（冷却结束后）
  if (list.length > 1 && idx === excludeIndex) idx = (idx + 1) % list.length;
  const text = String(list[idx])
    .replace(/\{ownerQQ\}/g, owner)
    .replace(/\{groupId\}/g, String(groupId ?? ''))
    .replace(/\{groupName\}/g, String(groupName || ''))
    .trim();
  return text ? { text, index: idx } : null;
}

/**
 * 群级限频：同一个群在 cooldownMs 内只提示一次。
 * 返回 cache 里的 entry（调用方可把实际选中的话术 index 写回去）；限频中返回 null。
 */
export function takeWhitelistNotice(cache, groupId, {
  cooldownMs = 10 * 60 * 1000,
  now = Date.now(),
  maxEntries = 500
} = {}) {
  if (!(cache instanceof Map)) return null;
  const key = String(groupId);
  const prev = cache.get(key);
  const wait = Math.max(0, Number(cooldownMs) || 0);
  if (prev && now - Number(prev.at) < wait) return null;
  const entry = {
    at: now,
    index: Number.isInteger(prev?.index) ? prev.index : -1,
    count: (Number(prev?.count) || 0) + 1
  };
  cache.set(key, entry);
  if (cache.size > maxEntries) {
    const overflow = cache.size - maxEntries;
    let i = 0;
    for (const k of cache.keys()) {
      if (i++ >= overflow) break;
      cache.delete(k);
    }
  }
  return entry;
}

// 非白名单提示的唯一发送适配器：不接入模型。
export function createWhitelistNotifier({ getSelfQQ, whitelistNoticeCache, onebotSend, log }) {
  async function maybeSendWhitelistNotice(groupId, event, cfg) {
    const nc = cfg.socialV2?.whitelistNotice ?? {};
    if (nc.enabled === false) return;
    const ownerQQ = String(cfg.ownerQQ ?? '').trim();
    if (!ownerQQ) return;
    // 管理员自己 @ 时不提示（没必要让管理员去找管理员）
    if (String(event?.user_id) === ownerQQ) return;
    // 被显式拉黑的群不发，避免把管理员 QQ 暴露给恶意群
    const denied = (Array.isArray(cfg.deny?.groups) ? cfg.deny.groups : []).map(String).includes(String(groupId));
    if (denied) return;
    if (!isAtBotInMessage(event?.message, event?.self_id || getSelfQQ())) return;
    const cooldownMs = Math.max(0, Number(nc.cooldownMs) || 10 * 60 * 1000);
    const slot = takeWhitelistNotice(whitelistNoticeCache, groupId, { cooldownMs });
    if (!slot) return;
    const built = buildWhitelistNotice({
      ownerQQ,
      groupId,
      groupName: event?.group_name || '',
      messages: nc.messages,
      excludeIndex: slot.index
    });
    if (!built) return;
    slot.index = built.index;
    try {
      await onebotSend('group', groupId, built.text);
      log(`[白名单提示] 已回复非白名单群 ${groupId} 的 @（预设 ${built.index + 1}，本群第 ${slot.count} 次）`);
    } catch (error) {
      log(`[白名单提示] 发送失败 ${groupId}：${error?.message ?? error}`);
    }
  }

  return maybeSendWhitelistNotice;
}
