import { looksLikeImageBuffer } from './plugin-api/media.js';
export { looksLikeImageBuffer } from './plugin-api/media.js';
// 只读 HTTP(S) 安全抓取工具：供 qq-bridge / MCP 共用。
// 设计目标与 mcp-web-search-safe 一致：
// - 仅 http/https
// - 禁止 localhost / .local / 私有 IP / 环回 / 链路本地 / CGNAT 等内网地址
// - 域名先 DNS 解析并检查全部解析结果，避免 DNS rebinding
// - 手动跟随重定向，每一跳重新校验
// - 响应体按字符数限量读取，避免超大响应拖垮进程
import dns from 'node:dns';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';

const dnsLookup = dns.promises.lookup;

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`操作超时(${ms}ms)：${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

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
 * Clash 的 fake-IP 模式：系统 DNS 是 198.18.x，所有域名也解析到 198.18.x。
 * 这时 198.18.0.0/15 不是"内网/benchmark 地址"，而是代理的假 IP；
 * 当成内网拦会把所有域名（包括 p.qpic.cn 表情图）全部拒掉。
 * 只有系统 DNS 本身就是 198.18/19 段时才放行，正常网络仍按保留段拦截。
 */
function isFakeIpDns() {
  try {
    return dns.getServers().some((s) => /^198\.(?:18|19)\./.test(String(s)));
  } catch {
    return false;
  }
}

export function isPrivateIp(ip) {
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
    if (parts[0] === 198 && parts[1] >= 18 && parts[1] <= 19) return !isFakeIpDns();
    if (parts[0] === 192 && parts[1] === 0 && parts[2] === 0) return true;
    if (parts[0] >= 224) return true;
    return false;
  }

  if (net.isIP(h) === 6) {
    if (h === '::' || h === '::1') return true;
    if (h.startsWith('fc') || h.startsWith('fd')) return true;
    if (/^fe[89ab]/.test(h)) return true;
    if (h.startsWith('fec') || h.startsWith('fed') || h.startsWith('fee') || h.startsWith('fef')) return true;
    if (h.startsWith('2001:db8')) return true;
    if (h.startsWith('2001:2:') || h.startsWith('2001:10:') || h.startsWith('2001:20:')) return true;
    const sixth4 = h.match(/^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4}):/i);
    if (sixth4) {
      const num = (parseInt(sixth4[1], 16) << 16) + parseInt(sixth4[2], 16);
      const ipv4 = `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
      if (isPrivateIp(ipv4)) return true;
    }
    if (h.startsWith('ff')) return true;
    return false;
  }

  return false;
}

