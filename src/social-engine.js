// 社交消息引擎（R3-11）：入站消息/拍一拍/机器人发言写入社交状态与 journal。
import { looksLikeBridgeErrorEcho } from './error-notifier.js';
import { sanitizeForwardId } from './forward.js';

export function createSocialEngine({
  cfg,
  getSocialV2State,
  saveSocialV2State,
  appendContextMessage,
  STATE_DIR,
  seenForwardIds,
  redactKnownTokensOnly,
  log = () => {}
} = {}) {
  if (!cfg) throw new Error('createSocialEngine: cfg 不能为空');
  if (typeof getSocialV2State !== 'function') throw new Error('createSocialEngine: getSocialV2State 不能为空');
  if (!seenForwardIds || typeof seenForwardIds.get !== 'function') throw new Error('createSocialEngine: seenForwardIds 不能为空');

  function appendSocialV2Message(key, sender, textContent, plainContent, quoteTargetIsSelf, isOwner, messageId, media = [], userId = null, forwardIds = [], groupRole = '', atSelf = false, share = null) {
    // 入站源头拦截：桥接自己发的报错被 QQ 回显时，直接丢弃、不记录、不唤醒。
    // 判据见 error-notifier.js 的 looksLikeBridgeErrorEcho（有专门的回归测试，别在这里另写正则）。
    const echoText = String(plainContent ?? textContent ?? '');
    if (looksLikeBridgeErrorEcho(echoText)) {
      log(`[清理] 丢弃桥接自身报错的回显消息 (${key})：${echoText.slice(0, 60)}`);
      return;
    }
    const st = getSocialV2State(key);
    const recentLimit = Number(cfg.socialV2?.context?.recentLimit) || 100;
    const unreadLimit = Number(cfg.socialV2?.context?.unreadLimit) || 30;
    const safeMedia = Array.isArray(media) ? media.map((m) => ({
      kind: m?.kind === 'face' ? 'face' : 'image',
      file: m?.file ? String(m.file) : undefined,
      url: m?.url ? String(m.url) : undefined,
      faceId: m?.faceId ? String(m.faceId) : undefined
    })).filter((m) => m.kind === 'face' ? !!m.faceId : !!(m.file || m.url)) : [];
    const safeForwardIds = (Array.isArray(forwardIds) ? forwardIds : []).map(sanitizeForwardId).filter(Boolean);
    if (safeForwardIds.length) {
      let set = seenForwardIds.get(key);
      if (!set) {
        set = new Set();
        seenForwardIds.set(key, set);
      }
      for (const fid of safeForwardIds) set.add(fid);
      // 有界：最多保留 1000 个最近见过的 forward id
      if (set.size > 1000) {
        for (const old of set) {
          set.delete(old);
          if (set.size <= 1000) break;
        }
      }
    }
    const shareUrl = share?.url ? String(share.url).slice(0, 1200) : '';
    // 卡片链接在文本末尾，200 字硬切会把 xsec_token 切掉（实测小红书卡片只剩半截）。
    const textLimit = shareUrl ? 1200 : 200;
    const msg = {
      seq: (st.lastUnreadSeq || 0) + 1,
      messageId: messageId != null ? String(messageId) : null,
      sender,
      userId: userId != null ? String(userId) : null,
      text: String(textContent).slice(0, textLimit),
      plain: String(plainContent ?? textContent).slice(0, textLimit),
      tail: String(plainContent ?? textContent).slice(-textLimit),
      quoteTargetIsSelf: !!quoteTargetIsSelf,
      // 分享卡片：完整链接/封面/标题单独存一份，模型工具与唤醒提示都能直接拿到。
      shareUrl,
      shareCover: share?.cover ? String(share.cover).slice(0, 1200) : '',
      shareTitle: share?.title ? String(share.title).slice(0, 200) : '',
      sharePlatform: share?.platform ? String(share.platform).slice(0, 40) : '',
      // 入站时从 OneBot 的 at 段直接判定的"@ 了机器人"。比按昵称/群名片猜可靠：
      // 别名表可能缺当前群名片（见 selfCardCache 的说明），而这个字段不会漏。
      atSelf: !!atSelf,
      isOwner: !!isOwner,
      ownerLabel: isOwner ? `管理员（ownerQQ ${cfg.ownerQQ ?? ''}）` : '',
      // 群内身份：owner=群主 / admin=群管理员 / member=普通成员 / ''=私聊或未知。
      // 三个概念必须分清（2026-10-16 用户要求）：
      //   ① isOwner（后台管理员=config.ownerQQ）—— 控制台/管理命令/写操作的权限
      //   ② groupRole='owner'（群主）—— 群里的身份，与①无关（群主未必是后台管理员）
      //   ③ groupRole='admin'（群管理员）—— 群里的身份，与①②都无关
      groupRole: groupRole || '',
      isGroupOwner: groupRole === 'owner',
      isGroupAdmin: groupRole === 'admin',
      isSelf: false,
      media: safeMedia,
      hasMedia: safeMedia.length > 0,
      forwardIds: safeForwardIds,
      hasForward: safeForwardIds.length > 0,
      time: Date.now()
    };
    st.lastUnreadSeq = msg.seq;
    // Phase 2：完整消息日志（recentMessages 只有 100 条，突发时会丢中间段）。
    try { appendContextMessage(STATE_DIR, key, msg); } catch { /* 记忆写盘失败不影响收发 */ }
    st.lastIncomingAt = Date.now();
    // 记下「最近一条群友消息是谁发的」——管理员专属工具（如删表情）据此判定
    // 请求者身份。为什么需要：工具调用本身不带"谁在要求"，而 DSH 的每次 prompt
    // 都由某条入站消息触发，所以这条就是本次请求的发起人。
    // 只记非自己的消息（isSelf 的不会走到这里）且带 userId 的。
    if (userId != null && String(userId).trim()) {
      st.lastRequesterId = String(userId).trim();
      // 连群角色一起记：某些能力以后可能要按"群主/群管理员"放行（当前删表情只认后台管理员）。
      st.lastRequesterRole = groupRole || '';
      // 额外记「管理员最后一次说话的时间」。
      //
      // 为什么需要（2026-10-22 用户反馈「删不掉表情包」）：`lastRequesterId` 是
      // **最后一条**入站消息的发送者，而一次 prompt 可能由多条未读触发。
      // 实测时间线：
      //   13:55:48 管理员说「把这个表情包删了」
      //   13:56:06 群友发了个拍一拍 → lastRequesterId 被覆盖成群友
      //   13:56:35 模型这才调用删除工具 → 判成"非管理员"直接拒绝
      // 管理员的合法请求被后续闲聊冲掉了，越热闹的群越容易出这问题。
      // 所以另外记一个时间戳，让 isOwnerTurn 能在时间窗内认出"刚才管理员说过话"。
      const ownerQq = String(cfg.ownerQQ ?? '').trim();
      if (ownerQq && String(userId).trim() === ownerQq) {
        st.ownerSpokeAt = Date.now();
      }
    }
    st.preSleepWaitSatisfiedAt = 0; // 有新消息进来，之前的“沉睡前已等待/已观察”作废
    st.preSleepWaitObservedAt = 0;
    st.preSleepWaitAccumMs = 0;
    st.recentMessages.push(msg);
    if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
    st.unread.push(msg);
    if (st.unread.length > unreadLimit) st.unread.splice(0, st.unread.length - unreadLimit);
    const lowerPlain = String(plainContent ?? textContent ?? '');
    for (const t of st.activeTopics || []) {
      if (!t || typeof t !== 'object') continue;
      const topicHit = String(t.text || '').length > 0 && lowerPlain.includes(String(t.text || '').slice(0, 10));
      const participantHit = Array.isArray(t.participants) && t.participants.some((p) => p && lowerPlain.includes(String(p)));
      if (topicHit || participantHit) t.lastMentionAt = Date.now();
    }
    saveSocialV2State();
  }

  // 二代拍一拍事件写入最近/未读消息流，让 AI 能看到“谁拍了拍谁/拍了拍我”。
  function appendSocialV2Poke(key, { sender, userId, targetId, targetIsSelf, isOwner = false, groupId = null, action = '', suffix = '' }) {
    const st = getSocialV2State(key);
    const recentLimit = Number(cfg.socialV2?.context?.recentLimit) || 100;
    const unreadLimit = Number(cfg.socialV2?.context?.unreadLimit) || 30;
    const actor = String(sender || userId || '未知');
    const target = targetIsSelf ? '你' : (String(targetId || '未知'));
    const actionText = action ? String(action) : '拍了拍';
    const suffixText = suffix ? ` ${String(suffix)}` : '';
    const text = `[拍一拍] ${actor} ${actionText} ${target}${suffixText}`.slice(0, 200);
    const msg = {
      seq: (st.lastUnreadSeq || 0) + 1,
      messageId: null,
      sender: actor,
      userId: userId != null ? String(userId) : null,
      text,
      plain: text,
      tail: text,
      kind: 'poke',
      quoteTargetIsSelf: !!targetIsSelf,
      isOwner: !!isOwner,
      ownerLabel: isOwner ? `管理员（ownerQQ ${cfg.ownerQQ ?? ''}）` : '',
      isSelf: false,
      media: [],
      hasMedia: false,
      forwardIds: [],
      hasForward: false,
      poke: { targetId: targetId != null ? String(targetId) : null, targetIsSelf: !!targetIsSelf, groupId: groupId != null ? String(groupId) : null },
      time: Date.now()
    };
    st.lastUnreadSeq = msg.seq;
    // Phase 2：完整消息日志（recentMessages 只有 100 条，突发时会丢中间段）。
    try { appendContextMessage(STATE_DIR, key, msg); } catch { /* 记忆写盘失败不影响收发 */ }
    st.lastIncomingAt = Date.now();
    st.preSleepWaitSatisfiedAt = 0;
    st.preSleepWaitObservedAt = 0;
    st.preSleepWaitAccumMs = 0;
    st.recentMessages.push(msg);
    if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
    st.unread.push(msg);
    if (st.unread.length > unreadLimit) st.unread.splice(0, st.unread.length - unreadLimit);
    saveSocialV2State();
    return msg;
  }

  function recordSentMessagesV2(key, messages) {
    const st = getSocialV2State(key);
    const now = Date.now();
    const recentLimit = Number(cfg.socialV2?.context?.recentLimit) || 100;
    const list = Array.isArray(messages) ? messages : [];
    for (let i = 0; i < list.length; i++) {
      const raw = list[i];
      const isVoice = !!(raw && typeof raw === 'object' && raw.isVoice === true);
      const bodyText = raw && typeof raw === 'object' ? String(raw.text ?? '') : String(raw ?? '');
      const safeText = redactKnownTokensOnly(bodyText).slice(0, 200);
      // 语音必须留下可识别标记：桥接按概率把文字换成语音时，模型并没有主动
      // 调用 qq_send_voice；如果 recentMessages 里仍记成原文，它下一轮就不知道
      // 自己发的是语音（实测 2026-10-23 group:100002013）。
      const text = (isVoice ? '[语音] ' : '') + safeText;
      const entry = {
        sender: '我',
        text,
        plain: text,
        isVoice,
        quoteTargetIsSelf: false,
        isOwner: true,
        ownerLabel: '我',
        isSelf: true,
        time: now + i * 1000
      };
      st.recentMessages.push(entry);
      // 机器人自己的话也进 journal：episode 需要知道"我回了什么"。
      try { appendContextMessage(STATE_DIR, key, entry); } catch { /* 不影响发送 */ }
    }
    if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
    // AI 实际发言/参与了，说明这轮选择“继续回复”，沉睡前观察状态作废；下次想睡需重新走 5 分钟等待。
    st.preSleepWaitSatisfiedAt = 0;
    st.preSleepWaitObservedAt = 0;
    st.preSleepWaitAccumMs = 0;
    // 点单判定已消费：本轮已按（或未按）判定产出，留着会污染下一轮的新点单。
    st.pendingComply = null;
    saveSocialV2State();
  }

  return { appendSocialV2Message, appendSocialV2Poke, recordSentMessagesV2 };
}
