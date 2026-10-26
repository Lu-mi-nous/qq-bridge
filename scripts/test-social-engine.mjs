// R3-11 社交消息引擎：入站消息、拍一拍、机器人发言写入。
import { createSocialEngine } from '../src/social-engine.js';

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
};

function makeEngine() {
  const conversations = new Map();
  const journal = [];
  const seenForwardIds = new Map();
  const getSocialV2State = (key) => {
    if (!conversations.has(key)) {
      conversations.set(key, {
        lastUnreadSeq: 0,
        recentMessages: [],
        unread: [],
        activeTopics: [],
        preSleepWaitSatisfiedAt: 1,
        preSleepWaitObservedAt: 1,
        preSleepWaitAccumMs: 1,
        pendingComply: { x: 1 }
      });
    }
    return conversations.get(key);
  };
  const engine = createSocialEngine({
    cfg: { ownerQQ: 10001, socialV2: { context: { recentLimit: 5, unreadLimit: 3 } } },
    getSocialV2State,
    saveSocialV2State: () => {},
    appendContextMessage: (_dir, _key, msg) => journal.push(msg),
    STATE_DIR: 'state',
    seenForwardIds,
    redactKnownTokensOnly: (s) => String(s).replace('secret', '***'),
    log: () => {}
  });
  return { engine, getSocialV2State, journal, seenForwardIds };
}

console.log('── 1. 入站消息 ──');
{
  const { engine, getSocialV2State, journal, seenForwardIds } = makeEngine();
  engine.appendSocialV2Message('group:1', '甲', '你好', '你好', false, false, 'm1', [{ kind: 'image', file: 'a.png' }], 20002, ['f1'], 'member', false, null);
  const st = getSocialV2State('group:1');
  const msg = st.recentMessages[0];
  check('写入 recentMessages', st.recentMessages.length === 1 && msg.sender === '甲');
  check('记录 messageId 与 userId', msg.messageId === 'm1' && msg.userId === '20002');
  check('记录群身份', msg.groupRole === 'member' && msg.isGroupOwner === false);
  check('记录媒体与 forward', msg.hasMedia === true && msg.hasForward === true);
  check('写入 unread 与 journal', st.unread.length === 1 && journal.length === 1);
  check('记录 forward id', seenForwardIds.get('group:1')?.has('f1') === true);
}

console.log('\n── 2. 错误回显 / 拍一拍 ──');
{
  const { engine, getSocialV2State } = makeEngine();
  engine.appendSocialV2Message('group:2', '甲', '本条回复因疑似包含敏感信息，已拦截', '本条回复因疑似包含敏感信息，已拦截', false, false, 'm2');
  check('桥接错误回显不入库', getSocialV2State('group:2').recentMessages.length === 0);

  const poke = engine.appendSocialV2Poke('group:2', { sender: '乙', userId: 3, targetId: 4, targetIsSelf: true });
  check('拍一拍写入消息流', poke.kind === 'poke' && poke.text.includes('拍了拍'));
  check('拍一拍标记 targetIsSelf', poke.poke.targetIsSelf === true);
}

console.log('\n── 3. 机器人发言 / 上限 ──');
{
  const { engine, getSocialV2State } = makeEngine();
  engine.recordSentMessagesV2('group:3', ['secret 你好', { text: '语音内容', isVoice: true }]);
  const st = getSocialV2State('group:3');
  check('机器人发言入库', st.recentMessages.length === 2 && st.recentMessages[0].isSelf === true);
  check('脱敏与语音标记', st.recentMessages[0].text.includes('***') && st.recentMessages[1].text.startsWith('[语音]'));
  check('清空 pendingComply', st.pendingComply === null);
  for (let i = 0; i < 10; i++) engine.recordSentMessagesV2('group:3', ['x']);
  check('recentMessages 有界', st.recentMessages.length === 5);
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
