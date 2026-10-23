// 回归测试：加好友 / 入群邀请的人工裁决。
//
// 需求（2026-10-20 用户）：「当 bot 账号被请求加好友或者拉进群的时候通知管理员
// 并且询问同意或拒绝」。
//
// 本测试锁住五条不变量：
//   ① 默认 **不自动同意**（fail-closed）：加好友/入群都在扩张攻击面
//   ② 超时要自动拒绝——不能让请求一直挂着（申请人看到"永远在等待"比拒绝更糟）
//   ③ 裁决指令**只认管理员私聊**：群里的"同意"可能是别人说的
//   ④ 多条待决时必须用编号，避免误批
//   ⑤ 队列落盘，桥接重启后管理员看到的通知仍然有效
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseJoinCommand, describeJoinRequest, createJoinQueue, DEFAULT_TTL_MS } from '../src/join-request.js';

let pass = 0, fail = 0;
const check = (n, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'joinreq-'));
const root = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Z]:)/, '$1') + '/..';

// ── 1. 指令解析 ──
console.log('── 1. 指令解析 ──');
{
  const cases = [
    ['/yes', 'approve', undefined],
    ['/yes 2', 'approve', 2],
    ['/no', 'reject', undefined],
    ['/no 3', 'reject', 3],
    ['/approve 1', 'approve', 1],
    ['/reject 2', 'reject', 2],
    ['/ok', 'approve', undefined],
    ['/deny', 'reject', undefined],
    ['同意', 'approve', undefined],
    ['拒绝', 'reject', undefined],
    ['同意 2', 'approve', 2],
    ['拒绝 1', 'reject', 1],
    ['批准 3', 'approve', 3],
    ['驳回 4', 'reject', 4],
    ['/pending', 'list', undefined],
    ['/list', 'list', undefined]
  ];
  for (const [input, action, index] of cases) {
    const r = parseJoinCommand(input);
    const ok = r?.action === action && r?.index === index;
    check(`解析「${input}」→ ${action}${index ? ' ' + index : ''}`, ok, JSON.stringify(r));
  }

  // 不该认的
  const bad = [
    ['你好', '普通聊天'],
    ['我同意你的看法，但是……', '长句不是指令'],
    ['/model', 'DSH 的命令'],
    ['/yesplease', '不是完整指令'],
    ['/status', '别的管理命令'],
    ['', '空串'],
    [null, 'null']
  ];
  for (const [input, label] of bad) {
    check(`不认「${label}」`, parseJoinCommand(input) === null, JSON.stringify(parseJoinCommand(input)));
  }
  check('中文长句里的"同意"不算（避免误判）', parseJoinCommand('我同意了，你看着办吧') === null);
}

// ── 2. 描述文案 ──
console.log('\n── 2. 描述文案 ──');
{
  const f = describeJoinRequest({ requestType: 'friend', userId: 123456, nickname: '群友T1', comment: '我是老王' });
  check('好友请求含昵称与号码', f.includes('群友T1') && f.includes('123456'));
  check('好友请求含验证消息', f.includes('我是老王'));

  const g = describeJoinRequest({ requestType: 'group', subType: 'invite', userId: 1, groupId: 999, groupName: '测试群' });
  check('群邀请含群号与群名', g.includes('999') && g.includes('测试群'));
  check('群邀请标明是"邀请"', g.includes('群邀请'));

  const a = describeJoinRequest({ requestType: 'group', subType: 'add', userId: 1, groupId: 999 });
  check('主动入群申请标明是"申请"', a.includes('入群申请'), a);

  check('缺昵称时不崩', describeJoinRequest({ requestType: 'friend', userId: 1 }).includes('1'));
}

