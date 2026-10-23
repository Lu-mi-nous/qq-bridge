// 音色预设：从 GPT-SoVITS 目录里的 `GPT_SoVITS/voices.json` 读取
// 「音色 → 权重版本 → 情绪参考音频」的归档清单。
//
// 为什么需要这一层（2026-10-22 用户要求）：
//   用户把达妮娅/爱弥斯的权重和按情绪分好的参考音频归档到了 GPT-SoVITS 目录。
//   GPT-SoVITS 的"情绪"完全由参考音频决定（没有 emotion 参数），所以想换语气
//   就必须换参考音频。把「哪个音色、哪套权重、哪种情绪的哪条参考」做成清单，
//   桥接每次合成按回复语气挑一条，控制台也能直接选，不用手改路径。
//
// 本模块是纯逻辑（只读文件、不碰网络/进程），便于离线测试。
import fs from 'node:fs';
import path from 'node:path';

/** 清单默认位置：<GPT-SoVITS 根>/GPT_SoVITS/voices.json */
export const VOICES_MANIFEST_REL = path.join('GPT_SoVITS', 'voices.json');

/**
 * 回复语气 → 参考音频情绪。
 *
 * 复用的是 sticker-pick.js 的十类语气；归档里目前只有 happy/neutral/sad，
 * 其余先映射到最近的类别。没有匹配时按 neutral 处理。
 */
export const MOOD_TO_REF = {
  // 直接的情绪名（调用方可能已经归好类）
  happy: 'happy',
  neutral: 'neutral',
  sad: 'sad',
  angry: 'angry',
  // 表情包的十类语气
  laugh: 'happy',
  proud: 'happy',
  cute: 'happy',
  shy: 'happy',
  agree: 'happy',
  greet: 'happy',
  speechless: 'neutral',
  confused: 'neutral'
};

function toAbs(root, p) {
  const s = String(p ?? '').trim();
  if (!s) return '';
  return path.isAbsolute(s) ? s : path.join(root, s);
}

function normalizeVoice(raw, root) {
  const id = String(raw?.id ?? '').trim();
  if (!id) return null;
  const weights = (Array.isArray(raw?.weights) ? raw.weights : []).map((w) => {
    const wid = String(w?.id ?? '').trim();
    const gpt = toAbs(root, w?.gpt);
    const sovits = toAbs(root, w?.sovits);
    return {
      id: wid,
      label: String(w?.label ?? wid),
      gpt,
      sovits,
      exists: !!(gpt && sovits && fs.existsSync(gpt) && fs.existsSync(sovits))
    };
  }).filter((w) => w.id);
  const refs = (Array.isArray(raw?.refs) ? raw.refs : []).map((r) => {
    const rid = String(r?.id ?? '').trim();
    const audio = toAbs(root, r?.audio);
    const text = String(r?.text ?? '').trim();
    return {
      id: rid,
      mood: String(r?.mood ?? 'neutral').trim().toLowerCase() || 'neutral',
      label: String(r?.label ?? rid),
      audio,
      text,
      lang: String(r?.lang ?? 'zh').trim() || 'zh',
      exists: !!(audio && text && fs.existsSync(audio))
    };
  }).filter((r) => r.id);
  return {
    id,
    name: String(raw?.name ?? id),
    defaultWeights: String(raw?.defaultWeights ?? '').trim(),
    defaultRef: String(raw?.defaultRef ?? '').trim(),
    weights,
    refs
  };
}

/** 清单文件路径。 */
export function voicesManifestPath(dir) {
  return path.join(String(dir ?? ''), VOICES_MANIFEST_REL);
}

/**
 * 读取并校验音色清单。失败返回 `{ok:false, error}`，不抛错。
 * @returns {{ok:true, file:string, root:string, defaultVoice:string, voices:Array} | {ok:false, error:string, file:string}}
 */
