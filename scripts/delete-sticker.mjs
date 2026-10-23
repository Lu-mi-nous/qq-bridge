// 删除收藏表情（收藏表情 / QQ 自定义表情）。
//
// ⚠️ 这是**写操作脚本**，需手动执行；模型侧没有这个能力（与群文件一致的安全立场）。
//
// 为什么做成脚本而不是给模型的工具（2026-10-15）：
//   实测 `delete_custom_face` **不校验 emoji_id** —— 我传一个假值 "0"，
//   它返回 status=ok 并**真删掉了一个表情**（这次误删由我造成，已用本地库 URL 恢复）。
//   既然参数无效也能触发删除，就不能交给模型自由调用：模型传错 ID 时会静默删掉
//   别的表情，而它以为删的是目标那个。
//
// 安全设计：
//   - 默认 dry-run，必须显式 --apply 才真删
//   - **删前强制备份**：把要删的条目完整写进 state/stickers-deleted-<时间>.json，
//     含 url/md5/desc/备注，便于用 --restore 一键恢复
//   - 必须用完整 emoji_id 精确指定（支持 --md5 前缀匹配，但会列出全部命中让你确认）
//   - 每删一个都回读校验（因为对方不校验参数，只能自己验）
//
// 用法：
//   # 看有哪些表情（含 md5 便于指定）
//   node scripts/delete-sticker.mjs --list
//
//   # 预演（默认，不删）：按备注关键词
//   node scripts/delete-sticker.mjs --match 兔玩偶
//   # 按 md5 前缀
//   node scripts/delete-sticker.mjs --md5 BB84A8C8
//
//   # 真删（会先备份）
//   node scripts/delete-sticker.mjs --md5 BB84A8C8 --apply
//
//   # 从备份恢复
//   node scripts/delete-sticker.mjs --restore state/stickers-deleted-2026-10-15T....json
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STICKER_FILE = path.join(ROOT, 'state', 'stickers.json');

