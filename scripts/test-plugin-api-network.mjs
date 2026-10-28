// 公共代理网络 API：本地假代理返回固定 HTTP 响应，不连接外网。
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { proxyGet, openTunnel, isBlockedHost } from '../src/plugin-api/network.js';
import * as legacy from '../src/proxy-tunnel.js';

let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log(`PASS ${name}`); }
const sockets = new Set();
const requests = [];
const proxy = net.createServer(socket => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
  socket.on('error', () => {});
  let pending = '', connected = false;
  socket.on('data', chunk => {
    pending += chunk.toString('latin1');
    if (!pending.includes('\r\n\r\n')) return;
    if (!connected) {
      requests.push(pending.split('\r\n')[0]);
      pending = ''; connected = true;
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      return;
    }
    const target = pending.split(' ')[1];
    pending = '';
    if (target === '/redirect') socket.end('HTTP/1.1 302 Found\r\nLocation: /chunked\r\nContent-Length: 0\r\n\r\n');
    else if (target === '/private') socket.end('HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1/private\r\nContent-Length: 0\r\n\r\n');
    else socket.end('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Type: text/plain\r\n\r\n5\r\nhello\r\n0\r\n\r\n');
  });
});
try {
  await check('核心兼容入口共用三个公开函数', () => {
    assert.equal(proxyGet, legacy.proxyGet);
    assert.equal(openTunnel, legacy.openTunnel);
    assert.equal(isBlockedHost, legacy.isBlockedHost);
  });
  for (const host of ['localhost', '127.0.0.1', '10.1.2.3', '192.168.1.1', '172.16.0.1', '[::1]']) {
    await check(`拒绝 ${host}`, () => assert.equal(isBlockedHost(host), true));
  }
  await check('允许正常公网域名', () => assert.equal(isBlockedHost('example.com'), false));
  await check('拒绝非法协议', () => assert.rejects(proxyGet('file:///tmp/example'), /仅允许 http\/https/));
  await check('拒绝 URL 凭据', () => assert.rejects(proxyGet('http://user:password@example.com'), /不能包含凭据/));
  await check('拒绝本机 URL', () => assert.rejects(proxyGet('http://127.0.0.1/'), /已阻止/));
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  const opts = { proxy: `http://127.0.0.1:${proxy.address().port}`, timeoutMs: 1000 };
  await check('CONNECT 请求与 chunked 正文可用', async () => {
    const response = await proxyGet('http://example.com/chunked', opts);
    assert.equal(response.status, 200);
    assert.equal(response.body.toString(), 'hello');
    assert.equal(requests.at(-1), 'CONNECT example.com:80 HTTP/1.1');
  });
  await check('相对重定向保留最终 URL 与内容', async () => {
    const response = await proxyGet('http://example.com/redirect', opts);
    assert.equal(response.url, 'http://example.com/chunked');
    assert.equal(response.body.toString(), 'hello');
  });
  await check('重定向至内网在连接前拒绝', async () => {
    const before = requests.length;
    await assert.rejects(proxyGet('http://example.com/private', opts), /已阻止/);
    assert.equal(requests.length, before + 1);
  });
  await check('遵守重定向次数限制', () => assert.rejects(proxyGet('http://example.com/redirect', { ...opts, followRedirects: 0 }), /重定向次数过多/));
  console.log(`✅ ${passed} 通过 / 0 失败`);
} finally {
  for (const socket of sockets) socket.destroy();
  if (proxy.listening) await new Promise(resolve => proxy.close(resolve));
}
