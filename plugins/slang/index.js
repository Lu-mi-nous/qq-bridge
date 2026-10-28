import { registerSlangTools } from './mcp-tools.js';
// 黑话插件（R4.5-7）。
//
// 边界：黑话库读写、候选抽取/研究提示词、JSON 解析、注入片段都在 `lib/`；
// 核心通过 `src/slang-api.js` 网关使用。
//
// 谁在用：
//   - `src/bridge.js`：抽词/研究/注入唤醒提示、控制台 02 卡的库操作；
//   - MCP 工具 `qq_slang_query` / `qq_slang_submit` 走 HTTP 调桥接。
//
// 插件缺席：网关降级（读取空值、写入跳过），桥接照常启动，黑话学习/注入等同关闭。
import * as learner from './lib/slang-learner.js';

export function create(ctx) {
  registerSlangTools(ctx);
  ctx.console?.registerCard?.({
    id: 'slang',
    title: '黑话学习（候选 / 研究）',
    description: '从群聊里抽候选词、按阈值确认后注入唤醒提示；与工作区名绑定。',
    endpoint: '/api/plugins/slang/card'
  });
  ctx.console?.registerRoute?.('/api/plugins/slang/card', (req, res, url, helpers) => {
    const cfg = ctx.config.get() || {};
    helpers.sendJson({
      ok: true,
      id: 'slang',
      enabled: cfg.enabled !== false,
      autoResearch: cfg.autoResearch !== false,
      injectMax: Number(cfg.injectMax) || 8,
      thresholds: Array.isArray(cfg.inferenceThresholds) ? cfg.inferenceThresholds : []
    });
  });

  function start() {
    const cfg = ctx.config.get() || {};
    if (cfg.enabled === false) {
      ctx.log('已在配置中关闭（slang.enabled=false）');
      return;
    }
    ctx.log(`已加载：自动研究${cfg.autoResearch === false ? '关闭' : '开启'}，注入上限 ${Number(cfg.injectMax) || 8}`);
  }

  function stop() { /* 无自有定时器：抽词冷却由 bridge 的窗口状态控制 */ }

  return { start, stop, learner };
}
