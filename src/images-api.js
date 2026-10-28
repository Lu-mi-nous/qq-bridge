export function createImagesApi({ getCapability = () => null } = {}) {
const current = () => getCapability('images.instance');
const available = () => !!current();
const notLoaded = () => { throw new Error('图片插件不可用'); };
// image-sources
const fetchFromSources = (...a) => (current()?.sources?.fetchFromSources ? current()?.sources?.fetchFromSources(...a) : notLoaded());
const resolveTagName = (...a) => (current()?.sources?.resolveTagName ? current()?.sources?.resolveTagName(...a) : Promise.resolve(String(a[0] ?? '')));
const sourcePageOf = (...a) => (current()?.sources?.sourcePageOf ? current()?.sources?.sourcePageOf(...a) : '');
const translateArtistTag = (...a) => (current()?.sources?.translateArtistTag ? current()?.sources?.translateArtistTag(...a) : Promise.resolve(''));

// image-reverse-search
const createReverseSearcherNow = (opts) => (current()?.reverse?.createReverseSearcher
  ? current()?.reverse?.createReverseSearcher(opts)
  : {
      available: false,
      search: () => notLoaded(),
      setApiKey: () => {},
      stats: () => ({ available: false, note: '图片插件未加载' }),
      DB_INDEX: {}
    });

// image-archive
const saveOriginalImage = (...a) => (current()?.archive?.saveOriginalImage
  ? current()?.archive?.saveOriginalImage(...a)
  : Promise.resolve({ ok: false, error: '图片插件未加载' }));

// image-feedback
const classifyImageFeedback = (...a) => (current()?.feedback?.classifyImageFeedback
  ? current()?.feedback?.classifyImageFeedback(...a)
  : { negative: false, matched: [], reason: '图片插件未加载' });
const createFeedbackGateNow = (opts) => (current()?.feedback?.createFeedbackGate
  ? current()?.feedback?.createFeedbackGate(opts)
  : { shouldSwap: () => false, record: () => {}, reset: () => {} });

// image-source-hint
const detectSourceRequest = (...a) => (current()?.hint?.detectSourceRequest
  ? current()?.hint?.detectSourceRequest(...a)
  : { sources: [], matched: [], reason: '图片插件未加载' });
const createSourceHintStoreNow = (opts) => (current()?.hint?.createSourceHintStore
  ? current()?.hint?.createSourceHintStore(opts)
  : { get: () => null, remember: () => {}, clear: () => {} });

// image-style
const extractStyleVectors = (...a) => (current()?.style?.extractStyleVectors ? current()?.style?.extractStyleVectors(...a) : Promise.resolve(null));
const cosine = (...a) => (current()?.style?.cosine ? current()?.style?.cosine(...a) : 0);

// pixiv-auth
const loadPixivAuth = (file) => (current()?.pixiv?.loadPixivAuth
  ? current()?.pixiv?.loadPixivAuth(file)
  : { cookie: '', hasSession: false, loaded: false, reason: '图片插件未加载' });
const setPixivCookie = (...a) => current()?.pixiv?.setPixivCookie?.(...a);
const hasPixivCookie = (...a) => (current()?.pixiv?.hasPixivCookie ? current()?.pixiv?.hasPixivCookie(...a) : false);
const withPixivAuth = (headers) => (current()?.pixiv?.withPixivAuth ? current()?.pixiv?.withPixivAuth(headers) : headers);

// image-quality
const isGroupLike = (...a) => (current()?.quality?.isGroupLike ? current()?.quality?.isGroupLike(...a) : false);
const checkQuality = (...a) => (current()?.quality?.checkQuality ? current()?.quality?.checkQuality(...a) : { ok: false, reason: '图片插件未加载' });

// image-store（R4.5-5b）：插件缺席时给一个空 store，门面/控制台仍可构造与展示。
const emptyStoreStats = () => ({ total: 0, totalBytes: 0, totalMB: 0, maxFiles: 0, maxTotalMB: 0, sent: 0, bySource: {} });
const createImageStoreNow = (opts) => (current()?.store?.createImageStore
  ? current()?.store?.createImageStore(opts)
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

const createImageStore = (...args) => deferred(() => createImageStoreNow(...args));

const createFeedbackGate = (...args) => deferred(() => createFeedbackGateNow(...args));

const createSourceHintStore = (...args) => deferred(() => createSourceHintStoreNow(...args));

const createReverseSearcher = (...args) => deferred(() => createReverseSearcherNow(...args));
function deferred(create) {
  let owner, value;
  const resolve = () => {
    const next = current();
    if (next !== owner || !value) { owner = next; value = create(); }
    return value;
  };
  return new Proxy({}, { get(_, key) {
    const v = resolve()[key];
    return typeof v === 'function' ? (...args) => {
      const active = resolve();
      return typeof active[key] === 'function' ? active[key](...args) : undefined;
    } : v;
  } });
}
return { available, fetchFromSources, resolveTagName, sourcePageOf, translateArtistTag, get DB_INDEX() { return current()?.reverse?.DB_INDEX ?? {}; }, createReverseSearcher, saveOriginalImage, classifyImageFeedback, createFeedbackGate, detectSourceRequest, createSourceHintStore, extractStyleVectors, cosine, loadPixivAuth, setPixivCookie, hasPixivCookie, withPixivAuth, isGroupLike, checkQuality, createImageStore };
}
