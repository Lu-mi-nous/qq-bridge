// 回归测试：QQ 分享卡片解析（B 站视频 / 小程序 / 音乐 / 位置）。
//
// 背景（2026-10-12 用户要求「群里发送 bilibili 视频链接或者分享的小程序时，
// 能不能让机器人能看到标题和封面图片」）：
// 原先 `segmentsToText` 对 json 段只输出 `[卡片消息]` 四个字——标题、描述、封面、
// 真实链接全丢。实测机器人自己在群里抱怨过：
//   「卡片只显示成[卡片消息]，里面什么内容我看不到」
//
// 关键事实（从 SnowLuma 的 messages.db 提取真实卡片，共 4 种形态）：
//   卡片里**已经带了**标题、描述、封面直链和真实链接，不需要去抓网页。
//   尤其 B 站视频走 com.tencent.miniapp_01：title="哔哩哔哩"（平台名，不是标题！），
//   desc=真正的内容标题，preview=封面，qqdocurl="https://b23.tv/xxx"。
//   而 url 字段是 m.q.qq.com/a/s/... 中间页（浏览器打不开）——顺序取错就给了没用的链接。
//
// 夹具 test-fixtures/share-cards.json 是真实卡片（已脱敏掉分享者昵称无关字段）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0, fail = 0;
const check = (n, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };

const root = path.dirname(fileURLToPath(import.meta.url)) + '/..';
const m = await import(new URL('../src/share-card.js', import.meta.url));
const { parseShareCard, formatShareCard, coverUrlOf, extractShareCards, isShareCardSegment, parseCardData } = m;

const bridgeSrc = fs.readFileSync(path.join(root, 'src/bridge.js'), 'utf8');

// 真实卡片夹具
let fixtures = {};
try {
  fixtures = JSON.parse(fs.readFileSync(path.join(root, 'test-fixtures/share-cards.json'), 'utf8'));
} catch { /* 缺失 */ }
const fx = (key) => Object.entries(fixtures).find(([k]) => k.startsWith(key))?.[1];

