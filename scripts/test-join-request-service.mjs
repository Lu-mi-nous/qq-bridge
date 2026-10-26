// R3-7 加入请求服务：队列、裁决、通知、自动同意与已自动同意竞态。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createJoinRequestService } from '../src/join-request-service.js';

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-join-service-'));
function makeService(overrides = {}) {
  const calls = [];
  const sent = [];
  const queueFile = path.join(tmp, `q-${Math.random().toString(36).slice(2)}.json`);
  const service = createJoinRequestService({
    cfg: { ownerQQ: 10001, socialV2: { joinRequest: { enabled: true, autoApprove: false, ...(overrides.jr || {}) } } },
    file: queueFile,
    ttlMs: 5 * 60 * 1000,
    getSelfQQ: () => 10001,
    setFriendAddRequest: async (flag, approve) => { calls.push({ type: 'friend', flag, approve }); },
    setGroupAddRequest: async (flag, opts) => { calls.push({ type: 'group', flag, opts }); },
    getGroupMemberInfo: async () => overrides.inGroup ? { user_id: 10001 } : null,
    getStrangerInfo: async () => ({ nickname: '小王' }),
    getGroupInfo: async () => ({ group_name: '测试群' }),
    sendToQQ: async (key, text) => { sent.push({ key, text }); },
    appendActivity: () => {},
    withTimeout: (p) => p,
    log: () => {}
  });
  return { service, calls, sent };
}

try {
  console.log('── 1. 提交裁决 ──');
  {
    const { service, calls } = makeService();
    const r = await service.submitDecision({ n: 1, requestType: 'friend', flag: 'f1', userId: 2 }, true);
    check('好友请求调用 setFriendAddRequest', r.ok && calls[0].type === 'friend' && calls[0].approve === true);
    const g = await service.submitDecision({ n: 2, requestType: 'group', subType: 'invite', flag: 'g1', groupId: 3 }, false, '不加入');
    check('群邀请调用 setGroupAddRequest', g.ok && calls[1].type === 'group' && calls[1].opts.approve === false);
  }

  console.log('\n── 2. 已自动同意竞态 ──');
  {
    const { service, calls } = makeService({ inGroup: true });
    const r = await service.submitDecision({ n: 3, requestType: 'group', subType: 'invite', flag: 'g2', groupId: 4 }, true);
    check('已在群时不再提交邀请', r.ok && r.alreadyJoined === true && calls.length === 0);
  }

  console.log('\n── 3. handle 正常入队 / 自动同意 ──');
  {
    const { service, sent } = makeService();
    await service.handle({ request_type: 'friend', user_id: 20002, flag: 'f2', comment: '你好' });
    check('普通请求进入队列', service.queue.list().length === 1);
    check('通知管理员私聊', sent.length === 1 && sent[0].key === 'private:10001' && /好友请求 #1/.test(sent[0].text));

    const auto = makeService({ jr: { autoApprove: true } });
    await auto.service.handle({ request_type: 'friend', user_id: 20003, flag: 'f3' });
    check('autoApprove 直接同意', auto.calls.some((c) => c.type === 'friend' && c.approve === true));
    check('自动同意也通知管理员', auto.sent.some((s) => /已自动同意/.test(s.text)));
    check('自动同意不留在队列', auto.service.queue.list().length === 0);
  }

  console.log('\n── 4. 关闭 / 入群通知作废邀请 ──');
  {
    const off = makeService({ jr: { enabled: false } });
    await off.service.handle({ request_type: 'friend', user_id: 20004, flag: 'f4' });
    check('关闭时静默拒绝', off.calls.some((c) => c.type === 'friend' && c.approve === false));

    const t = makeService();
    await t.service.handle({ request_type: 'group', sub_type: 'invite', user_id: 20005, group_id: 30001, flag: 'g5' });
    check('群邀请先入队', t.service.queue.list().length === 1);
    t.service.handleGroupIncrease({ user_id: 10001, self_id: 10001, group_id: 30001 });
    check('机器人入群后作废邀请', t.service.queue.list().length === 0);
  }
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
