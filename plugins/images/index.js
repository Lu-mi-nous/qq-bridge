// 图片插件（R4.5-5a）。
//
// 边界：图源（safebooru/pixiv/yande.re）、画风向量、反查（SauceNAO）、归档、
// 差评识别、来源提示、Pixiv 凭据都在 `lib/`；核心通过 `src/images-api.js` 网关使用。
//
// 仍留在核心的（R4.5-5b 再迁）：`image-store.js`（图库索引/存储）、
// `image-facade.js`（图库门面）、`image-request.js`（发图请求服务）。
// 它们通过网关调用本插件实现；插件缺席时网关降级，图片能力等同关闭，
// 但桥接启动、控制台与其它功能不受影响。
import * as sources from './lib/image-sources.js';
import * as reverse from './lib/image-reverse-search.mjs';
import * as archive from './lib/image-archive.js';
import * as feedback from './lib/image-feedback.js';
import * as hint from './lib/image-source-hint.js';
import * as style from './lib/image-style.js';
import * as pixiv from './lib/pixiv-auth.js';
import * as quality from './lib/image-quality.js';
import * as store from './lib/image-store.js';

export function create(ctx) {
  ctx.console?.registerCard?.({
    id: 'images',
    title: '图片（图源 / 图库 / 反查）',
    description: '按标签/画师找图、发图额度、反查出处、收藏原图；图库存储暂留核心。',
    endpoint: '/api/plugins/images/card'
  });
  ctx.console?.registerRoute?.('/api/plugins/images/card', (req, res, url, helpers) => {
    const cfg = ctx.config.get() || {};
    const sourcesCfg = cfg.sources ?? {};
    const enabledSources = Object.entries(sourcesCfg)
      .filter(([, v]) => v?.enabled === true)
      .map(([k]) => k);
    helpers.sendJson({
      ok: true,
      id: 'images',
      enabled: cfg.enabled !== false,
      enabledSources,
      reverseSearch: !!String(cfg.reverseSearchApiKey || '').trim(),
      pixivAuth: !!pixiv.hasPixivCookie?.()
    });
  });

  function start() {
    const cfg = ctx.config.get() || {};
    if (cfg.enabled === false) {
      ctx.log('已在配置中关闭（socialV2.images.enabled=false）');
      return;
    }
    const enabled = Object.entries(cfg.sources ?? {}).filter(([, v]) => v?.enabled === true).map(([k]) => k);
    ctx.log(`已加载：启用图源 ${enabled.join('/') || '（无）'}；Pixiv 凭据 ${pixiv.hasPixivCookie?.() ? '已配置' : '未配置'}`);
  }

  function stop() { /* 无自有定时器：补货/清理由核心门面调度 */ }

  return { start, stop, sources, reverse, archive, feedback, hint, style, pixiv, quality, store };
}
