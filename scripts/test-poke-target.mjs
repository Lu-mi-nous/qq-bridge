// 回归测试：拍一拍的目标解析（「总是戳同一个人」）。
//
// 事故（2026-10-22，group:100002004）：机器人反复拍 群友C，群里问「怎么一直戳我」。
// 链路：
//   ① qq_send_poke 必须传数字 QQ 号；
//   ② 唤醒提示只说「有人戳了你（群友G）」——只有名字，没有号；
//   ③ 上下文里唯一的号来自很早以前某次 qq_get_recent_messages（群友C 的 1000000003），
//      以及它自己拍完后返回的 targetUserId；
//   ④ 模型拿旧号顶上，一拍十几次。
//
// 修法：支持 `latest`（最近戳你的人）与昵称，由桥接在本会话消息里换算；
// 同时把 QQ 号直接放进状态行、把自己拍一拍的记录写成名字而不是裸号。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePokeTarget, isSymbolicPokeRef } from '../src/poke-target.js';
import { readConsoleSource } from './lib/console-src.mjs';

let pass = 0, fail = 0;
const check = (n, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const wakeSrc = fs.readFileSync(path.join(root, 'src/pipeline/wake.js'), 'utf8');
const consoleServerSrc = readConsoleSource();
const mcpSrc = fs.readFileSync(path.join(root, 'src/mcp-snowluma-safe.js'), 'utf8');

const poke = (sender, userId, time, extra = {}) => ({
  sender, userId, isSelf: false,
  poke: { targetIsSelf: true, targetId: null },
  time, ...extra
});
const msg = (sender, userId, text, time) => ({ sender, userId, isSelf: false, text, time });

console.log('── 1. latest = 最近戳你的人（不是最近说话的人）──');
{
  // 事故回放：群友G在最新戳它，群友C 只是更早戳过、且还在上下文里留有旧号
  const unread = [
    poke('群友C', '1000000003', 900),
    poke('群友G', '2604175579', 2000),
    msg('Iris Tsui', '3251759205', '我家最爱吃鱼了', 2100) // 更近的说话者，但不是戳它的人
  ];
  const r = resolvePokeTarget({ ref: 'latest', unread, recentMessages: [] });
  check('latest 指向群友G（最近戳它的）', r.ok && r.userId === '2604175579', JSON.stringify(r));
  check('不会选到上下文里的旧号 群友C', !(r.ok && r.userId === '1000000003'));
  check('不会选到更近的普通说话者', !(r.ok && r.userId === '3251759205'));

  // 各种符号写法都认
  for (const ref of ['last', '戳我的人', '最近戳我的人', '上一条', 'LATEST']) {
    check(`符号"${ref}"可识别`, isSymbolicPokeRef(ref), ref);
  }
}

console.log('\n── 2. 拍别人的事件不算"戳你" ──');
{
  const unread = [
    { sender: '群友C', userId: '1000000003', isSelf: false, poke: { targetIsSelf: false }, time: 3000 },
    poke('群友G', '2604175579', 1000)
  ];
  const r = resolvePokeTarget({ ref: 'latest', unread, recentMessages: [] });
  check('忽略 targetIsSelf=false 的拍一拍', r.ok && r.userId === '2604175579', JSON.stringify(r));
}

console.log('\n── 3. 没有戳它的人时，latest 必须拒绝 ──');
{
  const r = resolvePokeTarget({ ref: 'latest', unread: [msg('甲', '1111111111', 'hi', 1)], recentMessages: [] });
  check('返回 not-found（不瞎选人）', !r.ok && r.reason === 'not-found', JSON.stringify(r));
}

console.log('\n── 4. 昵称解析 ──');
{
  const unread = [msg('群友C', '1000000003', '怎么一直戳我', 100)];
  const r1 = resolvePokeTarget({ ref: '群友C', unread, recentMessages: [] });
  check('昵称唯一命中', r1.ok && r1.userId === '1000000003' && r1.reason === 'name', JSON.stringify(r1));
  const r2 = resolvePokeTarget({ ref: 'testuser', unread: [msg('TestUser', '1000000003', '怎么一直戳我', 100)], recentMessages: [] });
  check('大小写不敏感', r2.ok && r2.userId === '1000000003', JSON.stringify(r2));

  // 同名两人 → 必须拒绝并列候选
  const dup = [
    msg('小明', '1111111111', 'a', 1),
    msg('小明', '2222222222', 'b', 2)
  ];
  const r3 = resolvePokeTarget({ ref: '小明', unread: dup, recentMessages: [] });
  check('同名多人时拒绝', !r3.ok && r3.reason === 'ambiguous', JSON.stringify(r3));
  check('拒绝时列出候选', Array.isArray(r3.candidates) && r3.candidates.length === 2);
  check('候选中带 QQ 号（便于改用号码）',
    (r3.candidates || []).every((c) => /^\d+$/.test(c.userId)));

  const r4 = resolvePokeTarget({ ref: '查无此人', unread, recentMessages: [] });
  check('查不到返回 not-found', !r4.ok && r4.reason === 'not-found');
  const r5 = resolvePokeTarget({ ref: '群友C', unread: [msg('群友C', '', 'x', 1)], recentMessages: [] });
  check('同名但缺 QQ 号 → not-found（不猜）', !r5.ok, JSON.stringify(r5));
}

console.log('\n── 5. 数字与空值 ──');
{
  const r = resolvePokeTarget({ ref: '1000000003', unread: [], recentMessages: [] });
  check('数字原样放行', r.ok && r.userId === '1000000003' && r.reason === 'numeric', JSON.stringify(r));
  check('空值返回 empty', !resolvePokeTarget({ ref: '   ' }).ok);
  check('undefined 安全', !resolvePokeTarget({}).ok);
}

console.log('\n── 6. 状态行必须带 QQ 号 ──');
{
  check('状态行拼入 QQ=', /QQ=\$\{m\.userId\}/.test(wakeSrc));
  check('提示可以直接传 targetUserId', /targetUserId="latest"/.test(wakeSrc));
  check('明确禁止用记忆里的号', /不要用记忆里别的号/.test(wakeSrc));
}

console.log('\n── 7. 自己的拍一拍记录写名字 ──');
{
  
  check('改成「你拍了拍 名字」', /\[拍一拍\] 你拍了拍 \$\{targetName\}/.test(consoleServerSrc));
  check('名字通过 resolveGroupMemberName 解析', /resolveGroupMemberName\(id, targetUserId\)/.test(consoleServerSrc));
  check('查不到名字时退回号（不影响发送）', /targetName = \(await resolveGroupMemberName\(id, targetUserId\)\) \|\| targetUserId/.test(consoleServerSrc));
}

console.log('\n── 8. 端点接线 ──');
{
  
  check('send-poke 里调用解析', /resolvePokeTarget\(\{[\s\S]{0,160}recentMessages: peek\.recentMessages/.test(consoleServerSrc));
  check('解析结果会覆盖 targetUserId', /targetUserId = resolved\.userId/.test(consoleServerSrc));
  check('同名多人返回 400 并给候选', /对应多人：/.test(consoleServerSrc));
  check('latest 无人可拍时给出明确原因', /最近没有戳你的人，无法用 latest/.test(consoleServerSrc));
  check('解析成功后记审计日志', /\[拍一拍\].*目标解析/.test(consoleServerSrc));
}

console.log('\n── 9. MCP 工具描述同步 ──');
{
  check('描述里提到 latest', /`latest`/.test(mcpSrc));
  check('描述里提到可用昵称', /对方在本群的昵称/.test(mcpSrc));
  check('描述里警告不要凭记忆填旧号', /不要凭记忆填一个旧号/.test(mcpSrc));
  check('schema 描述列出三种填法', /QQ 号 \/ 昵称 \/ "latest"/.test(mcpSrc));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
