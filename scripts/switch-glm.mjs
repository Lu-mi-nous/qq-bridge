// switch-glm.mjs — 把 QQ 机器人的模型切到 cn:glm-5.3
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

// 网关实测：cn:glm-5.3 -> context_length 1000000 / max_output 131072
const MODEL = 'cn:glm-5.3';

// 1. provider 模型目录：glm-5.3 放首位，保留之前的两个便于随时切回
await call('settings.mutate', {
  ns: 'llm-pi-ai',
  ops: [{
    op: 'set',
    path: ['providers', 'local', 'models'],
    value: [
      { id: 'cn:glm-5.3', name: 'GLM-5.3 (cn)', contextWindow: 1000000, maxTokens: 32768, input: ['text'], reasoningEfforts: false },
      { id: 'global:deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash (global)', contextWindow: 1000000, maxTokens: 65536, input: ['text'], reasoningEfforts: false },
      { id: 'cn:deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash (cn)', contextWindow: 1000000, maxTokens: 65536, input: ['text'], reasoningEfforts: false },
    ],
  }],
});
console.log('✅ provider 模型目录已更新（glm-5.3 为首选）');

// 2. DSH 默认模型
await call('settings.update', {
  ns: 'agent-default-model',
  patch: { provider: 'local', model: MODEL },
});
console.log(`✅ agent-default-model -> local/${MODEL}`);

// 3. 核对
const models = await call('llm.models');
for (const g of models.groups) {
  if (g.id === 'local') console.log('local 目录:', g.models.map((m) => m.id).join(', '));
}
const nsView = await call('settings.describe');
const dm = nsView.namespaces.find((n) => n.ns === 'agent-default-model');
console.log('默认模型:', JSON.stringify(dm.value));
