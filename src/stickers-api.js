// 表情能力网关（R4.5-6）。
//
// 表情库/挑选/语气/提示词实现已迁到 `plugins/stickers/lib/`；
// 服务层 `src/sticker-service.js`（同步/列表/备注/删除/收藏）仍在核心，经本网关使用实现。
// 插件缺席时：读取类返回安全空值、写入/缓存类抛明确错误，桥接照常启动（表情功能等同于关闭）。
let lib = {};
let pick = {};
let loadError = '';
try {
  lib = await import('../plugins/stickers/lib/sticker-lib.js');
  pick = await import('../plugins/stickers/lib/sticker-pick.js');
} catch (error) {
  loadError = String(error?.message ?? error);
}

export const stickersPluginLoaded = Object.keys(lib).length > 0;
export const stickersPluginError = loadError;
const notLoaded = () => { throw new Error(`表情插件未加载（plugins/stickers）：${loadError || 'unknown'}`); };

// sticker-lib
export const formatStickerList = (...a) => (lib.formatStickerList ? lib.formatStickerList(...a) : { total: 0, matched: 0, truncated: false, stickers: [] });
export const buildStickerContext = (...a) => (lib.buildStickerContext ? lib.buildStickerContext(...a) : '');
export const buildStickerStrategyHint = (...a) => (lib.buildStickerStrategyHint ? lib.buildStickerStrategyHint(...a) : '');
export const markStickerUsed = (...a) => lib.markStickerUsed?.(...a);
export const writeStickerCacheImage = (...a) => (lib.writeStickerCacheImage ? lib.writeStickerCacheImage(...a) : notLoaded());

// sticker-pick
export const pickStickerCandidates = (...a) => (pick.pickStickerCandidates ? pick.pickStickerCandidates(...a) : []);
export const buildStickerNudge = (...a) => (pick.buildStickerNudge ? pick.buildStickerNudge(...a) : '');
export const moodOfText = (...a) => (pick.moodOfText ? pick.moodOfText(...a) : 'neutral');

// sticker-service 额外需要的读写接口
export const loadStickerStore = (file) => (lib.loadStickerStore ? lib.loadStickerStore(file) : []);
export const saveStickerStore = (...a) => lib.saveStickerStore?.(...a);
export const mergeStickerLibrary = (existing, fetched) => (lib.mergeStickerLibrary ? lib.mergeStickerLibrary(existing, fetched) : existing);
export const findSticker = (...a) => (lib.findSticker ? lib.findSticker(...a) : null);
export const applyStickerNote = (entries, id, patch) => (lib.applyStickerNote ? lib.applyStickerNote(entries, id, patch) : entries);
export const syncStickerCache = (...a) => (lib.syncStickerCache ? lib.syncStickerCache(...a) : []);
export const writeStickerCacheRecord = (...a) => lib.writeStickerCacheRecord?.(...a);
