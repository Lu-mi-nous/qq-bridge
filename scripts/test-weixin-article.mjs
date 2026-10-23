// 回归测试：微信公众号文章解析（mp.weixin.qq.com）。
//
// 背景（2026-10-12 用户反馈「机器人无法通过微信反爬验证」，机器人原话
// 「这条公众号还是过不去验证码，我这边只能拿到"环境异常"那页」）：
//
// 实测同一条链接、同一时刻，只换请求头：
//   UA = 'Mozilla/5.0'（残缺）→ 18045 字节「环境异常，完成验证后即可继续访问」页
//   UA = 完整 Chrome UA        → 2577741 字节完整文章页（标题/正文/配图都在）
// 微信拦的是**畸形 UA 指纹**（正常浏览器不会只报 5 个字符），不是要人过验证码。
// 所以修法是让请求看起来像正常客户端，而不是绕过验证。
//
// 第二个（静默）故障：正文元信息在 ~219KB、标题在 ~317KB、正文容器在 ~300KB，
// 而 web_fetch 原本硬截断在 50000 字符 —— **即使 UA 正常也拿不到正文**，
// 而且返回的是「成功 + 长 HTML」看不出异常。这类"成功但内容为空"最难排查。
//
// 本测试用真实抓下来的页面做夹具，覆盖：
//   1. UA 常量必须是完整浏览器 UA（防有人"优化"回 Mozilla/5.0）
//   2. 微信 URL 判定（只认 /s 文章路径，别把 profile_ext 之类当文章）
//   3. 解析真实文章页 → 标题/公众号/时间/摘要/配图
//   4. **验证页必须识别为 ok:false**（关键：绝不能把验证页当正文）
//   5. 图片帖：正文为空时不得编内容，须提示"内容在配图里"
//   6. 样板文字过滤（「微信扫一扫可打开此内容」不是正文）
//   7. 阅读上限必须覆盖正文位置（防回退到 50000 导致静默失败）
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

let pass = 0, fail = 0;
const check = (n, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };

const root = path.dirname(fileURLToPath(import.meta.url)) + '/..';
const mod = await import(new URL('../src/weixin-article.js', import.meta.url));
const { parseWeixinArticle, isWeixinArticleUrl, isBoilerplate, stripHtmlToText, detectWeixinBlock, WEIXIN_READ_CHARS, collectWeixinImages } = mod;

const mcpSrc = fs.readFileSync(path.join(root, 'src/mcp-web-search-safe.js'), 'utf8');

console.log('── 1. 请求头：UA 必须是完整浏览器 UA ──');
{
  const m = mcpSrc.match(/const BROWSER_UA\s*=\s*'([^']+)'/);
  check('BROWSER_UA 已定义', Boolean(m), m ? '长度 ' + m[1].length : '');
  check('不是残缺的 Mozilla/5.0', m && m[1] !== 'Mozilla/5.0', m ? m[1].slice(0, 40) : '');
  check('含 Chrome 版本标识', m && /Chrome\/\d+/.test(m[1]));
  check('含平台标识（Windows）', m && /Windows NT/.test(m[1]));
  check('requestOnce 不再硬编码 Mozilla/5.0', !/user-agent'\s*:\s*'Mozilla\/5\.0'/.test(mcpSrc));
  check('requestOnce 用 BROWSER_UA', /'user-agent':\s*BROWSER_UA/.test(mcpSrc));
}

console.log('\n── 2. 阅读上限必须覆盖正文位置（防静默失败）──');
{
  // 实测：正文元信息在 219784，正文容器在 ~300000
  check('WEIXIN_READ_CHARS >= 1MB', WEIXIN_READ_CHARS >= 1024 * 1024, String(WEIXIN_READ_CHARS));
  check('远大于旧的 50000 截断', WEIXIN_READ_CHARS > 50000 * 10);
  check('safeFetch 对微信走大上限', /weixin\s*\?\s*WEIXIN_READ_CHARS/.test(mcpSrc));
  check('普通网页仍保持 50000（不被放大）', /:\s*50000;/.test(mcpSrc));
}

