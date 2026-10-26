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
const consoleRoutes = (fs.readFileSync(path.join(ROOT, 'src', 'console-server.js'), 'utf8')
  .match(/url\.pathname ===/g) || []).length
  + sum(fs.readdirSync(routeDir).filter((f) => f.endsWith('.js')), (f) => {
    const src = fs.readFileSync(path.join(routeDir, f), 'utf8');
    return (src.match(/^  \['(?:GET|POST|PUT|DELETE|PATCH)', '[^']+', '(?:exact|prefix)'\]/gm) || []).length
      + (src.match(/router\.(?:get|post|put|del)\(/g) || []).length;
  });

const result = {
  generatedAt: new Date().toISOString(),
  src: {
    files: srcFiles.length,
    lines: srcTotal,
    average: Math.round(srcTotal / srcFiles.length),
    buckets,
    top: srcRows.slice(0, 10),
  },
  tests: { scripts: testFiles.length, scriptFiles: scriptFiles.length, lines: sum(scriptFiles, locOf) },
  public: { files: publicFiles.length, lines: sum(publicFiles, locOf) },
  docs: { files: docFiles.length, lines: sum(docFiles, locOf) },
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
  console.log(`测试      ${result.tests.scripts} 个脚本 / ${result.tests.lines} 行`);
  console.log(`前端      ${result.public.lines} 行 | 文档 ${result.docs.lines} 行 / ${result.docs.files} 份`);
  console.log(`控制流    if ${result.controlFlow.if}  try ${result.controlFlow.try}  await ${result.controlFlow.await}  定时器 ${result.controlFlow.timers}`);
  console.log(`注释      ${result.comments.commentLines} 行（${result.comments.ratio}%）  TODO ${result.todo}`);
  console.log(`配置      ${result.config.keys} 键 / ${result.config.tools} 个工具开关`);
  console.log(`接口      MCP ${result.mcpTools} 个 | 控制台路由 ${result.consoleRoutes} 条`);
  console.log(`依赖      ${result.dependencies} 个 | 循环依赖 ${result.graph.cycles}`);
  console.log('\n最大的 10 个源文件：');
  for (const r of result.src.top) console.log(String(r.loc).padStart(7), r.rel);
  console.log('\n扇出最大：');
  for (const [k, v] of result.graph.fanOutTop.slice(0, 5)) console.log(String(v).padStart(7), k);
  console.log('\n扇入最大：');
  for (const [k, v] of result.graph.fanInTop.slice(0, 5)) console.log(String(v).padStart(7), k);
}
