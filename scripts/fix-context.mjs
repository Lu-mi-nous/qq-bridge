// fix-context.mjs — 把 local provider 的上下文窗口改成真实值（1M）
const BASE = 'http://127.0.0.1:3080';
let rpc = 0;
async function call(method, payload = {}) {
  const r = await fetch(`${BASE}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: `x${++rpc}`, method, payload }),
    signal: AbortSignal.timeout(60000),
  });
  const j = await r.json();
  if (!j.result?.ok) throw new Error(`${method}: ${JSON.stringify(j.result?.error)}`);
  return j.result.value;
}

// 网关实测：deepseek-v4.1-flash 支持 1M 上下文 / 393216 最大输出。
// 之前误声明为 131072，导致会话到 128k 就被判 CONTEXT_WINDOW_EXCEEDED。
const common = { contextWindow: 1000000, maxTokens: 65536, input: ['text'], reasoningEfforts: false };

await call('settings.mutate', {
  ns: 'llm-pi-ai',
  ops: [
    {
      op: 'set',
      path: ['providers', 'local', 'models'],
      value: [
        { id: 'global:deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash (global)', ...common },
        { id: 'cn:deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash (cn)', ...common },
      ],
    },
    { op: 'set', path: ['providers', 'local', 'defaultContextWindow'], value: 1000000 },
  ],
});
console.log('✅ contextWindow 已改为 1000000');

const models = await call('llm.models');
for (const g of models.groups) {
  for (const m of g.models) {
    console.log(`  ${g.id} / ${m.id}  ctx=${m.contextWindow ?? m.context_length ?? '-'}`);
  }
}