export function loadVoicesManifest(dir) {
  const file = voicesManifestPath(dir);
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    const root = path.join(String(dir ?? ''), 'GPT_SoVITS');
    const voices = (Array.isArray(raw?.voices) ? raw.voices : [])
      .map((v) => normalizeVoice(v, root))
      .filter(Boolean);
    const usable = voices.filter((v) => v.weights.some((w) => w.exists) && v.refs.some((r) => r.exists));
    if (!usable.length) return { ok: false, error: `${file} 里没有可用的音色（权重或参考音频缺失）`, file };
    return {
      ok: true,
      file,
      root,
      defaultVoice: String(raw?.defaultVoice ?? '').trim(),
      voices
    };
  } catch (error) {
    return { ok: false, error: `读取音色清单失败：${error?.message ?? error}`, file };
  }
}

/**
 * 从清单里选定「音色 + 权重版本 + 可用参考音频」。
 *
 * 选择顺序：显式 id → 默认 id → 第一个可用的。权重/参考都必须文件存在，
 * 否则控制台选了也加载不起来——提前过滤掉比启动 30 秒后报错友好。
 */
export function resolveVoiceSelection(manifest, { voiceId = '', weightsId = '', refMode = 'auto' } = {}) {
  if (!manifest?.ok) return null;
  const voices = manifest.voices;
  const voice = voices.find((v) => v.id === String(voiceId).trim())
    || voices.find((v) => v.id === manifest.defaultVoice)
    || voices[0];
  if (!voice) return null;
  const usableWeights = voice.weights.filter((w) => w.exists);
  const weights = usableWeights.find((w) => w.id === String(weightsId).trim())
    || usableWeights.find((w) => w.id === voice.defaultWeights)
    || usableWeights[0];
  if (!weights) return null;
  const refs = voice.refs.filter((r) => r.exists);
  const defaultRef = refs.find((r) => r.id === voice.defaultRef)
    || refs.find((r) => r.mood === 'neutral')
    || refs[0];
  if (!defaultRef) return null;
  return {
    voice,
    weights,
    refs,
    defaultRef,
    refMode: String(refMode || 'auto').trim() || 'auto'
  };
}

/**
 * 为某一句回复挑参考音频。
 *
 * @param {object} selection resolveVoiceSelection 的结果
 * @param {{refId?:string, mood?:string, random?:()=>number}} opts
 *        refId 为具体 id 时固定用那条；否则按 mood 映射到情绪类别。
 * @returns {object|null}
 */
export function pickVoiceRef(selection, { refId = '', mood = '', random = Math.random } = {}) {
  const refs = Array.isArray(selection?.refs) ? selection.refs : [];
  if (!refs.length) return null;
  const wanted = String(refId ?? '').trim();
  if (wanted && wanted !== 'auto') {
    const exact = refs.find((r) => r.id === wanted);
    if (exact) return exact;
  }
  const group = MOOD_TO_REF[String(mood ?? '').toLowerCase()] || 'neutral';
  const candidates = refs.filter((r) => r.mood === group);
  if (candidates.length) {
    // 同一情绪有多条时随机挑，避免同一句话永远同一个语调
    const idx = Math.min(candidates.length - 1, Math.floor((Number(random()) || 0) * candidates.length));
    return candidates[idx];
  }
  return selection.defaultRef || refs.find((r) => r.mood === 'neutral') || refs[0];
}

/** 给控制台/API 的紧凑视图（只暴露 id/标签/是否存在，不回传绝对路径）。 */
export function voicesForApi(manifest, selection = null) {
  if (!manifest?.ok) return [];
  return manifest.voices.map((v) => {
    const weights = v.weights.filter((w) => w.exists).map((w) => ({ id: w.id, label: w.label }));
    const refs = v.refs.filter((r) => r.exists).map((r) => ({
      id: r.id, mood: r.mood, label: r.label, text: r.text
    }));
    return {
      id: v.id,
      name: v.name,
      defaultWeights: v.defaultWeights,
      defaultRef: v.defaultRef,
      weights,
      refs,
      selected: selection?.voice?.id === v.id
    };
  });
}
