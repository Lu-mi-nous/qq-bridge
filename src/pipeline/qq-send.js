// QQ 发送通道（第 4B 步：从 bridge.js 抽出）。
//
// 覆盖：系统提示/普通文本（sendToQQ）、真人式分条（sendBurstToQQ）、
// 二代统一发送（sendMessagesV2，含自动@/TTS）、收藏表情（sendStickerV2）、
// 语音发送（sendAsVoice）。状态与底层 API 由 bridge 注入。
// 所有发送都经由 sendQueue（每会话队列），跨会话不互相阻塞。
export function createQQSender(deps) {
  const {
    sendQueue,
    log,
    sleep,
    randInt,
    cfg,
    text,
    escapeCqText,
    redactKnownTokensOnly,
    splitForQQ,
    withTimeout,
    SEND_TIMEOUT_MS,
    bot,
    recordSentMessage,
    planAutoAtV2,
    getTtsPlugin,
    onebotSend,
    syncStickerLibrary,
    findSticker,
    getStickerEntries,
    setStickerEntries,
    validateFetchUrl,
    markStickerUsed,
    saveStickerStoreSafe,
    isFused
  } = deps;

  function sendToQQ(key, msg) {
    const safeMsg = redactKnownTokensOnly(msg);
    const [kind, id] = key.split(':');
    const parts = splitForQQ(safeMsg);
    return sendQueue.enqueue(key, async () => {
      const failed = [];
      for (const part of parts) {
        try {
          const sentData = kind === 'private'
            ? await withTimeout(bot.sendPrivateMessage(Number(id), text(escapeCqText(part))), SEND_TIMEOUT_MS, `QQ发送 ${kind}:${id}`)
            : await withTimeout(bot.sendGroupMessage(Number(id), text(escapeCqText(part))), SEND_TIMEOUT_MS, `QQ发送 ${kind}:${id}`);
          recordSentMessage(key, sentData, part);
        } catch (error) {
          failed.push(error);
          log(`QQ 发送失败 (${key}):`, error?.message ?? error);
        }
        await sleep(cfg.sendDelayMs);
      }
      if (failed.length > 0) {
        throw new Error(`QQ 发送失败 ${failed.length}/${parts.length} 条 (${key})：${failed[0]?.message ?? '未知错误'}`);
      }
    });
  }

  function sendBurstToQQ(key, messages, socialCfgOrMin, maybeMax) {
    if (isFused?.(key)) {
      log(`[Token熔断] 拦截分条发送 ${key}：会话已熔断`);
      throw new Error('会话已触发 Token 熔断，自动发送已停止；请先在控制台解除熔断');
    }
    const [kind, id] = key.split(':');
    let min, max, longProb = 0, longMin = 0, longMax = 0;
    if (typeof socialCfgOrMin === 'object' && socialCfgOrMin !== null) {
      const cfg = socialCfgOrMin;
      min = Math.max(0, Number(cfg.burstIntervalMinMs) || 1000);
      max = Math.max(min, Number(cfg.burstIntervalMaxMs) || min);
      longProb = Math.min(1, Math.max(0, Number(cfg.longGapProbability) || 0));
      longMin = Math.max(0, Number(cfg.longGapMinMs) || 8000);
      longMax = Math.max(longMin, Number(cfg.longGapMaxMs) || longMin);
    } else {
      min = Math.max(0, Number(socialCfgOrMin) || 0);
      max = Math.max(min, Number(maybeMax) || min);
    }

    return sendQueue.enqueue(key, async () => {
      const sent = [];
      for (let i = 0; i < messages.length; i++) {
        const msg = redactKnownTokensOnly(messages[i]);
        const isLast = i === messages.length - 1;
        try {
          if (kind === 'private') await withTimeout(bot.sendPrivateMessage(Number(id), text(escapeCqText(msg))), SEND_TIMEOUT_MS, `QQ发送 ${kind}:${id}`);
          else await withTimeout(bot.sendGroupMessage(Number(id), text(escapeCqText(msg))), SEND_TIMEOUT_MS, `QQ发送 ${kind}:${id}`);
          sent.push(msg);
        } catch (error) {
          log(`QQ 发送失败 (${key}):`, error?.message ?? error);
        }
        if (!isLast) {
          const useLong = longProb > 0 && Math.random() < longProb;
          const delay = useLong ? randInt(longMin, longMax) : randInt(min, max);
          await sleep(delay);
        }
      }
      return sent;
    });
  }

  function sendMessagesV2(key, messages, delays, replyToMessageId, atUserId = null, options = {}) {
    if (isFused?.(key) && options.manual !== true) {
      log(`[Token熔断] 拦截消息发送 ${key}：会话已熔断`);
      throw new Error('会话已触发 Token 熔断，自动发送已停止；请先在控制台解除熔断');
    }
    const [kind, id] = key.split(':');
    const sent = [];
    const failed = [];
    // 概率 @：只作用于第一条（与 reply/at 段一致，后续气泡不再挂 @）。
    const autoAt = (options.autoAt === false || replyToMessageId) ? null : planAutoAtV2(key, kind, messages, atUserId, options.quoted);
    // 概率语音：同样只作用于"单条文本回复"。
    // 注意它**不能与 @ 同时生效**：record 段不承载 at。
    // 也不能和 reply 同气泡（QQ 客户端实测语音不渲染）。所以带 replyToMessageId
    // 的回复仍然可以掷中语音，但语音单发；引用语义由端点内部保留。
    const ttsPlan = (autoAt || atUserId) ? null : (getTtsPlugin()?.plan?.(key, messages, options) ?? null);
    return sendQueue.enqueue(key, async () => {
      if (ttsPlan) {
        const r = await sendAsVoice(key, ttsPlan.text, ttsPlan);
        if (r.ok) {
          sent.push({ text: ttsPlan.text, isVoice: true });
        } else {
          // 回退：语音没发成，退回普通文字发送（下面这段与常规路径一致）
          try {
            await onebotSend(kind, id, ttsPlan.text, replyToMessageId, null);
            sent.push(ttsPlan.text);
          } catch (error) {
            log(`QQ 发送失败 (${key}):`, error?.message ?? error);
            failed.push(error);
          }
        }
      } else {
        for (let i = 0; i < messages.length; i++) {
          const msg = messages[i];
          const useReply = i === 0 ? replyToMessageId : null;
          // 模型自己传了 atUserId 时用它；否则用桥接掷出的 autoAt（仅第一条）。
          const useAt = i === 0 ? (atUserId ?? autoAt?.userId ?? null) : null;
          try {
            await onebotSend(kind, id, msg, useReply, useAt);
            sent.push(msg);
          } catch (error) {
            log(`QQ 发送失败 (${key}):`, error?.message ?? error);
            failed.push(error);
          }
          if (i < delays.length) await sleep(delays[i]);
        }
      }
      if (failed.length > 0) {
        const err = new Error(`QQ 发送失败 ${failed.length}/${messages.length} 条：${failed[0]?.message ?? '未知错误'}`);
        err.sent = sent.slice();
        throw err;
      }
      return sent;
    });
  }

  async function sendAsVoice(key, text, plan) {
    const plugin = getTtsPlugin();
    if (!plugin?.sendAsVoice) return { ok: false, reason: 'TTS 插件未启用' };
    return plugin.sendAsVoice(key, text, plan);
  }

  async function sendStickerV2(key, stickerRef, options = {}) {
    if (isFused?.(key) && options.manual !== true) {
      log(`[Token熔断] 拦截表情发送 ${key}：会话已熔断`);
      throw new Error('会话已触发 Token 熔断，自动发送已停止；请先在控制台解除熔断');
    }
    // 发送前强制同步一次，确保“刚新增的表情能立即用、刚删除的表情不会继续发”。
    const synced = await syncStickerLibrary(true);
    const entry = findSticker(synced?.entries ?? deps.getStickerEntries(), stickerRef);
    if (!entry) throw new Error(`找不到表情 ${stickerRef}，请先用 qq_list_stickers 获取有效 id`);
    const url = entry.url;
    if (!url) throw new Error(`表情 ${entry.id} 没有可发送的图片地址`);
    const [kind, id] = key.split(':');
    const segments = [];
    const replyToMessageId = options.replyToMessageId;
    const atUserId = options.atUserId;
    // 仿真常识：一条消息只能是一张表情，不能在同一气泡里附带文字说明。
    // 想说的话请用 qq_send_message / qq_reply 作为单独气泡发送。
    if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
      // 上层已把 seq 解析成真实 messageId（见 resolveReplyTargetV2），这里只做格式校验
      const rid = String(replyToMessageId).trim();
      if (!/^-?[1-9]\d*$/.test(rid)) throw new Error('replyToMessageId 必须是非零整数（消息 id 可能为负数）');
      segments.push({ type: 'reply', data: { id: rid } });
    }
    if (atUserId !== undefined && atUserId !== null && String(atUserId).trim() !== '') {
      const at = String(atUserId).trim();
      if (!/^\d+$/.test(at)) throw new Error('atUserId 必须是正整数 QQ 号，且不能为 all');
      segments.push({ type: 'at', data: { qq: at } });
    }
    // 发送前校验表情 URL 必须是公网 http(s)，防止本地库被污染后诱导 OneBot 抓取内网/本机地址。
    try {
      await validateFetchUrl(url);
    } catch (error) {
      throw new Error(`表情 ${entry.id} 的图片地址不合法，已拒绝发送：${error?.message ?? error}`);
    }
    segments.push({ type: 'image', data: { file: url } });
    const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
    const params = kind === 'private' ? { user_id: Number(id), message: segments } : { group_id: Number(id), message: segments };
    const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    // 与文本发送共用「本会话」的发送队列，保证“先文字后表情”的真人顺序；
    // 但只阻塞本会话，不拖住其他群。
    const data = await sendQueue.enqueue(key, async () => {
      try {
        // 真人发表情前通常会有短暂停顿，避免“文字刚发完表情立刻跟上”的机械感。
        await sleep(randInt(800, 2000));
        const res = await fetch(`${httpUrl}/${action}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
          },
          body: JSON.stringify(params),
          signal: AbortSignal.timeout(15000)
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
          const hint = res.status === 426 ? '（HTTP 426：snowluma.httpUrl 可能指向了 WebSocket 端口，请检查 config.json 的 snowluma.httpUrl 是否为 OneBot HTTP API 地址）' : '';
          throw new Error(`OneBot ${action} 失败: ${body.wording || body.retcode || res.status}${hint}`);
        }
        recordSentMessage(key, body.data, `［表情］${entry.id.slice(0, 16)}`);
        return body.data;
      } catch (error) {
        throw error;
      }
    });
    // 更新本地使用统计
    const updated = markStickerUsed(deps.getStickerEntries(), entry.id, 'sticker');
    deps.setStickerEntries(updated.entries);
    saveStickerStoreSafe();
    return { entry: updated.entry, messageId: data?.message_id ?? null };
  }

  return { sendToQQ, sendBurstToQQ, sendMessagesV2, sendAsVoice, sendStickerV2 };
}
