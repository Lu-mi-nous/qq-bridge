// B 站能力网关（R4.5-4）。
//
// 实现（bili.js / bili-auth.js / bili-browse.js）已迁到 `plugins/bili/lib/`。
// 核心只跟本文件打交道：插件存在时转发到真实实现；插件目录缺失时降级——
// 同步函数返回安全的空值、异步函数抛出明确错误，桥接照常启动（B 站功能等同关闭）。
//
// 为什么用顶层 await：网关必须在 bridge 求值其导入之前完成装载，
// 这样调用点仍是原来的同步/异步签名，107 处调用一行不用改。
let bili = {};
let auth = {};
let browse = {};
let loadError = '';
try {
  bili = await import('../plugins/bili/lib/bili.js');
  auth = await import('../plugins/bili/lib/bili-auth.js');
  browse = await import('../plugins/bili/lib/bili-browse.js');
} catch (error) {
  loadError = String(error?.message ?? error);
}

/** 插件是否加载成功（诊断用）。 */
export const biliPluginLoaded = Object.keys(bili).length > 0;
export const biliPluginError = loadError;

const notLoaded = () => { throw new Error(`B 站插件未加载（plugins/bili）：${loadError || 'unknown'}`); };

// ── bili.js ────────────────────────────────────────────────────────────────
export const setBiliCookie = (...a) => bili.setBiliCookie?.(...a);
export const createVideoMemory = (...a) => (bili.createVideoMemory ? bili.createVideoMemory(...a) : null);
export const resolveBiliId = (...a) => (bili.resolveBiliId ? bili.resolveBiliId(...a) : notLoaded());
export const fetchVideoInfo = (...a) => (bili.fetchVideoInfo ? bili.fetchVideoInfo(...a) : notLoaded());
export const fetchPopularVideos = (...a) => (bili.fetchPopularVideos ? bili.fetchPopularVideos(...a) : notLoaded());
export const fetchSubtitles = (...a) => (bili.fetchSubtitles ? bili.fetchSubtitles(...a) : Promise.resolve(null));
export const grabAudioTranscript = (...a) => (bili.grabAudioTranscript ? bili.grabAudioTranscript(...a) : Promise.resolve(null));

// ── bili-auth.js ───────────────────────────────────────────────────────────
export const loadBiliAuth = (file) => (auth.loadBiliAuth
  ? auth.loadBiliAuth(file)
  : { cookie: '', hasSessdata: false, loaded: false, reason: 'B 站插件未加载' });
export const searchVideos = (...a) => (auth.searchVideos ? auth.searchVideos(...a) : notLoaded());
export const buildSearchKeywords = (...a) => (auth.buildSearchKeywords ? auth.buildSearchKeywords(...a) : []);
export const pickSearchQuery = (...a) => (auth.pickSearchQuery ? auth.pickSearchQuery(...a) : '');

// ── bili-browse.js ─────────────────────────────────────────────────────────
export const GAME_KEYWORDS = browse.GAME_KEYWORDS ?? [];
export const categoryGroup = (...a) => (browse.categoryGroup ? browse.categoryGroup(...a) : '');
export const categoryWeight = (...a) => (browse.categoryWeight ? browse.categoryWeight(...a) : 0);
export const pickCandidate = (...a) => (browse.pickCandidate ? browse.pickCandidate(...a) : null);
export const watchDepth = (...a) => (browse.watchDepth ? browse.watchDepth(...a) : { seconds: 0, frames: 0 });
export const watchVideo = (...a) => (browse.watchVideo ? browse.watchVideo(...a) : notLoaded());
export const canSelfBrowse = (...a) => (browse.canSelfBrowse ? browse.canSelfBrowse(...a) : { ok: false, reason: 'B 站插件未加载' });
export const nextBrowseDelay = (...a) => (browse.nextBrowseDelay ? browse.nextBrowseDelay(...a) : 0);
export const buildBrowsePrompt = (...a) => (browse.buildBrowsePrompt ? browse.buildBrowsePrompt(...a) : '');
export const buildScanPrompt = (...a) => (browse.buildScanPrompt ? browse.buildScanPrompt(...a) : '');
export const buildExtendedPrompt = (...a) => (browse.buildExtendedPrompt ? browse.buildExtendedPrompt(...a) : '');
export const parseScanVerdict = (...a) => (browse.parseScanVerdict
  ? browse.parseScanVerdict(...a)
  : { liked: null, interest: null, tags: [], notes: '' });
