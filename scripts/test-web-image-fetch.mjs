// 回归测试：按 URL 取图给模型看（web_view_image）。
//
// 背景（2026-10-12 用户要求"做"）：
// 微信公众号图片帖（appmsg_type=10002）正文容器为空，内容全在配图里。
// web_fetch 能拿到图片直链，但机器人看不到图内容：
//   - qq_get_message_images 只认 QQ 消息里的图（不接受外链）
//   - qq_send_image 只支持标签检索（不接受任意 URL）
// 所以新增 web_view_image：抓图后以 {type:'image'} 返回，视觉模型可直接看懂。
//
// 这个测试重点保护三类约束（都是"错了会静默出问题"的）：
//   1. 安全：内网地址必须拒绝（复用 safe-fetch 的 SSRF 防护，不得另起一套）
//   2. 健壮：非图片内容（HTML 错误页）必须报错，不能把垃圾当图塞给模型
//   3. 可用：大小/数量上限要给出可读报错（超限会被模型 API 拒收，静默失败极难排查）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0, fail = 0;
const check = (n, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };

const root = path.dirname(fileURLToPath(import.meta.url)) + '/..';
const m = await import(new URL('../src/web-image-fetch.js', import.meta.url));
const { IMAGE_MAX_BYTES, IMAGE_MAX_PER_CALL, sniffImageMime, refererForHost, humanBytes, normalizeImageUrls } = m;

const mcpSrc = fs.readFileSync(path.join(root, 'src/mcp-web-search-safe.js'), 'utf8');
const modSrc = fs.readFileSync(path.join(root, 'src/web-image-fetch.js'), 'utf8');

console.log('── 1. 工具已注册且描述完整 ──');
{
  check('注册了 web_view_image', /server\.tool\(\s*'web_view_image'/.test(mcpSrc));
  check('描述说明返回图像给模型看', /直接以图像返回给你看/.test(mcpSrc));
  check('描述提到微信图片帖场景', /图片帖/.test(mcpSrc));
  check('描述写明单张上限', /2\.5MB/.test(mcpSrc));
  check('描述写明数量上限', /最多 3 张/.test(mcpSrc));
  check('描述要求取不到时如实说、不要猜', /不要猜图里的内容/.test(mcpSrc));
}

console.log('\n── 2. 安全：必须复用现成的 SSRF 防护，不得另写抓取 ──');
{
  // 关键：抓取必须走 safe-fetch（它带内网拦截/DNS rebinding 逐跳校验/magic 校验）
  check('复用了 safeFetchBuffer（而非自写 http 请求）', /import\s*\{[^}]*safeFetchBuffer[^}]*\}/.test(mcpSrc));
  check('调用 safeFetchBuffer 时传入上限', /safeFetchBuffer\(\s*u\s*,\s*IMAGE_MAX_BYTES/.test(mcpSrc));
  // 反面断言：本模块不得自己实现网络请求（否则防线分叉）
  check('web-image-fetch 不自己发请求（无 http/https import）', !/from 'node:(http|https|dns|net)'/.test(modSrc));
  check('web-image-fetch 不自己实现内网判定', !/isPrivateIp|127\.0\.0\.1|192\.168/.test(modSrc));
}

console.log('\n── 3. 图片类型判别（magic number）──');
{
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(6)]);
  const gif87 = Buffer.concat([Buffer.from('GIF87a'), Buffer.alloc(6)]);
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]);
  const bmp = Buffer.concat([Buffer.from('BM'), Buffer.alloc(10)]);
  const html = Buffer.from('<!DOCTYPE html><html><body>error page</body></html>');

  check('PNG', sniffImageMime(png) === 'image/png');
  check('JPEG', sniffImageMime(jpg) === 'image/jpeg');
  check('GIF89a', sniffImageMime(gif) === 'image/gif');
  check('GIF87a', sniffImageMime(gif87) === 'image/gif');
  check('WebP', sniffImageMime(webp) === 'image/webp');
  check('BMP 被识别（但调用方会跳过）', sniffImageMime(bmp) === 'image/bmp');
  // 最关键：HTML 必须不被当成图片
  check('HTML 不识别为图片', sniffImageMime(html) === '');
  check('空 buffer 不识别', sniffImageMime(Buffer.alloc(0)) === '');
  check('太短的 buffer 不识别', sniffImageMime(Buffer.from([0xff, 0xd8])) === '');
  check('纯文本不识别', sniffImageMime(Buffer.from('hello world, not an image at all')) === '');
  check('BMP 会被跳过（模型侧不可靠）', /image\/bmp/.test(mcpSrc) && /已跳过/.test(mcpSrc));
}

