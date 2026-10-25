// 会话代际：mode + preset 变化必须重建 DSH 会话。
import fs from 'node:fs';
import { sessionGeneration, needsNewSession } from '../src/pipeline/session-generation.js';

let pass = 0, fail = 0;
const check = (n, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };

check('代际包含 mode/preset', sessionGeneration({ mode: 'reserved2', preset: 'qq-chat-v2' }) === 'reserved2|qq-chat-v2');
check('空 preset 也有稳定代际', sessionGeneration({ mode: 'chat' }) === 'chat|');
check('相同代际不需要重建',
  needsNewSession({ mode: 'reserved2', preset: 'qq-chat-v2' }, { mode: 'reserved2', preset: 'qq-chat-v2' }) === false);
check('mode 变化需要重建',
  needsNewSession({ mode: 'chat', preset: 'qq-chat' }, { mode: 'reserved2', preset: 'qq-chat' }) === true);
check('preset 变化需要重建',
  needsNewSession({ mode: 'reserved2', preset: 'qq-chat' }, { mode: 'reserved2', preset: 'qq-chat-v2' }) === true);
check('preset 被清空需要重建',
  needsNewSession({ mode: 'reserved2', preset: 'qq-chat-v2' }, { mode: 'reserved2', preset: '' }) === true);
check('老状态无 meta 时按当前接管（不批量重建）',
  needsNewSession(null, { mode: 'reserved2', preset: 'qq-chat-v2' }) === false);
check('undefined 不崩', needsNewSession(undefined, {}) === false);

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
