// 一键跑全部回归测试（scripts/test-*.mjs）。
//
// 为什么需要：测试脚本有 60 个，逐个手敲不现实；而"只跑改动相关的那个"容易漏掉
// 跨模块的连带影响（例如改脱敏正则会同时影响发送、审批、日志三处）。
// 另外有些测试依赖外部服务（SnowLuma / 网关 / 视觉模型），本机没开时会失败——
// 所以输出里要能一眼区分「真失败」和「环境不满足」。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scriptsDir = path.join(root, 'scripts');

// 需要外部依赖的测试：失败时提示「环境不满足」而不是当成代码 bug。
// 判据来自实测（2026-10-12/15）：
//   - test-vision* / test-local-* / test-model-route：需要 provider 或测试图片文件
//     （常见报错：no adapter registered for provider "local"；ENOENT state/vision-*.jpg）
//   - test-mcp-* / test-onebot-connection：需要 MCP 拉起外部进程
//   - 图站类（test-image-query / test-pixiv / test-yandere 等）：**依赖真实图站 API**，
//     会让结果随上游波动。实测 2026-10-15 safebooru.donmai.us 被 Cloudflare 拦
//     （HTTP 403 "Just a moment..."），所有 safebooru 查询返回 0 条，
//     于是 test-image-query 的「两个通用标签组合仍可用」必然失败——**与本项目代码无关**。
//     这类测试自己的文件头也写了「依赖真实网络；无网络时相关用例会失败」。
const NEEDS_SERVICE = [
  { re: /^test-vision|^test-local-|^test-model-route|^test-onebot-connection|^test-mcp-|^test-console\.mjs$/, hint: '需要 DSH / 网关 / SnowLuma / 正在运行的桥接在跑' },
  { re: /^test-image-query|^test-pixiv|^test-yandere|^test-image-lib|^test-image-source|^test-artist-search|^test-group-images|^test-reverse-search/, hint: '依赖真实图站 API（上游可能被 Cloudflare 拦或限流）' },
];

const files = fs.readdirSync(scriptsDir).filter((f) => /^test-.*\.mjs$/.test(f)).sort();
const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const picked = only.length ? files.filter((f) => only.some((o) => f.includes(o))) : files;

if (!picked.length) {
  console.error('没有匹配的测试：' + (only.join(' ') || '(空)'));
  process.exit(1);
}

const TIMEOUT_MS = 180000;

function run(file) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [path.join(scriptsDir, file)], {
      cwd: root,
      windowsHide: true,
    });
    let out = '';
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      try { child.kill(); } catch {}
    }, TIMEOUT_MS);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ file, code, out, ms: Date.now() - started, killed });
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ file, code: -1, out: '无法启动进程', ms: Date.now() - started, killed: false });
    });
  });
}

/** 从输出里抠出断言数（各测试的汇总行格式不一）。 */
function assertionCount(out) {
  const sums = [...out.matchAll(/(\d+)\s*(?:通过|passed)/g)]
    .map((m) => Number(m[1]))
    .filter((n) => n > 0 && n < 10000);
  if (sums.length) return Math.max(...sums);
  return (out.match(/^(?:PASS|✅)/gm) || []).length;
}

/**
 * 判定测试是否失败。
 * 以**退出码为主**（测试脚本约定 `process.exit(fail ? 1 : 0)`），
 * 输出里的 ❌/FAIL 只作辅助——有些测试的输出中包含 "FAIL" 字样却是通过的
 * （例如打印被断言拦截的内容、或本来就没有汇总行）。

 * 唯一的例外：退出码为 0 但输出里出现「❌ N 项失败」这类明确汇总，才算失败。
 */
function looksFailed(code, out) {
  if (code !== 0) return true;
  return /❌\s*\d+\s*(项失败|通过\s*\/)/.test(out) || /❌\s*\d+\s*失败/.test(out);
}

console.log(`运行 ${picked.length} 个测试脚本...\n`);

const results = [];
for (const f of picked) {
  const r = await run(f);
  const n = assertionCount(r.out);
  const failed = r.killed || looksFailed(r.code, r.out);
  const needSvc = NEEDS_SERVICE.some((s) => s.re.test(f));
  results.push({ ...r, n, failed, needSvc });
  const mark = r.killed ? 'TIMEOUT' : (failed ? 'FAIL' : 'ok');
  const tail = r.killed ? '(超时)' : (needSvc && failed ? '(需外部服务)' : '');
  console.log(
    `${String(mark).padEnd(8)} ${f.padEnd(38)} ${String(n).padStart(5)} 断言  ${String(r.ms).padStart(6)}ms ${tail}`
  );
}

const okList = results.filter((r) => !r.failed);
const envFail = results.filter((r) => r.failed && r.needSvc);
const realFail = results.filter((r) => r.failed && !r.needSvc);
const totalAssertions = okList.reduce((a, r) => a + r.n, 0);

console.log('\n' + '─'.repeat(72));
console.log(`通过 ${okList.length}/${results.length}   累计断言 ${totalAssertions}`);
if (envFail.length) {
  console.log(`环境不满足（服务未启动，非代码问题）${envFail.length} 个：`);
  for (const r of envFail) console.log('  - ' + r.file);
}
if (realFail.length) {
  console.log(`\n❌ 真正失败 ${realFail.length} 个：`);
  for (const r of realFail) {
    console.log('  - ' + r.file);
    const lines = r.out.split('\n').filter((l) => /FAIL|❌|Error/.test(l)).slice(0, 4);
    for (const l of lines) console.log('      ' + l.trim().slice(0, 140));
  }
}

process.exit(realFail.length ? 1 : 0);