console.log('\n── 4. 上限约束 ──');
{
  check('单张上限 2.5MB', IMAGE_MAX_BYTES === 2.5 * 1024 * 1024, String(IMAGE_MAX_BYTES));
  check('单张上限 < 4MB（base64 膨胀 33% 后仍在模型限内）', IMAGE_MAX_BYTES < 4 * 1024 * 1024);
  check('单次最多 3 张', IMAGE_MAX_PER_CALL === 3, String(IMAGE_MAX_PER_CALL));

  const tooMany = normalizeImageUrls(['https://a.com/1.jpg', 'https://a.com/2.jpg', 'https://a.com/3.jpg', 'https://a.com/4.jpg']);
  check('超过 3 张被拒绝', tooMany.ok === false);
  check('超限报错可读（建议分批）', /最多看 3 张/.test(tooMany.error) && /分批/.test(tooMany.error), tooMany.error);

  const exactly3 = normalizeImageUrls(['https://a.com/1.jpg', 'https://a.com/2.jpg', 'https://a.com/3.jpg']);
  check('正好 3 张放行', exactly3.ok === true && exactly3.urls.length === 3);
}

console.log('\n── 5. URL 规范化 ──');
{
  const one = normalizeImageUrls('https://a.com/x.jpg');
  check('接受单个字符串', one.ok === true && one.urls.length === 1);
  check('单个字符串也转成数组', Array.isArray(one.urls));

  const arr = normalizeImageUrls(['https://a.com/1.jpg', 'https://a.com/2.jpg']);
  check('接受数组', arr.ok === true && arr.urls.length === 2);

  const dup = normalizeImageUrls(['https://a.com/1.jpg', 'https://a.com/1.jpg']);
  check('去重', dup.ok === true && dup.urls.length === 1);

  check('空输入被拒绝', normalizeImageUrls([]).ok === false);
  check('null 被拒绝', normalizeImageUrls(null).ok === false);
  check('非法 URL 被拒绝', normalizeImageUrls('not a url').ok === false);
  check('非 http(s) 被拒绝（file://）', normalizeImageUrls('file:///etc/passwd').ok === false);
  check('非 http(s) 被拒绝（data:）', normalizeImageUrls('data:image/png;base64,AAAA').ok === false);
  check('空白项被跳过', normalizeImageUrls(['  ', 'https://a.com/x.jpg']).urls.length === 1);
}

console.log('\n── 6. 防盗链 Referer ──');
{
  check('i.pximg.net 带 pixiv Referer', refererForHost('i.pximg.net') === 'https://www.pixiv.net/');
  check('mmbiz.qpic.cn 带微信 Referer', refererForHost('mmbiz.qpic.cn') === 'https://mp.weixin.qq.com/');
  check('未知 host 返回空串（不强加）', refererForHost('example.com') === '');
  check('大小写不敏感', refererForHost('I.PXIMG.NET') === 'https://www.pixiv.net/');
  check('子域也匹配', refererForHost('cdn.sinaimg.cn') === 'https://weibo.com/');
  check('不是后缀匹配漏洞（evilsinaimg.cn）', refererForHost('evilsinaimg.cn') === '');
  check('调用方把 Referer 传进 headers', /headers:\s*referer\s*\?\s*\{\s*referer\s*\}/.test(mcpSrc));
}

console.log('\n── 7. 与 web_fetch 共用同一个 UA（残缺 UA 会被图床判爬虫）──');
{
  check('web_view_image 用 BROWSER_UA', /userAgent:\s*BROWSER_UA/.test(mcpSrc));
  const uaMatch = mcpSrc.match(/const BROWSER_UA\s*=\s*'([^']+)'/);
  check('UA 是完整浏览器 UA', uaMatch && /Chrome\/\d+/.test(uaMatch[1]) && uaMatch[1] !== 'Mozilla/5.0');
}

console.log('\n── 8. humanBytes 展示 ──');
{
  check('字节', humanBytes(512) === '512B');
  check('KB', humanBytes(2048) === '2KB');
  check('MB', humanBytes(2.5 * 1024 * 1024) === '2.5MB');
  check('0 不崩', humanBytes(0) === '0B');
  check('非法值不崩', humanBytes(undefined) === '0B');
}

console.log('\n── 9. 失败路径必须给可操作信息（不静默）──');
{
  check('全部失败时 isError', /if\s*\(!okCount\)/.test(mcpSrc) && /isError:\s*true/.test(mcpSrc));
  check('失败提示要求如实告知群友', /如实告诉群友图片取不到/.test(mcpSrc));
  check('逐张报告成败', /notes\.push/.test(mcpSrc) && /√|×/.test(mcpSrc));
  check('非图片内容有专门提示', /不是有效图片/.test(mcpSrc));
}

console.log('\n── 10. 不污染既有工具 ──');
{
  const { registerSearchTool } = await import('../plugins/web-search/mcp-tools.js');
  const names = [];
  registerSearchTool({ config: { get: () => ({}) }, mcp: { registerTool: name => names.push(name) } }, {});
  check('web_search 仍由搜索插件注册', names.includes('web_search'));
  check('web_fetch 仍在', /'web_fetch'/.test(mcpSrc));
  check('内网拦截仍生效（既有断言未被动过）', /禁止访问内网\/本机地址/.test(
    fs.readFileSync(path.join(root, 'src/safe-fetch.js'), 'utf8')));
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
