import { createImagesApi } from './images-api.js';
// 图库门面（R3-5）：图库实例、补货拉取、画风分与已发图清理。
//
// 只负责图库存储与图源拉取；发图准入、来源标注、差评换图仍由 bridge/发送层编排。
import fs from 'node:fs';
import path from 'node:path';
import { createJsonStore } from './state/store.js';
import { safeFetchBuffer } from './safe-fetch.js';

export function createImageFacade({
  imageApi = createImagesApi(),
  createImageStore = imageApi.createImageStore, fetchFromSources = imageApi.fetchFromSources, extractStyleVectors = imageApi.extractStyleVectors, cosine = imageApi.cosine,
  cfg,
  imageLibDir,
  imageFetchStateFile,
  styleCenterFile,
  imageFetchUA = 'qq-bridge/0.1',
  sourceDownloadHeaders = {},
  log = () => {},
  now = Date.now,
  fetchSources = fetchFromSources,
  fetchBuffer = safeFetchBuffer,
  extractStyle = extractStyleVectors,
  cosineFn = cosine,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval
} = {}) {
  if (!cfg) throw new Error('createImageFacade: cfg 不能为空');
  if (!imageLibDir || !imageFetchStateFile) throw new Error('createImageFacade: 路径不能为空');

  const imageStore = createImageStore({
    dir: imageLibDir,
    maxFiles: Number(cfg.socialV2?.images?.maxFiles) || 300,
    maxTotalBytes: Number(cfg.socialV2?.images?.maxTotalBytes) || 256 * 1024 * 1024,
    recentBlockMs: Math.max(0, Number(cfg.socialV2?.images?.recentSendBlockMs ?? 10 * 60 * 1000)),
    log: (m) => log(`[图库] ${m}`)
  });
  const imageFetchStateStore = createJsonStore({
    file: imageFetchStateFile,
    version: 1,
    defaults: () => ({ lastFetchedAt: 0 })
  });
  let imageFetchedAt = 0;
  {
    const raw = imageFetchStateStore.read();
    const t = Number(raw?.lastFetchedAt);
    if (Number.isFinite(t) && t > 0 && t <= now()) imageFetchedAt = t;
  }
  let imageFetching = null;
  let lastFetchCorrections = [];
  let styleCenter = null;
  try {
    if (styleCenterFile && fs.existsSync(styleCenterFile)) {
      const sc = JSON.parse(fs.readFileSync(styleCenterFile, 'utf8'));
      if (Array.isArray(sc?.center) && sc.center.length) {
        styleCenter = sc;
        log(`[图库] 已载入画风中心（基于 ${sc.vectors} 张收藏，中位相似度 ${sc.stats?.median ?? '?'}）`);
      }
    }
  } catch (error) {
    log(`[图库] 画风中心载入失败，画风排序将跳过：${error?.message ?? error}`);
  }

  function imagesEnabled() {
    return imageApi.available() && cfg.socialV2?.images?.enabled === true;
  }

  let imageSweepTimer = null;
  function startSentSweep() {
    const ic = cfg.socialV2?.images ?? {};
    const ttl = Number(ic.sentTtlMs) || 0;
    if (!imagesEnabled() || ttl <= 0) return;
    const every = Math.max(10 * 1000, Number(ic.sentSweepMs) || 60 * 1000);
    if (imageSweepTimer) clearIntervalFn(imageSweepTimer);
    imageSweepTimer = setIntervalFn(() => {
      try { imageStore.pruneSent(ttl); } catch (e) { log(`[图库] 已发图清理失败：${e?.message ?? e}`); }
    }, every);
    imageSweepTimer.unref?.();
    log(`[图库] 已发图将在发出 ${Math.round(ttl / 60000)} 分钟后自动删除（每 ${Math.round(every / 1000)} 秒扫描）`);
  }

  async function refreshImageLib(opts = {}) {
    if (!imagesEnabled()) return { ok: false, error: '图库未启用（config.socialV2.images.enabled）' };
    const ic = cfg.socialV2.images;
    const at = now();
    const cooldown = Number(ic.cooldownMs) || 0;
    if (!opts.force && imageFetchedAt && at - imageFetchedAt < cooldown) {
      return { ok: true, cooled: true, added: 0, errors: [], remainMs: cooldown - (at - imageFetchedAt) };
    }
    if (imageFetching) return imageFetching;

    imageFetching = (async () => {
      const maxBytes = Number(ic.maxBytesPerFile) || 4 * 1024 * 1024;
      const perRun = Math.max(1, Number(opts.limit) || Number(ic.fetchPerRun) || 20);
      const { entries, errors, corrections } = await fetchSources(ic.sources, {
        limit: perRun,
        tags: opts.tags,
        order: opts.order,
        maxAgeDays: opts.maxAgeDays,
        sources: Array.isArray(opts.sources) ? opts.sources : undefined,
        preferSingle: ic.preferSingleCharacter !== false,
        proxy: ic.proxy
      });
      lastFetchCorrections = corrections ?? [];
      let added = 0;
      let skipped = 0;
      for (const e of entries) {
        if (added >= perRun) break;
        if (imageStore.has(e.id)) { skipped++; continue; }
        try {
          const srcProxy = String(ic.sources?.[e.source]?.proxy ?? ic.proxy ?? '').trim();
          const srcHeaders = sourceDownloadHeaders[e.source] ?? {};
          let buf;
          if (srcProxy) {
            const { proxyGet } = await import('./proxy-tunnel.js');
            const r = await proxyGet(e.url, {
              proxy: srcProxy,
              headers: { 'user-agent': imageFetchUA, ...srcHeaders },
              maxBytes,
              timeoutMs: 45000
            });
            if (r.status < 200 || r.status >= 300) throw new Error(`HTTP ${r.status}`);
            buf = r.body;
          } else {
            const fetched = await fetchBuffer(e.url, maxBytes, { userAgent: imageFetchUA, headers: srcHeaders });
            buf = fetched?.buffer;
          }
          if (!buf?.length) { skipped++; continue; }
          const rec = imageStore.add(buf, e);
          if (rec) {
            if (styleCenter) {
              try {
                const vecs = await extractStyle([path.join(imageStore.libDir, rec.file)]);
                const v = vecs?.[0];
                if (v) imageStore.setTaste(rec.id, +cosineFn(v, styleCenter.center).toFixed(4));
              } catch (err) { log(`[图库] 画风分计算失败 ${e.id}: ${err?.message ?? err}`); }
            }
            added++;
          } else skipped++;
        } catch (error) {
          errors.push(`${e.id}: ${error?.message ?? error}`);
          skipped++;
        }
      }
      imageStore.prune();
      imageFetchedAt = now();
      try {
        imageFetchStateStore.write({ lastFetchedAt: imageFetchedAt });
      } catch (e) { log(`[图库] 拉取时间写入失败：${e?.message ?? e}`); }
      log(`[图库] 拉取完成：新增 ${added}，跳过 ${skipped}，现有 ${imageStore.count()} 张${errors.length ? `，错误 ${errors.length} 条` : ''}`);
      return { ok: true, added, skipped, errors, total: imageStore.count() };
    })();

    try {
      return await imageFetching;
    } finally {
      imageFetching = null;
    }
  }

  return {
    imageStore,
    imagesEnabled,
    startSentSweep,
    refreshImageLib,
    get imageFetchedAt() { return imageFetchedAt; },
    set imageFetchedAt(value) { imageFetchedAt = Number(value) || 0; },
    get imageFetching() { return imageFetching; },
    set imageFetching(value) { imageFetching = value || null; },
    get lastFetchCorrections() { return lastFetchCorrections; },
    set lastFetchCorrections(value) { lastFetchCorrections = Array.isArray(value) ? value : []; },
    get styleCenter() { return styleCenter; }
  };
}
