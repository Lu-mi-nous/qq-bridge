// prune-dsh-sessions.mjs — 清理 DSH 会话残留，给内存/磁盘减负
//
// 背景（2026-10-12 排查内存占用）：
//   实测 DSH（:3080）稳态占 **1055 MB**，而桥接 + 3 个 MCP 子进程合计仅约 275 MB
//   —— 内存大头在 DSH，不在桥接代码里。DSH 的内存主要来自**活跃会话的累积上下文**：
//   当时 7 个活跃会话的转录合计 111 MB（zstd 压缩后，解压约 4 倍）。
//
//   另外磁盘上积压了 165 个**调试用的一次性会话**（scripts/ 那些 e2e/slang 测试留下的），
//   占 39 MB。它们不属于任何活跃会话，删掉不影响运行。
//
// 用法：
//   node scripts/prune-dsh-sessions.mjs            只看（dry-run，默认）
//   node scripts/prune-dsh-sessions.mjs --apply    真删
//   node scripts/prune-dsh-sessions.mjs --apply --older-than 30   只删 30 天前的
//
// 安全设计：
//   ① **默认 dry-run**，必须显式 --apply 才动手（删的是历史数据，不可逆）。
//   ② 与 state/sessions.json 里的**活跃会话 id 对比**，命中则跳过（绝不删正在用的会话）。
//   ③ 只清理「测试工作区」的会话（cwd 含 state-*-test / state-local-* / state-slang-* 等），
//      **不动真实群聊会话**（含 state/agents）。这条最关键——真实会话删了会丢历史。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const APPLY = process.argv.includes('--apply');
const OLDER_DAYS = (() => {
  const i = process.argv.indexOf('--older-than');
  if (i < 0) return 0;
  const n = Number(process.argv[i + 1]);
  return Number.isFinite(n) && n > 0 ? n : 0;
})();

const ROOT = process.cwd();
const SESS_BASE = path.join(os.homedir(), '.dsh', 'sessions');

// 只认这些「测试/调试工作区」前缀——它们的会话可以删。
// 真实群聊会话在 `-state-agents--` 下，**不在**此列表里。
const TEST_WORKSPACE_PATTERNS = [
  /-state-agents-.*$/,
  /-state-local-e2e--$/,
  /-state-local-provider-test--$/,
  /-state-self-test--$/,
  /-state-slang-agent--$/,
  /-state-vision-e2e--$/,
  /-state-tmp-[a-z-]*--$/
];

// ⚠️ 例外：-state-agents-- 是**真实群聊会话**，绝不能按上面的模式删（上面第一条只是为了
// 让"哪些属于 C:\qq-bridge"这一类能整体识别出来，实际删除时要排除它）。
const NEVER_DELETE_PATTERNS = [/-state-agents--$/];

function isTestWorkspace(name) {
  if (NEVER_DELETE_PATTERNS.some((re) => re.test(name))) return false;
  return TEST_WORKSPACE_PATTERNS.some((re) => re.test(name));
}

function activeSessionIds() {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(ROOT, 'state', 'sessions.json'), 'utf8'));
    return new Set(Object.values(s.sessions || {}).map((x) => String(x)));
  } catch {
    return new Set();
  }
}

function dirSize(p) {
  let bytes = 0;
  const walk = (x) => {
    let entries = [];
    try { entries = fs.readdirSync(x, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const q = path.join(x, e.name);
      if (e.isDirectory()) walk(q);
      else { try { bytes += fs.statSync(q).size; } catch {} }
    }
  };
  walk(p);
  return bytes;
}

if (!fs.existsSync(SESS_BASE)) {
  console.log(`没有找到 ${SESS_BASE}`);
  process.exit(0);
}

const active = activeSessionIds();
const cutoff = OLDER_DAYS > 0 ? Date.now() - OLDER_DAYS * 86400 * 1000 : 0;

console.log(`模式：${APPLY ? '真删 (--apply)' : 'dry-run（只列不删，加 --apply 执行）'}`);
if (OLDER_DAYS) console.log(`只处理 ${OLDER_DAYS} 天前的会话`);
console.log(`活跃会话 id：${active.size} 个（这些一律跳过）\n`);

let removedDirs = 0, removedBytes = 0, skippedActive = 0, skippedNew = 0;
const groups = [];

for (const ws of fs.readdirSync(SESS_BASE)) {
  if (!isTestWorkspace(ws)) continue;
  const wsDir = path.join(SESS_BASE, ws);
  let stat;
  try { stat = fs.statSync(wsDir); } catch { continue; }
  if (!stat.isDirectory()) continue;

  for (const sub of fs.readdirSync(wsDir)) {
    if (!sub.startsWith('session-')) continue;
    const sid = sub.replace(/^session-/, '');
    const full = path.join(wsDir, sub);
    if (active.has(sid)) { skippedActive += 1; continue; }
    if (cutoff) {
      let mt = 0;
      try { mt = fs.statSync(full).mtimeMs; } catch {}
      if (mt > cutoff) { skippedNew += 1; continue; }
    }
    const size = dirSize(full);
    removedDirs += 1;
    removedBytes += size;
    if (APPLY) {
      try { fs.rmSync(full, { recursive: true, force: true }); } catch (e) { console.log(`  删除失败 ${sub}: ${e.message}`); }
    }
    if (!groups.some((g) => g.ws === ws)) groups.push({ ws, n: 0, bytes: 0 });
    const g = groups.find((x) => x.ws === ws);
    g.n += 1; g.bytes += size;
  }
}

console.log('按工作区统计：');
for (const g of groups.sort((a, b) => b.bytes - a.bytes)) {
  console.log(`  ${(g.bytes / 1048576).toFixed(1).padStart(7)} MB  ${String(g.n).padStart(4)} 个  ${g.ws}`);
}
console.log(`\n合计：${removedDirs} 个会话目录，${(removedBytes / 1048576).toFixed(1)} MB`);
console.log(`已跳过：活跃会话 ${skippedActive} 个${skippedNew ? `，未到期 ${skippedNew} 个` : ''}`);
if (!APPLY && removedDirs) console.log('\n（dry-run 未改动任何文件；确认后加 --apply 执行）');
if (APPLY && removedDirs) console.log('\n✅ 已清理。若 DSH 正在运行，重启它才会释放对应的内存。');
