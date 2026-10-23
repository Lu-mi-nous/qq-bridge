// list-vision.mjs — 精确列出支持图片输入的模型（supports_images=true）
const r = await fetch('http://127.0.0.1:7863/v1/models', { headers: { authorization: 'Bearer local' } });
const j = await r.json();
const all = j.data ?? [];

const vision = all.filter((m) => m.supports_images === true);
const noVision = all.filter((m) => m.supports_images !== true);

console.log(`支持看图（supports_images=true）: ${vision.length} 个 / 共 ${all.length} 个\n`);
console.log('模型ID'.padEnd(32) + '积分'.padEnd(7) + '上下文'.padEnd(10) + '工具调用'.padEnd(9) + '名称');
console.log('-'.repeat(95));
for (const m of vision.sort((a, b) => parseFloat(a.credits?.slice(1) ?? 99) - parseFloat(b.credits?.slice(1) ?? 99))) {
  const tools = m.supports_tool_call === true ? '✓' : (m.supports_tool_call === false ? '✗' : '?');
  console.log(
    String(m.id).padEnd(32) +
    String(m.credits ?? '?').padEnd(7) +
    String(m.context_length ?? '?').padEnd(10) +
    tools.padEnd(9) +
    String(m.name ?? '')
  );
}

console.log('\n【当前在用的模型是否支持看图】');
for (const id of ['cn:glm-5.2', 'cn:glm-5.3', 'cn:deepseek-v4.1-flash', 'global:deepseek-v4.1-flash']) {
  const m = all.find((x) => x.id === id);
  console.log(`  ${id.padEnd(30)} supports_images=${m ? m.supports_images : '（不在列表）'}  tool_call=${m ? m.supports_tool_call : '-'}`);
}
