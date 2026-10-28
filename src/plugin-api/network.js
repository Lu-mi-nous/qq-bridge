// 代理隧道：通过 HTTP 代理（如 Clash 127.0.0.1:7897）访问境外站点。
//
// 为什么需要独立模块而不是用 node 的 fetch + ProxyAgent：
//   1) 本机代理是 HTTP CONNECT 型，node 内置 fetch 不认 HTTPS_PROXY 环境变量；
//   2) 走代理时**由代理解析域名**，可绕开本地 DNS 污染（实测本地把 pixiv/yande.re
//      解析到 Facebook 的 IP 段，直连必然超时）；
//   3) 同时要保留 SSRF 防护：拒绝内网/本机字面量与非法协议。
//
// 实现方式：手写 CONNECT 隧道 + 最小 HTTP/1.1 响应解析（含 chunked 解码）。
// 只支持 GET，够用且攻击面小。
import net from 'node:net';
import tls from 'node:tls';

// 内网/本机地址的字面量拦截（SSRF 第一道闸）。走代理时域名解析在代理侧完成，
// 本地无法校验解析结果，因此**字面量必须在这里挡住**。
const BLOCKED_HOST_RE = /^(localhost|.*\.local|.*\.internal|.*\.lan)$/i;
const BLOCKED_IP_RE = /^(127\.|10\.|192\.168\.|169\.254\.|0\.|::1$|fc|fd|fe80)/i;

export function isBlockedHost(hostname) {
  const h = String(hostname ?? '').trim();
  if (!h) return true;
  if (BLOCKED_HOST_RE.test(h)) return true;
  // IPv6 字面量
  if (h.startsWith('[') || h.includes(':')) {
    const bare = h.replace(/^\[|\]$/g, '').toLowerCase();
    if (bare === '::1' || bare.startsWith('fc') || bare.startsWith('fd') || bare.startsWith('fe80')) return true;
  }
  // IPv4 字面量（含 172.16-31 私有段）
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) {
    if (BLOCKED_IP_RE.test(h)) return true;
    const [a, b] = h.split('.').map(Number);
    if (a === 172 && b >= 16 && b <= 31) return true;
    return false;
  }
  return false;
}

