// test-local-e2e.mjs — 验证 DSH 用本地 provider 建会话并完成一次对话
// 复用桥接自带的 NodeApiClient（含 events.mux 事件流）
import { NodeApiClient, unwrap, createTurnCollector } from '../src/dsh-client.js';

const PROVIDER = process.argv[2] ?? 'local';
const MODEL = process.argv[3] ?? 'cn:deepseek-v4.1-flash';
const PROMPT = process.argv[4] ?? '用一句话介绍你自己，20 字以内';

const api = new NodeApiClient('http://127.0.0.1:3080');
const desc = unwrap(await api.host.describe({}), 'host.describe');
console.log('DSH 已连接, 默认模型:', desc.provider, '/', desc.model);

const cwd = 'C:\\qq-bridge\\state\\local-e2e';
const created = unwrap(await api.sessions.create({ cwd }), 'session.create');
const sessionId = created.sessionId;
console.log('测试会话:', sessionId);

// 不传 reasoningEffort（模拟补丁后 config.dsh.reasoningEffort = "" 的行为）
const sel = unwrap(await api.sessions.selectModel({ sessionId, provider: PROVIDER, model: MODEL }), 'session.selectModel');
console.log('✅ 模型已选定:', JSON.stringify(sel.selected));

const collector = createTurnCollector();
let resolveOpened;
const opened = new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('WebSocket open 超时')), 10000);
  resolveOpened = () => { clearTimeout(t); resolve(); };
});
const done = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('等待回复超时（180s）')), 180000);
  (async () => {
    for await (const envelope of api.events.mux({}, undefined, () => resolveOpened())) {
      const frame = envelope.payload;
      if (frame.type === 'session/event' && frame.sessionId === sessionId) {
        const ended = collector.push(frame.event);
        if (ended) { clearTimeout(timer); resolve(ended); return; }
      }
      if (frame.type === 'stream/error') { clearTimeout(timer); reject(new Error('事件流错误: ' + JSON.stringify(frame.error))); return; }
    }
  })().catch((e) => { clearTimeout(timer); reject(e); });
});
await opened;

const accepted = unwrap(await api.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text: PROMPT }] }), 'session.prompt');
console.log('prompt 已接受:', JSON.stringify(accepted));

const ended = await done;
console.log('回合结束 reason =', ended.reason?.kind ?? ended.reason);
console.log('🤖 本地模型回复:');
console.log(ended.text || '（无文本）');
process.exit(0);