console.log('\n── 3. 微信文章 URL 判定 ──');
{
  const yes = [
    'https://mp.weixin.qq.com/s/PLACEHOLDERARTICLEID',
    'http://mp.weixin.qq.com/s/abc',
    'https://mp.weixin.qq.com/s?__biz=MzA5&mid=123',
    'https://mp.weixin.qq.com/s/PLACEHOLDERARTICLEID?scene=1',
  ];
  const no = [
    'https://mp.weixin.qq.com/mp/profile_ext?action=home',
    'https://mp.weixin.qq.com/mp/appmsgalbum?action=getalbum',
    'https://evil.com/s/abc',
    'https://mp.weixin.qq.com.evil.com/s/abc',
    'https://weixin.qq.com/s/abc',
    'http://127.0.0.1/s/abc',
    'not a url',
    '',
  ];
  for (const u of yes) check(`识别文章 ${u.slice(0, 46)}`, isWeixinArticleUrl(u) === true);
  for (const u of no) check(`不误判 ${u.slice(0, 46) || '(空)'}`, isWeixinArticleUrl(u) === false);
  check('接受 URL 对象', isWeixinArticleUrl(new URL('https://mp.weixin.qq.com/s/x')) === true);
}

console.log('\n── 4. 真实文章页解析 ──');
// 真实抓下来的页面做夹具（gzip 存储，2.46MB → 约 0.55MB）。
// 夹具缺失时明确跳过并提示，避免"测试全绿但其实没测"。
const fixture = path.join(root, 'test-fixtures/weixin-article.html.gz');
let realHtml = '';
try {
  realHtml = zlib.gunzipSync(fs.readFileSync(fixture)).toString('utf8');
} catch { /* 夹具缺失 */ }

if (realHtml) {
  // 夹具完整性：必须含正文元信息（否则测试没意义）
  check('夹具含 content_noencode（图片帖字段）', realHtml.includes('content_noencode'));
  check('夹具含 msg_title', realHtml.includes('msg_title'));

  const r = parseWeixinArticle(realHtml, 'https://mp.weixin.qq.com/s/PLACEHOLDERARTICLEID');
  check('ok=true（读到了）', r.ok === true);
  check('标题正确', r.title === '示例图片帖标题', r.title);
  check('公众号名正确', r.account === '示例公众号', r.account);
  check('发布时间正确', r.publishedAt === '2026-01-01 12:00', r.publishedAt);
  check('摘要正确', r.description === '这是配图的文字说明', r.description);
  check('识别为图片帖类型 10002', r.appmsgType === '10002', r.appmsgType);
  check('收集到配图直链', r.images.length >= 1, `${r.images.length} 张`);
  check('配图全部是 https', r.images.every((u) => u.startsWith('https://')));
  check('配图只来自 mmbiz 域', r.images.every((u) => /mmbiz\.(qpic|qlogo)\.cn/.test(u)));
  check('配图已去重', new Set(r.images).size === r.images.length);
  // 关键：图片帖正文为空，必须显式提示"内容在配图里"，不能静默返回空
  check('正文为空（图片帖真实情况）', r.text === '', JSON.stringify(r.text.slice(0, 40)));
  check('有 notes 提示内容在配图里', Array.isArray(r.notes) && /配图/.test(r.notes.join('')), JSON.stringify(r.notes));
  check('不会把「微信扫一扫」当正文', !r.text.includes('微信扫一扫'));
  check('不会把「使用完整服务」当正文', !r.text.includes('使用完整服务'));
} else {
  console.log('⚠️  夹具 .tmp-wx/resp1.html 不存在，跳过真实页面解析断言（其余断言仍有效）');
}

