// 超分启动装配（R3-14）：缓存清理与插件可用性自检。
import path from 'node:path';

export function createUpscaleBootstrap({ cfg, root, stateDir, log = () => {} } = {}) {
  function start() {
  // 超分插件自检（只 stat 文件，不起进程，毫秒级）：
  // 让管理员在启动日志里一眼看到"超分有没有生效"，而不是等群友发小图才发现。
  // 不可用是正常情况（可选插件），只说一句，不报警。
  if (cfg.socialV2?.upscale?.enabled !== false) {
    import('./upscale.js')
      .then(({ probeUpscale, configureUpscaleCache, pruneUpscaleCache }) => {
        const uc = cfg.socialV2?.upscale ?? {};
        // 缓存目录：默认 <ROOT>/state/upscale-cache；空字符串 = 关闭缓存。
        // 配成相对路径时按 ROOT 解析，避免受启动时 cwd 影响。
        if (uc.cache?.enabled !== false) {
          const dir = uc.cache?.dir
            ? path.resolve(root, String(uc.cache.dir))
            : path.join(stateDir, 'upscale-cache');
          configureUpscaleCache(dir);
          // 启动时先清一次：进程可能停机很久，攒下的过期缓存要趁早收掉。
          const pr = pruneUpscaleCache({
            maxAgeDays: uc.cache?.maxAgeDays,
            maxBytes: uc.cache?.maxBytes
          });
          if (pr.total > 0) {
            log(`[超分] 缓存清理：${pr.total} 个 / ${(pr.totalBytes / 1024 / 1024).toFixed(1)}MB → 保留 ${pr.kept} 个 / ${(pr.keptBytes / 1024 / 1024).toFixed(1)}MB（删除 ${pr.removed} 个，释放 ${(pr.freedBytes / 1024 / 1024).toFixed(1)}MB）`);
          }
          // 定时清理：写入时也会按次数触发，这里兜底处理"长期没有新超分"的情况
          // （否则一张新图都没有时，旧缓存永远不会被回收）。
          const everyH = Math.max(1, Number(uc.cache?.sweepEveryHours) || 6);
          setInterval(() => {
            try {
              const r = pruneUpscaleCache({
                maxAgeDays: uc.cache?.maxAgeDays,
                maxBytes: uc.cache?.maxBytes
              });
              if (r.removed > 0) {
                log(`[超分] 定时缓存清理：删除 ${r.removed} 个（${(r.freedBytes / 1024 / 1024).toFixed(1)}MB），保留 ${r.kept} 个 / ${(r.keptBytes / 1024 / 1024).toFixed(1)}MB`);
              }
            } catch (error) {
              log(`[超分] 定时缓存清理失败：${error?.message ?? error}`);
            }
          }, everyH * 3600 * 1000).unref?.();
        } else {
          log('[超分] 缓存已关闭（socialV2.upscale.cache.enabled=false）');
        }
        const p = probeUpscale({ binDir: uc.binDir, modelDir: uc.modelDir, model: uc.model });
        if (p.ok) log(`[超分] 已启用（${p.model}）`);
        else log(`[超分] 未启用（${p.reason}）：小图放大走 lanczos，不影响其它功能`);
      })
      .catch((error) => log(`[超分] 插件加载失败（不影响桥接）：${error?.message ?? error}`));
  } else {
    log('[超分] 已在配置中关闭（socialV2.upscale.enabled=false）');
  }
  }
  return { start };
}
