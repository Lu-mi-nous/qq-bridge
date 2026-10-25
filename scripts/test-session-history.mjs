// 回归测试：会话映射历史（src/session-history.js）。
//
// 为什么重要：state/sessions.json 只保存当前映射；上下文超限/模式切换/reset
// 之后旧 sessionId 会变成无主，token 会话报表就丢归属。本模块锁住：
//   ① 记录与合并（create → rotate 同一条，archivedAt 不丢）
//   ② 当前映射 adopt、历史 compactions 回填
//   ③ 有界裁剪、损坏文件容错
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSessionHistory, keyFromContextDirName } from '../src/session-history.js';

let pass = 0, fail = 0;
const check = (n, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sesshist-'));
const file = path.join(tmp, 'state', 'session-history.json');
const contextRoot = path.join(tmp, 'state', 'context');

console.log('── 1. 记录与合并 ──');
{
  const h = createSessionHistory({ file });
  check('目录名还原 group key', keyFromContextDirName('group_12345') === 'group:12345');
  check('目录名还原 private key', keyFromContextDirName('private_67890') === 'private:67890');
  check('非会话目录返回空', keyFromContextDirName('backlog-history') === '');

  check('创建记录', h.record('session-1', 'group:1', 'create', { at: 1000 }) === true);
  check('映射可读', h.mapping()['session-1'] === 'group:1');
  const created = h.list().find((x) => x.sessionId === 'session-1');
  check('创建条目不写 archivedAt', created?.archivedAt === 0 && created?.createdAt === 1000,
    JSON.stringify(created));

  h.record('session-1', 'group:1', 'rotate', { at: 2000 });
  const rotated = h.list().find((x) => x.sessionId === 'session-1');
  check('轮换后同一 sessionId 不重复', h.list().filter((x) => x.sessionId === 'session-1').length === 1);
  check('轮换写入 archivedAt 且保留 createdAt',
    rotated?.archivedAt === 2000 && rotated?.createdAt === 1000 && rotated?.reason === 'rotate',
    JSON.stringify(rotated));
  check('空 sessionId 不记录', h.record('', 'group:1', 'create') === false);
}

console.log('\n── 2. adoptCurrent / 回填 ──');
{
  const h = createSessionHistory({ file });
  const added = h.adoptCurrent({ 'group:1': 'session-current', 'private:2': 'session-p2' });
  check('当前映射登记为 adopt', added === 2 && h.get('session-current') === 'group:1');
  check('adopt 幂等（重复不新增）', h.adoptCurrent({ 'group:1': 'session-current' }) === 0);

  const dir = path.join(contextRoot, 'group_12345');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'compactions.jsonl'), [
    JSON.stringify({ at: 3000, sessionId: 'session-old-1', summary: 'a' }),
    'not json',
    JSON.stringify({ at: 4000, sessionId: 'session-old-2', summary: 'b' }),
    JSON.stringify({ at: 5000, summary: 'no session id' })
  ].join('\n'), 'utf8');
  const priv = path.join(contextRoot, 'private_67890');
  fs.mkdirSync(priv, { recursive: true });
  fs.writeFileSync(path.join(priv, 'compactions.jsonl'),
    JSON.stringify({ at: 6000, sessionId: 'session-old-3' }) + '\n', 'utf8');

  const n = h.backfillFromContext(contextRoot);
  check('回填两个群历史 + 一个私聊历史', n === 3, String(n));
  check('回填归属正确', h.get('session-old-1') === 'group:12345'
    && h.get('session-old-3') === 'private:67890');
  check('已有 sessionId 不被回填覆盖', h.get('session-current') === 'group:1');
  check('再次回填不重复', h.backfillFromContext(contextRoot) === 0);
}

console.log('\n── 3. 有界裁剪 / 损坏容错 ──');
{
  const smallFile = path.join(tmp, 'small.json');
  const h = createSessionHistory({ file: smallFile, maxItems: 3 });
  for (let i = 1; i <= 5; i++) h.record(`s-${i}`, `group:${i}`, 'create', { at: i * 1000 });
  const list = h.list();
  check('超出上限按时间裁最旧', list.length === 3
    && !list.some((x) => x.sessionId === 's-1') && !list.some((x) => x.sessionId === 's-2'),
    list.map((x) => x.sessionId).join(','));

  const corrupt = path.join(tmp, 'corrupt.json');
  fs.writeFileSync(corrupt, '{not json', 'utf8');
  let ok = true;
  let h2;
  try { h2 = createSessionHistory({ file: corrupt }); } catch { ok = false; }
  check('损坏文件不抛异常', ok && !!h2);
  h2.record('session-x', 'group:9', 'create');
  check('损坏后仍能重建索引', h2.get('session-x') === 'group:9');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