function parseArgs(argv) {
  const out = { list: false, match: '', md5: '', apply: false, restore: '', emojiId: '', limit: 0 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--list') out.list = true;
    else if (a === '--match') out.match = String(argv[++i] ?? '').trim();
    else if (a === '--md5') out.md5 = String(argv[++i] ?? '').trim().toUpperCase();
    else if (a === '--emoji-id') out.emojiId = String(argv[++i] ?? '').trim();
    else if (a === '--restore') out.restore = String(argv[++i] ?? '').trim();
    else if (a === '--limit') out.limit = Number(argv[++i]) || 0;
    else if (a === '--apply') out.apply = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const httpBase = (() => {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
    return String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
  } catch { return 'http://127.0.0.1:3000'; }
})();

async function call(action, params, timeoutMs = 60000) {
  const r = await fetch(`${httpBase}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return r.json();
}

function loadLocal() {
  try {
    const j = JSON.parse(fs.readFileSync(STICKER_FILE, 'utf8'));
    return Array.isArray(j) ? j : (j.items ?? j.stickers ?? []);
  } catch { return []; }
}

/** 拉取 QQ 侧当前收藏（分页取全）。 */
async function fetchQqFaces() {
  const all = [];
  for (let i = 0; i < 20; i++) {
    const j = await call('fetch_custom_face', { count: 50, start: all.length });
    const d = j?.data;
    if (!Array.isArray(d) || !d.length) break;
    all.push(...d);
    if (d.length < 50) break;
  }
  const md5Of = (u) => {
    const m = /_0_0_0_([A-Fa-f0-9]+)_/.exec(String(u));
    return m ? m[1].toUpperCase() : '';
  };
  return all.map((u) => ({ url: String(u), md5: md5Of(u) })).filter((x) => x.md5);
}

async function cmdList() {
  const local = loadLocal();
  const qq = await fetchQqFaces();
  const qqSet = new Set(qq.map((x) => x.md5));
  console.log(`QQ 侧收藏 ${qq.length} 个｜本地库 ${local.length} 条\n`);
  console.log('md5(前8位)  用过  状态      备注');
  for (const e of local.slice().sort((a, b) => String(a.md5).localeCompare(String(b.md5)))) {
    const m = String(e.md5 || '').toUpperCase();
    const inQq = qqSet.has(m) ? '正常' : '⚠️QQ侧已无';
    console.log(`${m.slice(0, 8)}     ${String(e.useCount ?? 0).padStart(3)}  ${inQq.padEnd(9)} ${e.desc || e.localNote || '(无备注)'}`);
  }
}

/** 按条件挑出目标（返回 {entries, missing}）。 */
function pickTargets() {
  const local = loadLocal();
  let hit = [];
  if (args.emojiId) {
    hit = local.filter((e) => String(e.id) === args.emojiId || String(e.resId) === args.emojiId);
  } else if (args.md5) {
    hit = local.filter((e) => String(e.md5 || '').toUpperCase().startsWith(args.md5));
  } else if (args.match) {
    const kw = args.match.toLowerCase();
    hit = local.filter((e) => String(e.desc || '').toLowerCase().includes(kw) || String(e.localNote || '').toLowerCase().includes(kw));
  }
  if (args.limit > 0) hit = hit.slice(0, args.limit);
  return hit;
}

async function cmdDelete() {
  const targets = pickTargets();
  if (!targets.length) {
    console.log('没有匹配的表情。用 --list 看清单，或用 --md5 / --match 指定。');
    return;
  }
  console.log(`匹配 ${targets.length} 个：`);
  for (const e of targets) {
    console.log(`  ${String(e.md5).slice(0, 8)}  ${e.desc || e.localNote || '(无备注)'}  (用过 ${e.useCount ?? 0} 次)`);
  }
  console.log('');

  if (!args.apply) {
    console.log('（预演模式，未删除。加 --apply 才真删；删前会自动备份）');
    return;
  }

  // 删前备份：完整存下可恢复所需的字段
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupFile = path.join(ROOT, 'state', `stickers-deleted-${stamp}.json`);
  fs.writeFileSync(backupFile, JSON.stringify({ deletedAt: new Date().toISOString(), entries: targets }, null, 2), 'utf8');
  console.log(`已备份 ${targets.length} 条 → ${path.basename(backupFile)}`);

  let ok = 0, bad = 0;
  for (const e of targets) {
    const emojiId = String(e.id || e.resId || '');
    if (!emojiId) { console.error(`  ✗ 缺少 emoji_id，跳过：${e.desc || e.md5}`); bad += 1; continue; }
    try {
      const res = await call('delete_custom_face', { emoji_id: emojiId });
      if (res?.status !== 'ok' || res?.retcode !== 0) throw new Error(res?.wording || `retcode=${res?.retcode}`);
      ok += 1;
      console.log(`  ✓ 已删 ${String(e.md5).slice(0, 8)}  ${e.desc || ''}`);
    } catch (error) {
      bad += 1;
      console.error(`  ✗ 删除失败 ${String(e.md5).slice(0, 8)}：${error?.message ?? error}`);
    }
    await new Promise((r) => setTimeout(r, 400));
  }

  // 回读校验：接口不校验参数，只能自己确认结果
  const after = await fetchQqFaces();
  const gone = targets.filter((e) => !after.some((x) => x.md5 === String(e.md5).toUpperCase()));
  console.log('');
  console.log(`删除完成：请求 ${targets.length}，成功 ${ok}，失败 ${bad}`);
  console.log(`回读校验：确认已消失 ${gone.length} 个（QQ 侧现有 ${after.length} 个）`);
  if (gone.length !== targets.length) {
    console.log('⚠️ 有目标仍在 QQ 侧，可能未真正删除。用 --list 复核。');
  }
  console.log(`如需恢复：node scripts/delete-sticker.mjs --restore ${path.basename(backupFile)}`);
}

async function cmdRestore() {
  // 备份默认落在 state/ 下，而用法示例里传的是裸文件名（basename）。
  // 所以按「绝对路径 → 项目根 → state/」依次找，避免用户必须写全相对路径。
  const candidates = path.isAbsolute(args.restore)
    ? [args.restore]
    : [path.join(ROOT, args.restore), path.join(ROOT, 'state', args.restore)];
  const p = candidates.find((f) => fs.existsSync(f));
  if (!p) { console.error('备份文件不存在，找过：' + candidates.join(' | ')); return; }
  const bak = JSON.parse(fs.readFileSync(p, 'utf8'));
  const entries = bak?.entries ?? [];
  console.log(`从备份恢复 ${entries.length} 个表情（备份于 ${bak.deletedAt || '?'}）`);
  let ok = 0, bad = 0;
  for (const e of entries) {
    if (!e.url) { console.error('  ✗ 无 url，无法恢复：' + (e.desc || e.md5)); bad += 1; continue; }
    try {
      const r = await fetch(e.url, { signal: AbortSignal.timeout(30000) });
      if (!r.ok) throw new Error(`下载失败 HTTP ${r.status}`);
      const buf = Buffer.from(await r.arrayBuffer());
      if (!buf.length) throw new Error('下载到空内容');
      const res = await call('add_custom_face', { file: 'base64://' + buf.toString('base64') });
      if (res?.status !== 'ok' || res?.retcode !== 0) throw new Error(res?.wording || `retcode=${res?.retcode}`);
      const gotId = String(res?.data?.emoji_id || '');
      const sameMd5 = gotId.toUpperCase().includes(String(e.md5).toUpperCase());
      ok += 1;
      console.log(`  ✓ 已恢复 ${String(e.md5).slice(0, 8)}  ${e.desc || ''}${sameMd5 ? '' : '（注意：md5 与备份不同）'}`);
    } catch (error) {
      bad += 1;
      console.error(`  ✗ 恢复失败 ${String(e.md5).slice(0, 8)}：${error?.message ?? error}`);
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  console.log(`\n恢复完成：成功 ${ok}，失败 ${bad}`);
}

async function main() {
  if (args.restore) return cmdRestore();
  if (args.list) return cmdList();
  if (args.match || args.md5 || args.emojiId) return cmdDelete();
  console.log('用法：');
  console.log('  node scripts/delete-sticker.mjs --list                     # 列出收藏（含 md5）');
  console.log('  node scripts/delete-sticker.mjs --match <备注关键词>        # 预演要删哪些');
  console.log('  node scripts/delete-sticker.mjs --md5 <md5前几位> --apply   # 真删（自动备份）');
  console.log('  node scripts/delete-sticker.mjs --restore <备份文件>        # 从备份恢复');
}

main().catch((e) => { console.error('执行出错：', e?.message ?? e); process.exit(1); });
