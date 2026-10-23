// 回归测试：区分三种身份（后台管理员 / 群主 / 群管理员）。
//
// 背景（2026-10-16 用户要求）：「让机器人能够区分机器人管理员（后台管理员）、群主、群管理员
// 这三者并且在群聊时能看到群主和群管理员标识」。
//
// 三个概念必须分清，混起来会出事：
//   ① 后台管理员 = config.ownerQQ（= isOwner）—— **唯一**能执行管理命令/写操作（删表情、改备注）的身份
//   ② 群主 = sender.role === 'owner' —— 群里的身份，与①无关（群主未必是后台管理员）
//   ③ 群管理员 = sender.role === 'admin' —— 群里的身份，与①②都无关
// 典型反例：别把群主当"你的主人"——他管群，不管机器人的设置。
// 上一版人格卡就写错了（说【管理员】是群主），本测试守住这个区分。
//
// 数据来源实测（SnowLuma 的 sender 里带 role 字段，messages.db 三值分布：
// member 23395 / admin 21937 / owner 9414）；群成员 API 复核：
// 群 100001004 有 owner×1 + admin×5；群 100001005 有 owner×1 + admin×10。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0, fail = 0;
const check = (n, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };

const root = path.dirname(fileURLToPath(import.meta.url)) + '/..';
const src = fs.readFileSync(path.join(root, 'src/bridge.js'), 'utf8');
const roleSrc = fs.readFileSync(path.join(root, 'roles/大肥鱼.md'), 'utf8');

console.log('── 1. 群角色进入消息数据 ──');
{
  check('读取 sender.role', /event\.sender\?\.role/.test(src));
  check('归一化为小写', /String\(event\.sender\?\.role \?\? ''\)\.trim\(\)\.toLowerCase\(\)/.test(src));
  check('两条消息路径都取了 role（reserved2 + reserved）',
    (src.match(/const groupRole = kind === 'group'/g) || []).length === 2);
  check('appendSocialV2Message 接收 groupRole',
    /function appendSocialV2Message\([^)]*groupRole = ''(?:,|\))/.test(src));
  // 签名后面可能继续追加参数（如 share 上下文），不要要求 groupRole 必须是最后一个
  check('appendRecentMessage 接收 groupRole',
    /function appendRecentMessage\([^)]*groupRole = ''(?:,|\))/.test(src));
  check('消息对象存 groupRole', /groupRole: groupRole \|\| ''/.test(src));
  check('并存 isGroupOwner / isGroupAdmin 布尔量',
    /isGroupOwner: groupRole === 'owner'/.test(src) && /isGroupAdmin: groupRole === 'admin'/.test(src));
}

console.log('\n── 2. 三个身份必须分离（本需求的核心）──');
{
  // identityTagOf 是唯一渲染身份的地方；抽出它验证语义
  const fn = /function identityTagOf\(m\) \{[\s\S]*?\n\}/.exec(src)?.[0];
  check('identityTagOf 已定义', !!fn);
  const identityTagOf = new Function(`${fn}; return identityTagOf;`)();

  check('后台管理员 → 【管理员】', identityTagOf({ isOwner: true }) === '【管理员】');
  check('群主 → 【群主】', identityTagOf({ isGroupOwner: true }) === '【群主】');
  check('群管理员 → 【群管理员】', identityTagOf({ isGroupAdmin: true }) === '【群管理员】');
  check('普通群友 → 无标记', identityTagOf({}) === '');
  check('私聊（无角色字段）→ 无标记', identityTagOf({ isOwner: false, groupRole: '' }) === '');
  check('null 不崩', identityTagOf(null) === '');
  check('空对象不崩', identityTagOf(undefined) === '');

  // 关键：群主**不能**被判成后台管理员
  check('群主不等于后台管理员', identityTagOf({ isGroupOwner: true }) !== '【管理员】');
  check('群管理员不等于后台管理员', identityTagOf({ isGroupAdmin: true }) !== '【管理员】');

  // 叠加：一个人可能同时是多种身份
  const both = identityTagOf({ isOwner: true, isGroupOwner: true });
  check('同时是后台管理员+群主 → 两个标记都在', both.includes('【管理员】') && both.includes('【群主】'));
  const adminOwner = identityTagOf({ isOwner: true, isGroupAdmin: true });
  check('同时是后台管理员+群管理员 → 两个标记都在', adminOwner.includes('【管理员】') && adminOwner.includes('【群管理员】'));
  // 群主与群管理员是互斥的（同一个人不会既是群主又是管理员）
  check('群主优先于群管理员（互斥时只显示群主）',
    identityTagOf({ isGroupOwner: true, isGroupAdmin: true }) === '【群主】');
}

console.log('\n── 3. 所有标记点都用统一 helper（防漏改）──');
{
  const oldStyle = (src.match(/isOwner \? '【管理员】' : ''/g) || []).length;
  check('没有残留的手写【管理员】三元式', oldStyle === 0, String(oldStyle));
  check('helper 被多处复用（>=6 处）', (src.match(/identityTagOf\(/g) || []).length >= 6,
    String((src.match(/identityTagOf\(/g) || []).length));
}

console.log('\n── 4. 序列化白名单（踩过的坑）──');
{
  // saveSocialV2State 是白名单式序列化，新字段不补进去就静默丢失
  check('lastRequesterId 在白名单里', /lastRequesterId: st\.lastRequesterId/.test(src));
  check('lastRequesterRole 在白名单里', /lastRequesterRole: st\.lastRequesterRole/.test(src));
  check('requester 角色与实际角色同源', /st\.lastRequesterRole = groupRole/.test(src));
}

console.log('\n── 5. 人格卡必须讲清三者区别 ──');
{
  check('提到【群主】', /【群主】/.test(roleSrc));
  check('提到【群管理员】', /【群管理员】/.test(roleSrc));
  check('明确【管理员】= 主人（ownerQQ），不是群主',
    /【管理员】.*你的主人/.test(roleSrc));
  check('明确群主不等于主人', /群主.*不等于你的主人|不等于你的主人/.test(roleSrc));
  check('写操作只给【管理员】', /写操作.*只有【管理员】能做/.test(roleSrc));
  check('明确群主/群管理员不能指使管理操作', /不能指使你做管理操作/.test(roleSrc));
  check('要求不点破身份（避免出戏）', /不用特意点破/.test(roleSrc));
  // 反面：不能把【管理员】说成群主（上一版的错误）
  check('没有"【管理员】=群主"的错误说法', !/【管理员】[^。]*群主本人/.test(roleSrc));
}

console.log('\n── 6. 管理权限不受群身份影响（安全边界）──');
{
  // 群主/群管理员**不**能执行写操作：判据只认 ownerQQ
  check('isOwnerTurn 只比 ownerQQ', /const owner = String\(cfg\.ownerQQ \?\? ''\)\.trim\(\);[\s\S]{0,200}requester === owner/.test(src));
  check('isOwnerTurn 不看群角色', !/isOwnerTurn[\s\S]{0,300}isGroupOwner/.test(src));
  check('删除端点用 isOwnerTurn 判定', /sticker-delete[\s\S]{0,1200}isOwnerTurn\(key\)/.test(src));
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
