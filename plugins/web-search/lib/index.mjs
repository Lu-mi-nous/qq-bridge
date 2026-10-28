// web-search/index.mjs — 可插拔搜索引擎注册表 + 回退链
//
// 插拔方式（两层）：
//   1. 引擎即插件：往 engines/ 目录丢一个 .mjs（default 导出 { id, label, proxyRequired, search }）
//      即成为可用引擎，无需改任何代码；
//   2. 配置即开关：config.json 的 webSearch.engines 数组决定启用哪些、按什么顺序回退，
//      改完保存即生效（按 mtime 热加载，无需重启 DSH/桥接）。
//
// 回退语义：按 engines 顺序逐个尝试，首个返回非空结果的引擎胜出；
//   - 引擎抛错 → 5 分钟断路器（期间跳过该引擎），继续下一个；
//   - 引擎返回空结果 → 不熔断（可能是查询本身无结果），继续下一个；
//   - proxyRequired 的引擎在未配置代理时直接跳过（不熔断，配置补上即可用）。
//
// 引擎拿到的是统一的 httpText 助手：直连走 fetch，带 proxy 走项目现有
// proxy-tunnel.js（CONNECT 隧道，自带内网地址阻断）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { proxyGet } from '../../../src/plugin-api/network.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENGINES_DIR = path.join(__dirname, 'engines');
const CONFIG = path.resolve(__dirname, '..', '..', '..', 'config.json');

const BREAKER_MS = 5 * 60 * 1000;
const DEFAULT_ENGINES = ['weather', 'baidu', 'bing-html', 'bing-rss', 'duckduckgo'];
const DEFAULTS = {
  enabled: true,
  engines: DEFAULT_ENGINES,
  maxResults: 8,
  timeoutMs: 12000,
  totalTimeoutMs: 35000,
  proxy: '', // 留空则继承 socialV2.images.proxy（图库已配好的代理）
};

