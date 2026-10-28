import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProcessPluginRuntime } from './plugins/process-runtime.js';
// 安全版 Web Search / Fetch MCP server（stdio）。由 DSH 的 MCP 客户端 spawn。
//
// 安全设计：
// - 只暴露只读工具 `web_search` 与 `web_fetch`：查网络用语/梗/黑话、抓取网页正文。
// - 不暴露任何本地文件、命令执行、写操作。
// - 查询词做基础清洗：去 CQ 码、控制字符、超长截断。
// - `web_fetch` 仅允许 http/https：
//   - 禁止 URL 内嵌凭据；
//   - 禁止 localhost / .local / 私有 IP / 环回 / 链路本地 / CGNAT 等内网地址；
//   - 域名会先做 DNS 解析并检查全部解析结果，避免解析到内网；
//   - 手动跟随重定向，每一跳都重新校验；
//   - 响应体按字节流限量读取，避免超大响应拖垮进程。
// - 搜索结果/抓取结果仅作为“候选解释”，最终是否入库仍由控制台人工确认。
import dns from 'node:dns';
import fs from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
// 可插拔搜索引擎模块（R4.5-2 起在 plugins/web-search/）：引擎在其 lib/engines/ 下，
// 开关与顺序在 config.json 的 webSearch.engines（mtime 热加载，改配置不用重启）。
// 首个返回非空结果的引擎胜出。插件目录缺失时下面拿不到实现 → 不注册 web_search，
// 但 web_fetch / web_view_image 不受影响（它们不依赖引擎链）。
const searchRuntime = await createProcessPluginRuntime({
  root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
  only: ['web-search'], log: message => console.error(message)
});
// 微信公众号文章解析（纯函数）。见 weixin-article.js 顶部说明：UA 残缺会被风控拦，
// 且正文在 50KB 之后，必须读全量再解析。
import { parseWeixinArticle, isWeixinArticleUrl, WEIXIN_READ_CHARS } from './weixin-article.js';
// 按 URL 取图给模型看（SSRF 防护复用 safe-fetch）。
import { safeFetchBuffer, decodeBuffer } from './safe-fetch.js';
import { proxyGet } from './proxy-tunnel.js';
import { IMAGE_MAX_BYTES, IMAGE_MAX_PER_CALL, sniffImageMime, refererForHost, humanBytes, normalizeImageUrls } from './web-image-fetch.js';

const dnsLookup = dns.promises.lookup;

