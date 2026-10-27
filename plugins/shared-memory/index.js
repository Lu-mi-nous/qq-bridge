// 跨会话人物记忆插件（R4.5-8）。
//
// 隐私边界（与实现同等重要）：
//   - 只存**结构化人物资料**（稳定偏好/身份线索），不存聊天原文、episode、群名或群内事件；
//   - 身份只认 5~12 位纯数字 QQ 号；偏好走白名单谓词 + confidence/hits 门槛 + 敏感信息过滤；
//   - 唤醒注入点仍留在核心（`pipeline/wake.js` 调 `formatSharedMemoryForWake`），
//     本插件只提供存储、合并、脱敏与格式化；
//   - 控制台可见、可按人忘记、可整体清空。
//
// 插件缺席：网关降级（读取空、格式化空串、写入跳过），桥接照常启动，共享记忆等同关闭。
import path from 'node:path';
import * as impl from './lib/shared-memory.js';

export function create(ctx) {
  const stateDir = path.join(ctx.root, 'state');

  ctx.console?.registerCard?.({
    id: 'shared-memory',
    title: '跨会话人物记忆',
    description: '只共享结构化人物资料（不含聊天原文）；默认开启，可在控制台按人忘记或清空。',
    endpoint: '/api/plugins/shared-memory/card'
  });
  ctx.console?.registerRoute?.('/api/plugins/shared-memory/card', (req, res, url, helpers) => {
    const cfg = ctx.config.get() || {};
    helpers.sendJson({ ok: true, id: 'shared-memory', stats: impl.sharedMemoryStats(stateDir, cfg) });
  });

  function start() {
    const cfg = ctx.config.get() || {};
    if (cfg.enabled === false) {
      ctx.log('已在配置中关闭（socialV2.sharedMemory.enabled=false）');
      return;
    }
    const st = impl.sharedMemoryStats(stateDir, cfg);
    ctx.log(`已加载：共享人物 ${st.people} 位 / 偏好 ${st.traits} 条（注入点仍在核心 wake）`);
  }

  function stop() { /* 无定时器：记忆按 episode 写入，持久化在 state/shared-memory.json */ }

  return { start, stop, api: impl };
}
