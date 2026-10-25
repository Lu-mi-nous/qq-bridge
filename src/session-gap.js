// 记忆断层：记录每个 QQ 会话最后一次被完整处理的时间。
//
// 为什么需要：桥接重启/停机期间群里的消息收不到，但模型看到的历史是连续的，
// 容易接着旧话题答得毫不相干。这里只维护一个很小的「上次处理时间」状态；
// 唤醒时若间隔超过阈值，给模型补一句背景说明（不调用模型、不改消息原文）。
//
// 注意：状态文件独立于 social-v2 / context 目录，reset/清空上下文不会把它一起删掉；
// 它描述的是运行状态，不是群聊记忆。
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_GAP_NOTICE = Object.freeze({
  enabled: false,
  gapMinutes: 30,
  longGapHours: 6
});

const KEY_RE = /^(group|private):\d+$/;
const FILE_NAME = 'session-gap.json';

function clampInt(raw, dflt, min, max) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.round(n)));
}

export function normalizeGapNoticeConfig(raw = {}) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    enabled: src.enabled === true,
    gapMinutes: clampInt(src.gapMinutes, DEFAULT_GAP_NOTICE.gapMinutes, 1, 10080),
    longGapHours: clampInt(src.longGapHours, DEFAULT_GAP_NOTICE.longGapHours, 1, 720)
  };
}

export function sessionGapFile(stateDir) {
  return path.join(stateDir, FILE_NAME);
}

function emptyState() {
  return { version: 1, sessions: {} };
}

function normalizeEntry(v) {
  const src = v && typeof v === 'object' ? v : {};
  return {
    lastProcessedAt: Math.max(0, Number(src.lastProcessedAt) || 0),
    lastGapNotifiedAt: Math.max(0, Number(src.lastGapNotifiedAt) || 0)
  };
}

function humanGap(ms, longGapHours) {
  const longMs = Math.max(1, Number(longGapHours) || 6) * 3600000;
  if (ms >= longMs) {
    const h = Math.max(1, Math.round(ms / 3600000));
    return h >= 24 ? `已隔了很久（约 ${Math.round(h / 24)} 天）` : `已隔了很久（约 ${h} 小时）`;
  }
  return `已过约 ${Math.max(1, Math.round(ms / 60000))} 分钟`;
}

export function createSessionGap({ file, log = () => {}, maxKeys = 500, now = Date.now } = {}) {
  if (!file) throw new Error('createSessionGap 需要 file');
  let state = emptyState();
  let loaded = false;

  function load() {
    if (loaded) return;
    loaded = true;
    try {
      let text = fs.readFileSync(file, 'utf8');
      if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
      const data = JSON.parse(text);
      const sessions = data && typeof data.sessions === 'object' ? data.sessions : {};
      for (const [key, value] of Object.entries(sessions)) {
        if (!KEY_RE.test(key)) continue;
        state.sessions[key] = normalizeEntry(value);
      }
    } catch { /* 首次启动/损坏按空处理 */ }
  }

  function save() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (error) {
      log(`[断层提醒] 状态写入失败：${error?.message ?? error}`);
    }
  }

  function prune() {
    const entries = Object.entries(state.sessions)
      .sort((a, b) => (b[1].lastProcessedAt || 0) - (a[1].lastProcessedAt || 0));
    if (entries.length <= maxKeys) return;
    for (const [key] of entries.slice(maxKeys)) delete state.sessions[key];
  }

  /** 一个回合正常结束（含静默/工具回合）时更新；失败不影响回合。 */
  function markProcessed(key, at = now()) {
    const k = String(key || '');
    if (!KEY_RE.test(k)) return false;
    load();
    const cur = state.sessions[k] || normalizeEntry({});
    cur.lastProcessedAt = Math.max(Number(cur.lastProcessedAt) || 0, Number(at) || now());
    state.sessions[k] = cur;
    prune();
    save();
    return true;
  }

  /**
   * 生成断层背景；同一段断层只提示一次（lastGapNotifiedAt >= lastProcessedAt）。
   * 关闭时返回空串，调用方拼装结果与旧版逐字节一致。
   */
  function buildNotice(key, cfg = {}) {
    const c = normalizeGapNoticeConfig(cfg);
    if (!c.enabled) return '';
    const k = String(key || '');
    if (!KEY_RE.test(k)) return '';
    load();
    const cur = state.sessions[k];
    if (!cur || !cur.lastProcessedAt) return '';
    const at = now();
    const gapMs = at - cur.lastProcessedAt;
    if (gapMs < c.gapMinutes * 60000) return '';
    if (cur.lastGapNotifiedAt >= cur.lastProcessedAt) return '';
    cur.lastGapNotifiedAt = at;
    state.sessions[k] = cur;
    save();
    return [
      '【运行状态·背景补充】',
      `这个会话距你上次处理${humanGap(gapMs, c.longGapHours)}；这期间的新消息可能没有进入你的上下文。`,
      '需要回忆时用 qq_recall_memory 查历史记录，不要凭印象接旧话题。'
    ].join('\n');
  }

  function stats() {
    load();
    return { sessions: Object.keys(state.sessions).length };
  }

  function get(key) {
    load();
    return state.sessions[String(key || '')] || null;
  }

  return { markProcessed, buildNotice, stats, get };
}