function decodeHtml(s) {
  return String(s ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// 解析 IPv6 中内嵌的 IPv4（::ffff:a.b.c.d、::ffff:7f00:1、::a.b.c.d 等）。
// 只处理标准 IPv4-mapped / IPv4-compatible 形式，避免把 fc00::1、fe80::1 误判成内嵌 IPv4。
function ipv4FromLast32(lower) {
  const parts = String(lower || '').split(':');
  if (parts.length < 2) return null;
  const last = parts[parts.length - 1];
  const secondLast = parts[parts.length - 2];
  if (/^\d+\.\d+\.\d+\.\d+$/.test(last)) return last;
  if (/^[0-9a-f]{1,4}$/.test(secondLast) && /^[0-9a-f]{1,4}$/.test(last)) {
    const num = (parseInt(secondLast, 16) << 16) + parseInt(last, 16);
    return `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
  }
  return null;
}

function parseEmbeddedIpv4(h) {
  const lower = String(h || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!lower.includes(':')) return null;
  const dotted = lower.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return dotted[1];
  // ::ffff:7f00:1 或 ::7f00:1（IPv4-mapped / compatible）
  const m = lower.match(/^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (m) {
    const num = (parseInt(m[1], 16) << 16) + parseInt(m[2], 16);
    return `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
  }
  // 兼容 ::ffff:0:7f00:1、::ffff:0:c0a8:101、::c0a8:101 等非规范 IPv4-mapped/compatible 写法。
  if (lower.startsWith('::ffff:') || lower.startsWith('::')) {
    const embedded = ipv4FromLast32(lower);
    if (embedded) return embedded;
  }
  // NAT64 前缀（64:ff9b::/96 与 64:ff9b:1::/48）内嵌 IPv4，例如 64:ff9b::c0a8:101 -> 192.168.1.1
  if (lower.startsWith('64:ff9b')) {
    const embedded = ipv4FromLast32(lower);
    if (embedded) return embedded;
  }
  const nat64 = lower.match(/^64:ff9b:(?:::)?(?:([0-9a-f]{1,4}):([0-9a-f]{1,4})|(\d+\.\d+\.\d+\.\d+))$/i);
  if (nat64) {
    if (nat64[3]) return nat64[3];
    const num = (parseInt(nat64[1], 16) << 16) + parseInt(nat64[2], 16);
    return `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
  }
  return null;
}

/**
 * Clash fake-IP 模式：系统 DNS 是 198.18.x，域名也解析到 198.18.x。
 * 这时 198.18.0.0/15 不是内网/benchmark，而是代理假 IP；拦掉会让所有网页/表情图都失败。
 */
function isFakeIpDns() {
  try {
    return dns.getServers().some((s) => /^198\.(?:18|19)\./.test(String(s)));
  } catch {
    return false;
  }
}

function isPrivateIp(ip) {
  const h = String(ip || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  const embedded = h.includes(':') ? parseEmbeddedIpv4(h) : null;
  if (embedded) return isPrivateIp(embedded);

  if (net.isIP(h) === 4) {
    const parts = h.split('.').map(Number);
    if (parts[0] === 10) return true;
    if (parts[0] === 127) return true;
    if (parts[0] === 0) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
    // 198.18.0.0/15（benchmarking；Clash fake-IP 模式下放行）、192.0.0.0/24（IETF 协议保留）
    if (parts[0] === 198 && parts[1] >= 18 && parts[1] <= 19) return !isFakeIpDns();
    if (parts[0] === 192 && parts[1] === 0 && parts[2] === 0) return true;
    // 组播与保留段
    if (parts[0] >= 224) return true;
    return false;
  }

  if (net.isIP(h) === 6) {
    if (h === '::' || h === '::1') return true;
    // fc00::/7 ULA
    if (h.startsWith('fc') || h.startsWith('fd')) return true;
    // fe80::/10 link-local
    if (/^fe[89ab]/.test(h)) return true;
    // fec0::/10 site-local（已废弃）
    if (h.startsWith('fec') || h.startsWith('fed') || h.startsWith('fee') || h.startsWith('fef')) return true;
    // 2001:db8::/32 文档地址
    if (h.startsWith('2001:db8')) return true;
    if (h.startsWith('2001:2:') || h.startsWith('2001:10:') || h.startsWith('2001:20:')) return true;
    // 6to4 内嵌 IPv4，例如 2002:c0a8:0101:: -> 192.168.1.1
    const sixth4 = h.match(/^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4}):/i);
    if (sixth4) {
      const num = (parseInt(sixth4[1], 16) << 16) + parseInt(sixth4[2], 16);
      const ipv4 = `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
      if (isPrivateIp(ipv4)) return true;
    }
    // ff00::/8 组播地址
    if (h.startsWith('ff')) return true;
    return false;
  }

  // 非标准 IP 字面量由 DNS 解析后统一检查。
  return false;
}

// 解析主机名并固定到已校验的 IP，避免 DNS rebinding。
async function lookupWithTimeout(hostname) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('DNS 解析超时')), 5000);
  });
  return Promise.race([dnsLookup(hostname, { all: true, verbatim: true }), timeout]).finally(() => clearTimeout(timer));
}

async function resolveSafeHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) throw new Error('主机名为空');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) {
    throw new Error('禁止访问内网/本机地址');
  }
  if (net.isIP(h)) {
    if (isPrivateIp(h)) throw new Error('禁止访问内网/本机地址');
    return h;
  }
  let addresses;
  try {
    addresses = await lookupWithTimeout(h);
  } catch (error) {
    throw new Error(`域名解析失败：${error?.message ?? error}`);
  }
  if (!addresses.length) throw new Error('域名没有解析结果');
  for (const { address } of addresses) {
    if (isPrivateIp(address)) {
      throw new Error('域名解析到内网/本机地址，已阻止');
    }
  }
  return addresses[0].address;
}

async function validateFetchUrl(raw) {
  let url;
  try {
    url = new URL(String(raw ?? '').trim());
  } catch {
    throw new Error('URL 无效');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('仅允许 http/https');
  if (url.username || url.password) throw new Error('URL 不能包含凭据');
  const ip = await resolveSafeHost(url.hostname);
  return { url, ip };
}

function sliceByCodePoints(s, max) {
  if (s.length <= max) return s;
  return Array.from(s).slice(0, max).join('');
}

// 从 Node IncomingMessage 读取最多 maxChars 个字符，按页面字符集解码。
// 不能边读边 StringDecoder('utf8')：GB2312/GBK 页面会整页乱码（2026-10-23 实测 youth.cn）。
function readBoundedText(res, maxChars, contentType = '') {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    const maxBytes = Math.min(16 * 1024 * 1024, Math.max(64 * 1024, maxChars * 4 + 4096));
    const finish = (fn, val) => {
      if (settled) return;
      settled = true;
      fn(val);
    };
    const done = () => {
      const body = decodeBuffer(Buffer.concat(chunks), contentType);
      finish(resolve, sliceByCodePoints(body, maxChars));
    };
    res.on('data', (chunk) => {
      if (settled) return;
      chunks.push(chunk);
      total += chunk.length;
      if (total >= maxBytes) {
        try { res.destroy(); } catch {}
        done();
      }
    });
    res.on('end', () => { if (!settled) done(); });
    res.on('error', (err) => finish(reject, err));
  });
}

