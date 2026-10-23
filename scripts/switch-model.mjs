// switch-model.mjs — 把模型切到 global:deepseek-v4.1-flash
const BASE = 'http://127.0.0.1:3080';
let rpc = 0;
async function call(method, payload = {}) {
  const r = await fetch(`${BASE}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: `s${++rpc}`, method, payload }),
    signal: AbortSignal.timeout(60000),
  });
  const j = await r.json();
  if (!j.result?.ok) throw new Error(`${method}: ${JSON.stringify(j.result?.error)}`);
  return j.result.value;
}

const common = { contextWindow: 131072, maxTokens: 16384, input: ['text'], reasoningEfforts: false };

// 1. provider 模型目录：global 放首位，保留 cn 以便随时切回
await call('settings.mutate', {
  ns: 'llm-pi-ai',
  ops: [{
    op: 'set',
    path: ['providers', 'local', 'models'],
    value: [
      { id: 'global:deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash (global)', ...common },
      { id: 'cn:deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash (cn)', ...common },
    ],
  }],
});
console.log('✅ provider 模型目录已更新');

// 2. DSH 默认模型切到 global
await call('settings.update', {
  ns: 'agent-default-model',
  patch: { provider: 'local', model: 'global:deepseek-v4.1-flash' },
});
console.log('✅ agent-default-model -> local/global:deepseek-v4.1-flash');

// 3. 核对
const models = await call('llm.models');
for (const g of models.groups) {
  console.log(`provider ${g.id}:`, g.models.map((m) => m.id).join(', '));
}
const nsView = await call('settings.describe');
const dm = nsView.namespaces.find((n) => n.ns === 'agent-default-model');
console.log('默认模型现值:', JSON.stringify(dm.value));
