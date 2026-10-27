// 回归测试：非白名单群的 @ 提示（预设话术，不调用 DSH、不耗 token）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0, fail = 0;
const check = (n, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };

const root = path.dirname(fileURLToPath(import.meta.url)) + '/..';
const m = await import(new URL('../src/whitelist-notice.js', import.meta.url));
const { isAtBotInMessage, buildWhitelistNotice, takeWhitelistNotice, DEFAULT_WHITELIST_NOTICE_MESSAGES } = m;

console.log('── 1. @机器人 识别 ──');
{
  const self = '1000000001';
  check('at 段数字 qq → true', isAtBotInMessage([{ type: 'at', data: { qq: 1000000001 } }], self));
  check('at 段字符串 qq → true', isAtBotInMessage([{ type: 'at', data: { qq: '1000000001' } }], self));
  check('@全体成员 → false', !isAtBotInMessage([{ type: 'at', data: { qq: 'all' } }], self));
  check('@别人 → false', !isAtBotInMessage([{ type: 'at', data: { qq: '123456' } }], self));
  check('普通文本 → false', !isAtBotInMessage([{ type: 'text', data: { text: '@机器人 你好' } }], self));
  check('字符串消息 → false（不猜）', !isAtBotInMessage('@机器人 你好', self));
  check('selfId 为空 → false', !isAtBotInMessage([{ type: 'at', data: { qq: '1000000001' } }], ''));
}

console.log('── 2. 预设话术 ──');
{
  check('ownerQQ 为空 → null', buildWhitelistNotice({ ownerQQ: '', groupId: 123 }) === null);
  const r = buildWhitelistNotice({ ownerQQ: '1000000000', groupId: '1000000002', random: () => 0 });
  check('默认话术至少 3 条', DEFAULT_WHITELIST_NOTICE_MESSAGES.length >= 3);
  check('返回一条文本和索引', !!r && typeof r.text === 'string' && Number.isInteger(r.index));
  check('包含管理员 QQ', r.text.includes('1000000000'), r.text);
  check('包含群号', r.text.includes('1000000002'), r.text);
  check('占位符已替换干净', !r.text.includes('{ownerQQ}') && !r.text.includes('{groupId}'));

  const custom = buildWhitelistNotice({
    ownerQQ: '42', groupId: 7, groupName: '测试群',
    messages: ['找 {ownerQQ}（群 {groupName} / {groupId}）', '第二条'],
    random: () => 0
  });
  check('自定义话术生效', custom.text === '找 42（群 测试群 / 7）', custom.text);
  check('excludeIndex 避免连续重复', (() => {
    const x = buildWhitelistNotice({ ownerQQ: '42', groupId: 7, messages: ['A', 'B'], random: () => 0, excludeIndex: 0 });
    return x.index === 1;
  })());
  check('自定义列表为空时回落默认', (() => {
    const x = buildWhitelistNotice({ ownerQQ: '42', groupId: 7, messages: ['', '   '], random: () => 0 });
    return !!x && x.text.includes('42') && x.text.includes('7') && x.text.trim().length > 20;
  })());
}

console.log('── 3. 群级限频 ──');
{
  const cache = new Map();
  const t0 = 1_000_000;
  const e1 = takeWhitelistNotice(cache, 'group:1', { cooldownMs: 60000, now: t0 });
  check('第一次允许', !!e1 && e1.count === 1, JSON.stringify(e1));
  check('冷却内拒绝', takeWhitelistNotice(cache, 'group:1', { cooldownMs: 60000, now: t0 + 30000 }) === null);
  const e2 = takeWhitelistNotice(cache, 'group:1', { cooldownMs: 60000, now: t0 + 60000 });
  check('冷却后允许', !!e2 && e2.count === 2, JSON.stringify(e2));
  check('索引保留（供避免重复用）', e2.index === e1.index);
  const cache2 = new Map();
  for (let i = 1; i <= 3; i++) takeWhitelistNotice(cache2, 'group:' + i, { cooldownMs: 0, now: t0 + i, maxEntries: 2 });
  check('超过 maxEntries 淘汰最旧', cache2.size === 2 && !cache2.has('group:1'), [...cache2.keys()].join(','));
}

console.log('── 4. 真实提示发送适配器 ──');
{
  const sent=[];
  const notify=m.createWhitelistNotifier({ getSelfQQ:()=> '9', whitelistNoticeCache:new Map(), onebotSend:async (...a)=>sent.push(a), log:()=>{} });
  const cfg={ownerQQ:'42',deny:{groups:['2']},socialV2:{whitelistNotice:{}}};
  const event={user_id:7,self_id:9,message:[{type:'at',data:{qq:'9'}}]};
  await notify('1',event,cfg);
  check('未授权群 @ 使用预设直发', sent.length===1 && sent[0][0]==='group' && sent[0][2].includes('42'));
  await notify('1',event,cfg);
  check('同群重复 @ 限流',sent.length===1);
  await notify('2',event,cfg);
  await notify('3',{...event,user_id:42},cfg);
  await notify('4',{...event,message:[]},cfg);
  check('黑名单/管理员自己/普通消息都不提示',sent.length===1);
  for (const f of ['config.json', 'config.example.json']) {
    const cfg = JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));
    check(`${f} 有 whitelistNotice`, cfg.socialV2?.whitelistNotice?.enabled === true, JSON.stringify(cfg.socialV2?.whitelistNotice));
  }
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
