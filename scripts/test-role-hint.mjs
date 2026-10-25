import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRoleHintReader, ROLE_HINT_MAX } from '../src/pipeline/role-hint.js';
import { checks } from './helpers/pipeline-harness.mjs';
const { check, finish } = checks();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-role-hint-'));
try {
  fs.mkdirSync(path.join(root, 'roles'));
  const file = path.join(root, 'roles', 'test.md'), logs = [];
  fs.writeFileSync(file, '第一版');
  const read = createRoleHintReader({ ROOT: root, roleFor: k => k, roleHintCache: new Map(), log: s => logs.push(s) });
  check('正常角色卡完整读取', read('test') === '第一版');
  check('缺失角色卡返回空', read('missing') === '');
  fs.writeFileSync(file, '新版'); fs.utimesSync(file, new Date(), new Date(Date.now() + 1000));
  check('mtime 改变热更新', read('test') === '新版');
  fs.writeFileSync(file, '长'.repeat(ROLE_HINT_MAX + 1)); fs.utimesSync(file, new Date(), new Date(Date.now() + 2000));
  check('超长截断且留日志', read('test').length === ROLE_HINT_MAX && logs.some(s => s.includes('超长')));
} finally {
  if(path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith('qq-role-hint-')) throw new Error('unexpected temp path');
  fs.rmSync(root, { recursive: true, force: true });
}
finish();