// 使用已校验的 IP 发起请求（保留 Host/SNI），从根上消除 DNS rebinding。
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function requestOnce(url, ip, maxChars = 50000) {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http;
    const port = url.port || (url.protocol === 'https:' ? 443 : 80);
    const req = mod.request({
      hostname: ip,
      port,
      path: url.pathname + url.search,
      method: 'GET',
      headers: {
        host: url.host,
        'user-agent': BROWSER_UA,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'zh-CN,zh;q=0.9',
        'accept-encoding': 'identity',
      },
      servername: url.protocol === 'https:' ? url.hostname : undefined,
      rejectUnauthorized: url.protocol === 'https:',
      timeout: 20000,
    }, (res) => {
      const statusCode = res.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(statusCode)) {
        res.resume();
        resolve({ statusCode, redirect: String(res.headers.location || '') });
        return;
      }
      readBoundedText(res, maxChars, String(res.headers['content-type'] || ''))
        .then((body) => resolve({ statusCode, body, contentType: String(res.headers['content-type'] || '') }))
        .catch(reject);
    });
    req.on('timeout', () => req.destroy(new Error(`请求超时：${url.hostname}`)));
    req.on('error', reject);
    req.end();
  });
}

async function safeFetch(urlString) {
  const MAX_REDIRECTS = 5;
  let { url, ip } = await validateFetchUrl(urlString);
  // 微信文章可能 302 到 /mp/wappoc_appmsgcaptcha（验证页）。必须记住"原始链接是
  // 微信文章"，否则跳转后 isWeixinArticleUrl 变 false，会把验证页当普通 HTML
  // 原样返回给模型（2026-10-23 实测两条文章都被跳到验证页）。
  const weixinArticle = isWeixinArticleUrl(urlString);
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    // 微信文章页必须读全量：正文元信息在 ~219KB、标题在 ~317KB 处，
    // 按默认 50KB 读会「成功但正文为空」——静默失败，最难排查。
    const weixin = weixinArticle || isWeixinArticleUrl(url);
    const maxChars = weixin ? WEIXIN_READ_CHARS : 50000;
    const result = await requestOnce(url, ip, maxChars);
    if ([301, 302, 303, 307, 308].includes(result.statusCode)) {
      if (!result.redirect) throw new Error(`重定向缺少 Location: ${result.statusCode}`);
      const next = new URL(result.redirect, url).toString();
      ({ url, ip } = await validateFetchUrl(next));
      continue;
    }
    const body = result.body || '';
    if (weixin) {
      // 微信文章被风控时会 302 到 /mp/wappoc_appmsgcaptcha（验证页），
      // 页面本身几乎是空壳，parseWeixinArticle 识别不出内容。按 URL 直接判验证页。
      if (/wappoc_appmsgcaptcha/i.test(url.pathname)) {
        return {
          url: url.toString(),
          statusCode: result.statusCode,
          contentType: result.contentType,
          truncated: false,
          kind: 'weixin-article',
          ok: false,
          blockKind: 'verify',
          message: '微信返回了验证页（要求人工验证），这篇文章机器人读不到。请如实告诉群友打不开，不要猜内容；可以让对方贴标题或正文片段。',
        };
      }
      // 微信文章解析成短文本再交给模型：原始 HTML 是 2.5MB 的内联 JS bundle，
      // 直接塞给模型既超长又读不出内容。
      const parsed = parseWeixinArticle(body, url.toString());
      return {
        url: url.toString(),
        statusCode: result.statusCode,
        contentType: result.contentType,
        truncated: body.length >= maxChars,
        kind: 'weixin-article',
        ...parsed,
      };
    }
    return {
      url: url.toString(),
      statusCode: result.statusCode,
      contentType: result.contentType,
      truncated: body.length >= maxChars,
      body,
    };
  }
  throw new Error('重定向次数过多，已停止');
}

