// 测试安全 Web Search / Fetch MCP server：
// - web_search：查一个网络用语/梗
// - web_fetch：抓取一个公开 URL 并检查是否返回正文
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const entry = fileURLToPath(new URL('../src/mcp-web-search-safe.js', import.meta.url));
const transport = new StdioClientTransport({ command: process.execPath, args: [entry] });
const client = new Client({ name: 'bridge-test', version: '0.1.0' });

try {
  await client.connect(transport);
  console.log('✅ Web Search MCP 连接成功');
  const tools = await client.listTools();
  console.log('工具:', tools.tools.map((t) => t.name).join(', '));

  const search = await client.callTool({ name: 'web_search', arguments: { query: 'DeepSeek娘 萌娘百科' } });
  console.log('✅ web_search:', search.content?.[0]?.text?.slice(0, 300));

  // 天气查询应命中 weather 引擎并返回实时温度（2026-10-23 南京事故回归）
  const weather = await client.callTool({ name: 'web_search', arguments: { query: '南京 今天 明天 天气预报' } });
  const weatherText = weather.content?.[0]?.text ?? '';
  console.log('✅ weather:', weatherText.slice(0, 500));
  if (!weatherText.includes('"engine": "weather"') || !/°C/.test(weatherText)) {
    throw new Error('天气查询没有返回 weather 引擎的实时数据');
  }

  const fetch = await client.callTool({
    name: 'web_fetch',
    arguments: { url: 'https://example.com/' }
  });
  const text = fetch.content?.[0]?.text ?? '';
  console.log('✅ web_fetch:', text.slice(0, 300));
  if (fetch.isError || !text.includes('Example Domain')) throw new Error('web_fetch 未拿到 example.com 正文');

  // GB2312 页面必须正确解码（2026-10-23 实测 youth.cn 之前整页乱码）
  const gbk = await client.callTool({ name: 'web_fetch', arguments: { url: 'https://www.youth.cn/' } });
  const gbkText = gbk.content?.[0]?.text ?? '';
  console.log('✅ GBK 页面:', gbkText.slice(0, 200));
  if (gbk.isError || !gbkText.includes('中国青年网')) throw new Error('GBK/GB2312 页面解码失败');

  // 非 2xx 必须 isError=true（以前 404/403 也返回成功）
  const notFound = await client.callTool({ name: 'web_fetch', arguments: { url: 'https://httpbin.org/status/404' } });
  console.log('✅ 404 处理:', notFound.isError ? '已标记失败 ✓' : '⚠️ 未标记失败');
  if (!notFound.isError) throw new Error('404 没有被标记为失败');

  // 图片直链不能当网页正文返回
  const imageAsPage = await client.callTool({ name: 'web_fetch', arguments: { url: 'https://httpbin.org/image/png' } });
  console.log('✅ 图片直链处理:', imageAsPage.isError ? '已拒绝并提示用 web_view_image ✓' : '⚠️ 当成网页返回');
  if (!imageAsPage.isError) throw new Error('图片直链没有被 web_fetch 拒绝');

  // 内网地址应被拒绝
  const bad = await client.callTool({ name: 'web_fetch', arguments: { url: 'http://127.0.0.1/' } });
  console.log('🚫 内网拦截:', bad.isError ? '被拒绝 ✓' : '⚠️ 未被拒绝（异常！）', bad.content?.[0]?.text?.slice(0, 120));

  process.exit(0);
} catch (error) {
  console.error('❌ 测试失败:', error?.message ?? error);
  process.exit(1);
}
