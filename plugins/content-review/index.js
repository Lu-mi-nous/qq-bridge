// 内容审查插件（R4.5-10）。
//
// 这是 X 转发内容安全审查的落点（见桌面工作计划阶段 6）：
//   - 默认关闭；P1 先在 x-posts 拉取流程里接 `reviewText` 的 warn 模式；
//   - 审核入口、本地规则、审计与统计都在 `lib/review.mjs`；
//   - 敏感词表**不进仓库**，由使用者写进 config.json 的 xMonitor.review。
import * as review from './lib/review.mjs';

export function create(ctx) {
  ctx.console?.registerCard?.({
    id: 'content-review',
    title: '内容审查（X 转发安全）',
    description: '默认关闭；开启后按本地规则 + 可选模型审核，审计只存 hash/分类不存原文。',
    endpoint: '/api/plugins/content-review/card'
  });
  ctx.console?.registerRoute?.('/api/plugins/content-review/card', (req, res, url, helpers) => {
    const cfg = ctx.config.get() || {};
    helpers.sendJson({
      ok: true,
      id: 'content-review',
      enabled: cfg.enabled === true,
      mode: cfg.mode === 'block' ? 'block' : 'warn',
      failClosed: cfg.failClosed !== false,
      audit: review.auditStats(ctx.root, cfg, { limit: 20 })
    });
  });

  function start() {
    const cfg = ctx.config.get() || {};
    if (cfg.enabled !== true) {
      ctx.log('默认关闭（xMonitor.review.enabled 不是 true）；X 转发维持 P0 全关');
      return;
    }
    ctx.log(`已启用：mode=${cfg.mode === 'block' ? 'block' : 'warn'}，failClosed=${cfg.failClosed !== false}，词表分类 ${Object.keys(cfg.keywordsByCategory || {}).length} 组`);
  }

  function stop() { /* 无定时器：审计按条 append，统计按需读取 */ }

  return {
    start,
    stop,
    reviewText: review.reviewText,
    localRuleScan: review.localRuleScan,
    normalizeReviewConfig: review.normalizeReviewConfig,
    appendAudit: review.appendAudit,
    auditStats: review.auditStats
  };
}
