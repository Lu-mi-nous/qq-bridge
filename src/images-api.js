// 图片能力网关（R4.5-5a）。
//
// 实现（图源/画风/反查/归档/差评/来源提示/Pixiv 凭据）已迁到 `plugins/images/lib/`；
// 图库存储（image-store）与门面/请求服务仍留核心，它们通过本网关使用插件实现。
// 插件缺席时：同步函数返回安全空值、异步函数抛明确错误，桥接照常启动
// （图片能力等同关闭，图库仍可读已有文件）。
let src = {};
let rev = {};
let archive = {};
let feedback = {};
let hint = {};
let style = {};
let pixiv = {};
let quality = {};
let store = {};
let loadError = '';
try {
  src = await import('../plugins/images/lib/image-sources.js');
  rev = await import('../plugins/images/lib/image-reverse-search.mjs');
  archive = await import('../plugins/images/lib/image-archive.js');
  feedback = await import('../plugins/images/lib/image-feedback.js');
  hint = await import('../plugins/images/lib/image-source-hint.js');
  style = await import('../plugins/images/lib/image-style.js');
  pixiv = await import('../plugins/images/lib/pixiv-auth.js');
  quality = await import('../plugins/images/lib/image-quality.js');
  store = await import('../plugins/images/lib/image-store.js');
} catch (error) {
  loadError = String(error?.message ?? error);
}

export const imagesPluginLoaded = Object.keys(src).length > 0;
export const imagesPluginError = loadError;
const notLoaded = () => { throw new Error(`图片插件未加载（plugins/images）：${loadError || 'unknown'}`); };

// image-sources
export const fetchFromSources = (...a) => (src.fetchFromSources ? src.fetchFromSources(...a) : notLoaded());
export const resolveTagName = (...a) => (src.resolveTagName ? src.resolveTagName(...a) : Promise.resolve(String(a[0] ?? '')));
export const sourcePageOf = (...a) => (src.sourcePageOf ? src.sourcePageOf(...a) : '');
export const translateArtistTag = (...a) => (src.translateArtistTag ? src.translateArtistTag(...a) : Promise.resolve(''));

// image-reverse-search
export const DB_INDEX = rev.DB_INDEX ?? {};
export const createReverseSearcher = (opts) => (rev.createReverseSearcher
  ? rev.createReverseSearcher(opts)
  : {
      available: false,
      search: () => notLoaded(),
      setApiKey: () => {},
      stats: () => ({ available: false, note: '图片插件未加载' }),
      DB_INDEX: {}
    });

// image-archive
export const saveOriginalImage = (...a) => (archive.saveOriginalImage
  ? archive.saveOriginalImage(...a)
  : Promise.resolve({ ok: false, error: '图片插件未加载' }));

// image-feedback
export const classifyImageFeedback = (...a) => (feedback.classifyImageFeedback
  ? feedback.classifyImageFeedback(...a)
  : { negative: false, matched: [], reason: '图片插件未加载' });
export const createFeedbackGate = (opts) => (feedback.createFeedbackGate
  ? feedback.createFeedbackGate(opts)
  : { shouldSwap: () => false, record: () => {}, reset: () => {} });

// image-source-hint
export const detectSourceRequest = (...a) => (hint.detectSourceRequest
  ? hint.detectSourceRequest(...a)
  : { sources: [], matched: [], reason: '图片插件未加载' });
export const createSourceHintStore = (opts) => (hint.createSourceHintStore
  ? hint.createSourceHintStore(opts)
  : { get: () => null, remember: () => {}, clear: () => {} });

// image-style
export const extractStyleVectors = (...a) => (style.extractStyleVectors ? style.extractStyleVectors(...a) : Promise.resolve(null));
export const cosine = (...a) => (style.cosine ? style.cosine(...a) : 0);

// pixiv-auth
export const loadPixivAuth = (file) => (pixiv.loadPixivAuth
  ? pixiv.loadPixivAuth(file)
  : { cookie: '', hasSession: false, loaded: false, reason: '图片插件未加载' });
export const setPixivCookie = (...a) => pixiv.setPixivCookie?.(...a);
export const hasPixivCookie = (...a) => (pixiv.hasPixivCookie ? pixiv.hasPixivCookie(...a) : false);
export const withPixivAuth = (headers) => (pixiv.withPixivAuth ? pixiv.withPixivAuth(headers) : headers);

// image-quality
export const isGroupLike = (...a) => (quality.isGroupLike ? quality.isGroupLike(...a) : false);
export const checkQuality = (...a) => (quality.checkQuality ? quality.checkQuality(...a) : { ok: false, reason: '图片插件未加载' });

// image-store（R4.5-5b）：插件缺席时给一个空 store，门面/控制台仍可构造与展示。
const emptyStoreStats = () => ({ total: 0, totalBytes: 0, totalMB: 0, maxFiles: 0, maxTotalMB: 0, sent: 0, bySource: {} });
export const createImageStore = (opts) => (store.createImageStore
  ? store.createImageStore(opts)
  : {
      libDir: '',
      indexPath: '',
      add: () => null,
      has: () => false,
      prune: () => ({ removed: 0 }),
      pickRandom: () => null,
      markUsed: () => {},
      recentlySent: () => [],
      readBuffer: () => null,
      getById: () => null,
      count: () => 0,
      stats: emptyStoreStats,
      totalBytes: () => 0,
      setTaste: () => {},
      save: () => {},
      pruneSent: () => ({ removed: 0 }),
      listWithoutTaste: () => [],
      reject: () => false,
      unreject: () => false,
      isRejected: () => false,
      rejectedStats: () => ({ total: 0 })
    });
