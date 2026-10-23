// dbg-session.mjs — 查看指定 DSH 会话最近的回合内容（本地模型跑了什么）
const BASE = 'http://127.0.0.1:3080';
const sessionId = process.argv[2];
let rpc = 0;
async function call(method, payload = {}) {
  const r = await fetch(`${BASE}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: `d${++rpc}`, method, payload }),
    signal: AbortSignal.timeout(60000),
  });
  const j = await r.json();
  if (!j.result?.ok) throw new Error(`${method}: ${JSON.stringify(j.result?.error)}`);
  return j.result.value;
}

const h = await call('session.history', { sessionId });
const items = h.items ?? h.messages ?? h.events ?? [];
console.log('history 字段:', Object.keys(h).join(', '), '| 条目数:', items.length);
for (const it of items.slice(-14)) {
  const type = it.type ?? it.role ?? '?';
  let brief = JSON.stringify(it.data ?? it.content ?? it).slice(0, 300);
  console.log(`- [${type}] ${brief}`);
}
