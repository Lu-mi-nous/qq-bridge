// 群文件归档：按类型建文件夹并把根目录文件移进去。
//
// ⚠️ 这是**写操作脚本**（不在桥接运行时里，需手动执行）：
//   - 建文件夹：加性操作，可删
//   - 移动文件：**可逆**（parent_directory/target_directory 双向），实测验证过
//   - 不删除任何文件（本脚本没有调用 delete_group_file）
//
// 为什么做成独立脚本而不是给模型的工具（2026-10-15 用户要求整理群文件）：
//   一次性归档 1162 个文件属于"批量改动既有数据"，出错影响面大。
//   独立脚本可以：先 --dry-run 预演、日志留痕、失败即停、且模型不会误触发。
//   模型侧仍只有只读工具（qq_list_group_files / qq_group_file_stats）。
//
// 用法：
//   node scripts/archive-group-files.mjs --group 100002004 --dry-run    # 预演（默认）
//   node scripts/archive-group-files.mjs --group 100002004 --apply      # 真正执行
//   node scripts/archive-group-files.mjs --group 100002004 --apply --only 文档,图片   # 只归档指定分类
//
// 安全设计：
//   - 默认 dry-run，必须显式 --apply 才真改
//   - 每步失败即停（不留"移了一半"的混乱状态），并打印已完成的进度便于人工继续
//   - 只移动根目录的文件（不碰已存在于文件夹里的）
//   - 归档进度写 state/group-archive-log.json（含 file_id → 目标文件夹），便于回溯与撤销
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { normalizeEntries, humanSize, CATEGORY_ORDER } from '../src/group-files.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOG_FILE = path.join(ROOT, 'state', 'group-archive-log.json');

function parseArgs(argv) {
  const out = { group: '', dryRun: true, only: null, limit: 0, sleepMs: 350 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--group') out.group = String(argv[++i] ?? '').trim();
    else if (a === '--apply') out.dryRun = false;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--only') out.only = String(argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--limit') out.limit = Number(argv[++i]) || 0;
    else if (a === '--sleep') out.sleepMs = Math.max(0, Number(argv[++i]) || 0);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!/^\d+$/.test(args.group)) {
  console.error('用法: node scripts/archive-group-files.mjs --group <群号> [--apply] [--only 文档,图片] [--limit N]');
  process.exit(1);
}

const httpBase = (() => {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
    return String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
  } catch { return 'http://127.0.0.1:3000'; }
})();

async function call(action, params, timeoutMs = 30000) {
  const r = await fetch(`${httpBase}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const j = await r.json();
  if (j?.status !== 'ok' || j?.retcode !== 0) {
    throw new Error(`${action} 失败: ${j?.wording || j?.retcode} ${JSON.stringify(j).slice(0, 200)}`);
  }
  return j.data;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const gid = Number(args.group);
  console.log(`群 ${gid}｜模式：${args.dryRun ? '预演（不改动）' : '★ 实际执行 ★'}`);
  console.log('');

  // 读根目录现状
  const root = await call('get_group_root_files', { group_id: gid });
  const files = root.files ?? [];
  const existingFolders = root.folders ?? [];
  const { entries } = normalizeEntries(files);
  console.log(`根目录：${entries.length} 个文件，${existingFolders.length} 个已存在文件夹`);
  if (existingFolders.length) {
    console.log('  已存在的文件夹（将复用同名，不重复创建）：');
    for (const f of existingFolders) console.log(`    ${f.folder_name}  (${f.folder_id})`);
  }
  console.log('');

  // 按分类分组
  const byCat = new Map();
  for (const e of entries) {
    if (!byCat.has(e.category)) byCat.set(e.category, []);
    byCat.get(e.category).push(e);
  }
  let cats = [...byCat.entries()].sort((a, b) => b[1].length - a[1].length);
  if (args.only) cats = cats.filter(([c]) => args.only.includes(c));
  if (!cats.length) { console.log('没有需要归档的分类。'); return; }

  console.log('归档计划：');
  for (const [cat, arr] of cats) {
    const size = arr.reduce((a, e) => a + e.size, 0);
    console.log(`  ${cat.padEnd(6)} → 文件夹「${cat}」：${String(arr.length).padStart(5)} 个文件，${humanSize(size)}`);
  }
  console.log('');

  if (args.dryRun) {
    console.log('（预演模式，未做任何改动。加 --apply 才是真正执行）');
    return;
  }

  // ── 实际执行 ───────────────────────────────────────────────────────────────
  const log = { group: gid, startedAt: new Date().toISOString(), folders: {}, moved: [] };
  let movedCount = 0, failedCount = 0;

  for (const [cat, arr] of cats) {
    // 复用同名文件夹，避免重复创建
    let folderId = existingFolders.find((f) => f.folder_name === cat)?.folder_id;
    if (!folderId) {
      try {
        const created = await call('create_group_file_folder', { group_id: gid, name: cat, parent_id: '/' });
        folderId = created?.groupItem?.folderInfo?.folderId || created?.folderInfo?.folderId;
        if (!folderId) throw new Error('创建成功但未返回 folderId：' + JSON.stringify(created).slice(0, 200));
        console.log(`[建文件夹] ${cat} → ${folderId}`);
      } catch (error) {
        console.error(`✗ 建文件夹失败（${cat}）：${error.message}`);
        console.error('  已停止，避免留下部分归档的混乱状态。');
        console.error(`  已完成：${movedCount} 个文件。可修好后重跑（已归位的会被自动跳过）。`);
        break;
      }
      await sleep(args.sleepMs);
    } else {
      console.log(`[复用文件夹] ${cat} → ${folderId}`);
    }
    log.folders[cat] = folderId;

    const targets = args.limit ? arr.slice(0, args.limit) : arr;
    for (const e of targets) {
      try {
        await call('move_group_file', {
          group_id: gid,
          file_id: e.fileId,
          parent_directory: '/',
          target_directory: folderId,
        });
        movedCount += 1;
        log.moved.push({ file: e.name, category: cat, fileId: e.fileId, folder: folderId });
        if (movedCount % 25 === 0) console.log(`  …已移动 ${movedCount} 个`);
      } catch (error) {
        failedCount += 1;
        console.error(`  ✗ 移动失败：${e.name} — ${error.message}`);
        // 单个失败不中断（可能是别人正在下载/权限问题），继续；末尾汇总
      }
      if (args.sleepMs) await sleep(args.sleepMs);
    }
  }

  log.finishedAt = new Date().toISOString();
  log.summary = { moved: movedCount, failed: failedCount };
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  fs.writeFileSync(LOG_FILE, JSON.stringify(log, null, 2), 'utf8');

  console.log('');
  console.log(`完成：移动 ${movedCount} 个，失败 ${failedCount} 个`);
  console.log(`日志：${LOG_FILE}（含每个文件的目标文件夹，可用于回溯/撤销）`);
}

main().catch((error) => {
  console.error('执行出错：', error?.message ?? error);
  process.exit(1);
});
