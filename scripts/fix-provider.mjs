// fix-provider.mjs — 用 node 重写 provider 配置（正确 UTF-8），并测试 reasoningEffort=off
const BASE = 'http://127.0.0.1:3080';
let rpc = 0;
async function call(method, payload = {}) {
  const r = await fetch(`${BASE}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: `f${++rpc}`, method, payload }),
    signal: AbortSignal.timeout(60000),
  });
  const j = await r.json();
  if (!j.result?.ok) throw new Error(`${method} failed: ${JSON.stringify(j.result?.error)}`);
  return j.result.value;
}

// 1. 重写 provider 配置（正确 UTF-8 的 displayName + 模型名）
const value = {
  displayName: '本地模型 (7863)',
  api: 'openai-completions',
  baseURL: 'http://127.0.0.1:7863/v1',
  models: [
    {
      id: 'cn:deepseek-v4.1-flash',
      name: 'DeepSeek-V4.1-Flash (本地)',
      contextWindow: 131072,
      maxTokens: 16384,
      input: ['text'],
      reasoningEfforts: false,
    },
  ],
};
await call('settings.mutate', { ns: 'llm-pi-ai', ops: [{ op: 'set', path: ['providers', 'local'], value }] });
const provs = await call('llm.providers');
console.log('displayName now:', JSON.stringify(provs.providers.find((p) => p.provider === 'local')?.displayName));

// 2. 建会话，分别用 off / 不传 effort 测试
const created = await call('session.create', { cwd: path.join(ROOT, 'state', 'local-provider-test') });
const sessionId = created.sessionId;
console.log('会话:', sessionId);

for (const effort of ['off', undefined]) {
  try {
    const sel = await call('session.selectModel', {
      sessionId, provider: 'local', model: 'cn:deepseek-v4.1-flash',
      ...(effort === undefined ? {} : { reasoningEffort: effort }),
    });
    console.log(`✅ effort=${effort ?? '(不传)'} ->`, JSON.stringify(sel.selected));
  } catch (e) {
    console.log(`❌ effort=${effort ?? '(不传)'} ->`, e.message);
  }
}
