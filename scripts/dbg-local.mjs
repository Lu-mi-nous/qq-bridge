// dbg-local.mjs — 打印本地模型会话的完整事件流，定位 error 原因
import { NodeApiClient, unwrap } from '../src/dsh-client.js';

const api = new NodeApiClient('http://127.0.0.1:3080');
const created = unwrap(await api.sessions.create({ cwd: 'E:\\Downloads\\qq-bridge-main\\state\\local-e2e' }), 'session.create');
const sessionId = created.sessionId;
console.log('会话:', sessionId);
const sel = unwrap(await api.sessions.selectModel({ sessionId, provider: 'local', model: 'cn:deepseek-v4.1-flash' }), 'session.selectModel');
console.log('模型:', JSON.stringify(sel.selected));

let resolveOpened;
const opened = new Promise((res) => { resolveOpened = res; });
const seen = [];
const pump = (async () => {
  for await (const envelope of api.events.mux({}, undefined, () => resolveOpened())) {
    const frame = envelope.payload;
    if (frame.type === 'session/event' && frame.sessionId === sessionId) {
      seen.push(frame.event);
      console.log('[event]', JSON.stringify(frame.event).slice(0, 600));
    } else if (frame.type === 'stream/error') {
      console.log('[stream/error]', JSON.stringify(frame.error));
    }
  }
})();
await opened;
unwrap(await api.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text: '说 ok' }] }), 'session.prompt');

await new Promise((r) => setTimeout(r, 90000));
console.log('=== 事件总数:', seen.length, '===');
const errs = seen.filter((e) => JSON.stringify(e).includes('error'));
console.log('=== 含 error 的事件 ===');
for (const e of errs) console.log(JSON.stringify(e).slice(0, 1500));
process.exit(0);
