// X（Twitter）帖子插件（R4.5-3）。
//
// 边界：抓取、翻页、置顶识别、翻译、卡片渲染、配图/视频缓存全部在 `lib/`；
// 这里只构造 XMonitor 实例并交给运行时（`pluginRuntime.xMonitor()`），以及控制台卡片。
//
// 谁在用这个实现：
//   - 桥接：控制台端点 `/api/socialV2/fetch-x-posts`（MCP 工具 `qq_fetch_x_posts` 走 HTTP 调它）
//     与 `/api/socialV2/x-auth-check`；插件缺席时两处都回 503。
//   - 注意：**内容安全 P0 仍然生效**——工具开关 `socialV2.tools.fetchXPosts=false` 时，
//     MCP 不注册工具、桥接在拉取前 403。插件化没有、也不应该绕过这道闸门。
import { XMonitor } from './lib/index.mjs';
import { createConfigItems } from './config-items.js';
import { registerXPostsTools } from './mcp-tools.js';

export function create(ctx) {
  registerXPostsTools(ctx);
  const monitor = new XMonitor({
    root: ctx.root,
    log: (m) => ctx.log(m)
  });

  ctx.console?.registerCard?.({
    id: 'x-posts',
    title: 'X（Twitter）帖子',
    description: '按需拉取并渲染卡片；内容安全 P0 期间工具默认关闭。',
    endpoint: '/api/plugins/x-posts/card'
  });
  ctx.console?.registerConfigItems?.(createConfigItems(ctx));
  ctx.console?.registerRoute?.('/api/plugins/x-posts/card', (req, res, url, helpers) => {
    let auth = null;
    try { auth = monitor.describeAuth(); } catch (error) { auth = { available: false, error: String(error?.message ?? error) }; }
    helpers.sendJson({
      ok: true,
      id: 'x-posts',
      enabled: ctx.config.get().enabled !== false,
      auth
    });
  });

  function start() {
    const cfg = ctx.config.get() || {};
    let auth = null;
    try { auth = monitor.describeAuth(); } catch {}
    ctx.log(`已加载（配置${cfg.enabled === false ? '关闭' : '开启'}；登录态 ${auth?.available ? '可用' : '不可用'}）；工具开关 fetchXPosts 由内容安全 P0 控制`);
  }

  function stop() {
    try { monitor?.mediaCache?.stop?.(); } catch {}
  }

  return { start, stop, monitor };
}
