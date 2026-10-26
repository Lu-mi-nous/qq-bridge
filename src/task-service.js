// 任务服务（R3-3）：命名定时器注册、暂停/恢复、手动触发与状态查询。
//
// 只托管「定时任务」，不承载业务逻辑；任务回调由 bridge 注入。
export function createTaskService({
  log = () => {},
  now = Date.now,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout
} = {}) {
  const tasks = new Map();

  function define(name, opts = {}) {
    const id = String(name || '').trim();
    if (!id) throw new Error('taskService.define: name 不能为空');
    if (typeof opts.run !== 'function') throw new Error(`taskService.define(${id}): run 必须是函数`);
    if (tasks.has(id)) throw new Error(`taskService.define: 任务已存在 ${id}`);
    tasks.set(id, {
      name: id,
      kind: opts.kind === 'timeout' ? 'timeout' : 'interval',
      everyMs: Math.max(0, Number(opts.everyMs) || 0),
      delayMs: Math.max(0, Number(opts.delayMs) || 0),
      initialDelayMs: Math.max(0, Number(opts.initialDelayMs) || 0),
      run: opts.run,
      enabled: opts.enabled !== false,
      unref: opts.unref !== false,
      timer: null,
      initialTimer: null,
      status: 'idle',
      runCount: 0,
      lastRunAt: 0,
      lastError: ''
    });
    return tasks.get(id);
  }

  function clearRecord(rec) {
    if (rec.timer) { clearIntervalFn(rec.timer); rec.timer = null; }
    if (rec.initialTimer) { clearTimeoutFn(rec.initialTimer); rec.initialTimer = null; }
  }

  function runTask(rec, manual = false) {
    rec.runCount += 1;
    rec.lastRunAt = now();
    try {
      const result = rec.run({ manual, name: rec.name });
      if (result && typeof result.then === 'function') {
        result.catch((error) => {
          rec.lastError = String(error?.message ?? error);
          log(`[task] ${rec.name} 执行失败：${rec.lastError}`);
        });
      }
      return result;
    } catch (error) {
      rec.lastError = String(error?.message ?? error);
      log(`[task] ${rec.name} 执行失败：${rec.lastError}`);
      return undefined;
    }
  }

  function scheduleInterval(rec) {
    if (rec.kind !== 'interval' || !rec.everyMs) return;
    rec.timer = setIntervalFn(() => runTask(rec, false), rec.everyMs);
    rec.timer?.unref?.();
  }

  function start(name) {
    const rec = tasks.get(String(name));
    if (!rec) return false;
    if (!rec.enabled) return false;
    clearRecord(rec);
    rec.lastError = '';
    if (rec.kind === 'timeout') {
      rec.status = 'scheduled';
      rec.timer = setTimeoutFn(() => {
        rec.timer = null;
        rec.status = 'done';
        runTask(rec, false);
      }, rec.delayMs);
      rec.timer?.unref?.();
      return true;
    }
    rec.status = 'running';
    if (rec.initialDelayMs > 0) {
      rec.initialTimer = setTimeoutFn(() => {
        rec.initialTimer = null;
        runTask(rec, false);
        scheduleInterval(rec);
      }, rec.initialDelayMs);
      rec.initialTimer?.unref?.();
    } else {
      scheduleInterval(rec);
    }
    return true;
  }

  function stop(name) {
    const rec = tasks.get(String(name));
    if (!rec) return false;
    clearRecord(rec);
    rec.status = 'stopped';
    return true;
  }

  function pause(name) {
    const rec = tasks.get(String(name));
    if (!rec) return false;
    clearRecord(rec);
    rec.status = 'paused';
    return true;
  }

  function resume(name) {
    const rec = tasks.get(String(name));
    if (!rec) return false;
    if (!rec.enabled) return false;
    return start(name);
  }

  function trigger(name) {
    const rec = tasks.get(String(name));
    if (!rec) return false;
    return runTask(rec, true);
  }

  function setEnabled(name, enabled) {
    const rec = tasks.get(String(name));
    if (!rec) return false;
    rec.enabled = enabled === true;
    if (!rec.enabled) stop(name);
    return true;
  }

  function stopAll() {
    for (const rec of tasks.values()) clearRecord(rec);
  }

  function list() {
    return [...tasks.values()].map((rec) => ({
      name: rec.name,
      kind: rec.kind,
      everyMs: rec.everyMs,
      delayMs: rec.delayMs,
      initialDelayMs: rec.initialDelayMs,
      enabled: rec.enabled,
      status: rec.status,
      runCount: rec.runCount,
      lastRunAt: rec.lastRunAt,
      lastError: rec.lastError
    }));
  }

  function get(name) {
    return tasks.get(String(name)) || null;
  }

  return { define, start, stop, pause, resume, trigger, setEnabled, stopAll, list, get };
}