/** 建立到目标的隧道（经代理或不走代理），返回可读写的 socket。 */
export function openTunnel({ proxy, host, port = 443, timeoutMs = 25000, rejectUnauthorized = true }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const cleanup = () => { if (timer) clearTimeout(timer); };

    if (!proxy) {
      // 直连模式：本地解析 + 直连（保持原有行为）
      const socket = port === 443
        ? tls.connect({ host, port, servername: host, rejectUnauthorized })
        : net.connect(port, host);
      // TLS 的 host 参数会触发本地 DNS —— 境外域名在污染网络下不可用，
      // 因此直连模式仅供本地/已可达域名使用（如 safebooru）。
      const onReady = () => { if (settled) return; settled = true; cleanup(); resolve(socket); };
      const onErr = (e) => { if (settled) return; settled = true; cleanup(); socket.destroy(); reject(e); };
      timer = setTimeout(() => onErr(new Error('直连超时')), timeoutMs);
      socket.once(port === 443 ? 'secureConnect' : 'connect', onReady);
      socket.once('error', onErr);
      socket.once('timeout', () => onErr(new Error('直连超时')));
      return;
    }

    const p = new URL(proxy);
    const psock = net.connect(Number(p.port) || 7890, p.hostname);
    const fail = (e) => {
      if (settled) return;
      settled = true;
      cleanup();
      try { psock.destroy(); } catch {}
      reject(e instanceof Error ? e : new Error(String(e)));
    };
    timer = setTimeout(() => fail(new Error('代理连接超时')), timeoutMs);
    psock.once('error', fail);
    psock.once('connect', () => {
      psock.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`);
    });
    let buf = '';
    const onData = (chunk) => {
      buf += chunk.toString('latin1');
      if (!buf.includes('\r\n\r\n')) {
        if (buf.length > 8192) fail(new Error('代理响应异常'));
        return;
      }
      psock.removeListener('data', onData);
      const status = Number((buf.match(/^HTTP\/1\.\d (\d+)/) ?? [])[1] || 0);
      if (status !== 200) return fail(new Error(`代理拒绝 CONNECT（HTTP ${status}）`));
      if (port !== 443) {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(psock);
        return;
      }
      const tsock = tls.connect({ socket: psock, servername: host, rejectUnauthorized });
      tsock.once('secureConnect', () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(tsock);
      });
      tsock.once('error', fail);
    };
    psock.on('data', onData);
  });
}

/** 解析 HTTP/1.1 响应（状态行 + 头 + body，支持 chunked）。 */
function parseHttpResponse(raw) {
  const sep = raw.indexOf('\r\n\r\n');
  if (sep < 0) return null;
  const head = raw.subarray(0, sep).toString('latin1');
  let body = raw.subarray(sep + 4);
  const status = Number((head.match(/^HTTP\/1\.\d (\d+)/) ?? [])[1] || 0);
  const headers = {};
  for (const line of head.split('\r\n').slice(1)) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  // chunked 解码：不处理的话图片字节会混入 "1a2b\r\n" 这类块标记，导致图片损坏
  if (/chunked/i.test(headers['transfer-encoding'] ?? '')) {
    const out = [];
    let off = 0;
    for (;;) {
      const nl = body.indexOf('\r\n', off);
      if (nl < 0) break;
      const size = parseInt(body.subarray(off, nl).toString('latin1').split(';')[0], 16);
      if (!Number.isFinite(size) || size === 0) break;
      const start = nl + 2;
      out.push(body.subarray(start, start + size));
      off = start + size + 2;
    }
    body = Buffer.concat(out);
  }
  return { status, headers, body };
}

/**
 * 经（可选）代理发起 GET，返回 { status, headers, body, url }。
 * followRedirects 默认跟随 5 次（图站常用 302 跳 CDN）。
 */
export async function proxyGet(urlString, opts = {}) {
  const {
    proxy = '',
    maxBytes = 16 * 1024 * 1024,
    timeoutMs = 25000,
    headers = {},
    followRedirects = 5,
    headOnly = false,   // 只读响应头就断开：用于探测资源是否存在（不下载正文）
  } = opts;

  let current = String(urlString);
  for (let hop = 0; hop <= followRedirects; hop++) {
    const url = new URL(current);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('仅允许 http/https');
    if (url.username || url.password) throw new Error('URL 不能包含凭据');
    if (isBlockedHost(url.hostname)) throw new Error('目标指向内网/本机地址，已阻止');

    const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
    const sock = await openTunnel({ proxy, host: url.hostname, port, timeoutMs });
    try {
      const reqHead = [
        `GET ${url.pathname}${url.search} HTTP/1.1`,
        `Host: ${url.host}`,
        ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
        'Connection: close',
        '',
        ''
      ].join('\r\n');

      const raw = await new Promise((resolve, reject) => {
        const chunks = [];
        let total = 0;
        let done = false;
        const finish = (fn, v) => { if (done) return; done = true; clearTimeout(t); fn(v); };
        const t = setTimeout(() => finish(reject, new Error('读取超时')), timeoutMs);
        sock.on('data', (c) => {
          total += c.length;
          // headOnly：收到响应头（\r\n\r\n）即可判定状态，立即断开，不拉正文。
          // 用于探测 pixiv 的图片扩展名（jpg/png），避免为探测下载整张图。
          if (headOnly) {
            chunks.push(c);
            const joined = Buffer.concat(chunks);
            if (joined.includes(Buffer.from('\r\n\r\n'))) {
              try { sock.destroy(); } catch {}
              return finish(resolve, joined);
            }
            return;
          }
          if (total > maxBytes) {
            // chunked 会有额外开销，给 4 倍余量后仍超才判超限
            if (total > maxBytes * 4) { try { sock.destroy(); } catch {} return finish(reject, new Error(`超过大小上限`)); }
          }
          chunks.push(c);
        });
        sock.on('end', () => finish(resolve, Buffer.concat(chunks)));
        sock.on('error', (e) => {
          // headOnly 主动 destroy 会触发 ECONNRESET，此时若已拿到数据按成功处理
          if (headOnly && chunks.length) return finish(resolve, Buffer.concat(chunks));
          finish(reject, e);
        });
        sock.on('timeout', () => finish(reject, new Error('读取超时')));
        sock.write(reqHead);
      });

      const parsed = parseHttpResponse(raw);
      if (!parsed) throw new Error('响应解析失败');
      if ([301, 302, 303, 307, 308].includes(parsed.status) && parsed.headers.location) {
        current = new URL(parsed.headers.location, url).toString();
        continue;
      }
      return { ...parsed, url: current };
    } finally {
      try { sock.destroy(); } catch {}
    }
  }
  throw new Error('重定向次数过多');
}
