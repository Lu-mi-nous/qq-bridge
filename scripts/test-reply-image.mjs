// 回归测试：被引用消息里的图片能被识别并取到（「别人回复图片消息，机器人看不到」）。
//
// 关键链路：
//   1) 被引用消息的**图片段**要被统计出来（原先只取 sender+text，图片被丢弃 →
//      模型只看到 `[引用 某人：[图片]]`，无从取图）。
//   2) 引用文案要注入「怎么看到它」（含被引用消息 id 与取图工具名）。
//   3) 本地缓存没命中时要能回源取那条消息（群友引用别人的图，本地往往没有）。
import {
  extractQuotedMedia, buildReplyText, reserved2MediaFetchHint, inlineMediaFactHint
} from '../src/quoted-media.js';

let pass = 0, fail = 0;
const check = (n, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };

console.log('── 从消息段提取图片/表情 ──');
{
  const segs = [
    { type: 'text', data: { text: '看看这个' } },
    { type: 'image', data: { file: 'abc.jpg', url: 'http://x/y.jpg' } },
    { type: 'face', data: { id: '339' } },
    { type: 'image', data: {} },             // 无 file/url → 取不到图，不该算
    { type: 'reply', data: { id: '-123' } }, // 引用段不是媒体
    { type: 'image', data: { url: 'http://only/url.jpg' } }, // 只有 url 也算
    null,
    'junk'
  ];
  const media = extractQuotedMedia(segs);
  check('提取到 3 个（2 image + 1 face）', media.length === 3, JSON.stringify(media));
  check('image 带 file/url', media[0].kind === 'image' && media[0].file === 'abc.jpg');
  check('face 带 faceId', media[1].kind === 'face' && media[1].faceId === '339');
  check('只有 url 的图也算', media.some((m) => m.url === 'http://only/url.jpg'));
  check('无 file/url 的空图段被丢弃', !media.some((m) => m.kind === 'image' && !m.file && !m.url));
  check('无 id 的 face 被丢弃', !media.some((m) => m.kind === 'face' && !m.faceId));
  check('空数组不抛', extractQuotedMedia([]).length === 0);
  check('undefined 不抛', extractQuotedMedia(undefined).length === 0);
  check('非对象元素跳过', extractQuotedMedia([null, undefined, 1, 'x']).length === 0);
}

console.log('\n── reserved2：引用里含图时给取图指引 ──');
{
  const hint = reserved2MediaFetchHint('group:100002005');
  const info = { sender: '月狐', text: '[图片]', messageId: '-577523028', mediaCount: 1 };
  const t = buildReplyText(info, hint);
  check('含被引用者与原文', t.includes('月狐') && t.includes('[图片]'), t);
  check('含图片数量', t.includes('含 1 个图片/表情'));
  check('含被引用消息 id', t.includes('-577523028'));
  check('含取图工具名', t.includes('qq_get_message_images'));
  check('参数里带正确 key', t.includes('key="group:100002005"'));
  check('参数里带正确 messageId', t.includes('messageId="-577523028"'));
}

console.log('\n── 不该注入的情况 ──');
{
  const hint = reserved2MediaFetchHint('group:1');
  check('纯文字引用不注入', !buildReplyText({ sender: 'A', text: '你好', messageId: '-1', mediaCount: 0 }, hint).includes('qq_get_message_images'));
  check('无 messageId 时退回事实描述（不拼坏文案）',
    (() => { const t = buildReplyText({ sender: 'A', text: '[图片]', messageId: '', mediaCount: 1 }, hint); return t.includes('含 1 个图片/表情') && !t.includes('qq_get_message_images'); })());
  check('无 sender/text 但有图 → 仍给提示', buildReplyText({ messageId: '-9', mediaCount: 2 }, hint).includes('qq_get_message_images'));
  check('无 sender/text 也无图 → 占位文案', buildReplyText({}, hint) === '[引用消息]');
  check('null info 不抛', buildReplyText(null, hint) === '[引用消息]');
}

console.log('\n── 其他模式（图片自动内联）只报事实 ──');
{
  const hint = inlineMediaFactHint();
  const t = buildReplyText({ sender: 'A', text: '[图片]', messageId: '-5', mediaCount: 1 }, hint);
  check('不出现工具名', !t.includes('qq_get_message_images'), t);
  check('仍告知含图与 id', t.includes('含 1 个图片/表情') && t.includes('-5'), t);
}

console.log('\n── 多图与边界 ──');
{
  const hint = reserved2MediaFetchHint('group:2');
  check('多图数量正确', buildReplyText({ sender: 'A', text: 'x', messageId: '-9', mediaCount: 3 }, hint).includes('含 3 个图片/表情'));
  check('mediaCount 为字符串也能处理', buildReplyText({ sender: 'A', text: 'x', messageId: '-9', mediaCount: '2' }, hint).includes('含 2 个图片/表情'));
  check('mediaCount 缺失不注入', !buildReplyText({ sender: 'A', text: 'x', messageId: '-9' }, hint).includes('图片/表情'));
  check('未传 hint 时退回报事实', buildReplyText({ sender: 'A', text: '[图片]', messageId: '-1', mediaCount: 1 }).includes('含 1 个图片/表情'));
}

console.log('\n── 被引用的合并转发：必须把 id 交给模型 ──');
{
  // 事故（2026-10-22）：群友引用一条「群聊的聊天记录」问「这个是什么」，
  // 机器人答「那条转发鱼打不开，id对不上」——它根本没拿到 id。
  // forward 段以前在 buildReplyText 里被完全忽略（只处理 mediaCount）。
  const t = buildReplyText({ sender: '鱼恋海', text: '[转发消息]', messageId: '123', mediaCount: 0, forwardIds: ['ABC123'] });
  check('包含转发 id', t.includes('id=ABC123'), t);
  check('说明这是合并转发', t.includes('合并转发'));
  check('指出用哪个工具读', t.includes('qq_get_forward_msg'));
  check('说明参数直接用 id', /参数 id 直接用/.test(t));

  const many = buildReplyText({ sender: 'A', text: 'x', forwardIds: ['F1', 'F2'] });
  check('多个 id 都列出', many.includes('F1') && many.includes('F2'), many);

  const plain = buildReplyText({ sender: 'A', text: '你好', messageId: '9', mediaCount: 0 });
  check('普通引用不含转发提示', !plain.includes('合并转发'), plain);
  check('forwardIds 为空数组也不提示', !buildReplyText({ sender: 'A', text: 'x', forwardIds: [] }).includes('合并转发'));

  const both = buildReplyText(
    { sender: 'A', text: '看图', messageId: '77', mediaCount: 2, forwardIds: ['F9'] },
    (mid, n) => `（含 ${n} 张图，messageId=${mid}）`
  );
  check('图片与转发提示可共存', both.includes('含 2 张图') && both.includes('F9'), both);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
