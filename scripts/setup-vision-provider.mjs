// setup-vision-provider.mjs — 用全新 provider 名 localv 承载本地模型（带看图能力），并切换 DSH 默认模型
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

const CURRENT_MODEL = process.argv[2] ?? 'cn:glm-5.2';

const gw = await (await fetch('http://127.0.0.1:7863/v1/models', { headers: { authorization: 'Bearer local' } })).json();
const byId = new Map((gw.data ?? []).map((m) => [m.id, m]));
const entry = (id) => {
  const m = byId.get(id);
  return {
    id,
    name: m?.name ? `${m.name} (本地)` : id,
    contextWindow: Number(m?.context_length) || 1000000,
    maxTokens: 32768,
    input: m?.supports_images === true ? ['text', 'image'] : ['text'],
    reasoningEfforts: false,
  };
};

const nsView = await call('settings.describe');
const providers = nsView.namespaces.find((n) => n.ns === 'llm-pi-ai').value.providers;
const src = providers.local ?? {};
const credentialRef = src.apiKeyEnv ?? 'LOCAL_MODEL_API_KEY';

await call('settings.mutate', {
  ns: 'llm-pi-ai',
  ops: [{
    op: 'set',
    path: ['providers', 'localv'],
    value: {
      displayName: '本地模型 (7863)',
      api: 'openai-completions',
      baseURL: src.baseURL ?? 'http://127.0.0.1:7863/v1',
      apiKeyEnv: credentialRef,
      models: [
        entry('cn:glm-5.2'),
        entry('cn:deepseek-v4.1-flash'),
        entry('cn:glm-5.3'),
        entry('cn:glm-5.3-flash'),
      ],
    },
  }],
});
console.log('✅ provider localv 已配置（含看图声明）');

await call('settings.update', { ns: 'agent-default-model', patch: { provider: 'localv', model: CURRENT_MODEL } });
console.log(`✅ DSH 默认模型 -> localv/${CURRENT_MODEL}`);

const models = await call('llm.models');
const g = models.groups.find((x) => x.id === 'localv');
console.log('localv 目录:', g?.models.map((m) => m.id).join(', '));
