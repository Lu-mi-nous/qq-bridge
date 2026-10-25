// 第 3 步消息管线 · 纯计算层行为测试。
//
// 覆盖从 handleIncoming 抽出的：
//   - 身份标记 / 发送者展示名 / 群角色 / 管理员回合判定
//   - 媒体提示拼装
//   - 入站提示拼装（人格 + 身份 + 发送者 + 正文 + 媒体）
//   - OneBot 消息段转文本
import {
  identityTagOf,
  senderDisplayName,
  groupRoleOf,
  isOwnerSender,
  isOwnerTurn,
  buildMediaHint,
  buildIncomingPrompt
} from '../src/pipeline/message-format.js';
import { segmentsToText } from '../src/pipeline/segments.js';
import { makeTurnId } from '../src/pipeline/turn-id.js';

let pass = 0, fail = 0;
const check = (n, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };

console.log('── 1. 身份标记 ──');
{
  check('后台管理员', identityTagOf({ isOwner: true }) === '【管理员】');
  check('群主', identityTagOf({ isGroupOwner: true }) === '【群主】');
  check('群管理员', identityTagOf({ isGroupAdmin: true }) === '【群管理员】');
  check('群主优先于群管理员', identityTagOf({ isGroupOwner: true, isGroupAdmin: true }) === '【群主】');
  check('普通群友无标记', identityTagOf({}) === '');
  check('null 不崩', identityTagOf(null) === '');
  check('后台管理员 + 群主两个标记都在',
    identityTagOf({ isOwner: true, isGroupOwner: true }).includes('【管理员】')
    && identityTagOf({ isOwner: true, isGroupOwner: true }).includes('【群主】'));
}

console.log('\n── 2. 发送者 / 群角色 ──');
{
  const groupEvent = { user_id: 123, sender: { card: '群名片', nickname: '昵称', role: 'ADMIN' } };
  check('群聊优先群名片', senderDisplayName(groupEvent, 'group') === '群名片');
  check('群聊无群名片用昵称', senderDisplayName({ user_id: 123, sender: { nickname: '昵称' } }, 'group') === '昵称');
  check('群聊无昵称用号码', senderDisplayName({ user_id: 123, sender: {} }, 'group') === '123');
  check('私聊优先昵称', senderDisplayName({ user_id: 123, sender: { nickname: '甲', card: '卡' } }, 'private') === '甲');
  check('私聊无昵称用「私聊」', senderDisplayName({ user_id: 123, sender: {} }, 'private') === '私聊');
  check('群角色归一化为小写', groupRoleOf(groupEvent, 'group') === 'admin');
  check('私聊没有群角色', groupRoleOf(groupEvent, 'private') === '');
  check('ownerQQ 判定', isOwnerSender({ user_id: 123 }, '123') === true
    && isOwnerSender({ user_id: 123 }, '456') === false);
}

console.log('\n── 3. 回合 ID 与管理员判定 ──');
{
  check('turnId 跨会话唯一（带 session 前缀）', makeTurnId('session-x', 3) === 'session-x#3');
  check('缺 turn 返回空串', makeTurnId('session-x', null) === '' && makeTurnId(null, 3) === '');
}

{
  const now = Date.now();
  const owner = '100002000';
  check('最近一条是管理员', isOwnerTurn({ ownerQQ: owner, state: { lastRequesterId: owner, ownerSpokeAt: now }, now }) === true);
  check('管理员说完 47 秒后被别人覆盖仍通过',
    isOwnerTurn({ ownerQQ: owner, state: { lastRequesterId: 'x', ownerSpokeAt: now - 47_000 }, now }) === true);
  check('超出 5 分钟窗拒绝',
    isOwnerTurn({ ownerQQ: owner, state: { lastRequesterId: 'x', ownerSpokeAt: now - 6 * 60_000 }, now }) === false);
  check('未配置 ownerQQ fail-closed',
    isOwnerTurn({ ownerQQ: '', state: { lastRequesterId: '', ownerSpokeAt: now }, now }) === false);
  check('窗口 0 只看最新一条',
    isOwnerTurn({ ownerQQ: owner, state: { lastRequesterId: 'x', ownerSpokeAt: now }, windowMs: 0, now }) === false);
}

