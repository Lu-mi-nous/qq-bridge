// 逐调用查询宿主，不直接加载插件实现。
export function createSlangApi({ getCapability = () => null } = {}) {
const getImpl = () => getCapability('slang.instance')?.learner ?? {};
const available = () => !!getCapability('slang.instance')?.learner;
const SLANG_STATUS = getImpl().SLANG_STATUS ?? Object.freeze({
  CANDIDATE: 'candidate',
  CONFIRMED: 'confirmed',
  REJECTED: 'rejected'
});

const nowIso = () => (getImpl().nowIso ? getImpl().nowIso() : new Date().toISOString());
const createId = () => (getImpl().createId ? getImpl().createId()
  : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8));
const normalizeSlangEntry = (raw) => (getImpl().normalizeSlangEntry ? getImpl().normalizeSlangEntry(raw) : raw);
const loadSlang = (file) => (getImpl().loadSlang ? getImpl().loadSlang(file) : []);
const saveSlang = (...a) => getImpl().saveSlang?.(...a);
const createSlangEntry = (input = {}) => (getImpl().createSlangEntry ? getImpl().createSlangEntry(input) : {
  content: String(input.content ?? '').trim(), meaning: '', usage: '', example: '', risk: '',
  sources: [], status: 'candidate', source: 'ai', evidence: []
});
const upsertSlangEntry = (entries, content, patch) => (getImpl().upsertSlangEntry
  ? getImpl().upsertSlangEntry(entries, content, patch)
  : entries);
const mergeEvidence = (current, incoming) => (getImpl().mergeEvidence ? getImpl().mergeEvidence(current, incoming) : current);
const buildSlangContext = (...a) => (getImpl().buildSlangContext ? getImpl().buildSlangContext(...a) : '');
const buildExtractionPrompt = (...a) => (getImpl().buildExtractionPrompt ? getImpl().buildExtractionPrompt(...a) : '');
const buildResearchPrompt = (...a) => (getImpl().buildResearchPrompt ? getImpl().buildResearchPrompt(...a) : '');
const parseExtractionJson = (...a) => (getImpl().parseExtractionJson ? getImpl().parseExtractionJson(...a) : []);
const parseResearchJson = (...a) => (getImpl().parseResearchJson ? getImpl().parseResearchJson(...a) : []);

return { available, SLANG_STATUS, nowIso, createId, normalizeSlangEntry, loadSlang, saveSlang, createSlangEntry, upsertSlangEntry, mergeEvidence, buildSlangContext, buildExtractionPrompt, buildResearchPrompt, parseExtractionJson, parseResearchJson };
}
