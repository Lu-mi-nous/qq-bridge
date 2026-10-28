// 表情包插件（R4.5-6）。
//
// 边界：表情库（索引/同步/备注/删除/收藏/缓存写盘）、挑选与语气、提示词都在 `lib/`；
// 服务层 `src/sticker-service.js` 仍在核心，经 `src/stickers-api.js` 网关使用。
//
// 谁在用：
//   - `src/sticker-service.js`（同步/列表/备注/删除/收藏，控制台与 bridge 调它）；
//   - `src/bridge.js`（挑选候选、提示词、缓存图、使用计数）；
//   - MCP 工具 `qq_*_sticker*` 走 HTTP 调桥接。
//
// 插件缺席：网关降级（读取给空值、写缓存抛明确错误），桥接照常启动，表情功能等同关闭。
import * as lib from './lib/sticker-lib.js';
import * as pick from './lib/sticker-pick.js';
import { registerStickersTools } from './mcp-tools.js';

export function create(ctx) {
  registerStickersTools(ctx);
  ctx.console?.registerCard?.({
    id: 'stickers',
    title: '表情包（图库 / 挑选 / 收藏）',
    description: '表情库同步、按语气挑候选、群友收藏；与图片插件共用缓存目录策略。',
    endpoint: '/api/plugins/stickers/card'
  });
  ctx.console?.registerRoute?.('/api/plugins/stickers/card', (req, res, url, helpers) => {
    const cfg = ctx.config.get() || {};
    helpers.sendJson({
      ok: true,
      id: 'stickers',
      enabled: cfg.enabled !== false,
      includeInPrompt: cfg.includeInPrompt !== false,
      autoNudge: cfg.autoNudge !== false,
      collect: cfg.collect?.enabled !== false
    });
  });

  function start() {
    const cfg = ctx.config.get() || {};
    ctx.log(cfg.enabled === false
      ? '已在配置中关闭（socialV2.sticker.enabled=false）'
      : `已加载：提示词${cfg.includeInPrompt === false ? '关闭' : '开启'}，自动催图${cfg.autoNudge === false ? '关闭' : '开启'}`);
  }

  function stop() { /* 无自有定时器：同步缓存 TTL 由服务层控制 */ }

  return { start, stop, lib, pick };
}
