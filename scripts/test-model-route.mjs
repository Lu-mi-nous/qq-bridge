// test-model-route.mjs — 测试指定模型路由（对话 + tool calling）
const BASE = 'http://127.0.0.1:7863/v1';
const MODEL = process.argv[2] ?? 'global:deepseek-v4.1-flash';
const KEY = 'local';

async function call(body, label) {
  const r = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });
  const text = await r.text();
  console.log(`--- ${label} -> HTTP ${r.status} ---`);
  if (r.status !== 200) { console.log(text.slice(0, 300)); return null; }
  const j = JSON.parse(text);
  const m = j.choices?.[0]?.message ?? {};
  console.log('content:', JSON.stringify(m.content)?.slice(0, 160));
  if (m.tool_calls) console.log('tool_calls:', JSON.stringify(m.tool_calls).slice(0, 300));
  return m;
}

await call({ model: MODEL, messages: [{ role: 'user', content: '只回复两个字：收到' }], stream: false }, '基础对话');

await call({
  model: MODEL,
  messages: [{ role: 'user', content: '请用工具往群里发"在的"' }],
  tools: [{
    type: 'function',
    function: {
      name: 'qq_send_message',
      description: '向 QQ 会话发送文本消息',
      parameters: { type: 'object', properties: { messages: { type: 'array', items: { type: 'string' } } }, required: ['messages'] },
    },
  }],
  tool_choice: 'auto',
  stream: false,
}, 'tool calling');
