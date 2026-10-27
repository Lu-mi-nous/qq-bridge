// test-vision.mjs — 测试哪些模型真的能看图
// 用法: node scripts/test-vision.mjs [模型ID ...]
import fs from 'node:fs';

const BASE = 'http://127.0.0.1:7863/v1';
const KEY = 'local';
const IMG = 'C:/qq-bridge/state/vision-test.jpg';

const models = process.argv.slice(2);
if (models.length === 0) models.push('cn:deepseek-v4.1-flash', 'cn:glm-5.3-flash', 'cn:glm-5.2');

const b64 = fs.readFileSync(IMG).toString('base64');
console.log(`测试图片: ${(fs.statSync(IMG).size / 1024).toFixed(1)} KB (base64 ${(b64.length / 1024).toFixed(0)} KB)\n`);

for (const model of models) {
  const t0 = Date.now();
  try {
    const r = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        model,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: '这张图里是什么？用中文一句话说清：人物外貌特征（发色/配色）、是否闭眼、有无鲸鱼元素。' },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } },
          ],
        }],
        stream: false,
      }),
      signal: AbortSignal.timeout(180000),
    });
    const text = await r.text();
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    if (r.status !== 200) {
      console.log(`❌ ${model} -> HTTP ${r.status} (${secs}s): ${text.slice(0, 200)}`);
      continue;
    }
    const j = JSON.parse(text);
    const msg = j.choices?.[0]?.message ?? {};
    const ans = String(msg.content ?? '').replace(/\s+/g, ' ').trim();
    console.log(`✅ ${model} (${secs}s)`);
    console.log(`   回复: ${ans.slice(0, 220) || '（空）'}`);
    if (msg.reasoning_content) console.log(`   （有思维链，${String(msg.reasoning_content).length} 字）`);
  } catch (e) {
    console.log(`❌ ${model} -> ERR ${e.message}`);
  }
}
