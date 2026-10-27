# 联网搜索插件（web-search）

给模型用的只读联网搜索：按配置顺序尝试 **天气 → 百度 → 必应（HTML）→ 必应（RSS）→ DuckDuckGo**，
首个返回非空结果的引擎胜出；失败引擎有 5 分钟断路器，需要代理的引擎在没配代理时直接跳过。

## 目录

| 文件 | 作用 |
| --- | --- |
| `manifest.json` | 插件声明：id / 配置路径 `webSearch` / 权限 / 控制台卡片 |
| `index.js` | 生命周期（启动日志）+ 控制台卡片状态；能力导出 `search/describeEngines/sanitizeQuery` |
| `lib/index.mjs` | 引擎注册表 + 回退链 + 查询词清洗 + 熔断 |
| `lib/query-plan.mjs` | 查询改写（降级检测、天气定位、实体切分） |
| `lib/engines/*.mjs` | 各引擎实现（往目录丢一个 .mjs 即成为可用引擎） |
| `config.schema.js` | 配置字段清单（可读版） |

## 谁在用它

- **MCP 进程**（`src/mcp-web-search-safe.js`，由 DSH spawn）：直接 import `lib/index.mjs`；
  插件目录缺失时**不注册 `web_search`**，MCP 照常启动；
- `web_fetch` / `web_view_image` 仍由 MCP 提供——它们只依赖 `safe-fetch` / `proxy-tunnel`，
  与搜索插件无关（微信文章、按 URL 看图都靠它们）；
- 本插件：启动日志与控制台卡片。

## 配置（`config.json` → `webSearch`）

```jsonc
{
  "enabled": true,
  "engines": ["weather", "baidu", "bing-html", "bing-rss", "duckduckgo"],
  "maxResults": 8,
  "timeoutMs": 12000,
  "totalTimeoutMs": 35000,
  "proxy": ""            // 留空继承 socialV2.images.proxy
}
```

- 引擎开关与顺序**按 mtime 热加载**，改完保存即生效，不用重启。
- `duckduckgo` 需要代理；`bing-html` / `bing-rss` 在直连下可用，但受上游风控影响。

## 新增引擎

在 `lib/engines/` 放一个 `.mjs`，默认导出 `{ id, label, proxyRequired, search }`，
再把 id 加进 `webSearch.engines` 即可，无需改代码。
