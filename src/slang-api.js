// 黑话能力网关（R4.5-7）。
//
// 黑话库读写、候选抽取/研究提示词、解析与注入片段都在 `plugins/slang/lib/`；
// 核心通过本网关使用。插件缺席时：读取类返回空值、写入类安全跳过，
// 桥接照常启动（黑话学习/注入等同关闭）。
let impl = {};
let loadError = '';
try {
  impl = await import('../plugins/slang/lib/slang-learner.js');
} catch (error) {
  loadError = String(error?.message ?? error);
}

export const slangPluginLoaded = Object.keys(impl).length > 0;
export const slangPluginError = loadError;

export const SLANG_STATUS = impl.SLANG_STATUS ?? Object.freeze({
  CANDIDATE: 'candidate',
  CONFIRMED: 'confirmed',
  REJECTED: 'rejected'
});

export const nowIso = () => (impl.nowIso ? impl.nowIso() : new Date().toISOString());
export const createId = () => (impl.createId ? impl.createId()
  : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8));
export const normalizeSlangEntry = (raw) => (impl.normalizeSlangEntry ? impl.normalizeSlangEntry(raw) : raw);
export const loadSlang = (file) => (impl.loadSlang ? impl.loadSlang(file) : []);
export const saveSlang = (...a) => impl.saveSlang?.(...a);
export const createSlangEntry = (input = {}) => (impl.createSlangEntry ? impl.createSlangEntry(input) : {
  content: String(input.content ?? '').trim(), meaning: '', usage: '', example: '', risk: '',
  sources: [], status: 'candidate', source: 'ai', evidence: []
});
export const upsertSlangEntry = (entries, content, patch) => (impl.upsertSlangEntry
  ? impl.upsertSlangEntry(entries, content, patch)
  : entries);
export const mergeEvidence = (current, incoming) => (impl.mergeEvidence ? impl.mergeEvidence(current, incoming) : current);
export const buildSlangContext = (...a) => (impl.buildSlangContext ? impl.buildSlangContext(...a) : '');
export const buildExtractionPrompt = (...a) => (impl.buildExtractionPrompt ? impl.buildExtractionPrompt(...a) : '');
export const buildResearchPrompt = (...a) => (impl.buildResearchPrompt ? impl.buildResearchPrompt(...a) : '');
export const parseExtractionJson = (...a) => (impl.parseExtractionJson ? impl.parseExtractionJson(...a) : []);
export const parseResearchJson = (...a) => (impl.parseResearchJson ? impl.parseResearchJson(...a) : []);
