// dbg-turn.mjs — 查看会话当前回合状态（是否卡住/多久）
const BASE = 'http://127.0.0.1:3080';
const sessionId = process.argv[2];
let rpc = 0;
async function call(method, payload = {}) {
  const r = await fetch(`${BASE}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: `t${++rpc}`, method, payload }),
    signal: AbortSignal.timeout(60000),
  });
  const j = await r.json();
  if (!j.result?.ok) throw new Error(`${method}: ${JSON.stringify(j.result?.error)}`);
  return j.result.value;
}
const h = await call('session.history', { sessionId });
const events = (h.events ?? []).map((w) => w.event ?? w);
console.log('事件总数:', events.length);
const now = Date.now();
for (const e of events.slice(-12)) {
  const age = ((now - (e.time ?? now)) / 1000).toFixed(0);
  let brief = '';
  if (e.type === 'assistant/chunk') {
    const c = e.data?.chunk ?? {};
    brief = `chunk=${c.type}${c.name ? ' ' + c.name : ''}${c.reason?.kind ? ' reason=' + c.reason.kind : ''}`;
  } else if (e.type === 'tool/call') {
    brief = `tool=${e.data?.name} args=${String(e.data?.arguments).slice(0, 110)}`;
  } else if (e.type === 'turn/start' || e.type === 'turn/end' || e.type === 'step/start' || e.type === 'step/end') {
    brief = `turn=${e.data?.turn} step=${e.data?.step ?? '-'} ${e.data?.reason ? JSON.stringify(e.data.reason).slice(0, 90) : ''}`;
  } else {
    brief = JSON.stringify(e.data ?? {}).slice(0, 110);
  }
  console.log(`[${age}s 前] ${e.type}: ${brief}`);
}
