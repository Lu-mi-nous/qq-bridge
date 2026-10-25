// 上下文记忆检索（Phase 3 P0）：在 journal + episode 上做轻量本地检索。
//
// 为什么不用向量库：
//   1. 当前数据量只有几千条/会话，FTS/BM25 足够；
//   2. 本地 embedding 会额外吃内存和 CPU，而且中文短查询的收益要先验证；
//   3. 先做到“能查到、带时间/seq 证据”，再决定是否升级语义检索。
//
// 纯函数模块，无网络/无文件 IO，便于离线测试。

const CJK_RE = /[\u3400-\u9fff]/;

/** 中文按 Intl.Segmenter 分词；额外补 CJK bigram，兼容分词粒度不一致。 */
export function tokenizeMemoryText(text) {
  const s = String(text ?? '').toLowerCase();
  if (!s.trim()) return [];
  const out = new Set();
  let seg;
  try {
    seg = new Intl.Segmenter('zh-CN', { granularity: 'word' });
  } catch {
    seg = null;
  }
  if (seg) {
    for (const part of seg.segment(s)) {
      const w = String(part.segment || '').trim();
      if (!w) continue;
      if (/^[\p{P}\p{S}\s]+$/u.test(w)) continue;
      if (w.length > 24) continue;
      out.add(w);
    }
  } else {
    for (const w of s.match(/[a-z0-9_]+|[\u3400-\u9fff]+/g) || []) out.add(w);
  }
  // 给连续中文串补 bigram：例如“上下文持久化”与“上下文记忆”能互相命中。
  for (const run of s.match(/[\u3400-\u9fff]{2,}/g) || []) {
    if (run.length > 24) continue;
    for (let i = 0; i + 1 < run.length; i += 1) out.add(run.slice(i, i + 2));
  }
  return [...out].filter((w) => w && !/^\d{1,2}$/.test(w));
}

function docFromMessage(m, i) {
  const text = String(m?.text || m?.plain || '').trim();
  if (!text) return null;
  return {
    id: `msg:${m.messageId != null ? String(m.messageId) : `seq:${Number(m.seq) || i}`}`,
    kind: 'message',
    seq: Number(m.seq) || 0,
    messageId: m.messageId != null ? String(m.messageId) : null,
    time: Number(m.time) || 0,
    sender: String(m.sender || (m.isSelf ? '机器人' : '')),
    text,
    isSelf: m.isSelf === true
  };
}

function docFromEpisode(e, i) {
  const text = String(e?.summary || '').trim();
  if (!text) return null;
  return {
    id: `ep:${Number(e.fromSeq) || 0}:${Number(e.toSeq) || i}:${Number(e.createdAt) || 0}`,
    kind: 'episode',
    seq: Number(e.toSeq) || 0,
    fromSeq: Number(e.fromSeq) || 0,
    toSeq: Number(e.toSeq) || 0,
    time: Number(e.createdAt || e.endAt) || 0,
    sender: '情节摘要',
    text
  };
}

/** 构造倒排索引；documents 已去重，按时间升序。 */
export function buildMemoryIndex({ messages = [], episodes = [] } = {}) {
  const docs = [];
  const seen = new Set();
  for (let i = 0; i < messages.length; i += 1) {
    const d = docFromMessage(messages[i], i);
    if (!d || seen.has(d.id)) continue;
    seen.add(d.id);
    docs.push(d);
  }
  for (let i = 0; i < episodes.length; i += 1) {
    const d = docFromEpisode(episodes[i], i);
    if (!d || seen.has(d.id)) continue;
    seen.add(d.id);
    docs.push(d);
  }
  docs.sort((a, b) => (a.time || 0) - (b.time || 0));
  const df = new Map();
  const tf = new Map();
  let totalLen = 0;
  for (const d of docs) {
    const toks = tokenizeMemoryText(d.text);
    const counts = new Map();
    for (const t of toks) counts.set(t, (counts.get(t) || 0) + 1);
    d.tokens = counts;
    d.length = Math.max(1, toks.length);
    totalLen += d.length;
    for (const t of counts.keys()) df.set(t, (df.get(t) || 0) + 1);
    tf.set(d.id, counts);
  }
  return { docs, df, avgLen: docs.length ? totalLen / docs.length : 1, builtAt: Date.now() };
}

