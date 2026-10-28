export function createStickersApi({ getCapability = () => null } = {}) {
const current = () => getCapability('stickers.instance');
const available = () => !!current();
const notLoaded = () => { throw new Error('表情插件不可用'); };
// sticker-lib
const formatStickerList = (...a) => (current()?.lib?.formatStickerList ? current()?.lib?.formatStickerList(...a) : { total: 0, matched: 0, truncated: false, stickers: [] });
const buildStickerContext = (...a) => (current()?.lib?.buildStickerContext ? current()?.lib?.buildStickerContext(...a) : '');
const buildStickerStrategyHint = (...a) => (current()?.lib?.buildStickerStrategyHint ? current()?.lib?.buildStickerStrategyHint(...a) : '');
const markStickerUsed = (...a) => current()?.lib?.markStickerUsed?.(...a);
const writeStickerCacheImage = (...a) => (current()?.lib?.writeStickerCacheImage ? current()?.lib?.writeStickerCacheImage(...a) : notLoaded());

// sticker-pick
const pickStickerCandidates = (...a) => (current()?.pick?.pickStickerCandidates ? current()?.pick?.pickStickerCandidates(...a) : []);
const buildStickerNudge = (...a) => (current()?.pick?.buildStickerNudge ? current()?.pick?.buildStickerNudge(...a) : '');
const moodOfText = (...a) => (current()?.pick?.moodOfText ? current()?.pick?.moodOfText(...a) : 'neutral');

// sticker-service 额外需要的读写接口
const loadStickerStore = (file) => (current()?.lib?.loadStickerStore ? current()?.lib?.loadStickerStore(file) : []);
const saveStickerStore = (...a) => current()?.lib?.saveStickerStore?.(...a);
const mergeStickerLibrary = (existing, fetched) => (current()?.lib?.mergeStickerLibrary ? current()?.lib?.mergeStickerLibrary(existing, fetched) : existing);
const findSticker = (...a) => (current()?.lib?.findSticker ? current()?.lib?.findSticker(...a) : null);
const applyStickerNote = (entries, id, patch) => (current()?.lib?.applyStickerNote ? current()?.lib?.applyStickerNote(entries, id, patch) : entries);
const syncStickerCache = (...a) => (current()?.lib?.syncStickerCache ? current()?.lib?.syncStickerCache(...a) : []);
const writeStickerCacheRecord = (...a) => current()?.lib?.writeStickerCacheRecord?.(...a);

return { available, formatStickerList, buildStickerContext, buildStickerStrategyHint, markStickerUsed, writeStickerCacheImage, pickStickerCandidates, buildStickerNudge, moodOfText, loadStickerStore, saveStickerStore, mergeStickerLibrary, findSticker, applyStickerNote, syncStickerCache, writeStickerCacheRecord };
}
