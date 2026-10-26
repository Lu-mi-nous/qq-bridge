// 加好友 / 入群邀请的人工裁决服务（R3-7）。
//
// 负责队列、通知、自动同意、已自动同意的竞态识别与提交裁决；
// 事件订阅仍由 bridge 接线。
import { createJoinQueue, describeJoinRequest } from './join-request.js';

export const DEFAULT_JOIN_TTL_MS = 5 * 60 * 1000;

export function createJoinRequestService({
  cfg,
  file,
  ttlMs = DEFAULT_JOIN_TTL_MS,
  getSelfQQ = () => '',
  setFriendAddRequest,
  setGroupAddRequest,
  getGroupMemberInfo,
  getStrangerInfo,
  getGroupInfo,
  sendToQQ,
  appendActivity = () => {},
  withTimeout = (p) => p,
  log = () => {},
  now = Date.now
} = {}) {
  if (!file) throw new Error('createJoinRequestService: file 不能为空');
  const queue = createJoinQueue({ file, ttlMs: Math.max(30 * 1000, Number(ttlMs) || DEFAULT_JOIN_TTL_MS), now });

  async function isBotInGroup(groupId) {
    const selfQQ = String(getSelfQQ() || '');
    if (!groupId || !selfQQ) return false;
    try {
      const info = await withTimeout(getGroupMemberInfo(Number(groupId), Number(selfQQ)), 5000, '查自己的群成员身份');
      return !!info;
    } catch {
      return false;
    }
  }

  async function submitDecision(item, approve, reason = '') {
    const isInvite = item.requestType !== 'friend' && !!item.groupId
      && (item.subType === 'invite' || !item.subType);
    if (isInvite && approve === true && await isBotInGroup(item.groupId)) {
      log(`[加入请求] #${item.n} 机器人已在群 ${item.groupId}，邀请已被处理，无需再同意`);
      return { ok: true, alreadyJoined: true };
    }
    try {
      if (item.requestType === 'friend') {
        await setFriendAddRequest(String(item.flag), approve === true);
      } else {
        await setGroupAddRequest(String(item.flag), {
          subType: item.subType || 'invite',
          type: item.subType === 'add' ? 'add' : 'invite',
          approve: approve === true,
          ...(approve ? {} : { reason: reason || '暂不加入' })
        });
      }
      log(`[加入请求] ${approve ? '同意' : '拒绝'} #${item.n}：${item.requestType === 'friend' ? '好友' : '群'} ${item.userId ?? ''}${item.groupId ? ` → ${item.groupId}` : ''}`);
      return { ok: true };
    } catch (error) {
      const msg = error?.message ?? String(error);
      if (isInvite && await isBotInGroup(item.groupId)) {
        log(`[加入请求] #${item.n} 提交时请求已失效，但机器人已在群 ${item.groupId}`);
        return { ok: true, alreadyJoined: true };
      }
      const expired = /not found|不存在|已失效|expired/i.test(msg);
      log(`[加入请求] 提交裁决失败 #${item.n}：${msg}`);
      return { ok: false, error: msg, expired };
    }
  }

  async function notify(n, item) {
    const owner = String(cfg.ownerQQ ?? '').trim();
    if (!owner) {
      log('[加入请求] 未配置 ownerQQ，无法通知管理员；将按超时拒绝处理');
      return false;
    }
    const mins = Math.round((queue.ttlMs || DEFAULT_JOIN_TTL_MS) / 60000);
    const text = `【新的${item.requestType === 'friend' ? '好友' : '入群'}请求 #${n}】\n`
      + `${describeJoinRequest(item)}\n\n`
      + `回复以下任一指令处理（${mins} 分钟内有效）：\n`
      + `/yes ${n}　同意\n`
      + `/no ${n}　拒绝\n`
      + `/pending　看还有哪些待处理\n`
      + `⚠️ 超时未处理会自动拒绝。`;
    try {
      await sendToQQ(`private:${owner}`, text);
      return true;
    } catch (error) {
      log(`[加入请求] 通知管理员失败：${error?.message ?? error}`);
      return false;
    }
  }

  async function handle(event) {
    const jr = cfg.socialV2?.joinRequest ?? {};
    if (jr.enabled === false) {
      const tmp = {
        flag: event.flag, requestType: event.request_type,
        subType: event.sub_type, userId: event.user_id, groupId: event.group_id
      };
      await submitDecision({ ...tmp, n: 0 }, false, '未开启自动处理');
      return;
    }
    const item = {
      flag: String(event.flag ?? ''),
      requestType: event.request_type === 'friend' ? 'friend' : 'group',
      subType: String(event.sub_type ?? ''),
      userId: Number(event.user_id) || 0,
      groupId: Number(event.group_id) || 0,
      comment: String(event.comment ?? '').slice(0, 200),
      nickname: '',
      groupName: ''
    };
    if (!item.flag) {
      log(`[加入请求] 事件缺 flag，无法裁决：${JSON.stringify(event).slice(0, 200)}`);
      return;
    }
    try {
      if (item.requestType === 'friend' && item.userId) {
        const info = await withTimeout(getStrangerInfo?.(item.userId) ?? null, 5000, '查陌生人信息').catch(() => null);
        if (info?.nickname) item.nickname = String(info.nickname);
      } else if (item.groupId) {
        const info = await withTimeout(getGroupInfo?.(item.groupId) ?? null, 5000, '查群信息').catch(() => null);
        item.groupName = String(info?.group_name ?? info?.groupName ?? '');
      }
    } catch {}
    if (item.requestType === 'group' && item.groupId
        && (item.subType === 'invite' || !item.subType)
        && await isBotInGroup(item.groupId)) {
      log(`[加入请求] 忽略邀请 #${item.groupId}：机器人已在群里（QQ 已自动同意）`);
      const owner = String(cfg.ownerQQ ?? '').trim();
      if (owner) {
        sendToQQ(`private:${owner}`,
          `【入群邀请已自动同意】\n${describeJoinRequest(item)}\n机器人已经在群里，这条邀请不需要再裁决。`).catch(() => {});
      }
      appendActivity(`[加入请求] 忽略已自动同意的邀请 ${item.userId}→${item.groupId}`);
      return;
    }
    if (jr.autoApprove === true) {
      const res = await submitDecision({ ...item, n: 0 }, true);
      log(`[加入请求] 自动同意（autoApprove=true）：${item.requestType} ${item.userId}${item.groupId ? ` → ${item.groupId}` : ''}${res.ok ? '' : '（提交失败）'}`);
      const owner = String(cfg.ownerQQ ?? '').trim();
      if (owner) {
        sendToQQ(`private:${owner}`,
          `【已自动同意】${item.requestType === 'friend' ? '好友请求' : '入群邀请'}\n${describeJoinRequest(item)}`).catch(() => {});
      }
      return;
    }
    const { n, item: stored } = queue.push(item);
    const notified = await notify(n, stored);
    if (!notified) {
      const taken = queue.take(n);
      if (taken.ok) await submitDecision(taken.item, false, '无法联系管理员');
      log('[加入请求] 无法通知管理员，已自动拒绝');
      return;
    }
    appendActivity(`[加入请求] #${n} ${item.requestType === 'friend' ? '好友' : '入群'} ${item.userId}${item.groupId ? `→${item.groupId}` : ''}，等管理员裁决`);
  }

  function handleGroupIncrease(event) {
    if (event?.user_id == null || event?.self_id == null) return;
    if (String(event.user_id) !== String(event.self_id)) return;
    const gid = Number(event.group_id) || 0;
    if (!gid) return;
    const removed = queue.takeWhere((it) => it.requestType === 'group'
      && Number(it.groupId) === gid
      && (it.subType === 'invite' || !it.subType));
    if (!removed.length) return;
    log(`[加入请求] 机器人已加入 ${gid}，作废待决邀请 ${removed.map((it) => `#${it.n}`).join('、')}`);
    const owner = String(cfg.ownerQQ ?? '').trim();
    if (owner) {
      sendToQQ(`private:${owner}`,
        `${removed.map((it) => `#${it.n}`).join('、')} 的入群邀请已由 QQ 自动同意（机器人已在群里），无需再裁决。`).catch(() => {});
    }
  }

  return {
    queue,
    isBotInGroup,
    submitDecision,
    notify,
    handle,
    handleGroupIncrease,
    takeExpiredAtStartup: () => queue.takeExpiredAtStartup(),
    pruneExpired: () => queue.pruneExpired(),
    takeWhere: (fn) => queue.takeWhere(fn)
  };
}
