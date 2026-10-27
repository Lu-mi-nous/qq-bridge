// 护栏测试：版本号一致性（docs/VERSIONING.md）。
//
// 背景：版本号散在 8 个文件里，手动逐个改曾经漏过、也出现过
// 「package.json 已经是 x.y.z 但更新日志还挂着未发布」的不同步。
// 这里锁住两条不变量：
//   ① 所有镜像与 package.json 完全一致（改版本必须走 npm run version:set）；
//   ② 更新日志是「一个未发布桶 + 已剪版本段」的结构，不再出现「未发布（续）」。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConsoleUiSource } from './lib/console-ui-src.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const v = pkg.version;
check('package.json 版本号是 x.y.z 形态', /^\d+\.\d+\.\d+$/.test(v), v);

// ① 镜像一致性
{
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  check('package-lock 两处版本号一致',
    lock.version === v && lock.packages?.['']?.version === v,
    `${lock.version} / ${lock.packages?.['']?.version}`);

  const html = readConsoleUiSource();
  const vCount = (html.match(new RegExp(`v${v.replace(/\./g, '\\.')}`, 'g')) || []).length;
  check('控制台 fallback 共 3 处（侧栏 / 徽标 / JS 兜底）', vCount === 3, String(vCount));
  const stray = [...html.matchAll(/v0\.\d+\.\d+/g)].map((m) => m[0]).filter((x) => x !== `v${v}`);
  check('控制台没有残留旧版本号', stray.length === 0, stray.join(','));

  for (const f of ['src/mcp-snowluma-safe.js', 'src/mcp-host-server.js', 'src/mcp-web-search-safe.js']) {
    const s = fs.readFileSync(path.join(root, f), 'utf8');
    check(`${path.basename(f)} 元数据一致`, s.includes(`version: '${v}'`));
  }

  const qmc = JSON.parse(fs.readFileSync(path.join(root, 'plugins', 'qq-mode-console', 'package.json'), 'utf8'));
  check('qq-mode-console 跟随主包版本', qmc.version === v, qmc.version);

  check('version:set 脚本已注册', pkg.scripts?.['version:set'] === 'node tools/set-version.mjs');
}

// ② 更新日志结构（发布版 README 是精简导航页、无此章节时跳过）
{
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  if (readme.includes('## 更新日志')) {
    check('更新日志只有一个「未发布」桶',
      (readme.match(/^### 未发布\r?$/gm) || []).length === 1);
    check('不再用「未发布（续）」堆条目', !readme.includes('### 未发布（续）'));
    const cut = readme.match(new RegExp(`^### ${v.replace(/\./g, '\\.')}（`, 'm'));
    check('当前版本已在更新日志剪版', !!cut, cut ? cut[0] : '未找到');
  } else {
    check('更新日志结构（发布版 README 无「## 更新日志」，跳过）', true);
  }
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
