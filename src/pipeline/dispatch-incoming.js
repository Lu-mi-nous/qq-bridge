// 入站派发（R3-12）：reserved2 唤醒、社交仿真、DSH 投递。
export function createIncomingDispatcher(deps = {}) {
  const {
    getMode,
    isDshReady,
    socialV2,
    api,
    sendToQQ,
    notifyOwnerOfError,
    senderDisplayName,
    groupRoleOf,
    ensureSelfCardV2,
    appendSocialV2Message,
    extractForwardIds,
    isAimedAtSelfV2,
    isContentRequestV2,
    getSocialV2State,
    saveSocialV2State,
    feedSlangWindow,
    appendActivity,
    handleImageFeedback,
    detectSourceRequest,
    sourceHints,
    scheduleWakeV2,
    evaluateWakeTriggerV2,
    currentRoleHint,
    buildIncomingPrompt,
    mediaHintFor,
    isSocialEnabled,
    appendRecentMessage,
    socialState,
    appendSummary,
    triggerActiveDurationExit,
    scheduleSocialReply,
    isDirectAddress,
    enterActive,
    buildContextBlock,
    deliverPrompt,
    queued,
    QUEUE_MAX,
    queuedHintAt,
    QUEUE_HINT_COOLDOWN_MS,
    ensureSession,
    enqueueForRetry,
    withSlangContext,
    resolveMediaList,
    auditAndSend,
    mdToPlain,
    log,
    DIRECTION_HINT,
    SPACE_SPLIT_HINT,
    SILENT_MARKER
  } = deps;

  async function dispatchIncoming({ key, kind, id, event, cfg, textContent, plainContent,
    mediaList, shareCard, messageRef, quoteTargetIsSelf, isOwner }) {
    const currentMode = getMode();
    const dshReady = isDshReady();
    // 二代仿真模式（reserved2）：唤醒调度
    if (currentMode === 'reserved2') {
      // 私聊也取昵称（同 reserved 路径）：让模型能认出私聊里说话的是谁，
      // 而不是一律看到 "私聊"（那会让它认不出管理员）。
      const sender = senderDisplayName(event, kind);
      // 群内身份（owner=群主 / admin=群管理员 / member=普通成员）。
      // 实测 SnowLuma 的 sender 里带 role 字段（messages.db 实测三值分布：
      // member 23395 / admin 21937 / owner 9414），可靠可用。
      // 与「后台管理员」(config.ownerQQ) 是**两回事**：那个是控制台/管理命令的权限；
      // 这个是群里的身份，用于让模型知道"谁说话更有分量"。
      const groupRole = groupRoleOf(event, kind);
      // @ 机器人？直接看 OneBot 的 at 段，不依赖别名表（群名片可能还没查到/已改名）。
      const atSelfRaw = Array.isArray(event.message)
        && event.self_id != null
        && event.message.some((seg) => seg?.type === 'at' && String(seg?.data?.qq) === String(event.self_id));
      if (kind === 'group') void ensureSelfCardV2(key); // 顺带刷新群名片缓存（@ 别名用）
      appendSocialV2Message(key, sender, textContent, plainContent, quoteTargetIsSelf, isOwner, event.message_id ?? event.msg_id ?? null, mediaList, event.user_id ?? null, extractForwardIds(event.message ?? []), groupRole, atSelfRaw, shareCard);
      // 点单标记：在**入站时刻**判定（此时才拿得到 at 段），存到消息条目上，
      // 供唤醒时掷骰——名单之外的群友点单同样纳入。
      if (!isOwner) {
        try {
          const stOrder = getSocialV2State(key);
          const aimed = isAimedAtSelfV2(plainContent, event, quoteTargetIsSelf);
          if (isContentRequestV2(plainContent, aimed)) {
            const last = stOrder.recentMessages[stOrder.recentMessages.length - 1];
            if (last && !last.isSelf) {
              last.orderText = String(plainContent).slice(0, 120);
              last.orderAt = Date.now();
              saveSocialV2State();
            }
          }
        } catch (error) {
          log(`[reserved2] 点单标记失败 ${key}: ${error?.message ?? error}`);
        }
      }
      // 二代同样收集群聊黑话学习素材（AI 自主提交之外，桥接仍自动提取高频陌生词）
      if (kind === 'group') feedSlangWindow(key, sender, plainContent);
      if (socialV2.paused) {
        appendActivity(`${key} [reserved2] AI 已暂停，消息仅入库不唤醒：${textContent.slice(0, 80)}`);
        return;
      }
      // 差评换图：群友说「不好看/换一张」时，删掉刚发的那张（并禁止再拉回）后另发一张。
      // 放在唤醒之前，是为了**即时响应**——等模型回合结束再处理，群里那口气已经凉了。
      // 命中即 return：这条消息由本机制处理完，不必再交给模型（避免模型又为它发一张）。
      if (!isOwner) {
        try {
          const swapped = await handleImageFeedback(key, plainContent);
          if (swapped) {
            appendActivity(`${key} [reserved2] 差评换图已处理：${plainContent.slice(0, 40)}`);
            return;
          }
        } catch (error) {
          log(`[reserved2] 差评换图处理失败 ${key}: ${error?.message ?? error}`);
        }
      }
      // 「群主指定图站」识别：「pixiv上找几张X的图」这类话里，图站是自然语言，
      // 而**实测模型经常不填 sources 参数**（于是又去 safebooru 找）。桥接在这里
      // 记下指定，之后该会话取图默认用它；模型若显式传了 sources 仍以模型为准。
      try {
        const det = detectSourceRequest(plainContent);
        if (det.sources.length) {
          sourceHints.remember(key, det.sources, plainContent);
          log(`[图库] ${key} 识别到指定图源：${det.sources.join('/')}（命中「${det.matched.join('、')}」）`);
        }
      } catch (error) {
        log(`[图库] 图源识别失败 ${key}: ${error?.message ?? error}`);
      }
      const st = getSocialV2State(key);
      if (!st.bootstrapSent) {
        st.bootstrapSent = true;
        saveSocialV2State();
        scheduleWakeV2(key, 'bootstrap');
      } else {
        const reason = evaluateWakeTriggerV2(key, st, event, kind, textContent, plainContent, quoteTargetIsSelf);
        if (reason) {
          scheduleWakeV2(key, reason);
        }
      }
      appendActivity(`${key} [reserved2] 消息已入未读：${textContent.slice(0, 80)}`);
      return;
    }

    // 黑话学习素材：只从群聊普通消息进入滚动窗口（命令/角色控制语不学；只学当前消息自己的文字，不学引用原文）
    if (kind === 'group') {
      feedSlangWindow(key, event.sender?.card || event.sender?.nickname || String(event.user_id), plainContent);
    }

    // 角色扮演提示注入（仅注入给 agent，不影响群友之间的正常对话语义）
    const roleHint = currentRoleHint(key);
    // 非 reserved2 分支也需要群内身份；reserved2 在更早的块里已单独声明并返回。
    const groupRole = groupRoleOf(event, kind);
    const sender = senderDisplayName(event, kind);

    // 群聊里带发送者信息，私聊不用；角色提示注入到消息开头（agent 可见）；
    // 身份标记（供 agent 识别，但其权限仍受工具面硬限制）
    const promptText = buildIncomingPrompt({
      roleHint,
      isOwner,
      groupRole,
      kind,
      sender,
      userId: event.user_id,
      textContent,
      mediaHint: mediaHintFor(key, messageRef, mediaList)
    });

    appendActivity(`${key} ${isOwner ? '管理员' : '群友'} ${event.sender?.nickname || event.user_id}：${textContent.slice(0, 80)}`);

    // 仿真群友模式：reserved 走状态机（观望/活跃/试探/退场）
    if (isSocialEnabled()) {
      // 私聊原本一律记成 '私聊'，导致模型认不出私聊里说话的就是管理员本人
      // （2026-10-15 用户要求「管理员发消息时机器人应该能够认出」）。
      // 改成优先取昵称/群名片，取不到再退回 '私聊'。
      const sender = senderDisplayName(event, kind);
      // 群内身份（owner=群主 / admin=群管理员），与后台管理员(isOwner)分开算。
      const groupRole = groupRoleOf(event, kind);
      appendRecentMessage(key, sender, textContent, plainContent, quoteTargetIsSelf, isOwner, mediaList, messageRef, groupRole, shareCard); // AI 始终感知
      const st = socialState(key);

      // 退场中：收尾发言发出前不再接话，新消息进入摘要
      if (st.phase === 'exiting') {
        appendSummary(key, sender, textContent, plainContent, isOwner, mediaList, messageRef);
        log(`社交模式：${key} 退场中，新消息转入摘要`);
        return;
      }

      // 活跃超时：即使群里一直有人说话，到达随机上限后也主动收尾退场
      if (st.phase === 'active' && triggerActiveDurationExit(key, st, Date.now())) {
        appendSummary(key, sender, textContent, plainContent, isOwner, mediaList, messageRef);
        log(`社交模式：${key} 活跃超时退场中，新消息转入摘要`);
        return;
      }

      // 活跃 / 试探中：有新消息 → 保持活跃（或从试探回到活跃）
      if (st.phase === 'active' || st.phase === 'probing') {
        st.phase = 'active';
        st.lastActiveMessageAt = Date.now();
        st.probeDeadline = 0;
        // 私聊：发给你就是叫你，直接即时投递，不等轮询、不参与沉默
        if (kind === 'private') {
          const promptText = `${roleHint ? roleHint + '\n\n' : ''}${identityTagOf({ isOwner, isGroupOwner: groupRole === 'owner', isGroupAdmin: groupRole === 'admin' })}${textContent}${mediaHintFor(key, messageRef, mediaList)}`;
          scheduleSocialReply(
            key, promptText,
            Number(cfg.social?.activeReplyDelayMinMs ?? 2000),
            Number(cfg.social?.activeReplyDelayMaxMs ?? 8000),
            '私聊即时回应',
            false,
            mediaList
          );
          log(`社交模式：${key} 私聊活跃中收到消息，即时投递`);
          return;
        }
        log(`社交模式：${key} 活跃中收到消息，等待批量检测`);
        return;
      }

      // 启动阶段（观望）：触发条件 ① 明确对 AI 说（含引用机器人自己） ② 普通消息小概率
      // 指向性判断只基于当前消息自己的文字，不把引用原文算作“在叫 AI”
      const direct = isDirectAddress(plainContent, event, kind) || quoteTargetIsSelf;
      const randomTrigger = Math.random() < Number(cfg.social?.triggerProbability ?? 0.15);
      if (!direct && !randomTrigger) {
        appendSummary(key, sender, textContent, plainContent, isOwner, mediaList, messageRef);
        log(`社交模式：观望中未触发 ${key}（${sender}：${plainContent.slice(0, 40)}）`);
        return;
      }

      // 触发成功：进入活跃，贴最近上下文 + 当前消息 + 人格（仅此一次），让 AI 回复
      enterActive(key);
      const roleHint = currentRoleHint(key);
      const currentLine = (isOwner && kind === 'private') ? `【管理员】${sender}：${textContent}` : `${sender}：${textContent}`;
      const directionHint = textContent.includes('[引用') ? DIRECTION_HINT + '\n' : '';
      const replyInstruction = direct
        ? `请回复消息。\n${directionHint}${SPACE_SPLIT_HINT}`
        : `请根据情况决定是否回复。如果不需要回应、想潜水/不接话，请只输出 ${SILENT_MARKER}；否则正常回复。\n${directionHint}${SPACE_SPLIT_HINT}`;
      const promptText = `${roleHint ? roleHint + '\n\n' : ''}【群聊上下文】\n${buildContextBlock(key)}\n【当前消息】${currentLine}${mediaHintFor(key, messageRef, mediaList)}\n\n${replyInstruction}`;
      if (isOwner && kind === 'private') {
        log(`社交模式：管理员私聊触发，立即投递 ${key}`);
        await deliverPrompt(key, promptText, { media: mediaList });
      } else {
        scheduleSocialReply(
          key, promptText,
          Number(cfg.social?.activeReplyDelayMinMs ?? 2000),
          Number(cfg.social?.activeReplyDelayMaxMs ?? 8000),
          '触发进入活跃',
          false,
          mediaList
        );
      }
      return;
    }

    // DSH 重启容错：DSH 不可用时消息入队（不丢），恢复后自动补投
    if (!dshReady) {
      const items = queued.get(key) ?? [];
      if (items.length >= QUEUE_MAX) {
        items.shift();
        log(`队列满（${QUEUE_MAX}），丢弃最旧消息 (${key})`);
      }
      items.push({ promptText, media: mediaList });
      queued.set(key, items);
      const now = Date.now();
      if ((queuedHintAt.get(key) ?? 0) + QUEUE_HINT_COOLDOWN_MS < now) {
        queuedHintAt.set(key, now);
        // 群里不发「系统服务重启中」这类内部状态（用户要求报错/内部信息不进群）；
        // 只私聊管理员，群友侧表现为机器人暂时安静。
        notifyOwnerOfError(key, 'DSH 不可用，消息已入队', `队列中已有 ${items.length} 条待处理`, {
          说明: 'DSH 未就绪，消息会在恢复后自动处理，群内未提示'
        });
      }
      log(`DSH 不可用，消息入队 (${key})`);
      return;
    }

    let sessionId;
    try {
      sessionId = await ensureSession(key);
    } catch (error) {
      if (String(error?.message ?? error).includes('会话创建期间已重置')) {
        enqueueForRetry(key, promptText, { media: mediaList });
        return;
      }
      throw error;
    }
    let content = [{ type: 'text', text: withSlangContext(promptText) }];
    if (Array.isArray(mediaList) && mediaList.length > 0) {
      const imageParts = await resolveMediaList(mediaList);
      content = [{ type: 'text', text: withSlangContext(promptText) }, ...imageParts];
    }
    const accepted = await api.sessions.prompt({
      sessionId,
      mode: 'queue',
      content
    });
    if (!accepted.result.ok) {
      const errText = `${accepted.result.error.code}: ${accepted.result.error.message}`;
      notifyOwnerOfError(key, '消息未被 DSH 接受', errText);
      return;
    }
    if (accepted.result.value.command) {
      // 斜杠命令直接有结果，不走模型
      if (accepted.result.value.command.text) await auditAndSend(key, mdToPlain(accepted.result.value.command.text));
      return;
    }
    if (cfg.ackMessage && currentMode !== 'reserved2') await sendToQQ(key, cfg.ackMessage);
    log(`已投递 ${key}: ${promptText.slice(0, 80)}${promptText.length > 80 ? '…' : ''}`);
  }

  return dispatchIncoming;
}
