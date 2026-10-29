// R4.7-2：表情领域读模型（会话表情列表 / 控制台表情库）。
//
// 列表本身依赖一次同步（syncStickerLibrary），属于读路径上的缓存刷新：
// 不写 QQ、不发消息；AI 强制刷新的 10 秒最小间隔也在这里维护。
// 发送/收藏/抓取/备注/删除在 `src/console/commands/stickers.js`。

export function createStickersReadModel({
  cfg = {},
  live = {},
  stickerEnabled,
  syncStickerLibrary,
  formatStickerList,
  stickerCacheOpts
} = {}) {
  function countOf(rawCount) {
    const maxCount = Math.max(1, Number(cfg.socialV2?.sticker?.maxListCount) || 100);
    return Math.min(500, Math.max(1, Math.min(Number(rawCount) || 48, maxCount)));
  }

  /** GET /api/socialV2/sticker-list：AI 会话里的表情列表（可强制刷新）。 */
  async function list({ key, query = '', rawCount, refresh = false, agent = false } = {}) {
    if (!stickerEnabled?.()) return { ok: false, status: 403, error: '表情包体系已关闭' };
    let force = refresh === true;
    // AI 强制刷新加最小间隔，避免反复调用 OneBot 表情接口造成限频/负载。
    if (agent && force) {
      const now = Date.now();
      if (now - live.lastForcedAgentStickerSync < 10000) {
        force = false;
      } else {
        live.lastForcedAgentStickerSync = now;
      }
    }
    try {
      const synced = await syncStickerLibrary(force);
      const list = formatStickerList(synced?.entries ?? live.stickerEntries, query, countOf(rawCount), stickerCacheOpts?.());
      return {
        ok: true,
        key,
        ...list,
        syncedAt: synced?.syncedAt ?? live.stickerSyncedAt,
        fromCache: synced?.fromCache ?? false
      };
    } catch (error) {
      return { ok: false, status: 500, error: `获取表情列表失败：${error?.message ?? error}` };
    }
  }

  /** GET /api/stickers：控制台表情库（无会话鉴权）。 */
  async function adminList({ query = '', rawCount, refresh = false } = {}) {
    try {
      const synced = await syncStickerLibrary(refresh === true);
      const list = formatStickerList(synced?.entries ?? live.stickerEntries, query, countOf(rawCount), stickerCacheOpts?.());
      return {
        ok: true,
        ...list,
        syncedAt: synced?.syncedAt ?? live.stickerSyncedAt,
        fromCache: synced?.fromCache ?? false
      };
    } catch (error) {
      return { ok: false, status: 500, error: `获取表情失败：${error?.message ?? error}` };
    }
  }

  return { list, adminList };
}
