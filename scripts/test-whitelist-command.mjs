// 回归测试：群白名单管理命令（/wl）的解析、增删语义与准入例外。
//
// 背景（2026-10-17 用户要求）：「添加一条管理员指令，能够控制群白名单，
// 包含添加进白名单和从中移除」。
//
// 这件事的三个坑（本测试分别守住）：
//   ① 准入闸门在命令块**之前**：新群还没进白名单时，消息会被直接丢弃，
//      `/wl add` 永远走不到命令处理——命令只能对已授权的群生效，等于没法加新群。
//      修法是闸门处开一个很窄的例外（仅群聊 + 仅 ownerQQ + 确实是白名单命令）。
//   ② 只改内存不写 config.json → 重启即丢；只写文件不同步内存 → 当前进程不认，
//      管理员看到"没生效"又去重启。两者必须都做，且写盘失败时**不许**改内存。
//   ③ 删到空与 allowAllWhenEmpty 的语义耦合：false 时白名单空 = 所有群都被拦，
//      包括管理员刚操作的这个群。这条必须显式告知，不能静默生效。
//
// 2026-10-24 重构第 2 步：解析/增删/闸门判定已迁到 src/admin-commands.js。
// 本测试直接 import 纯函数，不再从 bridge.js 抽源码文本。
import {
  parseWhitelistCommand,
  extractIdList,
  applyWhitelistChange,
  describeEmptyWhitelistRisk,
  rawTextOfMessage,
  isWhitelistCommand,
  canBypassAdmission
} from '../src/admin-commands.js';

let pass = 0, fail = 0;
const check = (n, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };

console.log('── 1. 命令解析 ──');
{
  const p = (t) => parseWhitelistCommand(t);

  check('/wl 单独 → list', p('/wl')?.action === 'list');
  check('/WL 大小写不敏感', p('/WL')?.action === 'list');
  check('/白名单 → list', p('/白名单')?.action === 'list');
  check('/wl add 1000000001 → add', p('/wl add 1000000001')?.action === 'add'
    && p('/wl add 1000000001').ids[0] === 1000000001);
  check('/wl del 1000000001 → del', p('/wl del 1000000001')?.action === 'del');
  check('/wl 移除 → del（中文）', p('/wl 移除 1000000001')?.action === 'del');
  check('/白名单 加 123456789 → add', p('/白名单 加 123456789')?.action === 'add');
  check('/wl add 多个（空格/逗号/顿号混用）', (() => {
    const r = p('/wl add 1000000001，1000000002、1000000003 1000000010');
    return r.ids.length === 4;
  })());
  check('/wl 1000000001（只给群号）按 add 处理', p('/wl 1000000001')?.action === 'add');
  check('/wl add 带 @ 残留不崩', p('/wl add @1000000001')?.ids.length === 1 || p('/wl add @1000000001')?.ids.length === 0);
  check('/wl 乱写 → help（提示用法，不当成加群）', p('/wl xyz')?.action === 'help');
  check('/wl add 无参数 → ids 为空', p('/wl add')?.ids.length === 0);

  // 不能抢 DSH / 普通消息
  check('普通消息不识别', p('白名单怎么改') === null);
  check('/model 不识别', p('/model') === null);
  check('/wlsomething 不识别（避免前缀误伤）', p('/wlsomething') === null);
  check('/白名单列表 不识别（命令后必须是空白或结尾）', p('/白名单列表') === null);
  check('空字符串不识别', p('') === null);
  check('null 不崩', p(null) === null);
}

console.log('\n── 2. 群号提取 ──');
{
  check('忽略非数字词', extractIdList('abc 123456789 def').length === 1);
  check('去重', extractIdList('123456789 123456789').length === 1);
  check('拒绝太短的（<5 位，防止手滑）', extractIdList('1234').length === 0);
  check('拒绝太长的（>12 位，超出 QQ 号范围）', extractIdList('1234567890123').length === 0);
  check('拒绝 0', extractIdList('0').length === 0);
  check('正常群号通过（实测群 1000000001）', extractIdList('1000000001')[0] === 1000000001);
}