/** BM25 + 时间衰减；query 为空时返回最近文档。 */
export function searchMemory(index, query, {
  limit = 6,
  minScore = 0.1,
  from = 0,
  to = 0,
  excludeSeqs = [],
  excludeIds = []
} = {}) {
  const docs = Array.isArray(index?.docs) ? index.docs : [];
  const n = docs.length;
  if (!n) return [];
  const lim = Math.max(1, Math.min(30, Number(limit) || 6));
  const fromMs = Number(from) || 0;
  const toMs = Number(to) || 0;
  const excluded = new Set([
    ...[...excludeSeqs].map((x) => `seq:${Number(x)}`),
    ...excludeIds.map(String)
  ]);
  const filter = (d) => {
    if (!d) return false;
    if (fromMs && d.time < fromMs) return false;
    if (toMs && d.time > toMs) return false;
    if (d.messageId && excluded.has(`id:${d.messageId}`)) return false;
    if (d.seq && excluded.has(`seq:${d.seq}`)) return false;
    if (excluded.has(d.id)) return false;
    return true;
  };
  const rawQTokens = tokenizeMemoryText(query);
  // 查询侧丢掉单个汉字：像“成本非常低”这种只因一个“低”字命中的噪声太大。
  // 如果整个查询只有一个字，则保留它，避免“鱼”这类短查询完全失效。
  const strongQTokens = rawQTokens.filter((t) => t.length > 1 || /[a-z0-9]/i.test(t));
  const qTokens = strongQTokens.length ? strongQTokens : rawQTokens;
  if (!qTokens.length) {
    return docs.filter(filter).sort((a, b) => (b.time || 0) - (a.time || 0)).slice(0, lim)
      .map((d) => ({ ...d, score: 0 }));
  }
  const now = Date.now();
  const k1 = 1.2;
  const b = 0.75;
  const avg = Number(index.avgLen) || 1;
  const scored = [];
  for (const d of docs) {
    if (!filter(d)) continue;
    let score = 0;
    for (const t of qTokens) {
      const f = d.tokens?.get(t) || 0;
      if (!f) continue;
      const df = Number(index.df.get(t)) || 0;
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + b * (d.length / avg))));
    }
    if (!score) continue;
    // 情节摘要比单条消息更适合作为“回忆”；再给一点时间衰减，避免旧事压过新事。
    if (d.kind === 'episode') score *= 1.25;
    const ageDays = Math.max(0, (now - (d.time || now)) / 86400000);
    score *= 1 / (1 + Math.min(1.5, ageDays / 30));
    if (score >= minScore) scored.push({ ...d, score });
  }
  scored.sort((a, b2) => b2.score - a.score || (b2.time || 0) - (a.time || 0));
  return scored.slice(0, lim).map((d) => ({
    id: d.id, kind: d.kind, seq: d.seq, fromSeq: d.fromSeq, toSeq: d.toSeq,
    messageId: d.messageId, time: d.time, sender: d.sender, text: d.text,
    isSelf: d.isSelf === true, score: Number(d.score.toFixed(3))
  }));
}

function fmtTime(ms) {
  const n = Number(ms) || 0;
  if (!n) return '';
  const d = new Date(n);
  const p = (x) => String(x).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 把检索结果压成注入提示的短文本，保留时间/发送者/seq 证据。 */
export function formatRecallResults(results, { budgetChars = 600 } = {}) {
  const rows = Array.isArray(results) ? results : [];
  if (!rows.length) return '';
  const lines = ['【相关记忆（按当前话题检索，仅作背景）】'];
  for (const r of rows) {
    const who = r.kind === 'episode' ? '情节' : (r.sender || (r.isSelf ? '机器人' : '某人'));
    const text = String(r.text || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const seq = r.seq ? ` seq=${r.seq}` : '';
    lines.push(`- （${fmtTime(r.time)}${seq}）${who}：${text.slice(0, 180)}`);
  }
  if (lines.length === 1) return '';
  let out = lines.join('\n');
  const budget = Math.max(120, Number(budgetChars) || 600);
  if (out.length > budget) out = `${out.slice(0, Math.max(0, budget - 12)).replace(/[\s，。；、]*$/, '')}\n…（检索结果已截断）`;
  return out;
}
