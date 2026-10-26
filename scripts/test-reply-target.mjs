// R3-13 引用目标解析：messageId / seq / 符号引用。
import { createReplyTargetService } from '../src/pipeline/reply-target.js';

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
};

const service = createReplyTargetService({
  bot: {
    getMessage: async (id) => (id === 999 ? null : ({
      message_id: id,
      group_id: 1,
      sender: { card: '甲', user_id: 2 },
      message: [{ type: 'text', data: { text: '被引用内容' } }]
    }))
  },
  segmentsToText: async () => '被引用内容',
  resolveGroupMemberName: async () => '甲',
  extractForwardIds: () => [],
  seenForwardIds: new Map(),
  keyForKindId: (k, i) => `${k}:${i}`,
  loadContextMessages: () => [],
  STATE_DIR: 'state',
  log: () => {}
});

console.log('── 1. 符号引用 ──');
{
  check('识别 latest', service.isSymbolicReplyRef('latest') === true);
  check('识别上一条', service.isSymbolicReplyRef('上一条') === true);
  check('普通数字不是符号引用', service.isSymbolicReplyRef('123') === false);
  const r = await service.resolveReplyTargetV2({ recentMessages: [{ seq: 3, messageId: 'm3', sender: '乙', text: 'hi' }] }, 'group', 1, 'latest');
  check('latest 解析到最近一条别人的消息', r?.messageId === 'm3' && r.info.sender === '乙');
}

console.log('\n── 2. seq / messageId ──');
{
  const st = { recentMessages: [{ seq: 5, messageId: 'm5', sender: '甲', text: 'x' }] };
  const bySeq = await service.resolveReplyTargetV2(st, 'group', 1, '5');
  check('seq 映射到真实 messageId', bySeq?.messageId === 'm5');
  const byId = await service.resolveReplyTargetV2(st, 'group', 1, '500');
  check('直接 messageId 可解析', byId?.messageId === '500' && byId.info.text === '被引用内容');
  const missing = await service.resolveReplyTargetV2({ recentMessages: [] }, 'group', 1, '999');
  check('找不到返回 null', missing === null);
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
