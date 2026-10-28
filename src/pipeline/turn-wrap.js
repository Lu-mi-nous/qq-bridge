// T1：发言回合的自动收尾（把「必填 mark_read / set_wake_config」移出模型控制流）。
//
// 背景：过去每轮回复后模型都必须再调 qq_mark_read 或 qq_set_wake_config，漏了事件泵
// 会投递「未设置唤醒条件」提醒——那是额外一次模型调用；实测回复后不调用的回合很常见。
// 现在：本回合成功发过言 = 正常收尾，由这里完成两件事：
//   ① 标记已读水位（只清唤醒时已存在的未读，`wakeSeqAt` 之后新到的一条不动）；
//   ② ensureWakeable 保证下一轮一定还能被唤醒。
//
// 硬约束（与 qq_mark_read 同源）：未读里还有**没答过的 @** 时不清未读，只补唤醒配置——
// 绝不能把别人叫你的消息顺手标掉。没有水位（老状态/异常）时也不清：
// 自动通道宁可留着重复，也不能吞掉本轮新到的消息。
export function createTurnWrap({ getState, findCallers, ensureWakeable, save, log = () => {}, now = Date.now }) {
  if (typeof getState !== 'function' || typeof findCallers !== 'function' || typeof ensureWakeable !== 'function' || typeof save !== 'function') {
    throw new TypeError('createTurnWrap: getState/findCallers/ensureWakeable/save 必填');
  }
  return function autoWrapAfterReply(key) {
    const st = getState(key);
    const nowMs = now();
    const callers = findCallers(key, st);
    let cleared = 0;
    if (!callers.pending.length) {
      const wakeSeqAt = Number(st.wakeSeqAt) || 0;
      if (wakeSeqAt > 0) {
        const before = st.unread.length;
        st.unread = st.unread.filter((m) => Number(m?.seq) > wakeSeqAt);
        cleared = before - st.unread.length;
      }
      st.wakeSeqAt = 0;
    }
    st.lastActionAt = nowMs;
    st.wakeConfig.noActionCount = 0;
    ensureWakeable(st, { key });
    st.wakeConfig.confirmedAt = nowMs;
    st.wakeConfig.confirmedBy = 'auto_reply';
    save();
    if (callers.pending.length) {
      log(`[reserved2] ${key} 自动收尾：保留 ${st.unread.length} 条未读（含 ${callers.pending.length} 条未答 @）`);
    } else {
      log(`[reserved2] ${key} 自动收尾：标记已读 ${cleared} 条，保留 ${st.unread.length} 条`);
    }
    return { cleared, kept: st.unread.length, pendingCallers: callers.pending.length };
  };
}