// ── 查询词清洗（与 MCP 侧同规则）────────────────────────────────────────────
export function sanitizeQuery(query) {
  return String(query ?? '')
    .replace(/\[CQ:[^\]]*\]/gi, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

// ── 配置（mtime 热加载）─────────────────────────────────────────────────────
let cfgCache = { mtimeMs: -1, cfg: null };

function loadConfig() {
  try {
    const st = fs.statSync(CONFIG);
    if (!cfgCache.cfg || st.mtimeMs !== cfgCache.mtimeMs) {
      const raw = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
      const ws = raw.webSearch ?? {};
      const imagesProxy = raw.socialV2?.images?.proxy ?? '';
      cfgCache = {
        mtimeMs: st.mtimeMs,
        cfg: {
          enabled: ws.enabled !== false,
          engines: Array.isArray(ws.engines) && ws.engines.length ? ws.engines.map(String) : [...DEFAULTS.engines],
          maxResults: Math.min(20, Math.max(1, Number(ws.maxResults) || DEFAULTS.maxResults)),
          timeoutMs: Math.min(60000, Math.max(3000, Number(ws.timeoutMs) || DEFAULTS.timeoutMs)),
          totalTimeoutMs: Math.min(120000, Math.max(5000, Number(ws.totalTimeoutMs) || DEFAULTS.totalTimeoutMs)),
          proxy: String(ws.proxy ?? '').trim() || String(imagesProxy).trim(),
        },
      };
    }
    return cfgCache.cfg;
  } catch {
    return { ...DEFAULTS };
  }
}

// ── 引擎发现（目录即插件）───────────────────────────────────────────────────
const engineCache = new Map(); // id -> module.default

async function loadEngines() {
  const found = new Map();
  let files = [];
  try {
    files = fs.readdirSync(ENGINES_DIR).filter((f) => f.endsWith('.mjs'));
  } catch {
    return found;
  }
  for (const f of files) {
    const id = f.replace(/\.mjs$/, '');
    if (engineCache.has(id)) {
      found.set(id, engineCache.get(id));
      continue;
    }
    try {
      const mod = await import(pathToFileURL(path.join(ENGINES_DIR, f)).href);
      const eng = mod.default;
      if (eng && typeof eng.id === 'string' && typeof eng.search === 'function') {
        engineCache.set(eng.id || id, eng);
        found.set(eng.id || id, eng);
      }
    } catch {
      // 单个引擎文件损坏不影响其它引擎
    }
  }
  return found;
}

// ── 断路器 ──────────────────────────────────────────────────────────────────
const breaker = new Map(); // id -> { until, error }

const breakerOpen = (id) => {
  const b = breaker.get(id);
  return b && b.until > Date.now() ? b : null;
};

// ── 统一 HTTP 助手 ──────────────────────────────────────────────────────────
async function httpText(url, { proxy = '', timeoutMs = 12000, headers = {} }) {
  if (proxy) {
    const r = await proxyGet(url, { proxy, timeoutMs, headers });
    if (r.status && r.status !== 200) throw new Error(`HTTP ${r.status}`);
    return String(r.body ?? '');
  }
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.text();
}

// ── 引擎链 ──────────────────────────────────────────────────────────────────
export async function searchWeb(query, opts = {}) {
  const clean = sanitizeQuery(query);
  if (!clean) {
    return { query: clean, engine: null, results: [], tried: [], error: '查询词为空' };
  }
  const cfg = loadConfig();
  if (cfg.enabled === false) {
    return { query: clean, engine: null, results: [], tried: [], error: '联网搜索已关闭（config.json webSearch.enabled=false）' };
  }

  const engines = await loadEngines();
  const order = (opts.engines ?? cfg.engines).filter((id) => engines.has(id));
  const tried = [];
  const deadline = Date.now() + (opts.totalTimeoutMs ?? cfg.totalTimeoutMs);
  const count = opts.count ?? cfg.maxResults;

  for (const id of order) {
    const eng = engines.get(id);
    const open = breakerOpen(id);
    if (open) {
      tried.push({ engine: id, skipped: `熔断中：${open.error}` });
      continue;
    }
    if (eng.proxyRequired && !cfg.proxy) {
      tried.push({ engine: id, skipped: '需要代理但未配置' });
      continue;
    }
    if (Date.now() > deadline) {
      tried.push({ engine: id, skipped: '总耗时预算已用完' });
      continue;
    }
    try {
      const res = await eng.search(clean, { count, timeoutMs: cfg.timeoutMs, proxy: cfg.proxy, httpText });
      const results = Array.isArray(res?.results) ? res.results.filter((r) => r && r.title && r.url) : [];
      // 引擎可能因「多词查询被上游降级」而改用更窄的词重搜（见 bing-html.mjs 顶部）。
      // 这件事必须带给调用方：模型要据此知道"实际搜的是哪个词"，
      // 否则它会把窄查询的结果当成原查询的答案，或反过来以为查询没被执行。
      const extra = {};
      if (res?.retriedWith) extra.retriedWith = String(res.retriedWith);
      if (res?.degraded) extra.degraded = true;
      tried.push({ engine: id, results: results.length, ...extra });
      if (results.length) {
        return { query: clean, engine: id, results: results.slice(0, count), tried, ...extra };
      }
    } catch (error) {
      const msg = String(error?.message ?? error);
      breaker.set(id, { until: Date.now() + BREAKER_MS, error: msg });
      tried.push({ engine: id, error: msg });
    }
  }
  return { query: clean, engine: null, results: [], tried, error: '所有已启用引擎都未返回结果' };
}

// ── 引擎状态描述（供工具失败时提示 AI/运维）────────────────────────────────
export async function describeEngines() {
  const cfg = loadConfig();
  const engines = await loadEngines();
  const lines = [];
  for (const id of cfg.engines) {
    const eng = engines.get(id);
    if (!eng) {
      lines.push(`- ${id}: 配置里启用了但不存在（engines/ 目录下没有对应文件）`);
      continue;
    }
    const open = breakerOpen(id);
    const parts = [`- ${id}（${eng.label ?? id}）`];
    if (eng.proxyRequired) parts.push('需代理');
    parts.push(cfg.proxy || !eng.proxyRequired ? '代理就绪' : '代理未配置');
    if (open) parts.push(`熔断中（${open.error}）`);
    lines.push(parts.join('，'));
  }
  for (const id of engines.keys()) {
    if (!cfg.engines.includes(id)) lines.push(`- ${id}: 已安装但未启用（webSearch.engines 未列出）`);
  }
  return lines.join('\n');
}
