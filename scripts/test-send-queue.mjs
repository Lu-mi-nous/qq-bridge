// 每会话发送队列：同会话保序、跨会话并行、失败不毒化后续。
import { createSendQueue } from '../src/pipeline/send-queue.js';

let pass = 0, fail = 0;
const check = (n, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('── 1. 同会话保序 ──');
{
  const q = createSendQueue();
  const order = [];
  const p1 = q.enqueue('group:1', async () => { await sleep(20); order.push('a'); return 'a'; });
  const p2 = q.enqueue('group:1', async () => { order.push('b'); return 'b'; });
  const p3 = q.enqueue('group:1', async () => { order.push('c'); return 'c'; });
  const results = await Promise.all([p1, p2, p3]);
  check('同会话任务顺序执行', order.join(',') === 'a,b,c', order.join(','));
  check('同会话返回结果对应', results.join(',') === 'a,b,c', results.join(','));
}

console.log('\n── 2. 跨会话并行 ──');
{
  const q = createSendQueue();
  const events = [];
  const a = q.enqueue('group:1', async () => { events.push('a-start'); await sleep(40); events.push('a-end'); });
  const b = q.enqueue('group:2', async () => { events.push('b-start'); await sleep(10); events.push('b-end'); });
  await Promise.all([a, b]);
  check('不同会话任务可交错执行（无跨会话头阻塞）',
    events.indexOf('b-start') < events.indexOf('a-end'), events.join(','));
}

console.log('\n── 3. 失败不毒化后续 ──');
{
  const q = createSendQueue();
  let ran = false;
  const bad = q.enqueue('group:3', async () => { throw new Error('boom'); });
  const good = q.enqueue('group:3', async () => { ran = true; return 'ok'; });
  let rejected = false;
  try { await bad; } catch { rejected = true; }
  const result = await good;
  check('失败任务本身 reject', rejected);
  check('后续任务仍执行', ran && result === 'ok');
}

console.log('\n── 4. 队列清理 ──');
{
  const q = createSendQueue();
  await q.enqueue('group:4', async () => 'x');
  await sleep(0);
  check('任务完成后队列条目清理', q.size() === 0, String(q.size()));
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
