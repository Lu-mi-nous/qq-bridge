// R4.7-3：定时任务命令。
//
// 概览路由原先直接持有 `deps.taskService` 并自己拼返回体；这里收成
// list / apply 两个命令，路由只解析路径与拒绝 agent token。
// 任务名由 task-service 自己的注册表约束，命令层不做白名单（新增任务无需改这里）。

export function createTaskCommands({ taskService } = {}) {
  function list() {
    return { ok: true, tasks: taskService?.list?.() ?? [] };
  }

  /** @returns {{ok:true, action:string, task:object|null}|{ok:false,status:number,error:string}} */
  async function apply(name, action) {
    if (!taskService) return { ok: false, status: 404, error: '任务服务未加载' };
    try {
      if (action === 'trigger') await taskService.trigger(name);
      else if (action === 'pause') taskService.pause(name);
      else if (action === 'resume') taskService.resume(name);
      else if (action === 'start') taskService.start(name);
      else if (action === 'stop') taskService.stop(name);
      const current = taskService.get?.(name);
      return {
        ok: true,
        action,
        task: current?.status ? {
          name,
          status: current.status,
          runCount: current.runCount,
          lastError: current.lastError
        } : null
      };
    } catch (error) {
      return { ok: false, status: 500, error: `任务操作失败：${error?.message ?? error}` };
    }
  }

  return { list, apply };
}