console.log('\n── 4. 媒体提示 ──');
{
  const media = [{ kind: 'image' }, { kind: 'face' }];
  const reserved = buildMediaHint({ mode: 'reserved2', key: 'group:1', messageRef: 'm1', mediaList: media });
  check('reserved2 提示工具名', reserved.includes('mcp__snowluma__qq_get_message_images'));
  check('reserved2 提示 key/messageId', reserved.includes('group:1') && reserved.includes('m1'));
  const inline = buildMediaHint({ mode: 'chat', key: 'group:1', messageRef: 'm1', mediaList: media });
  check('其他模式只报数量', inline.includes('2 个图片/表情') && !inline.includes('qq_get_message_images'));
  check('无媒体返回空串', buildMediaHint({ mode: 'reserved2', key: 'group:1', messageRef: 'm1', mediaList: [] }) === '');
  check('无 messageRef 返回空串', buildMediaHint({ mode: 'reserved2', key: 'group:1', messageRef: '', mediaList: media }) === '');
}

console.log('\n── 5. 入站提示拼装 ──');
{
  const group = buildIncomingPrompt({
    roleHint: '【人格】大肥鱼',
    isOwner: true,
    groupRole: 'admin',
    kind: 'group',
    sender: '甲',
    userId: 123,
    textContent: '你好',
    mediaHint: '\n【图片/表情】1 个'
  });
  check('群聊带人格卡', group.startsWith('【人格】大肥鱼\n\n'));
  check('群聊带身份标记', group.includes('【管理员】'));
  check('群聊带发送者：正文', group.includes('甲：你好'));
  check('群聊带媒体提示', group.includes('【图片/表情】1 个'));
  const privateMsg = buildIncomingPrompt({ kind: 'private', sender: '甲', textContent: '在吗' });
  check('私聊不带发送者前缀', privateMsg === '在吗');
  const noRole = buildIncomingPrompt({ kind: 'group', sender: '甲', textContent: 'hi' });
  check('无角色卡不产生多余空行', noRole === '甲：hi');
}

console.log('\n── 6. 消息段转文本 ──');
{
  const at = await segmentsToText([
    { type: 'text', data: { text: '你好' } },
    { type: 'at', data: { qq: '123' } },
    { type: 'face', data: { id: '76' } },
    { type: 'image', data: {} },
    { type: 'record', data: {} },
    { type: 'video', data: {} },
    { type: 'file', data: { name: 'a.txt' } }
  ], { resolveAtName: async () => '群友Y6' });
  check('文本/@/表情/图片/语音/视频/文件', at === '你好@群友Y6[表情76][图片][语音][视频][文件a.txt]', at);
  check('字符串消息', await segmentsToText('  纯文本  ') === '纯文本');
  const reply = await segmentsToText([
    { type: 'reply', data: { id: 'm1' } },
    { type: 'text', data: { text: '你说呢' } }
  ], { resolveReply: async () => ({ sender: '甲', text: '原文' }) });
  check('引用段转文本', reply === '[引用 甲：原文]你说呢', reply);
  const noReply = await segmentsToText([
    { type: 'reply', data: { id: 'm1' } },
    { type: 'text', data: { text: '你说呢' } }
  ], { resolveReply: async () => ({ sender: '甲', text: '原文' }), includeReply: false });
  check('includeReply=false 只看当前文字', noReply === '你说呢');
  check('@ 解析失败回退号码', await segmentsToText([{ type: 'at', data: { qq: '999' } }], { resolveAtName: async () => null }) === '@999');
  check('@全体成员', await segmentsToText([{ type: 'at', data: { qq: 'all' } }]) === '@全体成员');
  check('转发段带 id', await segmentsToText([{ type: 'forward', data: { id: 'f1' } }]) === '[转发消息 id=f1]');
  check('未知段占位', await segmentsToText([{ type: 'foo', data: {} }]) === '[foo]');
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
