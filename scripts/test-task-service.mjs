// R3-3 任务服务：注册、启动、暂停/恢复、手动触发、错误记录。
import { createTaskService } from '../src/task-service.js';

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
};

function fakeTimers() {
  let seq = 0;
  const timeouts = new Map();
  const intervals = new Map();
  return {
    timeouts,
    intervals,
    setTimeoutFn(fn, ms) {
      const id = ++seq;
      timeouts.set(id, { fn, ms, unref() {} });
      return id;
    },
    clearTimeoutFn(id) { timeouts.delete(id); },
    setIntervalFn(fn, ms) {
      const id = ++seq;
      intervals.set(id, { fn, ms, unref() {} });
      return id;
    },
    clearIntervalFn(id) { intervals.delete(id); },
    fireTimeout(id) {
      const t = timeouts.get(id);
      if (!t) return;
      timeouts.delete(id);
      t.fn();
    },
    fireInterval(id) {
      const t = intervals.get(id);
      if (t) t.fn();
    }
  };
}

console.log('── 1. 注册与 interval ──');
{
  const ft = fakeTimers();
  let runs = 0;
  const svc = createTaskService({ ...ft, log: () => {} });
  svc.define('tick', { everyMs: 1000, run: () => { runs++; } });
  check('define 后可查询', svc.get('tick')?.kind === 'interval');
  check('start 创建 interval', svc.start('tick') && ft.intervals.size === 1);
  ft.fireInterval([...ft.intervals.keys()][0]);
  check('interval 到点执行', runs === 1);
  check('list 反映运行次数', svc.list()[0].runCount === 1 && svc.list()[0].status === 'running');
}

console.log('\n── 2. 初始延迟 ──');
{
  const ft = fakeTimers();
  let runs = 0;
  const svc = createTaskService({ ...ft, log: () => {} });
  svc.define('delayed', { everyMs: 1000, initialDelayMs: 5000, run: () => { runs++; } });
  svc.start('delayed');
  check('初始延迟先创建 timeout', ft.timeouts.size === 1 && ft.intervals.size === 0);
  ft.fireTimeout([...ft.timeouts.keys()][0]);
  check('初始延迟执行一次并转为 interval', runs === 1 && ft.intervals.size === 1);
}

console.log('\n── 3. 暂停 / 恢复 / 停止 ──');
{
  const ft = fakeTimers();
  let runs = 0;
  const svc = createTaskService({ ...ft, log: () => {} });
  svc.define('tick', { everyMs: 1000, run: () => { runs++; } });
  svc.start('tick');
  const id = [...ft.intervals.keys()][0];
  svc.pause('tick');
  check('pause 清理定时器', ft.intervals.size === 0 && svc.get('tick').status === 'paused');
  ft.fireInterval(id);
  check('暂停后旧定时器不再执行', runs === 0);
  svc.resume('tick');
  check('resume 重新创建定时器', ft.intervals.size === 1 && svc.get('tick').status === 'running');
  svc.stop('tick');
  check('stop 清理并标记 stopped', ft.intervals.size === 0 && svc.get('tick').status === 'stopped');
}

console.log('\n── 4. 手动触发 / one-shot / 错误 ──');
{
  const ft = fakeTimers();
  let runs = 0;
  const svc = createTaskService({ ...ft, log: () => {} });
  svc.define('manual', { everyMs: 1000, run: ({ manual }) => { runs += manual ? 10 : 1; } });
  svc.trigger('manual');
  check('手动触发可独立执行', runs === 10 && svc.get('manual').runCount === 1);

  svc.define('once', { kind: 'timeout', delayMs: 500, run: () => { runs++; } });
  svc.start('once');
  ft.fireTimeout([...ft.timeouts.keys()][0]);
  check('one-shot 执行后标记 done', runs === 11 && svc.get('once').status === 'done');

  const errSvc = createTaskService({ ...ft, log: () => {} });
  errSvc.define('bad', { everyMs: 1000, run: () => { throw new Error('boom'); } });
  let threw = false;
  try { errSvc.trigger('bad'); } catch { threw = true; }
  check('执行异常被记录', errSvc.get('bad').lastError.includes('boom'));
  check('异常不抛出到调用方', threw === false);
}

console.log('\n── 5. 禁用 / 停止全部 ──');
{
  const ft = fakeTimers();
  const svc = createTaskService({ ...ft, log: () => {} });
  svc.define('a', { everyMs: 1000, run: () => {} });
  svc.define('b', { everyMs: 1000, run: () => {} });
  svc.start('a'); svc.start('b');
  check('两个任务各有一个定时器', ft.intervals.size === 2);
  svc.setEnabled('a', false);
  check('禁用会停止任务', ft.intervals.size === 1 && svc.get('a').enabled === false);
  svc.stopAll();
  check('stopAll 清空全部定时器', ft.intervals.size === 0);
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
