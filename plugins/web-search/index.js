// 联网搜索插件（R4.5-2）。
//
// 边界：搜索引擎注册表、回退链、查询词改写、各引擎实现全部在 `lib/`；这里只做
// 生命周期（启动日志）与控制台插槽。
//
// 谁在用这个实现：
//   - MCP 进程 `src/mcp-web-search-safe.js`（独立进程，使用限定插件的宿主；不在就**不注册**
//     `web_search`，但 `web_fetch` / `web_view_image` 仍可用——它们不依赖引擎链）；
//   - 本插件（控制台卡片状态）。
//
// 配置热加载：引擎开关与顺序来自 config.json 的 webSearch.engines，按 mtime 热加载，
// 改完保存即生效，不用重启桥接/DSH（这一点没有因为插件化而改变）。
import { searchWeb, describeEngines, sanitizeQuery } from './lib/index.mjs';
import { createConfigItems } from './config-items.js';
import { registerSearchTool } from './mcp-tools.js';

export function create(ctx) {
  registerSearchTool(ctx, { searchWeb, describeEngines, sanitizeQuery });
  ctx.console?.registerCard?.({
    id: 'web-search',
    title: '联网搜索（多引擎回退）',
    description: '天气/百度/必应/DuckDuckGo 按顺序回退；引擎与顺序改配置即生效，代理可选。',
    endpoint: '/api/plugins/web-search/card'
  });
  ctx.console?.registerConfigItems?.(createConfigItems(ctx));
  ctx.console?.registerRoute?.('/api/plugins/web-search/card', async (req, res, url, helpers) => {
    const cfg = ctx.config.get() || {};
    let engineStatus = '';
    try { engineStatus = await describeEngines(); } catch (error) { engineStatus = `引擎状态读取失败：${error?.message ?? error}`; }
    helpers.sendJson({
      ok: true,
      id: 'web-search',
      enabled: cfg.enabled !== false,
      engines: Array.isArray(cfg.engines) ? cfg.engines : [],
      proxyConfigured: !!String(cfg.proxy || '').trim(),
      status: engineStatus
    });
  });

  function start() {
    const cfg = ctx.config.get() || {};
    if (cfg.enabled === false) {
      ctx.log('已在配置中关闭（webSearch.enabled=false）；MCP 不注册 web_search');
      return;
    }
    const engines = Array.isArray(cfg.engines) && cfg.engines.length ? cfg.engines : ['（默认：weather→baidu→bing-html→bing-rss→duckduckgo）'];
    ctx.log(`已启用：引擎顺序 ${engines.join(' → ')}（改配置热加载，无需重启）`);
  }

  function stop() { /* 无定时器/队列，引擎熔断状态在进程内存，随进程退出 */ }

  return {
    start,
    stop,
    search: (query) => searchWeb(query),
    describeEngines: () => describeEngines(),
    sanitizeQuery: (query) => sanitizeQuery(query)
  };
}
