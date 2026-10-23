// rebuild-local-provider.mjs — 删除并重建 local provider（强制刷新运行时注册的模态能力）
const BASE = 'http://127.0.0.1:3080';
let rpc = 0;
async function call(method, payload = {}) {
  const r = await fetch(`${BASE}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: `r${++rpc}`, method, payload }),
    signal: AbortSignal.timeout(60000),
  });
  const j = await r.json();
  if (!j.result?.ok) throw new Error(`${method}: ${JSON.stringify(j.result?.error)}`);
  return j.result.value;
}

// 网关的 supports_images 实况
const gw = await (await fetch('http://127.0.0.1:7863/v1/models', { headers: { authorization: 'Bearer local' } })).json();
const byId = new Map((gw.data ?? []).map((m) => [m.id, m]));
const meta = (id) => {
  const m = byId.get(id);
  return { ctx: Number(m?.context_length) || 1000000, images: m?.supports_images === true };
};
const modelEntry = (id, name) => {
  const { ctx, images } = meta(id);
  return { id, name, contextWindow: ctx, maxTokens: 32768, input: images ? ['text', 'image'] : ['text'], reasoningEfforts: false };
};

const nsView = await call('settings.describe');
const providers = nsView.namespaces.find((n) => n.ns === 'llm-pi-ai').value.providers;
const local = providers.local;

const rebuilt = {
  displayName: local.displayName ?? '本地模型 (7863)',
  api: local.api ?? 'openai-completions',
  baseURL: local.baseURL,
  apiKeyEnv: local.apiKeyEnv,
  models: [
    modelEntry('cn:glm-5.2', 'GLM-5.2 (cn)'),
    modelEntry('cn:glm-5.3', 'GLM-5.3 (cn)'),
    modelEntry('cn:deepseek-v4.1-flash', 'DeepSeek-V4.1-Flash (cn)'),
    modelEntry('cn:glm-5.3-flash', 'GLM-5.3-Flash (cn)'),
  ],
};

// 1. 先摘掉（含刚才的验证别名 localv）
await call('settings.mutate', {
  ns: 'llm-pi-ai',
  ops: [{ op: 'unset', path: ['providers', 'localv'] }, { op: 'unset', path: ['providers', 'local'] }],
});
console.log('已移除 local / localv');
await new Promise((r) => setTimeout(r, 1500));

// 2. 重新写入全新 local
await call('settings.mutate', {
  ns: 'llm-pi-ai',
  ops: [{ op: 'set', path: ['providers', 'local'], value: rebuilt }],
});
await new Promise((r) => setTimeout(r, 1500));
console.log('已重建 local，模型声明：');
for (const m of rebuilt.models) console.log(`  ${m.id} | input=${m.input.join(',')} | ctx=${m.contextWindow}`);

const models = await call('llm.models');
for (const g of models.groups) console.log(`- provider ${g.id}: ${g.models.map((m) => m.id).join(', ')}`);