// ── 3. 队列行为 ──
console.log('\n── 3. 队列 ──');
{
  let clock = 1_700_000_000_000;
  const q = createJoinQueue({ file: '', ttlMs: 60000, now: () => clock });

  const a = q.push({ requestType: 'friend', userId: 1, flag: 'f1' });
  const b = q.push({ requestType: 'group', groupId: 2, flag: 'g1' });
  check('入队分配递增编号', a.n === 1 && b.n === 2, `${a.n},${b.n}`);
  check('列表按编号升序', q.list().map((x) => x.n).join(',') === '1,2');

  // 多条时不许无编号操作（避免误批）
  const ambiguous = q.take();
  check('多条待决时要求指定编号', ambiguous.ok === false && /编号/.test(ambiguous.error), ambiguous.error);
  check('拒绝时给出候选列表', Array.isArray(ambiguous.candidates) && ambiguous.candidates.length === 2);
  check('被拒的无编号操作不影响队列', q.size() === 2);

  const one = q.take(1);
  check('指定编号可取出', one.ok === true && one.item.flag === 'f1');
  check('取出后编号不重排', q.list().map((x) => x.n).join(',') === '2');

  // 单条时允许无编号
  const single = q.take();
  check('只剩一条时可不带编号', single.ok === true && single.item.n === 2);

  check('空队列拿出报错', q.take().ok === false);
  check('拿不存在的编号报错', (() => { q.push({ requestType: 'friend', userId: 9, flag: 'x' }); return q.take(99).ok === false; })());

  // 超时
  const q2 = createJoinQueue({ file: '', ttlMs: 60000, now: () => clock });
  q2.push({ requestType: 'friend', userId: 1, flag: 'a' });
  clock += 61000;
  check('超时后 list 为空', q2.list().length === 0);
  check('超时项被 pruneExpired 返回（供自动拒绝）',
    (() => { const q3 = createJoinQueue({ file: '', ttlMs: 60000, now: () => clock }); q3.push({ requestType: 'friend', userId: 2, flag: 'b' }); clock += 61000; return q3.pruneExpired().length === 1; })());
  check('默认 TTL 是 5 分钟', DEFAULT_TTL_MS === 5 * 60 * 1000, String(DEFAULT_TTL_MS));
}

// ── 3b. takeWhere：外部状态让请求作废（机器人已进群） ──
console.log('\n── 3b. 按条件作废 ──');
{
  // 2026-10-22 事故：QQ 自动同意了邀请，管理员 /yes 时请求已不存在。
  // 入群通知到达后要把**同群的 invite** 全部作废，但不能误删入群申请/好友请求。
  let clock2 = 1_700_000_000_000;
  const q = createJoinQueue({ file: '', ttlMs: 600000, now: () => clock2 });
  q.push({ requestType: 'group', subType: 'invite', groupId: 99, flag: 'i1' });
  q.push({ requestType: 'group', subType: 'invite', groupId: 99, flag: 'i2' });
  q.push({ requestType: 'group', subType: 'add', groupId: 99, flag: 'a1' });
  q.push({ requestType: 'friend', userId: 5, flag: 'f1' });
  const removed = q.takeWhere((it) => it.requestType === 'group'
    && it.subType === 'invite' && Number(it.groupId) === 99);
  check('takeWhere 只删匹配的邀请', removed.length === 2 && removed.map((x) => x.n).join(',') === '1,2',
    JSON.stringify(removed.map((x) => x.n)));
  check('不误删同群的入群申请', q.list().some((it) => it.flag === 'a1'));
  check('不误删好友请求', q.list().some((it) => it.flag === 'f1'));
  check('takeWhere 无匹配时返回空数组', q.takeWhere(() => false).length === 0);
  check('takeWhere 后队列仍可用', q.size() === 2 && q.take(3).ok === true);
}

// ── 4. 落盘与重启 ──
console.log('\n── 4. 落盘 ──');
{
  const f = path.join(tmp, 'q.json');
  const q = createJoinQueue({ file: f, ttlMs: 600000, now: () => Date.now() });
  q.push({ requestType: 'friend', userId: 42, nickname: '存活测试', flag: 'keep' });

  // 模拟重启：新建实例从同一个文件读
  const q2 = createJoinQueue({ file: f, ttlMs: 600000, now: () => Date.now() });
  const list = q2.list();
  check('重启后待决请求还在', list.length === 1 && list[0].userId === 42, JSON.stringify(list.map((x) => x.n)));
  check('编号在重启后保持', list[0].n === 1, String(list[0].n));

  // 新请求编号要继续递增（不能与已有编号撞）
  const next = q2.push({ requestType: 'group', groupId: 7, flag: 'next' });
  check('重启后新编号不与旧编号冲突', next.n === 2, String(next.n));

  // 损坏文件不崩
  fs.writeFileSync(path.join(tmp, 'broken.json'), '{ not json');
  const q3 = createJoinQueue({ file: path.join(tmp, 'broken.json'), ttlMs: 600000 });
  check('损坏的队列文件按空处理', q3.list().length === 0);
  check('损坏后仍可入队', q3.push({ requestType: 'friend', userId: 1, flag: 'z' }).n >= 1);

  // 启动时已过期的项必须能被取出补拒绝（2026-10-20 实测：不捞出来就
  // "静默消失"——队列没了、QQ 侧却从没收到拒绝，申请人一直挂着等）
  {
    const f2 = path.join(tmp, 'stale.json');
    const t = Date.now();
    const mk = (n, ageMs) => ({ n, flag: `F${n}`, requestType: 'friend', userId: n, at: t - ageMs });
    fs.writeFileSync(f2, JSON.stringify({ seq: 3, items: [mk(1, 20 * 60 * 1000), mk(2, 20 * 60 * 1000), { ...mk(3, 0), requestType: 'group', groupId: 9 }] }));
    const q4 = createJoinQueue({ file: f2, ttlMs: 60000, now: () => t });
    const stale = q4.takeExpiredAtStartup();
    check('启动时捞出已过期项供补拒绝', stale.length === 2, String(stale.length));
    check('未过期的仍留在队列', q4.list().length === 1 && q4.list()[0].n === 3);
    check('补拒绝只能取一次（避免重复提交）', q4.takeExpiredAtStartup().length === 0);
  }
}