// web_fetch 直连失败且配置了代理时，走一次 CONNECT 隧道重试。
// 典型场景：raw.githubusercontent.com / 部分境外站点直连被 reset。
function readProxyConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
    return String(raw.webSearch?.proxy || raw.socialV2?.images?.proxy || '').trim();
  } catch {
    return '';
  }
}

function isNetworkError(message) {
  return /(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|请求超时|读取超时|fetch failed|socket hang up)/i.test(String(message ?? ''));
}

async function safeFetchViaProxy(urlString, proxy) {
  const weixinArticle = isWeixinArticleUrl(urlString);
  const maxChars = weixinArticle ? WEIXIN_READ_CHARS : 50000;
  const r = await proxyGet(urlString, {
    proxy,
    timeoutMs: 20000,
    maxBytes: 16 * 1024 * 1024,
    headers: {
      'user-agent': BROWSER_UA,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'zh-CN,zh;q=0.9',
      'accept-encoding': 'identity',
    },
  });
  const contentType = String(r.headers?.['content-type'] || '');
  const rawBody = Buffer.isBuffer(r.body) ? r.body : Buffer.from(String(r.body ?? ''), 'utf8');
  const body = sliceByCodePoints(decodeBuffer(rawBody, contentType), maxChars);
  const finalUrl = r.url || urlString;
  if (weixinArticle) {
    let pathname = '';
    try { pathname = new URL(finalUrl).pathname; } catch {}
    if (/wappoc_appmsgcaptcha/i.test(pathname)) {
      return {
        url: finalUrl,
        statusCode: r.status,
        contentType,
        truncated: false,
        kind: 'weixin-article',
        ok: false,
        blockKind: 'verify',
        message: '微信返回了验证页（要求人工验证），这篇文章机器人读不到。请如实告诉群友打不开，不要猜内容；可以让对方贴标题或正文片段。',
      };
    }
    const parsed = parseWeixinArticle(body, finalUrl);
    return {
      url: finalUrl,
      statusCode: r.status,
      contentType,
      truncated: body.length >= maxChars,
      kind: 'weixin-article',
      ...parsed,
    };
  }
  return {
    url: finalUrl,
    statusCode: r.status,
    contentType,
    truncated: body.length >= maxChars,
    body,
  };
}

const server = new McpServer({ name: 'web-search-safe', version: '0.7.1' });

for (const tool of searchRuntime.mcpTools()) {
  server.tool(tool.name, tool.description, tool.inputSchema, tool.handler);
}

