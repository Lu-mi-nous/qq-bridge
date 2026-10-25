// 缓存盘点与清理（控制台 19「磁盘缓存」）。
//
// 需求（2026-10-22 用户）：「全部做完后注意清理 C 盘缓存，并且控制台中给出对应功能卡片」。
// 2026-10-22 二次重写：用户反馈「还有没列出的可删除项」——原清单只覆盖 7 项，
// 漏掉了 X 媒体、表情临时目录、测试截图、旧菜单备份、进程临时文件等一整批。
// 现在按**分组**列出全部可清项，并把大块"不能删但要让人知道"的占用也列出来。
//
// ── 原则：只删"能重新生成的东西"，且必须让用户看见删了什么 ──────────
//
// 磁盘清理最怕两件事：① 删了还要用的（语音模型、图库、会话历史）；② 删了但没人知道。
// 所以：
//   - 每项都有 `kind`：`safe`（纯缓存/临时文件，删了自动重建或本来就该清）/
//     `keep`（只在界面展示占用，不参与清理）；
//   - 每项都有 `group`，界面按组分区展示，避免一长串平铺；
//   - 清理前算体积，清理后回报**实际释放量**，不虚报；
//   - 只碰本模块列出的路径/前缀，不做全盘通配（防止误伤别的目录）。
//
// ── C 盘为什么单独关注 ─────────────────────────────────────────────
//
// 项目在 E:，但运行时大头都在 C: 用户目录：
//   - `%TEMP%\ghshot-*` / `conshot-*`：每次截图起一个 headless Chrome，每个 profile
//     几 MB~几十 MB，退出后目录不保证被清（强杀时必残留）。实测可积 180MB+。
//   - `%TEMP%\qq-ds-* / qq-up-* / qq-pub-* / qqgif-* / bili-* / qqb-sticker-*`：
//     缩图/超分/GIF 抽帧/语音转写/表情解析的中间文件，正常会删，异常退出会留。
//   - `~/.cache/huggingface`：底模下载缓存。
//   - `~/.dsh/sessions`：**不是缓存**（对话历史），只展示占用。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = process.env.USERPROFILE || process.env.HOME || os.homedir();
const TEMP = os.tmpdir();

/** 分组（顺序即界面顺序）。 */
export const CACHE_GROUPS = [
  { id: 'chat', label: '聊天与媒体缓存' },
  { id: 'render', label: '渲染与报表缓存' },
  { id: 'temp', label: '临时文件（C 盘）' },
  { id: 'dev', label: '开发与测试残留' },
  { id: 'keep', label: '保留（只展示，不参与清理）' }
];

/** 目录/文件体积（递归，失败返回 0，绝不抛）。 */
export function sizeOf(target) {
  let total = 0;
  let count = 0;
  const walk = (p, depth) => {
    if (depth > 6) return;
    let st;
    try { st = fs.statSync(p); } catch { return; }
    if (st.isFile()) { total += st.size; count += 1; return; }
    if (!st.isDirectory()) return;
    let ents;
    try { ents = fs.readdirSync(p); } catch { return; }
    for (const e of ents) walk(path.join(p, e), depth + 1);
  };
  walk(target, 0);
  return { bytes: total, files: count };
}

/** 列出某目录下名称匹配 predicate 的条目（返回绝对路径）。 */
function listMatching(dir, predicate) {
  let ents;
  try { ents = fs.readdirSync(dir); } catch { return []; }
  return ents.filter(predicate).map((n) => path.join(dir, n));
}

/** 按前缀列出。 */
function listByPrefix(dir, prefixes) {
  return listMatching(dir, (n) => prefixes.some((p) => n.startsWith(p)));
}

/**
 * 缓存清单。
 *
 * @param {object} opts
 *   - root             项目根目录
 *   - ttsDir           GPT-SoVITS 目录（可选，仅用于展示模型占用）
 *   - collectedDir     收藏原图目录（默认 <root>/collected）
 *   - dshSessionsDir   DSH 会话目录（默认 ~/.dsh/sessions）
 * @returns {Array<{key,label,kind,group,paths,bytes,files,note}>}
 */
