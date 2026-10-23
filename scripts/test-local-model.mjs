// test-local-model.mjs — 测试本地 OpenAI 兼容端点的能力
const BASE = 'http://127.0.0.1:7863/v1';
const KEY = 'local';
const MODEL = 'cn:deepseek-v4.1-flash';

async function call(body, withAuth = true, label = '') {
  const headers = { 'content-type': 'application/json' };
  if (withAuth) headers.authorization = `Bearer ${KEY}`;
  const r = await fetch(`${BASE}/chat/completions`, {
    method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(120000),
  });
  const text = await r.text();
  console.log(`--- ${label} (auth=${withAuth}) -> HTTP ${r.status} ---`);
  if (r.status !== 200) { console.log(text.slice(0, 300)); return null; }
  const j = JSON.parse(text);
  const msg = j.choices?.[0]?.message ?? {};
  console.log('content:', JSON.stringify(msg.content)?.slice(0, 200));
  if (msg.tool_calls) console.log('tool_calls:', JSON.stringify(msg.tool_calls).slice(0, 400));
  if (msg.reasoning_content) console.log('reasoning_content: (有，长度', String(msg.reasoning_content).length, ')');
  return msg;
}

// 1. 基础对话（带 key）
await call({ model: MODEL, messages: [{ role: 'user', content: '只回复两个字：收到' }], stream: false }, true, '基础对话');

// 2. 不带 Authorization 头
await call({ model: MODEL, messages: [{ role: 'user', content: '说"ok"' }], stream: false }, false, '无鉴权头');

// 3. tool calling 测试
const tools = [{
  type: 'function',
  function: {
    name: 'qq_send_message',
    description: '向 QQ 会话发送文本消息',
    parameters: {
      type: 'object',
      properties: { messages: { type: 'array', items: { type: 'string' }, description: '要发送的文本数组' } },
      required: ['messages'],
    },
  },
}];
await call({
  model: MODEL,
  messages: [{ role: 'user', content: '请用工具在群里发一条"大家好"' }],
  tools,
  tool_choice: 'auto',
  stream: false,
}, true, 'tool calling');
