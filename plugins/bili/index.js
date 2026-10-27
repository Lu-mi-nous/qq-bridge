// B 站插件（R4.5-4）。
//
// 边界：B 站 API / 搜索 / 观看（抽帧、字幕、ASR）/ 自刷候选与提示词 / 观看记忆的**实现**
// 都在 `lib/`；核心通过 `src/bili-api.js` 网关使用这些能力：
//   - 插件存在：网关转发到真实实现；
//   - 插件目录缺失：网关降级（同步函数返回安全空值、异步函数抛明确错误），
//     桥接照常启动，B 站功能等同关闭。
//
// 仍留在核心的（属于编排/装配，不是 B 站业务实现）：
//   - `src/bili-bootstrap.js`：启动时读凭据、建观看记忆、装 ASR、注册自主刷调度；
//   - `src/pipeline/bili-runtime.js` / `bili-sharing.js`：自主刷流程与落脚群选择；
//   - 控制台 14 卡与 MCP 工具（走 HTTP）。
import * as bili from './lib/bili.js';
import * as auth from './lib/bili-auth.js';
import * as browse from './lib/bili-browse.js';

export function create(ctx) {
  ctx.console?.registerCard?.({
    id: 'bili',
    title: 'B 站（搜索 / 观看 / 自刷）',
    description: '搜视频、看画面与字幕/ASR、潜水时自己刷；观看记忆跨群共享。',
    endpoint: '/api/plugins/bili/card'
  });
  ctx.console?.registerRoute?.('/api/plugins/bili/card', (req, res, url, helpers) => {
    const cfg = ctx.config.get() || {};
    helpers.sendJson({
      ok: true,
      id: 'bili',
      enabled: cfg.enabled !== false,
      selfBrowsing: cfg.selfBrowsing?.enabled !== false,
      asr: cfg.asr?.enabled !== false,
      memoryFile: String(cfg.memory?.file || 'state/bili-memory.json')
    });
  });

  function start() {
    const cfg = ctx.config.get() || {};
    if (cfg.enabled === false) {
      ctx.log('已在配置中关闭（socialV2.bili.enabled=false）');
      return;
    }
    ctx.log(`已加载：自主刷${cfg.selfBrowsing?.enabled === false ? '关闭' : '开启'}，ASR ${cfg.asr?.enabled === false ? '关闭' : '开启'}；启动装配由核心 bili-bootstrap 负责`);
  }

  function stop() { /* 无自有定时器：调度在 task-service / 核心，记忆在 core 持有 */ }

  return { start, stop, bili, auth, browse };
}
