// 回归测试：群白名单管理命令（/wl）。
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
// 解析/增删都是从 bridge.js 抽真实函数来跑（不复制逻辑），另做源码级断言防漂移。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0, fail = 0;
const check = (n, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };

const root = path.dirname(fileURLToPath(import.meta.url)) + '/..';
const src = fs.readFileSync(path.join(root, 'src/bridge.js'), 'utf8');

// ── 从源码抽真实函数（改动源码时这里跟着走，不会两处漂移）──────────────────
function grabFn(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`找不到 ${name}()`);
  let depth = 0;
  let i = src.indexOf('{', start);
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(start, i + 1);
}
const grabConst = (name) => {
  const m = new RegExp(`const ${name} = [^;]+;`).exec(src);
  if (!m) throw new Error(`找不到常量 ${name}`);
  return m[0];
};

const sandbox = new Function(
  `${grabConst('WHITELIST_CMD_RE')}
   ${grabFn('parseWhitelistCommand')}
   ${grabFn('extractIdList')}
   ${grabFn('applyWhitelistChange')}
   ${grabFn('describeEmptyWhitelistRisk')}
   ${grabFn('rawTextOfMessage')}
   return { parseWhitelistCommand, extractIdList, applyWhitelistChange, describeEmptyWhitelistRisk, rawTextOfMessage };`
)();
const {
  parseWhitelistCommand, extractIdList, applyWhitelistChange,
  describeEmptyWhitelistRisk, rawTextOfMessage
} = sandbox;

console.log('── 1. 命令解析 ──');
{
  const p = (t) => parseWhitelistCommand(t);

  check('/wl 单独 → list', p('/wl')?.action === 'list');
  check('/WL 大小写不敏感', p('/WL')?.action === 'list');
  check('/白名单 → list', p('/白名单')?.action === 'list');
  check('/wl add 100001004 → add', p('/wl add 100001004')?.action === 'add'
    && p('/wl add 100001004').ids[0] === 100001004);
  check('/wl del 100001004 → del', p('/wl del 100001004')?.action === 'del');
  check('/wl 移除 → del（中文）', p('/wl 移除 100001004')?.action === 'del');
  check('/白名单 加 123456789 → add', p('/白名单 加 123456789')?.action === 'add');
  check('/wl add 多个（空格/逗号/顿号混用）', (() => {
    const r = p('/wl add 100001004，100001030、100001031 100001032');
    return r.ids.length === 4;
  })());
  check('/wl 100001004（只给群号）按 add 处理', p('/wl 100001004')?.action === 'add');
  check('/wl add 带 @ 残留不崩', p('/wl add @100001004')?.ids.length === 1 || p('/wl add @100001004')?.ids.length === 0);
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
  check('正常群号通过（实测群 100001004）', extractIdList('100001004')[0] === 100001004);
}

