export function createBiliApi({ getCapability = () => null } = {}) {
const current = () => getCapability('bili.instance');
const available = () => !!current();
const notLoaded = () => { throw new Error('B站插件不可用'); };
// ── bili.js ────────────────────────────────────────────────────────────────
const setBiliCookie = (...a) => current()?.bili?.setBiliCookie?.(...a);
const createVideoMemory = (...a) => (current()?.bili?.createVideoMemory ? current()?.bili?.createVideoMemory(...a) : null);
const resolveBiliId = (...a) => (current()?.bili?.resolveBiliId ? current()?.bili?.resolveBiliId(...a) : notLoaded());
const fetchVideoInfo = (...a) => (current()?.bili?.fetchVideoInfo ? current()?.bili?.fetchVideoInfo(...a) : notLoaded());
const fetchPopularVideos = (...a) => (current()?.bili?.fetchPopularVideos ? current()?.bili?.fetchPopularVideos(...a) : notLoaded());
const fetchSubtitles = (...a) => (current()?.bili?.fetchSubtitles ? current()?.bili?.fetchSubtitles(...a) : Promise.resolve(null));
const grabAudioTranscript = (...a) => (current()?.bili?.grabAudioTranscript ? current()?.bili?.grabAudioTranscript(...a) : Promise.resolve(null));

// ── bili-auth.js ───────────────────────────────────────────────────────────
const loadBiliAuth = (file) => (current()?.auth?.loadBiliAuth
  ? current()?.auth?.loadBiliAuth(file)
  : { cookie: '', hasSessdata: false, loaded: false, reason: 'B 站插件未加载' });
const searchVideos = (...a) => (current()?.auth?.searchVideos ? current()?.auth?.searchVideos(...a) : notLoaded());
const buildSearchKeywords = (...a) => (current()?.auth?.buildSearchKeywords ? current()?.auth?.buildSearchKeywords(...a) : []);
const pickSearchQuery = (...a) => (current()?.auth?.pickSearchQuery ? current()?.auth?.pickSearchQuery(...a) : '');

// ── bili-browse.js ─────────────────────────────────────────────────────────
const categoryGroup = (...a) => (current()?.browse?.categoryGroup ? current()?.browse?.categoryGroup(...a) : '');
const categoryWeight = (...a) => (current()?.browse?.categoryWeight ? current()?.browse?.categoryWeight(...a) : 0);
const pickCandidate = (...a) => (current()?.browse?.pickCandidate ? current()?.browse?.pickCandidate(...a) : null);
const watchDepth = (...a) => (current()?.browse?.watchDepth ? current()?.browse?.watchDepth(...a) : { seconds: 0, frames: 0 });
const watchVideo = (...a) => (current()?.browse?.watchVideo ? current()?.browse?.watchVideo(...a) : notLoaded());
const canSelfBrowse = (...a) => (current()?.browse?.canSelfBrowse ? current()?.browse?.canSelfBrowse(...a) : { ok: false, reason: 'B 站插件未加载' });
const nextBrowseDelay = (...a) => (current()?.browse?.nextBrowseDelay ? current()?.browse?.nextBrowseDelay(...a) : 0);
const buildBrowsePrompt = (...a) => (current()?.browse?.buildBrowsePrompt ? current()?.browse?.buildBrowsePrompt(...a) : '');
const buildScanPrompt = (...a) => (current()?.browse?.buildScanPrompt ? current()?.browse?.buildScanPrompt(...a) : '');
const buildExtendedPrompt = (...a) => (current()?.browse?.buildExtendedPrompt ? current()?.browse?.buildExtendedPrompt(...a) : '');
const parseScanVerdict = (...a) => (current()?.browse?.parseScanVerdict
  ? current()?.browse?.parseScanVerdict(...a)
  : { liked: null, interest: null, tags: [], notes: '' });

return { available, setBiliCookie, createVideoMemory, resolveBiliId, fetchVideoInfo, fetchPopularVideos, fetchSubtitles, grabAudioTranscript, loadBiliAuth, searchVideos, buildSearchKeywords, pickSearchQuery, categoryGroup, categoryWeight, pickCandidate, watchDepth, watchVideo, canSelfBrowse, nextBrowseDelay, buildBrowsePrompt, buildScanPrompt, buildExtendedPrompt, parseScanVerdict, get GAME_KEYWORDS() { return current()?.browse?.GAME_KEYWORDS ?? []; } };
}
