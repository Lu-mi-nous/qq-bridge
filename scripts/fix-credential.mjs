// fix-credential.mjs — 给 local provider 配 apiKeyEnv 并写入凭据，然后重测对话
const BASE = 'http://127.0.0.1:3080';
let rpc = 0;
async function call(method, payload = {}) {
  const r = await fetch(`${BASE}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: `c${++rpc}`, method, payload }),
    signal: AbortSignal.timeout(120000),
  });
  const j = await r.json();
  if (!j.result?.ok) throw new Error(`${method} failed: ${JSON.stringify(j.result?.error)}`);
  return j.result.value;
}

const REF = 'LOCAL_MODEL_API_KEY';

// 1. provider 增加 apiKeyEnv
await call('settings.mutate', {
  ns: 'llm-pi-ai',
  ops: [{
    op: 'set', path: ['providers', 'local', 'apiKeyEnv'], value: REF,
  }],
});
console.log('已设置 apiKeyEnv =', REF);

// 2. 写入凭据（值用你的 key "local"，服务端其实不校验，但不给值 pi-ai 会拒绝）
await call('credentials.set', { ref: REF, value: 'local' });
const creds = await call('credentials.describe', { refs: [REF] });
console.log('凭据状态:', JSON.stringify(creds.credentials));

// 3. 确认 provider 仍激活
const provs = await call('llm.providers');
const local = provs.providers.find((p) => p.provider === 'local');
console.log('provider:', local?.provider, '| displayName:', JSON.stringify(local?.displayName), '| active:', local?.active);