console.log('\n── 3. 增删语义（含幂等）──');
{
  const base = [1000000001, 1000000002];

  const a = applyWhitelistChange(base, 'add', [1000000003]);
  check('加新群 → next 含三者', a.next.length === 3 && a.next.includes(1000000003));
  check('加新群 → added 记录', a.added.length === 1 && a.added[0] === 1000000003);
  check('加新群 → unchanged 为空', a.unchanged.length === 0);

  const dup = applyWhitelistChange(base, 'add', [1000000001]);
  check('重复加 → next 不变', dup.next.length === 2);
  check('重复加 → added 为空、unchanged 记录（命令要据此说"本来就在"）',
    dup.added.length === 0 && dup.unchanged[0] === 1000000001);

  const d = applyWhitelistChange(base, 'del', [1000000002]);
  check('删已有 → removed 记录', d.removed.length === 1 && d.next.length === 1);
  check('删已有 → 结果不含被删项', !d.next.includes(1000000002));

  const miss = applyWhitelistChange(base, 'del', [999999999]);
  check('删不存在 → 无变化、unchanged 记录', miss.removed.length === 0 && miss.unchanged[0] === 999999999);

  const all = applyWhitelistChange(base, 'del', base);
  check('删到空 → next 为空数组', Array.isArray(all.next) && all.next.length === 0);

  check('不改入参（纯函数）', base.length === 2, `实为 ${base.length}`);

  // 数字/字符串混写（config.json 里手写成字符串也要能用）
  const mixed = applyWhitelistChange(['1000000001'], 'add', [1000000003]);
  check('字符串与数字混写不产生重复', mixed.next.length === 2, JSON.stringify(mixed.next));

  const junk = applyWhitelistChange([null, 'abc', 1000000001], 'add', [1000000003]);
  check('入参里的脏值被过滤', junk.next.length === 2, JSON.stringify(junk.next));
}

console.log('\n── 4. 删到空的后果必须如实说明 ──');
{
  const riskOpen = describeEmptyWhitelistRisk(true);
  const riskClosed = describeEmptyWhitelistRisk(false);
  check('allowAllWhenEmpty=true → 说明仍全放行', /放行/.test(riskOpen));
  check('allowAllWhenEmpty=false → 说明所有群被拦', /拦截/.test(riskClosed));
  check('两种情况的说明不同', riskOpen !== riskClosed);
  check('空名单说明里给出自救方式（重新加本群）', /\/wl add/.test(riskClosed));
}

console.log('\n── 5. 闸门例外：解析门前的纯文本提取 ──');
{
  check('字符串消息', rawTextOfMessage('/wl add 123456789') === '/wl add 123456789');
  check('段数组拼接', rawTextOfMessage([
    { type: 'text', data: { text: '/wl add ' } },
    { type: 'text', data: { text: '123456789' } }
  ]) === '/wl add 123456789');
  check('忽略 at/image 段', rawTextOfMessage([
    { type: 'at', data: { qq: '111' } },
    { type: 'text', data: { text: '/wl' } },
    { type: 'image', data: {} }
  ]) === '/wl');
  check('空/null 不崩', rawTextOfMessage(null) === '' && rawTextOfMessage([]) === '');
}

console.log('\n── 6. 准入例外条件（必须窄）──');
{
  const base = { kind: 'group', mode: 'chat', ownerQQ: '123456', userId: '123456', text: '/wl add 123456' };
  check('群聊 + owner + /wl → 放行', canBypassAdmission(base) === true);
  check('非 owner → 不放行', canBypassAdmission({ ...base, userId: '999' }) === false);
  check('私聊 → 不放行', canBypassAdmission({ ...base, kind: 'private' }) === false);
  check('closed-agent → 不放行', canBypassAdmission({ ...base, mode: 'closed-agent' }) === false);
  check('ownerQQ 为空 → 不放行', canBypassAdmission({ ...base, ownerQQ: '' }) === false);
  check('非白名单命令 → 不放行', canBypassAdmission({ ...base, text: '/status' }) === false);
  check('/wlsomething 不误判', canBypassAdmission({ ...base, text: '/wlsomething' }) === false);
  check('空 ctx 不崩', canBypassAdmission() === false);
}

console.log('\n── 7. 命令识别与闸门同源 ──');
{
  const yes = ['/wl', '/WL', '/白名单', '/wl add 1000000001', '/wl del 1000000001', '/白名单 加 123456789'];
  const no = ['/model', '白名单怎么改', '/wlsomething', '/白名单列表', '', null];
  for (const c of yes) check(`isWhitelistCommand 识别 ${c}`, isWhitelistCommand(c) === true);
  for (const c of no) check(`isWhitelistCommand 不误判 ${JSON.stringify(c)}`, isWhitelistCommand(c) === false);
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
