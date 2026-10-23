// check-model.mjs — 从会话事件里确认实际使用的 provider/model
const BASE = 'http://127.0.0.1:3080';
const sessionId = process.argv[2];
const r = await fetch(`${BASE}/api/session.history`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ type: 'client-request', rpcId: 'cm1', method: 'session.history', payload: { sessionId } }),
  signal: AbortSignal.timeout(60000),
});
const j = await r.json();
const events = j.result?.value?.events ?? [];
let found = 0;
for (const wrap of events.slice().reverse()) {
  const e = wrap.event ?? wrap;
  const rs = e?.data?.chunk?.replayState ?? e?.data?.replayState;
  const resp = rs?.response;
  if (resp?.provider) {
    console.log(`seq ${e.seq} turn ${e.data?.turn}: provider=${resp.provider} model=${resp.model} (responseModel=${resp.responseModel ?? '-'})`);
    if (++found >= 3) break;
  }
}
if (!found) console.log('未找到 replayState（可能该回合并未调用模型）');
