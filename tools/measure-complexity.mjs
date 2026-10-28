#!/usr/bin/env node
// 复杂度指标采集（R0）。
// 用法：npm run measure           人类可读
//       npm run measure -- --json 机器可读（CI / 重构前后对比）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'collected', 'models']);
// `state` 只在**项目根**跳过（那是运行时状态）；src/state 是源码，
// 曾因按目录名跳过而漏统计 158 行（2026-10-27 修正口径）。
const SKIP_PATHS = new Set([path.join(ROOT, 'state')]);

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_PATHS.has(p)) continue;
      if (!SKIP_DIRS.has(e.name)) walk(p, out);
    } else out.push(p);
  }
  return out;
}

const locOf = (f) => fs.readFileSync(f, 'utf8').split('\n').length;
const sum = (arr, fn) => arr.reduce((s, x) => s + fn(x), 0);
const readText = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// 从 openIdx 处的 `{` 扫到配对的 `}`，跳过字符串与注释。
function balancedBlock(text, openIdx) {
  let depth = 0;
  let inStr = null;
  let inLine = false;
  let inBlock = false;
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];
    if (inLine) { if (c === '\n') inLine = false; continue; }
    if (inBlock) { if (c === '*' && n === '/') { inBlock = false; i++; } continue; }
    if (inStr) {
      if (c === '\\') { i++; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '/' && n === '/') { inLine = true; i++; continue; }
    if (c === '/' && n === '*') { inBlock = true; i++; continue; }
    if (c === "'" || c === '"' || c === '`') { inStr = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return { body: text.slice(openIdx + 1, i), end: i + 1 };
    }
  }
  return null;
}