console.log('── 1. 接入点（bridge.js 不再只输出 [卡片消息]）──');
{
  check('bridge.js 引入了 share-card', /from '\.\/share-card\.js'/.test(bridgeSrc));
  check('json 段调用 parseShareCard', /case 'json':[\s\S]{0,500}parseShareCard\(/.test(bridgeSrc));
  check('解析失败仍退回占位符（不编内容）', /card \? formatShareCard\(card\) : '\[卡片消息\]'/.test(bridgeSrc));
  check('封面进入媒体管线（extractMediaFromSegments）', /coverUrlOf\(card\)/.test(bridgeSrc));
  check('封面项带 fromCard 标记', /fromCard: true/.test(bridgeSrc));
}

console.log('\n── 2. data 字段两种形态都要吃 ──');
{
  const obj = { app: 'x', meta: { news: { title: 'T' } } };
  check('接受已解析对象', parseCardData(obj) === obj);
  check('接受转义 JSON 字符串', parseCardData(JSON.stringify(obj))?.meta?.news?.title === 'T');
  check('空值返回 null', parseCardData('') === null && parseCardData(null) === null);
  check('垃圾字符串返回 null', parseCardData('not json') === null);
  check('纯数字字符串返回 null', parseCardData('123') === null);
  check('数组不当作卡片', parseCardData('[1,2]') === null);
}

console.log('\n── 3. 真实 B 站视频卡片（核心场景）──');
{
  const card = fx('com.tencent.miniapp_01');
  check('夹具存在', !!card);
  if (card) {
    const p = parseShareCard(card);
    check('解析成功', !!p);
    check('识别为哔哩哔哩', p.platform === '哔哩哔哩', p.platform);
    // 关键：title 是平台名"哔哩哔哩"，不能当标题用
    check('title 不取平台名（避免"视频叫哔哩哔哩"）', p.title !== '哔哩哔哩', JSON.stringify(p.title));
    check('desc 是真正的视频标题', p.desc.length > 0, JSON.stringify(p.desc).slice(0, 50));
    // 关键：必须拿 qqdocurl（真实链接），不是 m.q.qq.com 中间页
    check('url 是 b23.tv 真实链接', /^https:\/\/b23\.tv\//.test(p.url), p.url);
    check('url 不是 m.q.qq.com 中间页', !/m\.q\.qq\.com/.test(p.url));
    check('有封面直链', /^https:\/\/.+/.test(p.cover), p.cover.slice(0, 60));
    check('封面可交给看图工具', !!coverUrlOf(p));
    const text = formatShareCard(p);
    check('渲染文本含卡片标记', /\[哔哩哔哩卡片\]/.test(text), text.slice(0, 60));
    check('渲染文本含视频标题', text.includes(p.desc));
    check('渲染文本含真实链接', text.includes(p.url));
  }
}

console.log('\n── 4. 封面 URL 判定（必须像图片才给模型抓）──');
{
  const base = { platform: 'x', title: 't', desc: '', url: '', source: '', extra: {} };
  check('jpg 放行', !!coverUrlOf({ ...base, cover: 'https://a.com/x.jpg' }));
  check('png 带参数放行', !!coverUrlOf({ ...base, cover: 'https://a.com/x.png?a=1' }));
  check('webp 放行', !!coverUrlOf({ ...base, cover: 'https://a.com/x.webp' }));
  check('http 升级为 https', coverUrlOf({ ...base, cover: 'http://a.com/x.jpg' }).startsWith('https://'));
  check('未知域名无扩展名 → 拒绝（避免抓 HTML 页）', coverUrlOf({ ...base, cover: 'https://a.com/page' }) === '');
  check('qq.ugcimg.cn 无扩展名 → 放行（图床）', !!coverUrlOf({ ...base, cover: 'https://qq.ugcimg.cn/v1/abc' }));
  check('mmbiz 图床放行', !!coverUrlOf({ ...base, cover: 'https://mmbiz.qpic.cn/a' }));
  check('中间页 m.q.qq.com 不放行', coverUrlOf({ ...base, cover: 'https://m.q.qq.com/a/s/xxx' }) === '');
  check('空封面返回空', coverUrlOf({ ...base, cover: '' }) === '');
  check('非 http 协议拒绝', coverUrlOf({ ...base, cover: 'mqzone://x.jpg' }) === '');
}

console.log('\n── 5. 其他真实形态（小红书 / QQ空间相册 / 位置）──');
{
  const xhs = fx('com.tencent.tuwen.lua');
  if (xhs) {
    const p = parseShareCard(xhs);
    check('小红书：识别平台', p.platform === '小红书', p.platform);
    check('小红书：有标题', p.title.length > 0, p.title.slice(0, 30));
    check('小红书：有封面', !!coverUrlOf(p));
    check('小红书：url 是 http(s)', /^https?:\/\//.test(p.url));
  }

  const feed = fx('com.tencent.feed.lua');
  if (feed) {
    const p = parseShareCard(feed);
    check('相册：解析出标题', p.title.length > 0, p.title.slice(0, 30));
    check('相册：封面 http 升级为 https', coverUrlOf(p).startsWith('https://') || coverUrlOf(p) === '');
    check('相册：mqzone:// 链接被丢弃（模型打不开）', p.url === '' || /^https?:/.test(p.url), JSON.stringify(p.url).slice(0, 40));
  }

  const map = fx('com.tencent.map');
  if (map) {
    const p = parseShareCard(map);
    check('位置：解析成功（早期实现返回 null）', !!p);
    check('位置：平台标为「位置」', p.platform === '位置', p.platform);
    check('位置：描述含地名', p.desc.length > 0, p.desc.slice(0, 40));
  }
}

console.log('\n── 6. 未知/异常卡片不能崩，也不能编内容 ──');
{
  check('空对象 → null', parseShareCard({}) === null);
  check('null → null', parseShareCard(null) === null);
  check('无 meta → null', parseShareCard({ app: 'x' }) === null);
  check('meta 为空对象 → null', parseShareCard({ app: 'x', meta: {} }) === null);
  check('meta 值全空 → null', parseShareCard({ app: 'x', meta: { news: {} } }) === null);
  check('未知 app 但字段像样 → 仍解析', (() => {
    const p = parseShareCard({ app: 'com.unknown.thing', meta: { detail: { title: '某标题', desc: '描述' } } });
    return !!p && p.title === '某标题';
  })());
  check('formatShareCard(null) 返回空串', formatShareCard(null) === '');
  check('垃圾字符串不崩', parseShareCard('{{{bad') === null);
}

console.log('\n── 7. 段落抽取（供媒体管线用）──');
{
  const cardJson = JSON.stringify({
    app: 'com.tencent.miniapp_01',
    meta: { detail_1: { title: '哔哩哔哩', desc: '标题', preview: 'https://qq.ugcimg.cn/v1/abc', qqdocurl: 'https://b23.tv/x' } }
  });
  const segs = [
    { type: 'text', data: { text: '看这个 ' } },
    { type: 'json', data: { data: cardJson } },
  ];
  const cards = extractShareCards(segs);
  check('抽到 1 张卡片', cards.length === 1, String(cards.length));
  check('记录了段索引', cards[0].segmentIndex === 1, String(cards[0].segmentIndex));
  check('封面已抽出', !!cards[0].cover);
  check('isShareCardSegment 认 json 段', isShareCardSegment({ type: 'json', data: {} }));
  check('非 json 段不认', !isShareCardSegment({ type: 'text', data: {} }));
  check('无卡片时返回空数组', extractShareCards([{ type: 'text', data: { text: 'hi' } }]).length === 0);
  check('非数组输入不崩', extractShareCards(null).length === 0);
  check('无封面的卡片不进媒体（cover 为空）', (() => {
    const c = extractShareCards([{ type: 'json', data: { data: JSON.stringify({ app: 'x', meta: { news: { title: 't' } } }) } }]);
    return c.length === 1 && c[0].cover === '';
  })());
}

console.log('\n── 8. 措辞：不能让模型以为卡片是"图片"或"文件"──');
{
  const p = parseShareCard({ app: 'com.tencent.miniapp_01', meta: { detail_1: { title: '哔哩哔哩', desc: '视频标题' } } });
  const t = formatShareCard(p);
  check('渲染不含"图片"字样（是卡片不是图）', !/\[图片\]/.test(t), t);
  check('渲染含卡片字样', /卡片/.test(t));
  check('渲染不重复标题（小红书早期出现重复）', (() => {
    const c = parseShareCard({ app: 'com.tencent.tuwen.lua', meta: { news: { title: 'T', desc: 'D' } } });
    const s = formatShareCard(c);
    return s.indexOf('T') !== s.lastIndexOf('T') ? false : true;
  })());
}

console.log('\n── 9. 链接清洗（去掉统计参数但保住鉴权参数）──');
{
  const { trimShareUrl } = m;
  check('trimShareUrl 已导出', typeof trimShareUrl === 'function');
  // 关键：xsec_token 是小红书链接能否打开的关键，绝不能删
  const xhs = 'https://www.xiaohongshu.com/discovery/item/abc?xsec_source=app_share&xsec_token=TOKEN123&xhsshare=&share_id=xyz&type=normal';
  const t1 = trimShareUrl(xhs);
  check('保留 xsec_token（删了链接打不开）', t1.includes('xsec_token=TOKEN123'), t1.slice(0, 120));
  check('去掉 share_id（统计参数）', !t1.includes('share_id='));
  check('去掉 xhsshare（统计参数）', !t1.includes('xhsshare='));
  const bili = 'https://b23.tv/zElGb1y';
  check('B站短链原样保留', trimShareUrl(bili) === bili);
  const withTs = 'https://b23.tv/OWJrtFs?share_medium=android&share_source=qq&bbid=XX90AB&ts=1790401551740';
  const t2 = trimShareUrl(withTs);
  check('B站长链去掉 share_medium/share_source/bbid/ts', !/share_medium|share_source|bbid|ts=/.test(t2), t2);
  check('清洗后仍是 b23.tv 短链形态', /^https:\/\/b23\.tv\/OWJrtFs$/.test(t2), t2);
  check('非 http 输入原样返回', trimShareUrl('mqzone://x') === 'mqzone://x');
  check('空输入不崩', trimShareUrl('') === '');
  check('非法 URL 不崩', trimShareUrl('http://[bad') === 'http://[bad');
  check('渲染时应用了清洗', (() => {
    const c = parseShareCard({ app: 'x', meta: { detail: { title: 'T', qqdocurl: 'https://b23.tv/abc?ts=123&share_source=qq' } } });
    const s = formatShareCard(c);
    return s.includes('b23.tv/abc') && !s.includes('ts=123');
  })());
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