console.log('\n── 5. 验证页必须识别为 ok:false（最关键：不能当正文）──');
{
  // 实测的"环境异常"页特征
  const verifyHtml = `<!DOCTYPE html><html><head><meta charset="utf8"><title></title>
<style>body{color:#000}</style></head><body>
<div class="weui-msg"><div class="weui-msg__title">环境异常</div>
<div class="weui-msg__desc">当前环境异常，完成验证后即可继续访问。</div>
<a class="weui-btn" href="javascript:;">去验证</a></div>
<script>window.js_verify=1;</script></body></html>`;
  const r = parseWeixinArticle(verifyHtml, 'https://mp.weixin.qq.com/s/blocked');
  check('ok=false（没有内容）', r.ok === false);
  check('reason=verify', r.reason === 'verify', r.reason);
  check('message 说明要如实告知', /打不开|如实/.test(r.message || ''), (r.message || '').slice(0, 60));
  check('message 明确不要猜内容', /不要猜/.test(r.message || ''));
  check('detectWeixinBlock 直接可用', detectWeixinBlock(verifyHtml)?.kind === 'verify');
  // 正文绝不能从验证页里被编出来
  check('验证页不产出 text', !r.text);
  check('验证页不产出 title 冒充正文', !r.title);
}

console.log('\n── 6. 其他失败态 ──');
{
  const removed = `<html><body><div>该内容已被发布者删除</div></body></html>`;
  check('已删除页 → ok:false / removed', (() => { const r = parseWeixinArticle(removed); return r.ok === false && r.reason === 'removed'; })());

  const needWx = `<html><body><div>请在微信客户端打开链接</div></body></html>`;
  check('需客户端打开 → ok:false / need_wechat', (() => { const r = parseWeixinArticle(needWx); return r.ok === false && r.reason === 'need_wechat'; })());

  const empty = `<html><head><title></title></head><body></body></html>`;
  const r = parseWeixinArticle(empty);
  check('完全空页 → ok:false', r.ok === false);
}

console.log('\n── 7. 正文型文章的解析（容器优先）──');
{
  // 构造一个带 js_content 容器的正文帖
  const body = '这是一篇普通文章的第一段，用来验证容器提取是否工作正常，长度足够。\n'
    + '第二段继续说明一些细节，确保解析后能拿到多段正文内容，而不是空字符串。\n'
    + '第三段收尾。';
  const html = `<html><head>
<meta property="og:title" content="测试文章标题" />
<meta name="description" content="测试摘要" />
</head><body>
<script>window.msg_title = '测试文章标题'; window.nick_name='测试公众号'; window.create_time='2026-10-12 10:00';</script>
<div id="js_content"><p>${body.split('\n')[0]}</p><p>${body.split('\n')[1]}</p><p>${body.split('\n')[2]}</p></div>
<div id="js_article_bottom_bar"><p>页脚内容不该出现，这是推荐位，长度也够长可以匹配规则。</p></div>
</body></html>`;
  const r = parseWeixinArticle(html, 'https://mp.weixin.qq.com/s/normal');
  check('ok=true', r.ok === true);
  check('标题从 script 取到', r.title === '测试文章标题', r.title);
  check('公众号名取到', r.account === '测试公众号', r.account);
  check('时间取到', r.publishedAt === '2026-10-12 10:00', r.publishedAt);
  check('正文容器提取成功', r.textSource === 'js_content', r.textSource);
  check('正文含第一段', r.text.includes('第一段'));
  check('正文含第三段', r.text.includes('第三段'));
  check('页脚被截掉（不吃推荐位）', !r.text.includes('页脚内容不该出现'));
  check('检查正文非空', r.text.length > 30, String(r.text.length));
}

