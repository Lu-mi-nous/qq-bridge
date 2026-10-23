// test-local-provider.mjs — 验证 DSH 能否用 provider=local 建会话并对话
const BASE = 'http://127.0.0.1:3080';
let rpc = 0;
async function call(method, payload = {}) {
  const r = await fetch(`${BASE}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: `t${++rpc}`, method, payload }),
    signal: AbortSignal.timeout(120000),
  });
  const j = await r.json();
  if (!j.result?.ok) throw new Error(`${method} failed: ${JSON.stringify(j.result?.error)}`);
  return j.result.value;
}

// 1. 本地 provider 的 displayName 是否存成正确 UTF-8
const provs = await call('llm.providers');
const local = provs.providers.find((p) => p.provider === 'local');
console.log('local provider displayName:', JSON.stringify(local?.displayName), '| active:', local?.active);

// 2. 建测试会话
const cwd = path.join(ROOT, 'state', 'local-provider-test');
const created = await call('session.create', { cwd });
const sessionId = created.sessionId;
console.log('测试会话:', sessionId);

// 3. selectModel：provider=local + reasoningEffort=max（桥接就是这么调的）
try {
  const sel = await call('session.selectModel', {
    sessionId, provider: 'local', model: 'cn:deepseek-v4.1-flash', reasoningEffort: 'max',
  });
  console.log('✅ selectModel 成功:', JSON.stringify(sel.selected));
} catch (e) {
  console.log('❌ selectModel 失败:', e.message);
}

// 4. 实际对话一次
const accepted = await call('session.prompt', {
  sessionId, mode: 'queue', content: [{ type: 'text', text: '用一句话自我介绍，20字以内' }],
});
console.log('prompt 已接受:', JSON.stringify(accepted));

// 5. 等回复（轮询 session.history）
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 3000));
  try {
    const h = await call('session.history', { sessionId });
    const items = h.items ?? h.events ?? [];
    const texts = items.filter((x) => x.type === 'assistant/message' || x.role === 'assistant');
    if (texts.length > 0) {
      console.log('✅ 收到回复:', JSON.stringify(texts[texts.length - 1]).slice(0, 400));
      break;
    }
  } catch (e) { /* 忽略 */ }
}
console.log('done');
