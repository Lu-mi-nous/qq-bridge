// 验证「有人戳了你」状态串的拼接逻辑（复刻 bridge.js 里的同一段代码）。
// 直接调真实 bridge 不可行（内部函数不导出），所以从源码抽出该段并在构造的数据上跑，
// 确保：只有 targetIsSelf 的 poke 才进状态、且最多 3 条、且带得清是谁。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(root, 'src/bridge.js'), 'utf8');

let pass = 0, fail = 0;
const check = (n, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };

// 抽出真实代码段
const start = src.indexOf('const pokeSelfs');
const end = src.indexOf('const statusLine =', start);
const snippet = src.slice(start, end);
check('能抽出"拍你"统计代码段', start > 0 && end > start);

// 桩：identityTagOf / statusBits / st
const identityTagOf = (m) => (m && m.isOwner ? '【管理员】' : '');
const run = (unread) => {
  const statusBits = [];
  const st = { unread };
  const fn = new Function('st', 'statusBits', 'identityTagOf', snippet + '\nreturn statusBits;');
  return fn(st, statusBits, identityTagOf);
};

console.log('\n── 只有"拍你"才算 ──');
{
  const bits = run([
    { sender: '甲', poke: { targetIsSelf: true } },
    { sender: '乙', poke: { targetIsSelf: false } },   // 拍别人
    { sender: '丙' }                                   // 普通消息
  ]);
  const line = bits.join('；');
  check('提到"有人戳了你"', /有人戳了你/.test(line), line);
  check('包含拍你的人', /甲/.test(line));
  check('不包含拍别人的人', !/乙/.test(line));
  check('不包含普通消息发送者', !/丙/.test(line));
  check('给出回应方式（含可照抄的目标）', /targetUserId="latest"/.test(line) && /回一句话/.test(line), line);
}

console.log('\n── 拍别人的事件不触发这一行 ──');
{
  const bits = run([{ sender: '乙', poke: { targetIsSelf: false } }]);
  check('没有"戳了你"字样', !bits.join('').includes('戳了你'));
}

console.log('\n── 上限 3 条 ──');
{
  const unread = Array.from({ length: 8 }, (_, i) => ({ sender: `人${i}`, poke: { targetIsSelf: true } }));
  const line = run(unread).join('；');
  const shown = (line.match(/人\d/g) || []);
  check('最多列出 3 个', shown.length <= 3, `shown=${shown.length}: ${line}`);
  check('取的是最近 3 条', shown.includes('人7') && !shown.includes('人0'), shown.join(','));
}

console.log('\n── 机器人自己的拍一拍不算 ──');
{
  const bits = run([{ sender: '我', isSelf: true, poke: { targetIsSelf: true } }]);
  check('isSelf 被排除', !bits.join('').includes('戳了你'));
}

console.log('\n── 管理员标记保留 ──');
{
  const bits = run([{ sender: '主人', isOwner: true, poke: { targetIsSelf: true } }]);
  check('带【管理员】标记', /【管理员】.*主人/.test(bits.join('')), bits.join(''));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
