// 报错处理（R3-14）：上游额度/限流拦截 + 统一「报错只私聊管理员」通道。
export function createErrorService({
  cfg,
  errorNotifier,
  sendToQQ,
  log = () => {},
  appendActivity = () => {},
  contextDisplayName,
  buildOwnerReport,
  buildOwnerNotice,
  condenseUpstreamDetail,
  classifyUpstreamError,
  pickMessage,
  healScriptFor,
  healDshConfig
} = {}) {
  if (!cfg) throw new Error('createErrorService: cfg 不能为空');

  async function handleUpstreamError(key, rawError, extra = {}) {
    // provider 配置丢失不属于"额度/限流"，先走自愈（不 return，后续照常通知管理员）。
    if (healScriptFor(rawError)) healDshConfig(`${key || '未知会话'} 投递被拒`, rawError).catch(() => {});
    const en = cfg.socialV2?.errorNotice ?? {};
    if (en.enabled === false) return false;
    const cls = classifyUpstreamError(rawError);
    if (!cls.matched) return false;

    // 节流：同一会话 windowMs 内只提示一次。判定与记账同步（见 error-notifier 注释），
    // 所以这里拿到的 allowed 就是最终结论，不存在两个回合都拿到 true 的窗口。
    const gate = errorNotifier.shouldNotify(key);
    let sentText = '';
    // 群内提示默认关闭（cfg.socialV2.errorNotice.inGroup）：报错不进群，只私聊管理员。
    if (gate.allowed && en.inGroup === true) {
      const msg = pickMessage(en.messages);
      sentText = msg;
      await sendToQQ(key, msg);
      log(`[报错拦截] ${key} 上游${cls.code}，已发人设提示：${msg}`);
      appendActivity(`${key} [报错拦截] 上游${cls.code}，已提示：${msg}`);
    } else if (gate.allowed) {
      log(`[报错拦截] ${key} 上游${cls.code}，群内提示已关闭（只通知管理员）`);
    } else {
      log(`[报错拦截] ${key} 上游${cls.code}，${Math.ceil(gate.retryAfterMs / 1000)}s 内已提示过，跳过`);
    }

    // 私聊管理员：带上群号、错误码与**压缩过的**错误详情，便于直接排查。
    // 为什么压缩：网关在 WAF 拦截时会把整个 403 HTML 页（含内联 CSS/JS、腾讯云 CDN
    // 链接）当 message 回传，原样转发就是满屏英文标签，真正有用的错误码反而被淹没。
    if (en.notifyOwner !== false && cfg.ownerQQ) {
      const report = buildOwnerReport({
        key,
        code: cls.code,
        rawError: condenseUpstreamDetail(rawError),
        // 群内提示默认关闭，此时列表为空——别塞空串，否则详情里会出现没有内容的「群内已回复：」。
        messages: sentText ? [sentText] : [],
        sessionId: extra.sessionId ?? '',
        sessionName: contextDisplayName(key) || ''
      });
      // 私聊走本会话的发送队列，顺序不会被群消息插队；失败只记日志，不影响主流程。
      sendToQQ(`private:${String(cfg.ownerQQ)}`, report).catch(() => {});
    }
    return true;
  }

  // ── 统一的「报错只私聊管理员」通道 ────────────────────────────────────
  // 用户要求：报错信息一律不再出现在群里，全部转发给管理员账号。
  // 所有原本 `await sendToQQ(key, '⚠️ …')` 的报错点都改走这里：
  //   ① 只在群里留下「无」——群友看不到任何报错相关字样；
  //   ② 详情走私聊，带群号/QQ 号、类型、上下文，便于直接排查；
  //   ③ 按 key+类型节流，避免刷屏；被节流压掉的数量会在下次通知里带出来，不静默丢失。
  const ownerNotices = new Map(); // `${key}|${title}` -> { at, suppressed }
  // selfHeal=true 表示这条通知来自自愈流程本身，不再触发自愈（防递归）。
  function notifyOwnerOfError(key, title, detail = '', extra = {}, selfHeal = false) {
    // 配置类故障（provider 丢失 / 推理档位冲突）在这里统一自愈：
    // 这条是**所有报错出口的汇聚点**，唤醒投递被拒、黑话提取失败等都经过它，
    // 比在 handleUpstreamError 里挂更全面（那个只管"额度/限流"类）。
    if (!selfHeal) {
      const probe = `${detail} ${extra?.sessionId ?? ''} ${title}`;
      if (healScriptFor(probe)) healDshConfig(`${key || '未知会话'} · ${title}`, probe).catch(() => {});
    }
    const en = cfg.socialV2?.errorNotice ?? {};
    const base = cfg.errorNotify ?? {};
    if (en.notifyOwner === false || base.notifyOwner === false) return;
    const ownerQQ = String(cfg.ownerQQ ?? '').trim();
    if (!ownerQQ) { log(`[报错] 想通知管理员但 cfg.ownerQQ 为空：${title}（${key}）`); return; }
    // key 可能为空（如发送线程里的错误），此时也能通知，只是没有群号字段。
    const bucket = `${key}|${title}`;
    const windowMs = Math.max(0, Number(base.windowMs) || 0);
    const now = Date.now();
    const prev = ownerNotices.get(bucket);
    if (windowMs > 0 && prev && now - prev.at < windowMs) {
      prev.suppressed += 1;
      log(`[报错] ${title}（${key}）在节流窗口内，已累计 ${prev.suppressed} 次不重复私聊`);
      return;
    }
    const suppressed = prev ? prev.suppressed : 0;
    ownerNotices.set(bucket, { at: now, suppressed: 0 });
    if (ownerNotices.size > 500) {
      for (const k of ownerNotices.keys()) { ownerNotices.delete(k); if (ownerNotices.size <= 400) break; }
    }
    const sessionName = key ? String(contextDisplayName(key) || '').trim() : '';
    const titleText = String(title ?? '');
    const header = /^Token\s*超限提醒/.test(titleText)
      ? '【Token 用量提醒】'
      : /^Token\s*超限熔断/.test(titleText)
        ? '【Token 超限熔断】'
        : '【桥接报错】';
    const report = buildOwnerNotice({ key, title, detail, at: now, extra, suppressed, header, sessionName });
    // 私聊走本会话的发送队列，顺序不会被群消息插队；失败只记日志，不影响主流程。
    sendToQQ(`private:${ownerQQ}`, report).catch(() => {});
    log(`[报错] 已私聊管理员：${title}（${key || '无会话'}）${suppressed ? `，含此前 ${suppressed} 次同类` : ''}`);
  }

  return { handleUpstreamError, notifyOwnerOfError };
}
