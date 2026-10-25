// 回归测试：私聊准入策略（白名单 / 好友自动放行 / 纯黑名单）。
//
// 背景（2026-10-12 用户要求）：「所有能够加好友的都是我亲自确认的，免得每次都要我手动添加」
// —— 想把私聊从白名单制改成黑名单制。
//
// ⚠️ 但**不能简单全放开**：实测 SnowLuma 的私聊分两类（源码注释原文：
//   "friend_message and temp_message differ only in `sub_type` ('friend' vs 'group')"）——
// 即 `sub_type: 'group'` 是**临时会话**，群里非好友点开就能发。所以「能加我好友的都确认过」
// 这个前提**只对 sub_type='friend' 成立**。于是引入三态策略，默认推荐 'friends'：
//   好友自动放行（免手动维护）+ 非好友（临时会话）仍需白名单。
//
// 这个测试直接跑真实实现（直接 import 准入模块），保证测的是跑着的代码。
import { normalizePrivateMode, privateAllowed } from '../src/pipeline/admission.js';
import { incomingHarness } from './helpers/pipeline-harness.mjs';

let pass = 0, fail = 0;
const check = (n, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };

const cfgOf = (privateMode, allowPrivate = [], denyPrivate = []) => ({
  allow: { private: allowPrivate.map(String), groups: [], privateMode },
  deny: { private: denyPrivate.map(String), groups: [] },
  allowAllWhenEmpty: false
});
const FRIENDS = new Set(['1001', '1002']);

console.log('── 策略值规范化：非法值必须 fail-closed 回落到白名单 ──');
{
  check('friends', normalizePrivateMode('friends') === 'friends');
  check('friend 单数也算', normalizePrivateMode('friend') === 'friends');
  check('all', normalizePrivateMode('all') === 'all');
  check('list', normalizePrivateMode('list') === 'list');
  check('大小写不敏感', normalizePrivateMode('FRIENDS') === 'friends');
  check('空值 → list', normalizePrivateMode('') === 'list');
  check('undefined → list', normalizePrivateMode(undefined) === 'list');
  check('拼错（frends）→ list（不能意外全放开）', normalizePrivateMode('frends') === 'list');
  check('危险值（true/1/open）→ list', normalizePrivateMode(true) === 'list' && normalizePrivateMode(1) === 'list' && normalizePrivateMode('open') === 'list');
}

console.log('\n── 模式 list：旧行为（只有白名单能私聊）──');
{
  const cfg = cfgOf('list', [1001]);
  check('白名单内放行', privateAllowed(1001, cfg, FRIENDS) === true);
  check('名单外拒绝', privateAllowed(9999, cfg, FRIENDS) === false);
  check('即使是好友也拒绝（list 不看好关系）', privateAllowed(1002, cfg, FRIENDS) === false);
}

console.log('\n── 模式 friends：好友自动放行（用户要的免维护）──');
{
  const cfg = cfgOf('friends', []);
  check('好友放行（未列进白名单）', privateAllowed(1001, cfg, FRIENDS) === true);
  check('另一个好友也放行', privateAllowed(1002, cfg, FRIENDS) === true);
  check('非好友拒绝（临时会话被挡住）', privateAllowed(9999, cfg, FRIENDS) === false);
  // 非好友但显式加进白名单 → 放行（保留"手动兜底"能力）
  const cfg2 = cfgOf('friends', [9999]);
  check('非好友但显式加白名单 → 放行', privateAllowed(9999, cfg2, FRIENDS) === true);
  check('好友与白名单并存互不影响', privateAllowed(1001, cfg2, FRIENDS) === true);
}

console.log('\n── 模式 all：纯黑名单（用户原意，但风险最大）──');
{
  const cfg = cfgOf('all', []);
  check('任何陌生人都放行', privateAllowed(9999, cfg, FRIENDS) === true);
  check('非好友也放行', privateAllowed(12345, cfg, FRIENDS) === true);
}

console.log('\n── deny 必须是最高优先级（三种模式都压不住它）──');
{
  for (const mode of ['list', 'friends', 'all']) {
    const cfg = cfgOf(mode, [1001], [1001]);
    check(`${mode}: 命中 deny 的好友也拒绝`, privateAllowed(1001, cfg, FRIENDS) === false);
    const cfg2 = cfgOf(mode, [], [8888]);
    check(`${mode}: 命中 deny 的陌生人拒绝`, privateAllowed(8888, cfg2, FRIENDS) === false);
  }
}

console.log('\n── 边界 ──');
{
  const cfg = cfgOf('friends', []);
  check('空好友集合 → 非白名单一律拒', privateAllowed(1001, cfg, new Set()) === false);
  check('数字与字符串 id 一致（int64 序列化差异）', privateAllowed('1001', cfg, FRIENDS) === true);
  check('前导零不误判', privateAllowed('01001', cfg, FRIENDS) === false);
}

console.log('\n── 新加好友必须立刻能用（2026-10-13「私聊怎么不回人了」）──');
{
  // 实测现场：好友列表缓存 6 人（5 分钟 TTL），用户新加好友 100002029（昵称"牢"），
  // 之后发了两条私聊全被丢弃，日志只有 `忽略未授权会话 private:100002029`。
  // SnowLuma 侧查同一个人是好友 —— 纯属缓存过期，不是陌生人。
  //
  // 修法：私聊被拒时强制刷新一次好友列表（带全局限流）再定论。
  const cfg = cfgOf('friends', []);
  const stale = new Set(['100002000', '100002003']);            // 旧缓存（缺新好友）
  const fresh = new Set([...stale, '100002029']);                 // 刷新后
  check('缓存过期时新好友被拒（复现 bug）', privateAllowed(100002029, cfg, stale) === false);
  check('刷新后同一好友放行（修复生效）', privateAllowed(100002029, cfg, fresh) === true);
  check('刷新不会误放陌生人', privateAllowed(9999999999, cfg, fresh) === false);

  const h = incomingHarness({ refreshFriendList: async () => h.friends.add('3') });
  check('私聊被拒时刷新后重判放行', await h.stages.admit(h.context('你好', {}, 'private', '3')));
  const denied = incomingHarness();
  await denied.stages.admit(denied.context('你好', {}, 'private', '3'));
  await denied.stages.admit(denied.context('你好', {}, 'private', '4'));
  check('强刷限流', denied.calls.filter(c => c[0] === 'refresh').length === 1);
  check('拒绝路径可观测', denied.calls.some(c => c[0] === 'log' && c[1].includes('忽略未授权会话')));

}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
