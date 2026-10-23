// add-vision-provider.mjs — 新建一个 provider 别名 localv（声明支持看图），用于验证"注册缓存"假设
const BASE = 'http://127.0.0.1:3080';
let rpc = 0;
async function call(method, payload = {}) {
  const r = await fetch(`${BASE}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: `v${++rpc}`, method, payload }),
    signal: AbortSignal.timeout(60000),
  });
  const j = await r.json();
  if (!j.result?.ok) throw new Error(`${method}: ${JSON.stringify(j.result?.error)}`);
  return j.result.value;
}

const nsView = await call('settings.describe');
const pi = nsView.namespaces.find((n) => n.ns === 'llm-pi-ai').value.providers;
const local = pi.local;

await call('settings.mutate', {
  ns: 'llm-pi-ai',
  ops: [{
    op: 'set',
    path: ['providers', 'localv'],
    value: {
      displayName: '本地模型-看图版',
      api: 'openai-completions',
      baseURL: local.baseURL,
      apiKeyEnv: local.apiKeyEnv,
      models: [
        { id: 'cn:glm-5.2', name: 'GLM-5.2 (vision)', contextWindow: 1000000, maxTokens: 32768, input: ['text', 'image'], reasoningEfforts: false },
        { id: 'cn:deepseek-v4.1-flash', name: 'DS-V4.1-Flash (vision)', contextWindow: 1000000, maxTokens: 32768, input: ['text', 'image'], reasoningEfforts: false },
      ],
    },
  }],
});
console.log('✅ 已创建 provider 别名 localv（声明 input: text,image）');

const models = await call('llm.models');
for (const g of models.groups) {
  console.log(`- ${g.id}: ${g.models.map((m) => m.id).join(', ')}`);
}
