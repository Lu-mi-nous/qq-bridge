// 超分插件（R4.5-1）。
//
// 边界：Real-ESRGAN 的实现（探测/模型选择/缓存/调用 upscayl-bin）全部在
// `lib/upscale.js`，这里只负责生命周期（启动自检 + 缓存清理定时器）和控制台插槽。
//
// 谁在用这个实现：
//   - 桥接出图管线 `src/image-downscale.js`（动态 import，失败即退回 lanczos）；
//   - MCP 进程 `src/mcp-snowluma-safe.js`（独立进程，直接 import lib；找不到就当没装）；
//   - 本插件（缓存定时器 + 控制台卡片状态）。
// 所以插件目录缺失时：桥接照常出图（lanczos），MCP 不注册 `qq_upscale_image`。
import path from 'node:path';
import {
  configureUpscaleCache,
  pruneUpscaleCache,
  probeUpscale,
  upscaleStatus,
  listModels,
  pickModel,
  upscaleImage,
  shrinkForPublish,
  clearUpscaleCache,
  resetUpscaleState
} from './lib/upscale.js';

export function create(ctx) {
  let timer = null;
  let probe = null;

  ctx.console?.registerCard?.({
    id: 'upscale',
    title: '超分放大（Upscayl）',
    description: '把过小的图放大变清晰；没装 Upscayl 时自动退回 lanczos，不影响出图。',
    endpoint: '/api/plugins/upscale/card'
  });
  ctx.console?.registerRoute?.('/api/plugins/upscale/card', (req, res, url, helpers) => {
    helpers.sendJson({
      ok: true,
      id: 'upscale',
      enabled: ctx.config.get().enabled !== false,
      ready: !!probe?.ok,
      model: probe?.model || '',
      reason: probe?.reason || ''
    });
  });

  function start() {
    const uc = ctx.config.get() || {};
    if (uc.enabled === false) {
      ctx.log('已在配置中关闭（socialV2.upscale.enabled=false）；小图放大走 lanczos');
      return;
    }
    // 缓存目录：默认 <root>/state/upscale-cache；空字符串 = 关闭缓存。
    // 这是运行缓存而非插件私有状态，所以仍放 state/ 根下（cache-manager 也在那里统计）。
    if (uc.cache?.enabled !== false) {
      const dir = uc.cache?.dir
        ? path.resolve(ctx.root, String(uc.cache.dir))
        : path.join(ctx.root, 'state', 'upscale-cache');
      configureUpscaleCache(dir);
      const pr = pruneUpscaleCache({ maxAgeDays: uc.cache?.maxAgeDays, maxBytes: uc.cache?.maxBytes });
      if (pr.total > 0) {
        ctx.log(`缓存清理：${pr.total} 个 / ${(pr.totalBytes / 1024 / 1024).toFixed(1)}MB → 保留 ${pr.kept} 个 / ${(pr.keptBytes / 1024 / 1024).toFixed(1)}MB（删除 ${pr.removed} 个，释放 ${(pr.freedBytes / 1024 / 1024).toFixed(1)}MB）`);
      }
      const everyH = Math.max(1, Number(uc.cache?.sweepEveryHours) || 6);
      timer = setInterval(() => {
        try {
          const r = pruneUpscaleCache({ maxAgeDays: uc.cache?.maxAgeDays, maxBytes: uc.cache?.maxBytes });
          if (r.removed > 0) {
            ctx.log(`定时缓存清理：删除 ${r.removed} 个（${(r.freedBytes / 1024 / 1024).toFixed(1)}MB），保留 ${r.kept} 个 / ${(r.keptBytes / 1024 / 1024).toFixed(1)}MB`);
          }
        } catch (error) {
          ctx.log(`定时缓存清理失败：${error?.message ?? error}`);
        }
      }, everyH * 3600 * 1000);
      timer.unref?.();
    } else {
      ctx.log('缓存已关闭（socialV2.upscale.cache.enabled=false）');
    }
    probe = probeUpscale({ binDir: uc.binDir, modelDir: uc.modelDir, model: uc.model });
    if (probe.ok) ctx.log(`已启用（${probe.model}）`);
    else ctx.log(`未启用（${probe.reason}）：小图放大走 lanczos，不影响其它功能`);
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  return {
    start,
    stop,
    probe: () => probe,
    upscaleImage,
    shrinkForPublish,
    status: (opts = {}) => upscaleStatus(opts),
    listModels: (opts = {}) => listModels(opts),
    pickModel: (requested, opts = {}) => pickModel(requested, opts),
    clearCache: () => clearUpscaleCache(),
    reset: () => resetUpscaleState()
  };
}
