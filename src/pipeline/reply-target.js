// 引用/回复目标解析（R3-13）：messageId/seq/符号引用 → 引用信息与真实 messageId。
export function createReplyTargetService({
  bot,
  segmentsToText,
  resolveGroupMemberName,
  extractForwardIds,
  seenForwardIds,
  keyForKindId,
  loadContextMessages,
  STATE_DIR,
  log = () => {}
} = {}) {
  if (!bot) throw new Error('createReplyTargetService: bot 不能为空');
  if (typeof segmentsToText !== 'function') throw new Error('createReplyTargetService: segmentsToText 不能为空');
  if (!seenForwardIds || typeof seenForwardIds.get !== 'function') throw new Error('createReplyTargetService: seenForwardIds 不能为空');

  // QQ 引用/回复解析缓存：messageId -> { sender, text, ts }，避免每条引用都调一次 OneBot API。
  const replyInfoCache = new Map(); // `kind:convId:messageId` -> { info, ts }
  const REPLY_INFO_TTL_MS = 10 * 60 * 1000;
  const REPLY_NEGATIVE_TTL_MS = 5 * 1000; // 失败/归属缺失只短缓存，避免一次瞬时抖动导致长时间解析失败
  function pruneReplyInfoCache() {
    if (replyInfoCache.size <= 1000) return;
    const now = Date.now();
    for (const [k, v] of replyInfoCache) {
      if (now - v.ts > REPLY_INFO_TTL_MS) replyInfoCache.delete(k);
    }
    if (replyInfoCache.size > 1000) {
      const oldestKey = replyInfoCache.keys().next().value;
      if (oldestKey !== undefined) replyInfoCache.delete(oldestKey);
    }
  }
  async function resolveReplyInfo(kind, convId, messageId, selfId = null) {
    pruneReplyInfoCache();
    const cacheKey = `${kind}:${String(convId)}:${String(messageId)}`;
    const hit = replyInfoCache.get(cacheKey);
    if (hit && Date.now() - hit.ts < (hit.info ? REPLY_INFO_TTL_MS : REPLY_NEGATIVE_TTL_MS)) return hit.info;
    try {
      const numericId = Number(messageId);
      if (!Number.isSafeInteger(numericId)) {
        log(`引用消息 id 超出安全整数范围，拒绝解析: ${messageId}`);
        replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
        return null;
      }
      const raw = await bot.getMessage(numericId);
      if (!raw) {
        replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
        return null;
      }
      // 消息归属校验：防止跨会话读取其他群/私聊消息。
      // 若网关返回的 raw 对象连归属字段都缺失，则视为无法确认归属，拒绝返回内容。
      if (kind === 'group') {
        const rawGroup = raw.group_id ?? raw.groupId;
        if (rawGroup == null) {
          replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
          return null;
        }
        if (String(rawGroup) !== String(convId)) {
          replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
          return null;
        }
      } else {
        const rawUser = raw.user_id ?? raw.userId ?? raw.sender?.user_id;
        const rawGroup = raw.group_id ?? raw.groupId;
        // 私聊消息必须同时满足：没有群归属，且发送者匹配。防止用群消息 id 跨会话读取。
        if (rawGroup != null) {
          replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
          return null;
        }
        if (rawUser == null) {
          replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
          return null;
        }
        if (String(rawUser) !== String(convId) && !(selfId != null && String(rawUser) === String(selfId))) {
          replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
          return null;
        }
      }
      const sender = raw.sender?.card || raw.sender?.nickname || String(raw.sender?.user_id ?? raw.user_id ?? '未知');
      // 被引用消息里的**图片/表情段**必须一并统计出来：否则「回复某张图并评论」
      // 这种最常见的用法里，模型只看到 `[引用 某人：[图片]]` —— 这是 resolveReplyInfo
      // 原先的 bug：它只取 sender+text，把图片段丢了，于是模型完全看不到那张图。
      // 这里只统计数量与类型（不下载），具体图片由模型按 messageId 调
      // qq_get_message_images 取（见下面 segmentsToText 里注入的引用提示）。
      const quotedMedia = [];
      for (const seg of (Array.isArray(raw.message) ? raw.message : [])) {
        if (!seg || typeof seg !== 'object') continue;
        const t = seg.type;
        if (t === 'image') {
          const d = seg.data ?? {};
          const file = d.file ? String(d.file) : '';
          const url = d.url ? String(d.url) : '';
          if (file || url) quotedMedia.push({ kind: 'image', ...(file ? { file } : {}), ...(url ? { url } : {}) });
        } else if (t === 'face') {
          const fid = seg.data?.id;
          if (fid != null) quotedMedia.push({ kind: 'face', faceId: String(fid) });
        }
      }
      const text = await segmentsToText(raw.message ?? [], {
        resolveAtName: kind === 'group' ? (qq) => resolveGroupMemberName(convId, qq) : null,
        includeReply: false
      });
      const senderUserId = raw.sender?.user_id ?? raw.user_id ?? null;
      // 被引用消息里的**合并转发**：必须把 forward id 提取出来并登记为可见。
      //
      // 事故（2026-10-22）：群友引用了一条「群聊的聊天记录」并问「@大肥鱼装AI 这个是什么」，
      // 机器人答「那条转发鱼打不开，id对不上」。查下来两处都在丢信息：
      //   ① 这里只处理 image/face 段，forward 段被忽略，模型连 id 都拿不到；
      //   ② 即便模型从文本里读到 id，qq_get_forward_msg 还有道白名单
      //      （seenInRecent / seenInUnread / seenForwardIds），而**引用里的转发从来没被登记**，
      //      于是必然 404「不在当前会话可见范围内」。
      // 修法：解析时提取 id、写进 info.forwardIds，并立刻登记到 seenForwardIds。
      // 安全性不变：这个 id 确实来自本会话收到的消息段，属于"本会话可见"。
      const quotedForwardIds = extractForwardIds(Array.isArray(raw.message) ? raw.message : []);
      if (quotedForwardIds.length) {
        // 登记为"本会话已见过"，这样 qq_get_forward_msg 不会被白名单挡掉。
        let set = seenForwardIds.get(keyForKindId(kind, convId));
        if (!set) {
          set = new Set();
          seenForwardIds.set(keyForKindId(kind, convId), set);
        }
        for (const fid of quotedForwardIds) set.add(fid);
        log(`[引用] ${kind}:${convId} 被引用的消息含转发 id=${quotedForwardIds.join(',')}，已登记可见`);
      }
      const info = {
        sender: String(sender ?? ''),
        text: String(text ?? '').slice(0, 200),
        userId: senderUserId != null ? String(senderUserId) : null,
        // 消息 id 与图片信息：让 caller 能告诉模型「被引用的那条消息里有图，去调工具看」
        messageId: String(messageId),
        media: quotedMedia,
        mediaCount: quotedMedia.length,
        // 被引用消息里的转发 id：让模型知道可以直接 qq_get_forward_msg 读
        forwardIds: quotedForwardIds
      };
      replyInfoCache.set(cacheKey, { info, ts: Date.now() });
      return info;
    } catch (error) {
      log('解析引用消息失败:', error?.message ?? error);
      replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
      return null;
    }
  }

  // 引用目标的三种合法写法：真实 messageId（非零整数）、本会话 seq（整数）、符号引用（latest/上一条）。
  // 符号引用由 resolveReplyTargetV2 解析成「最近一条别人的消息」，无需模型自己算编号。
  function isSymbolicReplyRef(ref) {
    return /^(latest|last|最新|最新一条|上一条|上一条消息|最后一条)$/i.test(String(ref ?? '').trim());
  }

  // 发送引用时解析目标：支持真实 QQ message_id，也支持 recentMessages 里的 seq（自动映射到真实 messageId）。
  async function resolveReplyTargetV2(st, kind, convId, ref) {
    const refStr = String(ref ?? '').trim();
    if (!refStr) return null;
    // 符号引用：模型可以传 latest/last/上一条 之类，由桥接解析成「最近一条别人的消息」。
    // 为什么需要：实测（2026-10-07）唤醒提示里没带 seq 时（probability 触发那轮），
    // 模型会拿它之前见过的 seq 加一 去猜（等消息返回里见过 seq=15360 → 填 15361）。
    // 而 seq 是连续编号，猜错也照样解析到另一条**真实存在**的消息 —— 不报错、静默引用错，
    // 只有群友看出来。给一个不需要数字的引用方式，比继续加强提示词可靠。
    if (isSymbolicReplyRef(refStr)) {
      const target = [...(Array.isArray(st?.recentMessages) ? st.recentMessages : [])]
        .reverse()
        .find((m) => m && !m.isSelf && m.messageId != null);
      if (!target) return null;
      const realId = String(target.messageId);
      log(`[引用] ${kind}:${convId} 符号引用「${refStr}」→ seq=${target.seq} messageId=${realId} 作者=${String(target.sender || '?')}`);
      const realInfo = await resolveReplyInfo(kind, convId, realId);
      return {
        info: realInfo || {
          sender: String(target.sender || ''),
          text: String(target.text || target.plain || '').slice(0, 200),
          userId: null,
          messageId: realId,
          seq: target.seq
        },
        messageId: realId
      };
    }
    let found = Array.isArray(st?.recentMessages) ? st.recentMessages.find((m) => m && String(m.seq) === refStr) : null;
    // 活跃群/长回合里，触发消息可能已经被 recentMessages 挤出；从完整 journal 兜底找回，
    // 否则模型引用旧 @ 时会退化成无引用发送（日志：解析引用消息失败: message not found）。
    if (!found && /^[1-9]\d*$/.test(refStr)) {
      try {
        const journalKey = `${kind}:${convId}`;
        const rows = loadContextMessages(STATE_DIR, journalKey, {
          afterSeq: Math.max(0, Number(refStr) - 1),
          limit: 1
        });
        found = rows.find((m) => m && String(m.seq) === refStr) || null;
        if (found) {
          log(`[引用] ${journalKey} 从完整日志找回 seq=${refStr} → messageId=${String(found.messageId || '')}`);
        }
      } catch { /* journal 不可读时退回原有行为 */ }
    }
    // 若 ref 命中本地 seq，且本地存有真实 messageId，优先按 seq 映射，避免与真实 id 冲突。
    if (found && found.messageId && String(found.messageId) !== refStr) {
      const realId = String(found.messageId);
      // 审计：模型按 seq 引用时把「它填的 seq → 实际引到谁」记进日志。
      // seq 在群消息里是连续编号，模型写错一位照样能解析到**另一条真实存在的消息**，
      // 桥接无法从 ref 本身判断对错，只能事后从日志核对（实测存在差 6 条仍静默引用成功的情况）。
      log(`[引用] ${kind}:${convId} 按 seq 引用：seq=${refStr} → messageId=${realId} 作者=${String(found.sender || '?')} 内容=${String(found.text || found.plain || '').slice(0, 40)}`);
      const realInfo = await resolveReplyInfo(kind, convId, realId);
      return {
        info: realInfo || {
          sender: String(found.sender || ''),
          text: String(found.text || found.plain || '').slice(0, 200),
          userId: null,
          messageId: realId,
          seq: found.seq
        },
        messageId: realId
      };
    }
    let info = await resolveReplyInfo(kind, convId, refStr);
    if (info) return { info, messageId: refStr };
    if (found && found.messageId) {
      const realId = String(found.messageId);
      const realInfo = await resolveReplyInfo(kind, convId, realId);
      return {
        info: realInfo || {
          sender: String(found.sender || ''),
          text: String(found.text || found.plain || '').slice(0, 200),
          userId: null,
          messageId: realId,
          seq: found.seq
        },
        messageId: realId
      };
    }
    return null;
  }

  return { resolveReplyInfo, resolveReplyTargetV2, isSymbolicReplyRef };
}
