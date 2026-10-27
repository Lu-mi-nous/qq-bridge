// 入站前三阶段：拒绝或消费消息时显式返回；模式派发由 bridge 完成。
import { canBypassAdmission, rawTextOfMessage, isAdminCommand } from '../admin-commands.js';
import { segmentsToText } from './segments.js';
import { isOwnerSender } from './message-format.js';
import { reserved2MediaFetchHint, inlineMediaFactHint } from '../quoted-media.js';
import { extractShareCards } from '../share-card.js';

export function createIncomingStages(deps) {
  const {
    getMode, modeAllowed, maybeSendWhitelistNotice, refreshFriendList, log,
    resolveGroupMemberName, resolveReplyInfo, extractMediaFromSegments,
    transcribeIncomingVoice, messageMediaStore, MAX_MEDIA_STORE_PER_KEY,
    isQuoteTargetSelf, readRoleState, adminCommands, pending, handlePendingAnswer,
    appendActivity, sendToQQ
  } = deps;
  let lastFriendForceRefreshAt = 0;
  const FRIEND_FORCE_REFRESH_MS = 30 * 1000;
  async function admit({ key, kind, id, event, cfg }) {
    // 白名单命令的准入例外。
    //
    // 为什么必须加（否则功能自相矛盾）：管理员想「从这个新群把自己加进白名单」时，
    // 消息在准入闸门就被丢掉了，永远走不到命令块——那这条命令就只能对**已经在白名单里的群**
    // 生效，等于没法加新群。
    // 放行条件收得很窄：仅群聊、仅 ownerQQ、且文本确实以白名单命令开头；
    // 群友发同样的话照旧被丢弃（命令块里还有一次 isOwner 校验）。
    // closed-agent 模式不例外（该模式只认管理员私聊，开了口子等于破模式）。
    const ownerWhitelistCmd = canBypassAdmission({
      kind,
      mode: getMode(),
      ownerQQ: cfg.ownerQQ,
      userId: event.user_id,
      text: rawTextOfMessage(event.message)
    });
    if (!modeAllowed(key, kind, id, cfg, getMode()) && !ownerWhitelistCmd) {
      // 非白名单群的 @：预设话术直接回，不经过 DSH（用户 2026-10-23 要求不耗 token）。
      if (kind === 'group' && getMode() !== 'closed-agent') {
        await maybeSendWhitelistNotice(id, event, cfg);
      }
      // 私聊被拒时先强制刷一次好友列表再定论。
      //
      // 为什么需要（2026-10-13 实测）：好友列表有 5 分钟 TTL 缓存，而**刚加的好友**
      // 不在缓存里，于是被判成"非好友"直接忽略——对方看到的就是"私聊不回人"。
      // 实测用户新加好友 3344952470（昵称"牢"），发了两条消息全被丢弃，
      // 日志只有 `忽略未授权会话 private:3344952470`，而 SnowLuma 侧查同一个人是好友。
      //
      // 节流：force 刷新会真的去问 SnowLuma，不加限制的话非好友持续刷消息就等于
      // 拿桥接当放大器打 SnowLuma 接口。所以全局限流（同一窗口内只刷一次），
      // 且失败也不重试——宁可这一次仍按拒绝处理，也不能被打爆。
      const canRetry = kind === 'private'
        && cfg.allow?.privateMode === 'friends'
        && (Date.now() - lastFriendForceRefreshAt >= FRIEND_FORCE_REFRESH_MS);
      let retryOk = false;
      if (canRetry) {
        lastFriendForceRefreshAt = Date.now();
        retryOk = await refreshFriendList({ force: true })
          .then(() => modeAllowed(key, kind, id, cfg, getMode()))
          .catch(() => false);
      }
      if (retryOk) {
        log(`[私聊准入] ${key} 刷新好友列表后放行（新加的好友）`);
      } else {
        log(`忽略未授权会话 ${key}（当前模式 ${getMode()}，来自 ${event.user_id}）`);
        return false;
      }
    }
    return true;
  }

  async function parse({ key, kind, id, event, cfg }) {
    const resolveAtName = async (qq) => {
      // 只有群聊才需要把 @QQ号 解析成群名片/昵称；私聊没有群成员概念
      if (kind !== 'group') return null;
      return resolveGroupMemberName(event.group_id, qq);
    };
    const resolveReply = (messageId) => resolveReplyInfo(kind, id, messageId, event.self_id);
    // 被引用消息里含图片/表情时，给模型一句「怎么看到它」的说明。
    // reserved2 用按需取图工具（图片不自动内联）；其他模式图片本就自动内联，只报事实。
    const mediaFetchHint = getMode() === 'reserved2' ? reserved2MediaFetchHint(key) : inlineMediaFactHint();
    // textContent 带引用对象信息，供 DSH 判断“这句话在对谁说”；
    // plainContent 只保留当前消息自己的文字，用于命令/指向性判断，避免被引用原文干扰。
    let textContent = await segmentsToText(event.message ?? [], { resolveAtName, resolveReply, mediaFetchHint });
    let plainContent = await segmentsToText(event.message ?? [], { resolveAtName, includeReply: false });
    const mediaList = extractMediaFromSegments(event.message ?? []);
    // 分享卡片的完整链接（小红书/B站等）：消息文本会被截断，单独留一份给模型。
    const shareCard = extractShareCards(event.message ?? [])[0] || null;
    const messageRef = String(event.message_id ?? event.msg_id ?? event.message_seq ?? '');
    // 语音输入：先转写再进入唤醒提示/上下文；失败就保留 [语音] 占位。
    const voiceTranscript = await transcribeIncomingVoice(key, messageRef, event.message ?? []);
    if (voiceTranscript) {
      textContent = `${textContent}（语音转文字：${voiceTranscript}）`;
      plainContent = `${plainContent}（语音转文字：${voiceTranscript}）`;
    }
    const seqRef = event.message_seq != null ? String(event.message_seq) : '';
    const refsToStore = [...new Set([messageRef, seqRef].filter(Boolean))];
    if (refsToStore.length > 0 && mediaList.length > 0) {
      let mediaByRef = messageMediaStore.get(key);
      if (!mediaByRef) {
        mediaByRef = new Map();
        messageMediaStore.set(key, mediaByRef);
      }
      for (const ref of refsToStore) mediaByRef.set(ref, mediaList);
      // 防止无限增长：超过上限时删除最旧一条（Map 保持插入序）
      while (mediaByRef.size > MAX_MEDIA_STORE_PER_KEY) {
        const oldestKey = mediaByRef.keys().next().value;
        if (oldestKey === undefined) break;
        mediaByRef.delete(oldestKey);
      }
    }
    // 引用对象是机器人自己时，视为直接对 AI 说（即使当前文字没有 @/关键词）。
    // 因此必须先解析 quoteTargetIsSelf 再做空文本过滤，避免“只引用不附文”被漏掉。
    const quoteTargetIsSelf = await isQuoteTargetSelf(event.message ?? [], kind, id, event.self_id);
    if (!plainContent && !quoteTargetIsSelf) return;
    const isOwner = isOwnerSender(event, cfg.ownerQQ);

    return { textContent, plainContent, mediaList, shareCard, messageRef, quoteTargetIsSelf, isOwner };
  }

  async function divert({ key, kind, id, event, textContent, plainContent, isOwner }) {
    // 「不想回时的轻量参与」：给群友的消息贴个表情。
    // **贴什么由消息语气决定**（好笑→偷笑、称赞→强、负面→不贴），不是随机抽一个；
    // 概率也按语气给（好笑 35%、中性 3%、负面 0），见 emoji-react.js 的说明。
    // 贴表情已改为**由模型自主决定**（它才有完整上下文）：桥接只提供
    // /api/socialV2/react-message 端点与 qq_react_message 工具，不再在此自动贴。
    // 曾在此按语气分类 + 概率自动贴，用户指出那本质仍是随机行为、易引起误解。
    const roleState = readRoleState();

    // 管理命令的识别（管理员专用，由桥接直接执行、不经过模型）。
    // 判据取「已知管理命令」而非「以 / 开头」：DSH 自己的斜杠命令（/model 之类）
    // 要原样转发给 DSH，不能被这里抢走。
    const adminCmd = isAdminCommand(plainContent);

    // 加好友/入群邀请的裁决指令：必须在一切之前处理。
    // 为什么提前：它既不该进 DSH（模型不该"批准加好友"），也不该被
    // 挂起提问逻辑吞掉。只有管理员私聊会被消费，其余返回 false 继续走正常流程。
    if (await adminCommands.handleJoinDecisionCommand(key, plainContent)) return true;

    // 若该会话有挂起的提问/审批，先当作回答处理（用当前消息自己的文字，不含引用原文）。
    // 审批只有管理员消息会被消费；群友消息不能因为“审批挂起”而被吞掉，应继续走正常处理。
    //
    // 但**管理员的管理命令优先**（2026-10-13 修）：原先 pending 判定在前且条件含 isOwner，
    // 于是管理员发 /status 时若恰好有挂起提问，命令会被当成"回答"发给 DSH——命令不执行，
    // 回复却是"已回答"，管理员完全不知道命令被吞了。这类静默失败只在挂起期间出现，很难查。
    const p = pending.get(key);
    if (p && !(isOwner && adminCmd) && (p.kind === 'question' || isOwner)) {
      await handlePendingAnswer(p, plainContent, key, isOwner);
      return true;
    }

    // 静默模式：群友消息不投递给 agent（只记录）；管理员消息照常
    if (roleState.mode === 'silent' && !isOwner) {
      appendActivity(`${key}（静默模式）群友 ${event.user_id}：${textContent.slice(0, 80)}`);
      log(`静默模式，忽略群友消息 ${key}`);
      return true;
    }

    // 控制类话语：仅管理员（ownerQQ）可下达；群友触发直接拦截
    if (!isOwner && /进入角色扮演|退出角色扮演|切换角色|设置角色|改角色|换角色|关闭角色扮演|开启角色扮演/.test(plainContent)) {
      await sendToQQ(key, '角色切换仅管理员可在管理端操作，群内不支持。');
      return true;
    }

    // 管理命令：仅管理员（ownerQQ）可用，且由桥接直接执行（硬性，不经过模型）
    if (await adminCommands.handleAdminCommand({ key, kind, id, plainContent, isOwner, roleState })) return true;

    return false;
  }
  return { admit, parse, divert };
}