export async function resolveSafeHost(hostname) {
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
    addresses = await withTimeout(dnsLookup(h, { all: true, verbatim: true }), 5000, `DNS 解析 ${h}`);
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

export async function validateFetchUrl(raw) {
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

/**
 * 统一字符集名：gb2312/gbk 都按 gb18030 解（后者是前两者的超集），
 * 避免「页面是 GBK、按 UTF-8 解出乱码」——2026-10-23 实测 youth.cn / cnr.cn。
 */
export function normalizeCharset(charset) {
  const s = String(charset ?? '').toLowerCase().replace(/["']/g, '').trim();
  if (!s) return 'utf-8';
  if (s === 'gb2312' || s === 'gbk' || s === 'x-gbk' || s === 'cp936') return 'gb18030';
  if (s === 'utf8') return 'utf-8';
  return s;
}

/** 从 Content-Type 或 HTML <meta> 前 4KB 推断字符集。 */
export function detectCharset(contentType, buffer) {
  const fromHeader = String(contentType ?? '').match(/charset\s*=\s*["']?([\w-]+)/i)?.[1];
  if (fromHeader) return normalizeCharset(fromHeader);
  const head = Buffer.isBuffer(buffer) ? buffer.subarray(0, 4096).toString('latin1') : '';
  const m = head.match(/<meta[^>]+charset\s*=\s*["']?\s*([\w-]+)/i)
    || head.match(/<meta[^>]+content\s*=\s*["'][^"']*charset\s*=\s*([\w-]+)/i);
  return normalizeCharset(m?.[1]);
}

/** 按检测到的字符集解码 Buffer；未知字符集回退 UTF-8（不抛错，宁可乱码也不丢内容）。 */
export function decodeBuffer(buffer, contentType) {
  const charset = detectCharset(contentType, buffer);
  try {
    return new TextDecoder(charset, { fatal: false }).decode(buffer);
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(buffer);
  }
}

// 按字节上限读取，最后按页面字符集解码。不能边读边用 StringDecoder('utf8')：
// GB2312/GBK 页面会被解成乱码（实测 youth.cn、cnr.cn）。
function readBoundedText(res, maxChars, contentType = '') {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    // 最坏情况 UTF-8 4 字节/字符；多留 4KB 供 meta charset 探测。
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

// 页面抓取统一用完整 Chrome UA：裸 "Mozilla/5.0" 会被部分 CDN/反爬判为可疑爬虫
// （2026-10 实测 Bing/微信/图床都踩过），完整 UA 才像正常浏览器。
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

export async function safeFetch(urlString, maxChars = 50000) {
  const MAX_REDIRECTS = 5;
  let { url, ip } = await validateFetchUrl(urlString);
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const result = await requestOnce(url, ip, maxChars);
    if ([301, 302, 303, 307, 308].includes(result.statusCode)) {
      if (!result.redirect) throw new Error(`重定向缺少 Location: ${result.statusCode}`);
      const next = new URL(result.redirect, url).toString();
      ({ url, ip } = await validateFetchUrl(next));
      continue;
    }
    const body = result.body || '';
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

/** 抓取图片字节并返回 Buffer（带 SSRF 防护，且校验确实为图片）。 */
export async function safeFetchBuffer(urlString, maxBytes = 8 * 1024 * 1024, opts = {}) {
  const MAX_REDIRECTS = 5;
  // UA 可覆盖：默认 'Mozilla/5.0' 是裸标识，部分 CDN（如 donmai.us）会判为可疑爬虫直接 403；
  // 实测改成明确自报的 UA 反而被放行（拦的是「伪装浏览器却缺配套头」的请求）。
  // 调用方可传 userAgent 覆盖，用于确实需要自定义标识的场景。
  const userAgent = String(opts.userAgent ?? '').trim() || 'Mozilla/5.0';
  // 附加头：部分图床有防盗链（pixiv 的 i.pximg.net 不带 Referer 一律 403）。
  const extraHeaders = (opts.headers && typeof opts.headers === 'object') ? opts.headers : {};
  let { url, ip } = await validateFetchUrl(urlString);
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const result = await requestOnceBuffer(url, ip, maxBytes, userAgent, extraHeaders, opts);
    if ([301, 302, 303, 307, 308].includes(result.statusCode)) {
      if (!result.redirect) throw new Error(`重定向缺少 Location: ${result.statusCode}`);
      const next = new URL(result.redirect, url).toString();
      ({ url, ip } = await validateFetchUrl(next));
      continue;
    }
    if (result.statusCode < 200 || result.statusCode >= 300) {
      throw new Error(`图片抓取失败：HTTP ${result.statusCode}`);
    }
    if (!looksLikeImageBuffer(result.buffer)) {
      throw new Error(`抓取内容不是有效图片（PNG/JPEG/GIF/WebP）`);
    }
    return { url: url.toString(), statusCode: result.statusCode, buffer: result.buffer };
  }
  throw new Error('重定向次数过多，已停止');
}

function requestOnceBuffer(url, ip, maxBytes, userAgent = 'Mozilla/5.0', extraHeaders = {}, opts = {}) {
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
        'user-agent': userAgent,
        accept: 'image/*,*/*;q=0.8',
        'accept-language': 'zh-CN,zh;q=0.9',
        ...extraHeaders,
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
      const chunks = [];
      let size = 0;
      let settled = false;
      // partialOnOversize：超限时**不要把已下载的部分丢掉**。
      //
      // 为什么需要（2026-10-22 事故）：群友发了 >8MB 的图，这里直接 reject，
      // 桥接记一行「图片超过大小限制」就把这张图丢了 —— 模型完全没看到图，
      // 只能对群友说「图没加载出来，你再发一次」；群友再发还是那张图，永远出不来。
      // 而桥接本身有 downscaleIfLarge()，只要有字节就能压缩。
      // 所以允许调用方选"要部分数据"：超限时断开，但把已收到的前缀交出去。
      // 默认仍 reject —— 原有的"有上限就有上限"语义不变。
      const partialOnOversize = opts.partialOnOversize === true;
      res.on('data', (chunk) => {
        if (settled) return;
        size += chunk.length;
        if (size > maxBytes) {
          settled = true;
          try { res.destroy(); } catch {}
          if (partialOnOversize) {
            resolve({ statusCode, buffer: Buffer.concat(chunks), truncated: true, receivedBytes: size });
            return;
          }
          reject(new Error(`图片超过大小限制（${maxBytes} 字节）`));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        if (settled) return;
        settled = true;
        resolve({ statusCode, buffer: Buffer.concat(chunks) });
      });
      res.on('error', (err) => {
        if (settled) return;
        settled = true;
        reject(err);
      });
    });
    req.on('timeout', () => req.destroy(new Error(`请求超时：${url.hostname}`)));
    req.on('error', reject);
    req.end();
  });
}
