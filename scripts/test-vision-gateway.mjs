// test-vision-gateway.mjs — 直接在网关层测试模型看图（绕开 DSH）
// 用法: node scripts/test-vision-gateway.mjs <图片路径> <提问> [模型ID ...]
import fs from 'node:fs';

const imgPath = process.argv[2] ?? 'C:/qq-bridge/state/vision-number.png';
const ask = process.argv[3] ?? '读出图中的数字，只回答数字本身。';
const models = process.argv.slice(4);
if (models.length === 0) models.push('cn:glm-5.2', 'cn:glm-5.3-flash', 'cn:deepseek-v4.1-flash');

const b64 = fs.readFileSync(imgPath).toString('base64');
const media = imgPath.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
console.log(`图片: ${imgPath} (${(b64.length / 1024).toFixed(0)} KB base64)\n`);

for (const model of models) {
  const t0 = Date.now();
  try {
    const r = await fetch('http://127.0.0.1:7863/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer local' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: [{ type: 'text', text: ask }, { type: 'image_url', image_url: { url: `data:${media};base64,${b64}` } }] }],
        stream: false,
      }),
      signal: AbortSignal.timeout(180000),
    });
    const text = await r.text();
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    if (r.status !== 200) { console.log(`❌ ${model} -> HTTP ${r.status}: ${text.slice(0, 150)}`); continue; }
    const j = JSON.parse(text);
    const ans = String(j.choices?.[0]?.message?.content ?? '').replace(/\s+/g, ' ').trim();
    console.log(`✅ ${model} (${secs}s): ${ans.slice(0, 120)}`);
  } catch (e) {
    console.log(`❌ ${model} -> ERR ${e.message}`);
  }
}