// 只切顶层的逗号，嵌套对象/数组算一项。
function topLevelEntries(body) {
  let depth = 0;
  let cur = '';
  let inStr = null;
  let inLine = false;
  let inBlock = false;
  const out = [];
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    const n = body[i + 1];
    if (inLine) { cur += c; if (c === '\n') inLine = false; continue; }
    if (inBlock) { cur += c; if (c === '*' && n === '/') { inBlock = false; cur += n; i++; } continue; }
    if (inStr) {
      cur += c;
      if (c === '\\') { cur += body[++i]; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '/' && n === '/') { inLine = true; cur += c; continue; }
    if (c === '/' && n === '*') { inBlock = true; cur += c; continue; }
    if (c === "'" || c === '"' || c === '`') { inStr = c; cur += c; continue; }
    if (c === '{' || c === '(' || c === '[') depth++;
    else if (c === '}' || c === ')' || c === ']') depth--;
    if (c === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

function countObjectKeys(body) {
  return topLevelEntries(body)
    .map((t) => t.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').trim())
    .filter((s) => /^[A-Za-z_$][\w$]*\s*(:|,|$)/.test(s) || /^['"][^'"]+['"]\s*:/.test(s))
    .length;
}

function lineOf(text, re) {
  const m = text.match(re);
  return m ? text.slice(0, m.index).split('\n').length : 0;
}

const srcFiles = walk(path.join(ROOT, 'src')).filter((f) => /\.(js|mjs)$/.test(f));
const scriptFiles = walk(path.join(ROOT, 'scripts')).filter((f) => /\.(js|mjs)$/.test(f));
const testFiles = scriptFiles.filter((f) => /^test-.*\.mjs$/.test(path.basename(f)));
const publicFiles = walk(path.join(ROOT, 'public')).filter((f) => /\.(html|css|js)$/.test(f));
const docFiles = walk(path.join(ROOT, 'docs')).filter((f) => /\.md$/.test(f));

const srcRows = srcFiles
  .map((f) => ({ rel: path.relative(ROOT, f), loc: locOf(f) }))
  .sort((a, b) => b.loc - a.loc);

const srcTotal = sum(srcRows, (x) => x.loc);
const buckets = { '<=100': 0, '101-300': 0, '301-600': 0, '601-1000': 0, '>1000': 0 };
for (const r of srcRows) {
  if (r.loc <= 100) buckets['<=100']++;
  else if (r.loc <= 300) buckets['101-300']++;
  else if (r.loc <= 600) buckets['301-600']++;
  else if (r.loc <= 1000) buckets['601-1000']++;
  else buckets['>1000']++;
}

// 依赖图
function importsOf(file) {
  const text = fs.readFileSync(file, 'utf8');
  const out = new Set();
  for (const m of text.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
    const resolved = path.resolve(path.dirname(file), m[1]);
    const hit = [resolved, resolved + '.js', resolved + '.mjs', path.join(resolved, 'index.js')]
      .find((p) => fs.existsSync(p));
    if (hit) out.add(path.relative(ROOT, hit));
  }
  return out;
}

const graph = new Map(srcFiles.map((f) => [path.relative(ROOT, f), importsOf(f)]));
const fanIn = new Map([...graph.keys()].map((k) => [k, 0]));
for (const deps of graph.values()) for (const d of deps) if (fanIn.has(d)) fanIn.set(d, fanIn.get(d) + 1);

const fanOutTop = [...graph].map(([k, v]) => [k, v.size]).sort((a, b) => b[1] - a[1]);
const fanInTop = [...fanIn].sort((a, b) => b[1] - a[1]);

// 循环依赖
const cycles = [];
const stateMap = new Map();
function dfs(node, stack) {
  if (stateMap.get(node) === 1) {
    const i = stack.indexOf(node);
    if (i >= 0) cycles.push(stack.slice(i).concat(node).join(' -> '));
    return;
  }
  if (stateMap.get(node) === 2) return;
  stateMap.set(node, 1);
  for (const d of graph.get(node) ?? []) if (graph.has(d)) dfs(d, stack.concat(node));
  stateMap.set(node, 2);
}
for (const n of graph.keys()) dfs(n, []);

// 控制流与注释
let ifCount = 0, tryCount = 0, awaitCount = 0, timerCount = 0;
let commentLines = 0, codeLines = 0, todo = 0;
for (const f of srcFiles) {
  const text = fs.readFileSync(f, 'utf8');
  ifCount += (text.match(/\bif\s*\(/g) || []).length;
  tryCount += (text.match(/\btry\s*\{/g) || []).length;
  awaitCount += (text.match(/\bawait\b/g) || []).length;
  timerCount += (text.match(/\bset(Timeout|Interval)\s*\(/g) || []).length;
  todo += (text.match(/\b(TODO|FIXME|HACK|XXX)\b/g) || []).length;
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    if (s.startsWith('//') || s.startsWith('*') || s.startsWith('/*')) commentLines++;
    else codeLines++;
  }
}

// 配置
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8'));
const countKeys = (o) => Object.values(o).reduce(
  (n, v) => n + 1 + (v && typeof v === 'object' && !Array.isArray(v) ? countKeys(v) : 0), 0);

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const mcpTools = sum(
  fs.readdirSync(path.join(ROOT, 'src')).filter((f) => /^mcp-.*\.js$/.test(f)),
  (f) => (fs.readFileSync(path.join(ROOT, 'src', f), 'utf8').match(/server\.tool\(/g) || []).length
);
// R4：路由按域拆到 src/console/routes/*.js，模块用 routes 清单声明端点。
// 计数 = 主文件内联比较 + 模块清单条目（00-overview 用 router.get/post 注册）。
const routeDir = path.join(ROOT, 'src', 'console', 'routes');
const consoleSource = readText('src/console-server.js');
const consoleRoutes = (consoleSource.match(/url\.pathname ===/g) || []).length
  + sum(fs.readdirSync(routeDir).filter((f) => f.endsWith('.js')), (f) => {
    const src = fs.readFileSync(path.join(routeDir, f), 'utf8');
    return (src.match(/^  \['(?:GET|POST|PUT|DELETE|PATCH)', '[^']+', '(?:exact|prefix)'\]/gm) || []).length
      + (src.match(/router\.(?:get|post|put|del)\(/g) || []).length;
  });

// 结构与基线指标（COMPLEXITY.md G1–G4 的对应项）。
// 这些值曾靠临时脚本手工统计，容易和文档漂移；这里统一由 measure 产出。
const bridgeText = readText('src/bridge.js');
const bridgeLines = bridgeText.split('\n');
const mainStart = lineOf(bridgeText, /^async function main\(\)/m);
let mainEnd = 0;
if (mainStart) {
  for (let i = mainStart; i < bridgeLines.length; i++) {
    // 顶层 `}` 在第 0 列；行尾可能是 CRLF，先去掉 \r。
    if (bridgeLines[i].replace(/\r$/, '') === '}') { mainEnd = i + 1; break; }
  }
}
const bagOpen = bridgeText.indexOf('{', bridgeText.indexOf('createConsoleServer('));
const consoleDependencyBag = bagOpen >= 0 ? countObjectKeys(balancedBlock(bridgeText, bagOpen).body) : 0;

const consoleRouteMaxSlice = Math.max(0, ...fs.readdirSync(routeDir)
  .filter((f) => f.endsWith('.js'))
  .map((f) => {
    const src = fs.readFileSync(path.join(routeDir, f), 'utf8');
    let max = 0;
    for (const m of src.matchAll(/const\s*\{/g)) {
      const blk = balancedBlock(src, m.index + m[0].length - 1);
      if (!blk || !/^\s*=\s*(deps|ctx)\s*;/.test(src.slice(blk.end))) continue;
      max = Math.max(max, countObjectKeys(blk.body));
    }
    return max;
  }));

const flagsSource = readText('src/tool-flags.js');
const toolFlagEntries = (flagsSource.match(/\{\s*flag:\s*'/g) || []).length;
const fixedToolFlags = flagsSource.split(/\r?\n/)
  .filter((l) => !l.trim().startsWith('//') && /fixed:\s*true/.test(l)).length;

const allowStart = consoleSource.indexOf('AGENT_ALLOWED_PATHS = new Set([');
const allowEnd = consoleSource.indexOf(']);', allowStart);
const agentAllowedPaths = allowStart >= 0
  ? (consoleSource.slice(allowStart, allowEnd).match(/^\s*'[^']+',?\s*$/gm) || []).length
  : 0;

const periodicTimerSites = sum(srcFiles, (f) => {
  const t = fs.readFileSync(f, 'utf8');
  return (t.match(/\bsetInterval\s*\(/g) || []).length + (t.match(/\bsetIntervalFn\s*\(/g) || []).length;
});

const stateDir = path.join(ROOT, 'state');
const stateEntries = fs.existsSync(stateDir) ? fs.readdirSync(stateDir).length : 0;
let stateBytes = 0;
for (const f of walk(stateDir)) {
  try { stateBytes += fs.statSync(f).size; } catch {}
}

const result = {
  generatedAt: new Date().toISOString(),
  src: {
    files: srcFiles.length,
    lines: srcTotal,
    average: Math.round(srcTotal / srcFiles.length),
    buckets,
    top: srcRows.slice(0, 10),
  },
  tests: {
    testFiles: testFiles.length,
    testLoc: sum(testFiles, locOf),
    scriptFiles: scriptFiles.length,
    scriptLoc: sum(scriptFiles, locOf),
  },
  public: { files: publicFiles.length, lines: sum(publicFiles, locOf) },
  docs: { files: docFiles.length, lines: sum(docFiles, locOf) },
  structure: {
    bridgeLines: bridgeLines.length - 1,
    bridgeMain: {
      start: mainStart,
      end: mainEnd,
      span: mainStart && mainEnd ? mainEnd - mainStart + 1 : 0,
      toEof: mainStart ? bridgeLines.length - 1 - mainStart + 1 : 0,
    },
    bridgeJsonStores: (bridgeText.match(/createJsonStore\(/g) || []).length,
    consoleDependencyBag,
    consoleRouteMaxSlice,
    agentAllowedPaths,
    toolFlagEntries,
    fixedToolFlags,
    periodicTimerSites,
  },
  runtimeSnapshot: {
    stateEntries,
    stateMB: Math.round(stateBytes / 1024 / 1024),
    note: '工作机运行时数据；发布包可能裁剪，不可由源码静态复现',
  },
  graph: {
    cycles: cycles.length,
    fanOutTop: fanOutTop.slice(0, 10),
    fanInTop: fanInTop.slice(0, 10),
  },
  controlFlow: { if: ifCount, try: tryCount, await: awaitCount, timers: timerCount },
  comments: {
    codeLines,
    commentLines,
    ratio: +(commentLines / Math.max(1, codeLines + commentLines) * 100).toFixed(1),
  },
  todo,
  config: { keys: countKeys(cfg), tools: Object.keys(cfg.socialV2?.tools ?? {}).length },
  mcpTools,
  consoleRoutes,
  dependencies: Object.keys(pkg.dependencies ?? {}).length,
  version: pkg.version,
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`qq-bridge 复杂度指标（v${result.version}）`);
  console.log('─'.repeat(52));
  console.log(`源码      ${result.src.files} 个文件 / ${result.src.lines} 行（平均 ${result.src.average}）`);
  console.log(`文件分布  ≤100: ${buckets['<=100']}  101-300: ${buckets['101-300']}  301-600: ${buckets['301-600']}  601-1000: ${buckets['601-1000']}  >1000: ${buckets['>1000']}`);
  console.log(`测试      ${result.tests.testFiles} 个 test / ${result.tests.testLoc} LOC（全部 scripts ${result.tests.scriptFiles} 个 / ${result.tests.scriptLoc} LOC）`);
  console.log(`前端      ${result.public.lines} 行 | 文档 ${result.docs.lines} 行 / ${result.docs.files} 份`);
  console.log(`控制流    if ${result.controlFlow.if}  try ${result.controlFlow.try}  await ${result.controlFlow.await}  定时器 ${result.controlFlow.timers}`);
  console.log(`注释      ${result.comments.commentLines} 行（${result.comments.ratio}%）  TODO ${result.todo}`);
  console.log(`配置      ${result.config.keys} 键 / ${result.config.tools} 个配置工具键（TOOL_FLAGS ${result.structure.toolFlagEntries}，fixed ${result.structure.fixedToolFlags}）`);
  console.log(`接口      MCP ${result.mcpTools} 个 | 控制台路由 ${result.consoleRoutes} 条 | Agent 白名单 ${result.structure.agentAllowedPaths}`);
  console.log(`结构      main ${result.structure.bridgeMain.span} 行 | JSON store ${result.structure.bridgeJsonStores} | 周期定时器 ${result.structure.periodicTimerSites} 处`);
  console.log(`注入      createConsoleServer ${result.structure.consoleDependencyBag} 项 | 路由最大解构 ${result.structure.consoleRouteMaxSlice} 项`);
  console.log(`依赖      ${result.dependencies} 个 | 循环依赖 ${result.graph.cycles}`);
  console.log(`运行态    state ${result.runtimeSnapshot.stateEntries} 项 / ${result.runtimeSnapshot.stateMB} MB（运行时快照）`);
  console.log('\n最大的 10 个源文件：');
  for (const r of result.src.top) console.log(String(r.loc).padStart(7), r.rel);
  console.log('\n扇出最大：');
  for (const [k, v] of result.graph.fanOutTop.slice(0, 5)) console.log(String(v).padStart(7), k);
  console.log('\n扇入最大：');
  for (const [k, v] of result.graph.fanInTop.slice(0, 5)) console.log(String(v).padStart(7), k);
}