console.log('\n── 3. 增删语义（含幂等）──');
{
  const base = [100001004, 100001030];

  const a = applyWhitelistChange(base, 'add', [100001031]);
  check('加新群 → next 含三者', a.next.length === 3 && a.next.includes(100001031));
  check('加新群 → added 记录', a.added.length === 1 && a.added[0] === 100001031);
  check('加新群 → unchanged 为空', a.unchanged.length === 0);

  const dup = applyWhitelistChange(base, 'add', [100001004]);
  check('重复加 → next 不变', dup.next.length === 2);
  check('重复加 → added 为空、unchanged 记录（命令要据此说"本来就在"）',
    dup.added.length === 0 && dup.unchanged[0] === 100001004);

  const d = applyWhitelistChange(base, 'del', [100001030]);
  check('删已有 → removed 记录', d.removed.length === 1 && d.next.length === 1);
  check('删已有 → 结果不含被删项', !d.next.includes(100001030));

  const miss = applyWhitelistChange(base, 'del', [999999999]);
  check('删不存在 → 无变化、unchanged 记录', miss.removed.length === 0 && miss.unchanged[0] === 999999999);

  const all = applyWhitelistChange(base, 'del', base);
  check('删到空 → next 为空数组', Array.isArray(all.next) && all.next.length === 0);

  check('不改入参（纯函数）', base.length === 2, `实为 ${base.length}`);

  // 数字/字符串混写（config.json 里手写成字符串也要能用）
  const mixed = applyWhitelistChange(['100001004'], 'add', [100001031]);
  check('字符串与数字混写不产生重复', mixed.next.length === 2, JSON.stringify(mixed.next));

  const junk = applyWhitelistChange([null, 'abc', 100001004], 'add', [100001031]);
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

console.log('\n── 6. 源码接线（防漏接/防漂移）──');
{
  // ① 命令必须被 adminCmd 识别，否则挂起提问期间会被当"回答"吞掉
  const adminCmdStart = src.indexOf('const adminCmd = ');
  const adminCmdExpr = src.slice(adminCmdStart, src.indexOf(';', src.indexOf('.test(plainContent)', adminCmdStart)) + 1);
  check('adminCmd 覆盖白名单命令', /parseWhitelistCommand\(plainContent\)/.test(adminCmdExpr), adminCmdExpr.slice(-120));

  // ② 闸门例外：必须是群聊 + ownerQQ + 该命令
  check('闸门例外已定义', /const ownerWhitelistCmd = /.test(src));
  check('例外只看群聊', /const ownerWhitelistCmd = kind === 'group'/.test(src));
  check('例外排除 closed-agent', /currentMode !== 'closed-agent'/.test(src));
  check('例外要求是 ownerQQ', /String\(event\.user_id\) === String\(cfg\.ownerQQ\)/.test(src));
  check('例外要求确实是白名单命令', /parseWhitelistCommand\(rawTextOfMessage\(event\.message\)\)/.test(src));
  check('闸门条件用上了例外', /!modeAllowed\(key, kind, id, cfg, currentMode\) && !ownerWhitelistCmd/.test(src));

  // ③ 持久化：写盘 + 同步内存，两者都要
  const cmdStart = src.indexOf('// ── 群白名单管理：/wl');
  const cmdEnd = src.indexOf('// 其余 / 开头内容照常发给 DSH', cmdStart);
  const block = src.slice(cmdStart, cmdEnd);
  check('命令处理块存在', cmdStart > 0 && cmdEnd > cmdStart);
  check('写 config.json', /atomicWriteJson\(configFile, file\)/.test(block));
  check('同步内存 cfg.allow.groups', /cfg\.allow\.groups = next/.test(block));
  check('写盘失败时不改内存（先 return）', (() => {
    const i = block.indexOf('atomicWriteJson(configFile, file)');
    const j = block.indexOf('cfg.allow.groups = next');
    // try/catch 包住写盘，catch 里 return：内存赋值必须在 try 之后
    return i > 0 && j > i && /catch \(error\) \{[\s\S]*?notifyOwnerOfError[\s\S]*?return;/.test(block.slice(i, j));
  })());
  check('配置损坏时 fail-fast 且不回写', /readJsonSafe\(configFile, null, true\)/.test(block));
  check('无变化时不写盘（先 return）', (() => {
    const i = block.indexOf('if (!added.length && !removed.length)');
    const j = block.indexOf('atomicWriteJson(configFile, file)');
    return i > 0 && i < j;
  })());
  check('只改群名单，不碰私聊名单', !/file\.allow\.private\s*=/.test(block));
  check('私聊里改群白名单被拒（语义分离）', /群白名单只能在群里操作/.test(block));
  check('移出当前群时明确告知', /本群已被移出/.test(block));
  check('删到空时附带风险说明', /describeEmptyWhitelistRisk\(cfg\.allowAllWhenEmpty\)/.test(block));
  check('操作写入日志', /管理命令 \/wl/.test(block));
}

console.log('\n── 7. 与 allowed() 的语义一致 ──');
{
  const wlBlock = (() => {
    const a = src.indexOf('// ── 群白名单管理：/wl');
    const b = src.indexOf('// 其余 / 开头内容照常发给 DSH', a);
    return src.slice(a, b);
  })();
  // /wl 改的是 allow.groups，allowed('group', ...) 读的就是它；不能另开一份名单
  check('allowed() 读 cfg.allow[kind]', /const allowList = cfg\.allow\[kind\] \?\? cfg\.allow\[kind \+ 's'\] \?\? \[\];/.test(src));
  check('命令块只写 allow.groups', /file\.allow = \{\s*\n\s*\.\.\.\(file\.allow \?\? \{\}\),\s*\n\s*groups: next/.test(wlBlock));
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
