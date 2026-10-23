// test-vision-dsh.mjs — 端到端验证：DSH 会话里发图片给模型，看它能否描述
// 用法: node scripts/test-vision-dsh.mjs [provider] [model] [图片路径]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
import { NodeApiClient, unwrap, createTurnCollector } from '../src/dsh-client.js';

const provider = process.argv[2] ?? 'local';
const model = process.argv[3] ?? 'cn:glm-5.2';
const imgPath = process.argv[4] ?? path.join(ROOT, 'state', 'vision-test.jpg');
const askText = process.argv[5] ?? '这张图里是什么？用中文一句话说清：发色、配色、是否睁眼、有无鲸鱼元素。';

const api = new NodeApiClient('http://127.0.0.1:3080');
const created = unwrap(await api.sessions.create({ cwd: path.join(ROOT, 'state', 'vision-e2e') }), 'session.create');
const sessionId = created.sessionId;
console.log('会话:', sessionId);

const sel = unwrap(await api.sessions.selectModel({ sessionId, provider, model }), 'session.selectModel');
console.log('模型:', JSON.stringify(sel.selected));

const data = fs.readFileSync(imgPath).toString('base64');
console.log('图片:', imgPath, `(${(data.length / 1024).toFixed(0)} KB base64)`);

const collector = createTurnCollector();
let resolveOpened;
const opened = new Promise((res) => { resolveOpened = res; });
const done = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('等待回复超时（180s）')), 180000);
  (async () => {
    for await (const envelope of api.events.mux({}, undefined, () => resolveOpened())) {
      const frame = envelope.payload;
      if (frame.type === 'session/event' && frame.sessionId === sessionId) {
        const ended = collector.push(frame.event);
        if (ended) { clearTimeout(timer); resolve(ended); return; }
      }
      if (frame.type === 'stream/error') { clearTimeout(timer); reject(new Error(JSON.stringify(frame.error))); return; }
    }
  })().catch((e) => { clearTimeout(timer); reject(e); });
});
await opened;

unwrap(await api.sessions.prompt({
  sessionId,
  mode: 'queue',
  content: [
    { type: 'text', text: askText },
    { type: 'image', mediaType: imgPath.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg', data },
  ],
}), 'session.prompt');

const ended = await done;
console.log('回合结束 reason =', ended.reason?.kind ?? ended.reason);
console.log('🤖 模型回复:');
console.log(ended.text || '（无文本）');
process.exit(0);
