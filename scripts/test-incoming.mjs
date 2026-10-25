// 群消息字段形态沿用 test-fixtures/share-cards.json 的真实 OneBot 分享卡片。
import fs from 'node:fs';
import { incomingHarness, checks } from './helpers/pipeline-harness.mjs';
const { check, finish } = checks();
{
  const h = incomingHarness();
  check('白名单群放行', await h.stages.admit(h.context()));
  check('非白名单群拒绝', !await h.stages.admit(h.context('你好', {}, 'group', '2')));
  check('拒绝群进入预设提示分支', h.calls.some(c => c[0] === 'notice'));
  check('管理员加白命令有狭窄准入例外', await h.stages.admit(h.context('/wl add', { user_id: 42 }, 'group', '2')));
  check('群友不能使用加白准入例外', !await h.stages.admit(h.context('/wl add', {}, 'group', '2')));
  h.live.mode = 'closed-agent';
  check('模式实时读取，封闭模式拒绝群', !await h.stages.admit(h.context('/wl add', { user_id: 42 }, 'group', '2')));
  check('封闭模式放行管理员私聊', await h.stages.admit(h.context('你好', { user_id: 42 }, 'private', '42')));
}
{
  const h = incomingHarness();
  h.deps.refreshFriendList = null; // 工厂捕获的是显式适配器，不是下面的测试变量。
  await h.stages.admit(h.context('a', {}, 'private', '3'));
  await h.stages.admit(h.context('b', {}, 'private', '4'));
  check('好友强刷全局限流', h.calls.filter(c => c[0] === 'refresh').length === 1);
  const fresh = incomingHarness({ refreshFriendList: async () => fresh.friends.add('3') });
  check('刷新后新好友立刻放行', await fresh.stages.admit(fresh.context('a', {}, 'private', '3')));
  const failed = incomingHarness({ refreshFriendList: async () => { throw new Error('offline'); } });
  check('好友刷新失败仍拒绝', !await failed.stages.admit(failed.context('a', {}, 'private', '3')));
}
{
  const h = incomingHarness();
  check('空消息过滤', !await h.stages.parse(h.context('')));
  h.live.quoteSelf = true;
  check('只引用机器人仍放行', !!await h.stages.parse(h.context('')));
  h.live.transcript = '语音样本';
  const parsed = await h.stages.parse(h.context('你好', { user_id: 42 }));
  check('转写同时进入正文和独立文本', parsed.textContent.includes('语音样本') && parsed.plainContent.includes('语音样本'));
  check('只按后台管理员识别身份', parsed.isOwner);
  h.live.transcript = '';
  for (let id = 1; id <= 3; id++) await h.stages.parse(h.context('', {
    message_id: id, message_seq: id + 10, message: [{ type: 'image', data: { url: 'https://example.com/img.png' } }]
  }));
  check('媒体按 messageId/seq 缓存且有界', h.media.get('group:1').size === 2 && h.media.get('group:1').has('13'));
  const cards = JSON.parse(fs.readFileSync(new URL('../test-fixtures/share-cards.json', import.meta.url), 'utf8'));
  const values = Array.isArray(cards) ? cards : Object.values(cards);
  for(const card of values) {
    const p=await h.stages.parse(h.context('', { message:[{type:'json',data:{data:JSON.stringify(card)}}] }));
    check('真实 OneBot 卡片解析保留分享信息', !!p?.shareCard && p.plainContent !== '[卡片消息]');
  }
}
{
  const h = incomingHarness();
  async function run(text, owner = false) {
    const context = h.context(text, { user_id: owner ? 42 : 7 });
    return h.stages.divert({ ...context, ...await h.stages.parse(context) });
  }
  h.pending.set('group:1', { kind: 'question' });
  check('普通消息回答挂起问题', await run('答案'));
  check('挂起问题得到当前独立文本', h.calls.find(c => c[0] === 'answer')[2] === '答案');
  const before = h.calls.filter(c => c[0] === 'answer').length;
  await run('/status', true);
  check('管理员命令不被挂起问题吞掉', h.calls.filter(c => c[0] === 'answer').length === before);
  h.pending.set('group:1', { kind: 'approval' });
  check('群友消息不消耗审批', !await run('你好'));
  check('管理员消息可回答审批', await run('通过', true));
  h.pending.clear(); h.live.role.mode = 'silent';
  check('静默模式消费群友消息', await run('你好'));
  check('静默模式管理员正常通过', !await run('你好', true));
  h.live.role.mode = 'normal';
  check('群友控制角色被拦截', await run('切换角色'));
  check('正常闲聊交给后续派发', !await run('聊天'));
}
finish();
