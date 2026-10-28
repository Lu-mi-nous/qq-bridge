// R4.6 架构护栏：跨层导入、手写插件工具注册、测试耦合上限。
//
// 背景（docs/refactor-r4.6-acceptance.md）：
//   - src/** 不得 import plugins/**（核心只经 src/*-api.js 网关）；
//   - plugins/** 只允许 import src/plugin-api/**（否则又回到插件依赖核心内部实现）；
//   - QQ MCP server 不得重新手写插件工具的 server.tool（R4.6-5 已全部迁入 Runtime）；
//   - 测试源码耦合冻结：读 bridge 源码 ≤14、new Function ≤4、读任意 src 源码不新增。
//
// 这是「重复出现就失败」的护栏，不是一次性审计；改这里必须先改 R4.6 验收口径。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLUGIN_TOOL_OWNERS } from '../src/plugins/tool-owners.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0, failed = 0;
const check = (name, condition, detail = '') => {
  if (condition) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name}${detail ? '  ' + detail : ''}`); }
};

const walk = (dir, out = []) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (/\.(m?js)$/.test(entry.name) && !/\.bak/.test(entry.name)) out.push(p);
  }
  return out;
};
const rel = (p) => path.relative(root, p).split(path.sep).join('/');
const specifiers = (text) => [
  ...text.matchAll(/(?:from|import)\s*\(\s*['"]([^'"]+)['"]\s*\)/g),
  ...text.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)
].map((m) => m[1]);

// ── 1. 跨层导入：src → plugins（实现目录）──
// 注意：src/plugins/** 是宿主基础设施（host/process-runtime/mcp-bridge-services 等），
// 不属于「插件实现」；规则针对顶层 plugins/<id>/。相对路径要解析后再判断。
{
  const pluginsRoot = path.join(root, 'plugins') + path.sep;
  const bad = [];
  for (const file of walk(path.join(root, 'src'))) {
    for (const spec of specifiers(fs.readFileSync(file, 'utf8'))) {
      if (!spec.startsWith('.')) continue;
      const resolved = path.resolve(path.dirname(file), spec);
      if (resolved.startsWith(pluginsRoot)) bad.push(`${rel(file)} -> ${spec}`);
    }
  }
  check('src/** 不 import plugins/**（核心只经网关）', bad.length === 0, bad.join('; '));
}

// ── 2. 跨层导入：plugins → 非公共 src ──
{
  const bad = [];
  let scanned = 0;
  for (const file of walk(path.join(root, 'plugins'))) {
    scanned++;
    for (const spec of specifiers(fs.readFileSync(file, 'utf8'))) {
      if (!/(^|\/)src\//.test(spec)) continue;
      if (spec.includes('plugin-api/')) continue;
      bad.push(`${rel(file)} -> ${spec}`);
    }
  }
  check(`plugins/** 只 import src/plugin-api/**（扫描 ${scanned} 个文件）`, bad.length === 0, bad.join('; '));
}

// ── 3. QQ MCP server 不得重新手写插件工具 ──
{
  const mcp = fs.readFileSync(path.join(root, 'src/mcp-snowluma-safe.js'), 'utf8');
  const handWritten = [...mcp.matchAll(/server\.tool\(\s*\n?\s*'([^']+)'/g)].map((m) => m[1]);
  const owned = handWritten.filter((name) => PLUGIN_TOOL_OWNERS[name]);
  check('MCP server 不再手写插件工具（由 Runtime 注册）', owned.length === 0, owned.join(', '));
  check('MCP server 仍消费 Runtime 工具输出', /localPlugins\.mcpTools\(\)/.test(mcp));
}

// ── 4. 测试源码耦合上限（冻结，不得新增）──
{
  // 本护栏自己也要读源码，不计入「测试源码耦合」；其余 test-*.mjs 全部计入。
  const tests = fs.readdirSync(path.join(root, 'scripts'))
    .filter((f) => /^test-.*\.mjs$/.test(f) && f !== 'test-arch-boundaries.mjs');
  const readSrc = (f) => fs.readFileSync(path.join(root, 'scripts', f), 'utf8');
  const bridgeReaders = tests.filter((f) => /readFileSync\([^)]*bridge/.test(readSrc(f)));
  const newFunctions = tests.filter((f) => readSrc(f).includes('new Function'));
  const srcReaders = [];
  for (const f of tests) {
    const text = readSrc(f);
    let i = -1;
    while ((i = text.indexOf('readFileSync(', i + 1)) >= 0) {
      const window = text.slice(i, i + 240);
      if (/['"\`](?:\.\.?\/)*src[/\\]/.test(window) || /['"]src['"]\s*,\s*['"`]/.test(window)) { srcReaders.push(f); break; }
    }
  }
  check(`读 bridge.js 源码的测试 ≤14`, bridgeReaders.length <= 14, `${bridgeReaders.length}: ${bridgeReaders.join(',')}`);
  check(`new Function / 函数截取 ≤4（逐步减少）`, newFunctions.length <= 4, `${newFunctions.length}: ${newFunctions.join(',')}`);
  // 2026-10-28 基线文档记为 50（旧口径）；本护栏用窗口法实测 51 并冻结，口径见报告中说明。
  check(`读任意 src 源码的测试不新增（冻结 51）`, srcReaders.length <= 51, `${srcReaders.length}: 超出即新增耦合，先改口径再放行`);
}

console.log(failed ? `❌ ${passed} 通过 / ${failed} 失败` : `✅ ${passed} 通过 / 0 失败`);
process.exit(failed ? 1 : 0);
