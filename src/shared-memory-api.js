// 跨会话人物记忆网关（R4.5-8）。
//
// 存储/合并/脱敏/格式化等实现已迁到 `plugins/shared-memory/lib/`；
// **注入点仍留在核心**（wake 拼装处调用 formatSharedMemoryForWake）——隐私策略集中一处。
// 插件缺席时：读取空值、格式化空串、写入跳过，桥接照常启动（共享记忆等同于关闭）。
let impl = {};
let loadError = '';
try {
  impl = await import('../plugins/shared-memory/lib/shared-memory.js');
} catch (error) {
  loadError = String(error?.message ?? error);
}

export const sharedMemoryPluginLoaded = Object.keys(impl).length > 0;
export const sharedMemoryPluginError = loadError;

const FALLBACK_DEFAULTS = Object.freeze({
  enabled: true,
  shareProfiles: true,
  includePrivate: true,
  excludeKeys: [],
  maxPeople: 2000,
  maxTraitsPerPerson: 20,
  maxPromptPeople: 3,
  maxPromptTraits: 3,
  maxPromptChars: 300,
  ttlDays: 180,
  identityTtlDays: 365
});
export const DEFAULT_SHARED_MEMORY = impl.DEFAULT_SHARED_MEMORY ?? FALLBACK_DEFAULTS;

export const normalizeSharedMemoryConfig = (raw = {}) => (impl.normalizeSharedMemoryConfig
  ? impl.normalizeSharedMemoryConfig(raw)
  : { ...DEFAULT_SHARED_MEMORY, ...raw });
export const sharedMemoryFile = (stateDir) => (impl.sharedMemoryFile ? impl.sharedMemoryFile(stateDir) : '');
export const emptySharedMemory = () => (impl.emptySharedMemory ? impl.emptySharedMemory() : { version: 1, updatedAt: 0, people: {} });
export const loadSharedMemory = (stateDir) => (impl.loadSharedMemory ? impl.loadSharedMemory(stateDir) : emptySharedMemory());
export const saveSharedMemory = (...a) => impl.saveSharedMemory?.(...a);
export const senderIdByName = (...a) => (impl.senderIdByName ? impl.senderIdByName(...a) : '');
export const resolveEpisodePeople = (...a) => (impl.resolveEpisodePeople ? impl.resolveEpisodePeople(...a) : []);
export const resolveFactSubject = (...a) => (impl.resolveFactSubject ? impl.resolveFactSubject(...a) : '');
export const mergeEpisodeToSharedMemory = (...a) => (impl.mergeEpisodeToSharedMemory
  ? impl.mergeEpisodeToSharedMemory(...a)
  : { changed: false, reason: 'plugin-missing', people: 0, traits: 0 });
export const selectSharedForPrompt = (...a) => (impl.selectSharedForPrompt ? impl.selectSharedForPrompt(...a) : []);
export const formatSharedMemory = (...a) => (impl.formatSharedMemory ? impl.formatSharedMemory(...a) : '');
export const formatSharedMemoryForWake = (...a) => (impl.formatSharedMemoryForWake ? impl.formatSharedMemoryForWake(...a) : '');
export const sharedMemoryStats = (stateDir, cfg = {}) => (impl.sharedMemoryStats
  ? impl.sharedMemoryStats(stateDir, cfg)
  : { enabled: false, shareProfiles: false, includePrivate: false, people: 0, traits: 0, updatedAt: 0 });
export const listSharedPeople = (...a) => (impl.listSharedPeople ? impl.listSharedPeople(...a) : []);
export const forgetSharedPerson = (...a) => (impl.forgetSharedPerson ? impl.forgetSharedPerson(...a) : false);
export const clearSharedMemory = (...a) => (impl.clearSharedMemory ? impl.clearSharedMemory(...a) : false);