export function collectCacheItems(opts = {}) {
  const root = String(opts.root || process.cwd());
  const state = path.join(root, 'state');
  const collected = String(opts.collectedDir || path.join(root, 'collected'));
  const dshSessions = String(opts.dshSessionsDir || path.join(HOME, '.dsh', 'sessions'));
  const items = [];

  const add = (key, group, kind, label, paths, note) => {
    const uniq = [...new Set(paths)].filter((p) => {
      try { return fs.existsSync(p); } catch { return false; }
    });
    let bytes = 0;
    let files = 0;
    for (const p of uniq) {
      const s = sizeOf(p);
      bytes += s.bytes;
      files += s.files;
    }
    items.push({ key, group, kind, label, paths: uniq, bytes, files, note });
  };

  // ── 聊天与媒体缓存 ────────────────────────────────────────────────
  add('ttsCache', 'chat', 'safe', '语音缓存（合成的 wav）',
    [path.join(state, 'tts-cache')],
    '同句再次合成会重新生成；删除后第一条语音会慢 1~3 秒');

  add('xMediaCache', 'chat', 'safe', 'X（推特）媒体缓存',
    [path.join(state, 'x-monitor-media')],
    '按需拉取的推文图片/视频，有 TTL 自动清理；删了下一次查询重新下载');

  add('xHandoff', 'chat', 'safe', 'X 发图临时中转',
    [path.join(state, 'x-monitor')],
    '发 X 截图时的临时文件，正常情况下 60 秒后自删；异常退出会残留');

  add('stickerCache', 'chat', 'safe', '表情解析缓存',
    [path.join(state, 'sticker-cache')],
    '下载/解析过的表情图片中间文件，可重新获取');

  add('reverseSearchCache', 'chat', 'safe', '反向搜图结果缓存',
    [path.join(state, 'reverse-search-cache.json')],
    'SauceNAO 查询结果缓存，删了下次重新查');

  // ── 渲染与报表缓存 ────────────────────────────────────────────────
  add('reportCache', 'render', 'safe', 'Token 报表图',
    [path.join(state, 'token-report')],
    '按内容指纹缓存；删了下一次生成会重新渲染（约 3 秒）');

  add('menuCache', 'render', 'safe', '功能菜单图',
    [path.join(state, 'feature-menu')],
    '群友问"你会啥"时重新渲染（约 2 秒）');

  add('upscaleCache', 'render', 'safe', '超分缓存',
    [path.join(state, 'upscale-cache')],
    '超分结果，重算较慢（每张几秒）；按天数与总量上限自动清理');

  add('menuBackup', 'render', 'safe', '功能菜单旧版本备份',
    listByPrefix(state, ['feature-menu-update-backup-']),
    '改菜单样式时自动留的旧版备份，确认新版没问题后可删');

  // ── 临时文件（C 盘）──────────────────────────────────────────────
  add('chromeTemp', 'temp', 'safe', '截图临时目录（Chrome profile）',
    listMatching(TEMP, (n) => n.startsWith('ghshot-') || n.startsWith('conshot-')),
    '每次截图起一个 headless Chrome，退出后目录不一定被清；实测可积到 180MB+');

  add('processTemp', 'temp', 'safe', '媒体处理临时文件',
    listMatching(TEMP, (n) => /^(qq-ds-|qq-up-|qq-pub-|qqgif-|biliasr-|bili-[a-z0-9]{6,}|qqb-sticker-)/i.test(n)),
    '缩图/超分/GIF 抽帧/语音转写/表情解析的中间文件，异常退出会残留');

  add('deployTemp', 'temp', 'safe', '部署残留压缩包',
    listByPrefix(TEMP, ['G2PWModel.zip', 'G2PW2.zip']),
    '安装语音引擎时下载的压缩包，解压后无用');

  add('hfCache', 'temp', 'safe', 'HuggingFace 下载缓存（C 盘）',
    [path.join(HOME, '.cache', 'huggingface')],
    '底模已落到 GPT-SoVITS 目录后可删；再下载时会重新拉取');

  // ── 开发与测试残留 ───────────────────────────────────────────────
  add('testRuns', 'dev', 'safe', '测试运行残留目录',
    ['local-e2e', 'local-provider-test', 'self-test', 'vision-e2e', 'tmp-effort-test']
      .map((d) => path.join(state, d)),
    '端到端/视觉/模型自检留下的工作目录，可安全删除');

  add('devShots', 'dev', 'safe', '调试截图',
    listMatching(state, (n) => /\.(png|jpe?g)$/i.test(n)
      && /^(console-shot|card-hover|cloth|wave|sphere|globe|snowluma-login)/i.test(n)),
    '改 UI / 调背景时留下的对比截图，不影响运行');

  // ── 保留（只展示占用）────────────────────────────────────────────
  if (opts.ttsDir) {
    add('ttsModels', 'keep', 'keep', '语音模型（GPT-SoVITS）',
      [String(opts.ttsDir)],
      '删了要重新下载 3GB+ 并重装依赖；不属于缓存，不参与清理');
  }
  add('imageLib', 'keep', 'keep', '图库',
    [path.join(state, 'image-lib')],
    '下载的图，删了要重新拉；不清');
  add('slangLib', 'keep', 'keep', '黑话库',
    [path.join(state, 'slang.json')],
    'AI 学到的群聊黑话，删了会丢掉已积累的词条');
  add('biliMemory', 'keep', 'keep', 'B 站观看记忆',
    [path.join(state, 'bili-memory.json')],
    '它的"口味"全靠这个文件，不清');
  add('contextState', 'keep', 'keep', '情节记忆 / 会话摘要',
    [path.join(state, 'context')],
    '上下文持久化数据（Phase 0/1），删了会丢长期记忆');
  add('dshSessions', 'keep', 'keep', 'DSH 会话历史（C 盘）',
    [dshSessions],
    '模型对话的原始转录，不是缓存；删了会丢上下文，只能在 DSH 侧清理');
  add('collected', 'keep', 'keep', '收藏的原图',
    [collected],
    '群友要求保存的原图，删了找不回');

  return items;
}