server.tool(
  'web_fetch',
  '只读抓取 HTTP(S) 网页正文，返回纯文本/HTML 前 50000 字符。禁止访问内网/本机地址，不执行任何本地操作。\n\n'
  + '【微信公众号文章】自动识别 mp.weixin.qq.com 的文章链接，返回结构化结果而非原始 HTML：'
  + 'title（标题）/ account（公众号名）/ publishedAt（发布时间）/ description（摘要）/ text（正文）/ images（配图直链）。\n'
  + '- text 为空、且 notes 说「内容在配图里」时：**说明这是图片帖，正文就是那些图**。'
  + '这时用 web_view_image 把 images 里的图取出来看（一次最多 3 张），再告诉群友图里是什么；'
  + '不要只复述 description，也不要凭空编造文章内容。\n'
  + '- ok:false 表示没读到（验证页/已删除/需客户端打开），message 里说明了原因。'
  + '**必须如实告诉群友打不开，不要猜内容**，可以请对方贴标题或正文片段。'
  + '- 非 2xx 状态（403/404/5xx）、Cloudflare/百度等验证页、图片/PDF 等非文本内容都会返回 isError=true 和原因；'
  + '不要把这些当成网页正文。图片 URL 请改用 web_view_image。',
  { url: z.string().describe('要抓取的 http(s) URL') },
  async ({ url }) => {
    try {
      let result;
      try {
        result = await safeFetch(url);
      } catch (error) {
        const proxy = readProxyConfig();
        if (!proxy || !isNetworkError(error?.message)) throw error;
        result = await safeFetchViaProxy(url, proxy);
      }
      const status = Number(result.statusCode || 0);
      const contentType = String(result.contentType || '');
      const bodyText = String(result.body || '');
      const preview = bodyText.slice(0, 500);
      const challengeText = bodyText.slice(0, 4000);
      const challengeRe = /(?:Just a moment|Attention Required|Access denied|Enable JavaScript and cookies|百度安全验证|安全验证|人机验证|访问过于频繁|请稍后再试)/i;

      const fail = (message) => ({
        content: [{
          type: 'text',
          text: JSON.stringify({
            ok: false,
            url: result.url,
            statusCode: status,
            contentType,
            message,
            bodyPreview: preview,
          }, null, 2),
        }],
        isError: true,
      });

      // 非 2xx 一律当失败：以前 403 的 Cloudflare 验证页也返回 isError=false，
      // 模型会以为读到了正文（2026-10-23 实测 moegirl 403 "Just a moment..."）。
      if (status < 200 || status >= 400) return fail(`HTTP ${status}，未拿到网页正文`);
      if (result.kind === 'weixin-article' && result.ok === false) return fail(result.message || '微信文章没读到正文');
      if (/^image\//i.test(contentType)) return fail('这是图片资源，不是网页正文；请改用 web_view_image 查看图片');
      if (/^application\/(?:pdf|zip|octet-stream|x-msdownload)/i.test(contentType)) {
        return fail(`这是 ${contentType} 二进制内容，web_fetch 只能读文本/HTML`);
      }
      if (!result.body && result.kind !== 'weixin-article') return fail('响应为空，没有可读正文');
      if (challengeRe.test(challengeText)) return fail('命中反爬/安全验证页，未拿到真正正文');

      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, ...result }, null, 2) }] };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `抓取失败：${error?.message ?? error}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  'web_view_image',
  '按图片直链 URL 抓取图片并**直接以图像返回给你看**（视觉模型可"看懂"内容）。'
  + '当 web_fetch 返回的 images 里有图、或群友发来图片链接而你只有 URL 时用它。\n'
  + '典型场景：微信公众号图片帖（正文为空、内容全在配图里）——先用 web_fetch 拿 images，再调用本工具看图，'
  + '然后告诉群友图里是什么。\n'
  + '限制：单张 ≤2.5MB（超了会被模型拒收，工具会明确报错）；一次最多 3 张。'
  + '禁止访问内网/本机地址；只读，不执行任何本地操作。\n'
  + '若报错说不是有效图片，说明该 URL 指向网页或已失效——如实告知群友图片取不到，不要猜图里的内容。',
  {
    urls: z.union([z.string(), z.array(z.string())])
      .describe('图片直链 URL，可以是单个字符串或字符串数组（最多 3 个）')
  },
  async ({ urls }) => {
    const norm = normalizeImageUrls(urls);
    if (!norm.ok) {
      return { content: [{ type: 'text', text: norm.error }], isError: true };
    }
    const content = [];
    const notes = [];
    let okCount = 0;
    for (const u of norm.urls) {
      try {
        const host = new URL(u).hostname;
        const referer = refererForHost(host);
        // 超限时取部分数据（partialOnOversize），不要整张丢弃：
        // 大图直接丢掉，模型就"看不到图"，只能对群友说图加载不出来。
        // 只要拿到能解码的前缀至少能看；上限放宽到 2 倍。
        const r = await safeFetchBuffer(u, IMAGE_MAX_BYTES * 2, {
          userAgent: BROWSER_UA,          // 与 web_fetch 同一 UA：残缺 UA 会被图床/CDN 判爬虫
          headers: referer ? { referer } : {},
          partialOnOversize: true,
        });
        const mime = sniffImageMime(r.buffer);
        if (!mime) {
          notes.push(`× ${u} → 抓到了内容但不是有效图片（可能是网页或错误页）`);
          continue;
        }
        if (mime === 'image/bmp') {
          // 模型侧对 BMP 支持不可靠，明确说明而不是塞进去让 API 报错
          notes.push(`× ${u} → 是 BMP 格式，视觉模型通常不支持，已跳过`);
          continue;
        }
        content.push({ type: 'image', mimeType: mime, data: r.buffer.toString('base64') });
        notes.push(`√ ${u} → ${mime}，${humanBytes(r.buffer.length)}`);
        okCount++;
      } catch (error) {
        notes.push(`× ${u} → ${error?.message ?? error}`);
      }
    }
    if (!okCount) {
      return {
        content: [{ type: 'text', text: `没有取到任何图片：\n${notes.join('\n')}\n提示：如实告诉群友图片取不到，不要猜内容。` }],
        isError: true,
      };
    }
    const head = `已获取 ${okCount}/${norm.urls.length} 张图片：\n${notes.join('\n')}`;
    return { content: [{ type: 'text', text: head }, ...content] };
  }
);

server.server.onclose = () => { void searchRuntime.stop(); };
await server.connect(new StdioServerTransport());