// ── 5. 桥接接线 ──
console.log('\n── 5. 桥接接线 ──');
{
  const bridge = fs.readFileSync(path.join(root, 'src', 'bridge.js'), 'utf8');
  const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
  const consoleHtml = fs.readFileSync(path.join(root, 'public', 'console.html'), 'utf8');

  check('监听 request 事件', /bot\.onRequest\(/.test(bridge));
  check('处理加好友请求', /setFriendAddRequest/.test(bridge));
  check('处理入群邀请', /setGroupAddRequest/.test(bridge));
  check('通知管理员私聊', /notifyJoinRequest/.test(bridge) && /private:\$\{owner\}/.test(bridge));
  check('超时会自动拒绝', /pruneExpired\(\)[\s\S]{0,400}submitJoinDecision\(it, false, '超时未处理'\)/.test(bridge));
  check('启动时补拒绝旧请求（否则静默消失、QQ 侧一直挂着）',
    /takeExpiredAtStartup\(\)[\s\S]{0,400}submitJoinDecision\(it, false, '超时未处理'\)/.test(bridge));
  check('定时清理（不是被动等下一个请求）', /setInterval\([\s\S]{0,300}pruneExpired/.test(bridge));
  check('通知失败时自动拒绝（不留悬挂）', /无法通知管理员/.test(bridge));
  check('裁决指令在一切之前处理', /if \(await handleJoinDecisionCommand\(key, plainContent\)\) return;/.test(bridge));
  check('裁决只认管理员私聊', /key !== `private:\$\{owner\}`/.test(bridge));
  check('管理员指令识别包含 /yes', /parseJoinCommand\(plainContent\) !== null/.test(bridge));
  check('有状态端点', /\/api\/socialV2\/join-requests/.test(bridge));

  // 2026-10-22 事故：邀请已被 QQ 自动同意，管理员 /yes 报 "matching group request not found"。
  // 三道防线：入队前查成员身份 / 入群通知作废队列 / 提交失败时区分"已在群"与"已失效"。
  check('入队前检查机器人是否已在群', /isBotInGroupV2\(item\.groupId\)/.test(bridge));
  check('入群通知按群作废待决邀请', /onNotice\('group_increase'/.test(bridge) && /takeWhere\(/.test(bridge));
  check('同意邀请前也检查是否已在群', /isInvite && approve === true && await isBotInGroupV2/.test(bridge));
  check('提交失败时返回结构化结果', /return \{ ok: false, error: msg, expired \}/.test(bridge));
  check('已在群时不报失败', /alreadyJoined: true/.test(bridge) && /已经处理过了：机器人已在群里/.test(bridge));
  check('请求失效时提示去 QQ 侧确认', /请求已经失效（QQ 侧可能已自动同意或过期）/.test(bridge));

  // 配置默认值（fail-closed）
  check('配置默认不自动同意', cfg.socialV2?.joinRequest?.autoApprove === false,
    String(cfg.socialV2?.joinRequest?.autoApprove));
  check('配置默认开启通知', cfg.socialV2?.joinRequest?.enabled !== false);
  check('配置 TTL 是 5 分钟', Number(cfg.socialV2?.joinRequest?.ttlMs) === 300000,
    String(cfg.socialV2?.joinRequest?.ttlMs));
  // 代码里的默认值也必须是 fail-closed（配置缺失时不能意外放行）
  check('代码默认 autoApprove: false', /autoApprove: false/.test(bridge));

  // 控制台
  check('控制台有卡片', /id="joinRequestCard"/.test(consoleHtml));
  check('控制台显示待决列表', /id="joinReqList"/.test(consoleHtml));
  check('控制台说明默认不自动同意', /默认<b>不自动同意<\/b>/.test(consoleHtml));
  check('控制台挂进轮询', /refreshJoinRequests\(\)/.test(consoleHtml));
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
