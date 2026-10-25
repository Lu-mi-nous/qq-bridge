// 消息管线 · 每会话发送队列。
//
// 原来的 sendChain 是**全进程一条 Promise 链**：任何一个群的一次 QQ 发送变慢/超时，
// 后面所有会话的发送都被堵住（跨会话头阻塞）。实测群友会感觉“这个群不说话，
// 别的群也不理人”。现在按目标会话 key 各排一条链：
//   - 同一个会话内严格保序（先文字后表情、分条发送不会乱序）；
//   - 不同会话互不阻塞；
//   - 某一任务失败不会毒化该会话后续任务（调用方自己决定是否抛错）。
export function createSendQueue() {
  const tails = new Map(); // key -> 队尾 Promise

  /**
   * 把任务排到指定会话的队尾。
   * @param {string} key 会话 key（group:xxx / private:xxx）
   * @param {() => Promise<any>} task
   * @returns {Promise<any>} 任务结果；任务抛错时 reject
   */
  function enqueue(key, task) {
    const target = String(key ?? '');
    const prev = tails.get(target) || Promise.resolve();
    // 前一个任务失败也要继续跑后面的：失败由各自调用方处理，
    // 不能因为一次网络超时把整个会话的发送队列永久卡死。
    const next = prev.catch(() => {}).then(task);
    tails.set(target, next);
    next
      .finally(() => {
        if (tails.get(target) === next) tails.delete(target);
      })
      .catch(() => {});
    return next;
  }

  /** 当前仍有排队/在途任务的会话数（诊断用）。 */
  function size() {
    return tails.size;
  }

  return { enqueue, size };
}