/** 汇总（给界面显示一行总计）。 */
export function summarizeCache(items) {
  const safe = items.filter((x) => x.kind === 'safe');
  return {
    safeBytes: safe.reduce((a, x) => a + x.bytes, 0),
    totalBytes: items.reduce((a, x) => a + x.bytes, 0),
    safeFiles: safe.reduce((a, x) => a + x.files, 0),
    safeCount: safe.length
  };
}

/**
 * 执行清理。
 *
 * @param {Array} items collectCacheItems() 的结果
 * @param {object} opts
 *   - keys     要清理的 key 列表；省略 = 全部 `safe` 项
 *   - dryRun   只算不删
 * @returns {{freedBytes:number, removed:number, details:Array}}
 */
export function purgeCache(items, opts = {}) {
  const wantKeys = Array.isArray(opts.keys) && opts.keys.length ? new Set(opts.keys) : null;
  const dryRun = opts.dryRun === true;
  let freedBytes = 0;
  let removed = 0;
  const details = [];

  for (const item of items) {
    // **只清 safe**：keep 项（模型/图库/记忆/会话）无论选没选都不动。
    // 这不是防御性编程，是防止将来有人把 keep 项也传进来造成不可逆损失。
    if (item.kind !== 'safe') continue;
    if (wantKeys && !wantKeys.has(item.key)) continue;
    if (!item.paths.length) continue;

    let bytes = 0;
    let count = 0;
    for (const p of item.paths) {
      const s = sizeOf(p);
      bytes += s.bytes;
      count += s.files;
      if (dryRun) continue;
      try {
        fs.rmSync(p, { recursive: true, force: true });
      } catch {
        // 单个删不掉（被占用）不该中断整体，但要记账为未删除
      }
    }
    if (!dryRun) {
      // 重新核算实际释放量：删失败的部分不该算进去（不虚报）
      let remain = 0;
      for (const p of item.paths) {
        try { if (fs.existsSync(p)) remain += sizeOf(p).bytes; } catch {}
      }
      const actual = Math.max(0, bytes - remain);
      freedBytes += actual;
      removed += count;
      details.push({ key: item.key, label: item.label, bytes: actual, files: count, ok: remain === 0 });
    } else {
      freedBytes += bytes;
      removed += count;
      details.push({ key: item.key, label: item.label, bytes, files: count, dryRun: true });
    }
  }
  return { freedBytes, removed, details, dryRun };
}

/** 人话体积。 */
export function humanBytes(n) {
  const v = Number(n) || 0;
  if (v >= 1024 ** 3) return `${(v / 1024 ** 3).toFixed(2)}GB`;
  if (v >= 1024 ** 2) return `${(v / 1024 ** 2).toFixed(1)}MB`;
  if (v >= 1024) return `${(v / 1024).toFixed(0)}KB`;
  return `${v}B`;
}