console.log('\n── 8. 样板文字过滤 ──');
{
  check('「知道了」是样板', isBoilerplate('知道了'));
  check('「微信扫一扫」是样板', isBoilerplate('微信扫一扫'));
  check('「微信扫一扫可打开此内容」是样板', isBoilerplate('微信扫一扫可打开此内容'));
  check('「轻点两下取消赞」是样板', isBoilerplate('轻点两下取消赞'));
  check('「使用完整服务」是样板', isBoilerplate('使用完整服务'));
  check('正常句子不是样板', !isBoilerplate('今天天气不错，我们出去玩吧'));
  check('长正文不是样板', !isBoilerplate('这篇文章讨论了缓存命中率的问题，实测数据表明前缀缓存效率很高，需要关注上下文长度。'));
  check('空串是样板', isBoilerplate(''));
}

console.log('\n── 9. stripHtmlToText 基础行为 ──');
{
  check('去 script', !stripHtmlToText('<div>a</div><script>var x=1;</script>').includes('var x'));
  check('去 style', !stripHtmlToText('<style>p{color:red}</style><p>b</p>').includes('color'));
  check('br 转换行', stripHtmlToText('a<br>b').includes('\n'));
  check('解 &amp;', stripHtmlToText('a &amp; b').includes('&'));
  check('解 &nbsp;', stripHtmlToText('a&nbsp;b').includes(' '));
  check('解数字实体', stripHtmlToText('&#x4e2d;&#x6587;') === '中文', stripHtmlToText('&#x4e2d;&#x6587;'));
  check('解十进制实体', stripHtmlToText('&#20013;') === '中');
  check('去注释', !stripHtmlToText('a<!-- 注释 -->b').includes('注释'));
}

console.log('\n── 10. 配图收集的安全约束 ──');
{
  const html = `<img src="//mmbiz.qpic.cn/a.jpg"><img src="http://mmbiz.qpic.cn/b.jpg">
<img src="https://evil.com/c.jpg"><img src="https://mmbiz.qpic.cn/a.jpg">
<img data-src="https://mmbiz.qpic.cn/d.jpg">
<script>cdn_url: 'https://mmbiz.qpic.cn/e.jpg'</script>`;
  const imgs = collectWeixinImages(html);
  check('协议相对 // 升级为 https', imgs.some((u) => u === 'https://mmbiz.qpic.cn/a.jpg'));
  check('http 升级为 https', imgs.some((u) => u === 'https://mmbiz.qpic.cn/b.jpg'));
  check('拒绝非 mmbiz 域（evil.com）', !imgs.some((u) => u.includes('evil.com')));
  check('去重（a.jpg 只一次）', imgs.filter((u) => u.endsWith('a.jpg')).length === 1);
  check('支持 data-src', imgs.some((u) => u.endsWith('d.jpg')));
  check('支持 cdn_url 字段', imgs.some((u) => u.endsWith('e.jpg')));
  check('全部 https', imgs.every((u) => u.startsWith('https://')));
  check('上限 12 张', collectWeixinImages(Array.from({ length: 40 }, (_, i) => `<img src="https://mmbiz.qpic.cn/${i}.jpg">`).join('')).length <= 12);
}

console.log('\n── 11. 工具描述必须引导"不编内容" ──');
{
  check('web_fetch 描述提到微信结构化返回', /微信公众号文章/.test(mcpSrc));
  check('描述说明 text 为空是图片帖', /内容在配图里/.test(mcpSrc));
  check('描述指引用 web_view_image 看图（不再只说"复述 description"）', /用 web_view_image 把 images 里的图取出来看/.test(mcpSrc));
  check('描述要求 ok:false 时如实告知', /如实告诉群友打不开/.test(mcpSrc));
  check('描述明确不要猜内容', /不要猜内容/.test(mcpSrc));
  check('描述提醒不要编造文章内容', /不要凭空编造/.test(mcpSrc));
  // 反面断言：不得指引模型去调看不了外链图的工具（qq_get_message_images 只认 QQ 消息里的图）
  check('不再误导数模型用 qq_get_message_images 看外链图', !/qq_get_message_images 看图/.test(mcpSrc));
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
