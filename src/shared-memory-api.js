// 宿主注入的共享记忆网关；每次调用查询能力，禁用后读取为空、写入跳过。
export function createSharedMemoryApi({ getCapability = () => null } = {}) {
const getImpl = () => getCapability('shared-memory.instance')?.api ?? {};
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
const DEFAULT_SHARED_MEMORY = getImpl().DEFAULT_SHARED_MEMORY ?? FALLBACK_DEFAULTS;

const normalizeSharedMemoryConfig = (raw = {}) => (getImpl().normalizeSharedMemoryConfig
  ? getImpl().normalizeSharedMemoryConfig(raw)
  : { ...DEFAULT_SHARED_MEMORY, ...raw });
const sharedMemoryFile = (stateDir) => (getImpl().sharedMemoryFile ? getImpl().sharedMemoryFile(stateDir) : '');
const emptySharedMemory = () => (getImpl().emptySharedMemory ? getImpl().emptySharedMemory() : { version: 1, updatedAt: 0, people: {} });
const loadSharedMemory = (stateDir) => (getImpl().loadSharedMemory ? getImpl().loadSharedMemory(stateDir) : emptySharedMemory());
const saveSharedMemory = (...a) => getImpl().saveSharedMemory?.(...a);
const senderIdByName = (...a) => (getImpl().senderIdByName ? getImpl().senderIdByName(...a) : '');
const resolveEpisodePeople = (...a) => (getImpl().resolveEpisodePeople ? getImpl().resolveEpisodePeople(...a) : []);
const resolveFactSubject = (...a) => (getImpl().resolveFactSubject ? getImpl().resolveFactSubject(...a) : '');
const mergeEpisodeToSharedMemory = (...a) => (getImpl().mergeEpisodeToSharedMemory
  ? getImpl().mergeEpisodeToSharedMemory(...a)
  : { changed: false, reason: 'plugin-missing', people: 0, traits: 0 });
const selectSharedForPrompt = (...a) => (getImpl().selectSharedForPrompt ? getImpl().selectSharedForPrompt(...a) : []);
const formatSharedMemory = (...a) => (getImpl().formatSharedMemory ? getImpl().formatSharedMemory(...a) : '');
const formatSharedMemoryForWake = (...a) => (getImpl().formatSharedMemoryForWake ? getImpl().formatSharedMemoryForWake(...a) : '');
const sharedMemoryStats = (stateDir, cfg = {}) => (getImpl().sharedMemoryStats
  ? getImpl().sharedMemoryStats(stateDir, cfg)
  : { enabled: false, shareProfiles: false, includePrivate: false, people: 0, traits: 0, updatedAt: 0 });
const listSharedPeople = (...a) => (getImpl().listSharedPeople ? getImpl().listSharedPeople(...a) : []);
const forgetSharedPerson = (...a) => (getImpl().forgetSharedPerson ? getImpl().forgetSharedPerson(...a) : false);
const clearSharedMemory = (...a) => (getImpl().clearSharedMemory ? getImpl().clearSharedMemory(...a) : false);

return { DEFAULT_SHARED_MEMORY, normalizeSharedMemoryConfig, sharedMemoryFile, emptySharedMemory, loadSharedMemory, saveSharedMemory, senderIdByName, resolveEpisodePeople, resolveFactSubject, mergeEpisodeToSharedMemory, selectSharedForPrompt, formatSharedMemory, formatSharedMemoryForWake, sharedMemoryStats, listSharedPeople, forgetSharedPerson, clearSharedMemory };
}
