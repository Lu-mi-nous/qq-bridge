// list-multimodal.mjs — 列出网关里疑似支持图片输入的模型（含全部字段，看有没有显式模态声明）
const r = await fetch('http://127.0.0.1:7863/v1/models', { headers: { authorization: 'Bearer local' } });
const j = await r.json();
const all = j.data ?? [];
console.log('模型总数:', all.length);
console.log('\n=== 字段结构（第一个模型）===');
console.log(JSON.stringify(all[0], null, 2));

console.log('\n=== 描述里含"多模态/视觉/vision/image"的模型 ===');
for (const m of all) {
  const d = String(m.description ?? '');
  if (/多模态|视觉|vision|image|omni/i.test(d)) {
    const credit = /x([\d.]+)\s*credit/.exec(d);
    console.log(`${m.id.padEnd(30)} ctx=${String(m.context_length).padEnd(8)} credit=${credit ? 'x' + credit[1] : '?'}  ${d.slice(0, 60)}`);
  }
}
