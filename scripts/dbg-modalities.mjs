// dbg-modalities.mjs — 查 DSH 认为某模型支持哪些输入模态
const BASE = 'http://127.0.0.1:3080';
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

const created = await call('session.create', { cwd: path.join(ROOT, 'state', 'vision-e2e') });
const sessionId = created.sessionId;

try {
  const sm = await call('session.models', { sessionId });
  console.log('session.models 字段:', Object.keys(sm).join(', '));
  const groups = sm.groups ?? sm.models ?? [];
  for (const g of groups) {
    const models = g.models ?? [g];
    for (const m of models) {
      if (String(m.id ?? m.model ?? '').includes('glm') || String(m.id ?? '').includes('deepseek')) {
        console.log(JSON.stringify(m).slice(0, 300));
      }
    }
  }
} catch (e) {
  console.log('session.models 失败:', e.message);
}

// 选模型后再看一次
try {
  const sel = await call('session.selectModel', { sessionId, provider: 'local', model: 'cn:glm-5.2' });
  console.log('选中:', JSON.stringify(sel.selected).slice(0, 300));
} catch (e) {
  console.log('selectModel 失败:', e.message);
}
