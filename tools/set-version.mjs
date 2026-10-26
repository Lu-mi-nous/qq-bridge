#!/usr/bin/env node
// 版本号统一改写（tools/set-version.mjs）。
//
// 用法：npm run version:set -- 0.4.2
//
// package.json 是唯一事实源，其余都是镜像。历史教训：手动逐个改会漏
// （2026-10-25 统一 0.4.0 时就清点过一轮），所以收敛成一个脚本 + 一个
// 护栏测试（scripts/test-version-sync.mjs）。README 的「剪版」是人工步骤，
// 流程见 docs/VERSIONING.md，本脚本只负责机械同步。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(target ?? '')) {
  console.error('用法：npm run version:set -- <x.y.z>（例如 0.4.2）');
  process.exit(1);
}

const pkgFile = path.join(ROOT, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
const current = pkg.version;
if (current === target) {
  console.error(`版本号已经是 ${target}，没有可做的改动。`);
  process.exit(1);
}

/** 镜像清单：每处的「旧串 → 新串」都由当前版本推导，新增镜像在这里加一行。 */
const MIRRORS = [
  { file: 'package-lock.json', pairs: (v) => [[`"version": "${v}"`, `"version": "${target}"`]] },
  {
    file: 'public/console.html',
    pairs: (v) => [
      [`<span id="sidebarVersion">v${v}</span>`, `<span id="sidebarVersion">v${target}</span>`],
      [`<span class="about-badge" id="aboutVersion">v${v}</span>`, `<span class="about-badge" id="aboutVersion">v${target}</span>`],
      [`'v${v}'`, `'v${target}'`]
    ]
  },
  { file: 'src/mcp-snowluma-safe.js', pairs: (v) => [[`version: '${v}'`, `version: '${target}'`]] },
  { file: 'src/mcp-host-server.js', pairs: (v) => [[`version: '${v}'`, `version: '${target}'`]] },
  { file: 'src/mcp-web-search-safe.js', pairs: (v) => [[`version: '${v}'`, `version: '${target}'`]] },
  // 跟随主包版本号（0.x 阶段不做独立发版）
  { file: 'plugins/qq-mode-console/package.json', pairs: (v) => [[`"version": "${v}"`, `"version": "${target}"`]] }
];

let fail = 0;
// package.json 本体
{
  let s = fs.readFileSync(pkgFile, 'utf8');
  const from = `"version": "${current}"`;
  if (!s.includes(from)) { console.error(`MISS package.json: ${from}`); fail++; }
  else { s = s.replace(from, `"version": "${target}"`); fs.writeFileSync(pkgFile, s); console.log(`OK   package.json  ${current} -> ${target}`); }
}
for (const { file, pairs } of MIRRORS) {
  const p = path.join(ROOT, file);
  let s = fs.readFileSync(p, 'utf8');
  for (const [from, to] of pairs(current)) {
    const n = s.split(from).length - 1;
    if (n === 0) { console.error(`MISS ${file}: ${from}`); fail++; continue; }
    s = s.replaceAll(from, to);
    console.log(`OK   ${file}  ×${n}`);
  }
  fs.writeFileSync(p, s);
}

// 收尾自检：所有镜像里不允许再出现旧版本号
for (const { file } of [{ file: 'package.json' }, ...MIRRORS]) {
  const s = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const stale = s.includes(`"${current}"`) || s.includes(`'${current}'`) || s.includes(`v${current}`);
  if (stale) { console.error(`STALE ${file} 仍含 ${current}`); fail++; }
}

console.log(fail ? `\n❌ ${fail} 处失败，未完全同步` : `\n✅ 版本号已统一为 ${target}（README 剪版请按 docs/VERSIONING.md 手工执行）`);
process.exit(fail ? 1 : 0);
