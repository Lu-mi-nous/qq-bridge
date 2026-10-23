// 回归测试：按需网页抓取 + 分享卡片完整链接 + 表情入库接线。
//
// 锁住：
//   ① HTML 提取：标题/描述/正文/og:image/srcset/相对 URL，脚本内容不进正文
//   ② aigengtu 索引：分类/关键词过滤、limit、随机抽样
//   ③ 图片格式识别（png/jpg/gif/webp）
//   ④ 桥接接线：crawl 端点、限流字段、add_custom_face、dryRun、工具开关
//   ⑤ 分享卡片不再 200 字截断，shareUrl 进入唤醒提示
import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns';
import {
  extractHtml,
  listAigengtuImages,
  imageExtOf,
  isAigengtuUrl
} from '../src/web-crawler.js';
import { normalizeCharset, detectCharset, decodeBuffer, isPrivateIp } from '../src/safe-fetch.js';

let pass = 0, fail = 0, skip = 0;
const check = (n, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };
const skipped = (n, why) => { skip++; console.log(`SKIP  ${n}  （${why}）`); };

const root = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Z]:)/, '$1') + '/..';

console.log('── 0. 字符集（GBK/GB2312 页面不再乱码）──');
{
  check('GBK 归一化为 gb18030', normalizeCharset('GBK') === 'gb18030');
  check('GB2312 归一化为 gb18030', normalizeCharset('gb2312') === 'gb18030');
  check('meta charset 识别', detectCharset('text/html', Buffer.from('<meta charset="gb2312">')) === 'gb18030');
  check('GBK 字节解码为中文', decodeBuffer(Buffer.from([0xd6, 0xd0, 0xce, 0xc4]), 'text/html; charset=gbk') === '中文');
  check('UTF-8 正常解码', decodeBuffer(Buffer.from('中国', 'utf8'), 'text/html; charset=utf-8') === '中国');
  const fakeIpDns = dns.getServers().some((s) => /^198\.(?:18|19)\./.test(String(s)));
  check('198.18 段与 fake-IP 环境一致', isPrivateIp('198.18.0.5') === !fakeIpDns,
    `dns=${dns.getServers().join(',')}`);
  check('127.0.0.1 始终拦截', isPrivateIp('127.0.0.1') === true);
}

console.log('\n── 1. HTML 提取 ──');
{
  const html = `<!doctype html><html><head>
    <title>测试 &amp; 页面</title>
    <meta name="description" content="这是一段描述">
    <meta property="og:image" content="/og.jpg">
    </head><body>
    <script>console.log('不该出现')</script>
    <h1>Hello</h1><p>正文 <b>内容</b></p>
    <img src="a.png" alt="A">
    <img data-src="/b.webp" alt="B">
    <img srcset="c-1.jpg 1x, c-2.jpg 2x" alt="C">
    <img src="data:image/png;base64,xxx" alt="data">
    </body></html>`;
  const p = extractHtml(html, 'https://example.com/post/1');
  check('标题解码实体', p.title === '测试 & 页面', p.title);
  check('描述', p.description === '这是一段描述');
  check('正文去掉脚本', p.text.includes('正文') && !p.text.includes('不该出现'));
  check('og:image 绝对化', p.images.some((x) => x.url === 'https://example.com/og.jpg'));
  check('相对图片地址解析', p.images.some((x) => x.url === 'https://example.com/post/a.png'));
  check('data-src 兼容', p.images.some((x) => x.url === 'https://example.com/b.webp'));
  check('srcset 取最大项', p.images.some((x) => x.url === 'https://example.com/post/c-2.jpg'));
  check('data: URI 被忽略', !p.images.some((x) => x.url.startsWith('data:')));
  check('登录页识别', extractHtml('<title>请登录</title><body>登录后查看</body>', 'https://x.com').needsLogin === true);
}

console.log('\n── 2. aigengtu 索引 ──');
{
  const fixture = {
    generated_at: '2026-10-22',
    gallery: {
      'DeepSeek娘': {
        name: 'DeepSeek娘',
        images: [
          { name: '气鼓鼓', alt: '气鼓鼓表情包', preview: 'https://img/1p.webp', original: 'https://img/1.webp', story: { zh: '便宜货梗' } },
          { name: '委屈落泪', alt: '委屈', preview: 'https://img/2p.webp', original: 'https://img/2.webp', story: { zh: '又错了' } }
        ]
      },
      '通用': {
        name: '通用',
        images: [
          { name: '猫猫', alt: '猫', preview: 'https://img/3p.webp', original: 'https://img/3.webp', story: { zh: '猫' } }
        ]
      }
    }
  };
  const all = listAigengtuImages(fixture, { limit: 10, random: () => 0 });
  check('全部图片', all.length === 3, String(all.length));
  check('优先 original', all.every((x) => x.url.includes('/img/') && !x.url.includes('p.webp')));
  const cat = listAigengtuImages(fixture, { category: 'DeepSeek', limit: 10, random: () => 0 });
  check('按分类过滤', cat.length === 2 && cat.every((x) => x.category === 'DeepSeek娘'));
  const q = listAigengtuImages(fixture, { query: '猫', limit: 10, random: () => 0 });
  check('按关键词过滤（含 story）', q.length === 1 && q[0].name === '猫猫');
  const limited = listAigengtuImages(fixture, { limit: 2, random: () => 0 });
  check('limit 生效', limited.length === 2);
  check('无匹配返回空', listAigengtuImages(fixture, { query: '不存在的词', limit: 10 }).length === 0);
  check('aigengtu host 识别', isAigengtuUrl('https://aigengtu.com/') && isAigengtuUrl('https://www.aigengtu.com/x'));
  check('其他站不算 aigengtu', !isAigengtuUrl('https://example.com'));
}

console.log('\n── 3. 图片格式识别 ──');
{
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0]);
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const gif = Buffer.from('GIF89a' + '\0'.repeat(6));
  const webp = Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
  check('png', imageExtOf(png) === 'png');
  check('jpg', imageExtOf(jpg) === 'jpg');
  check('gif', imageExtOf(gif) === 'gif');
  check('webp', imageExtOf(webp) === 'webp');
  check('未知格式', imageExtOf(Buffer.from('not an image')) === '');
}

console.log('\n── 4. 桥接 / 工具接线 ──');
{
  const bridge = fs.readFileSync(path.join(root, 'src', 'bridge.js'), 'utf8');
  const mcp = fs.readFileSync(path.join(root, 'src', 'mcp-snowluma-safe.js'), 'utf8');
  const flags = fs.readFileSync(path.join(root, 'src', 'tool-flags.js'), 'utf8');
  const preset = fs.readFileSync(path.join(root, 'dsh', 'agent-presets', 'qq-chat-v2', 'agent.cordis.yml'), 'utf8');

  check('crawl 端点', /'\/api\/socialV2\/crawl'/.test(bridge));
  check('取图拉取时间持久化（重启后控制台不归零）',
    /IMAGE_FETCH_STATE_FILE/.test(bridge) && /lastFetchedAt/.test(bridge));
  check('存表情调用 add_custom_face', /bot\.request\('add_custom_face'/.test(bridge));
  check('支持 dryRun（试运行不写 QQ）', /body\.dryRun === true/.test(bridge) && /dryRun: true/.test(bridge));
  check('按 md5 去重', /existingMd5/.test(bridge));
  check('爬取/存表情限流落盘', /crawlTimes: Array\.isArray\(st\.crawlTimes\)/.test(bridge)
    && /stickerAddTimes: Array\.isArray\(st\.stickerAddTimes\)/.test(bridge));
  check('MCP 工具 qq_crawl_web', /'qq_crawl_web'/.test(mcp) && /\/api\/socialV2\/crawl/.test(mcp));
  check('工具有 crawl 开关', /flag: 'crawl'/.test(flags) && /qq_crawl_web/.test(flags));
  check('人设写了使用边界', /qq_crawl_web/.test(preset) && /不要尝试绕过登录/.test(preset));

  check('分享卡片提取', /extractShareCards\(event\.message/.test(bridge));
  check('卡片消息放宽到 1200 字', /textLimit = shareUrl \? 1200 : 200/.test(bridge));
  check('shareUrl 单独存字段', /shareUrl,/.test(bridge) && /shareTitle:/.test(bridge));
  check('唤醒提示带完整分享链接', /分享链接（\$\{shareMsg\.sharePlatform \|\| '卡片'\}/.test(bridge));
}

console.log('\n── 5. 真实 aigengtu（可选，联网）──');
{
  if (process.env.LIVE_CRAWL !== '1') {
    skipped('真实 aigengtu 抓取', '设 LIVE_CRAWL=1 才跑');
  } else {
    const { crawlAigengtu } = await import('../src/web-crawler.js');
    const r = await crawlAigengtu({ query: '', limit: 3, random: () => 0 });
    check('索引可抓取', Array.isArray(r.images) && r.images.length > 0, String(r.images?.length));
    check('图片是 http(s)', r.images.every((x) => /^https?:\/\//.test(x.url)));
    check('有分类和名字', r.images.every((x) => x.category && x.name));
  }
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} 通过 / ${fail} 失败${skip ? ` / ${skip} 跳过` : ''}`);
process.exitCode = fail === 0 ? 0 : 1;
