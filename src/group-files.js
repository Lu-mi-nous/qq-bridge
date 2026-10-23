// 群文件只读分类：把 OneBot 返回的文件列表整理成"人看得懂、模型能用"的结构。
//
// 背景（2026-10-15 用户要求「让机器人访问群文件并且整理一下，先做只读分类」）：
// 群文件 API 实测可用（`get_group_root_files` 返回 1161 个文件、6.98GB、跨 6 年）。
// 但原始列表字段平淡（file_name/file_size/upload_time/uploader_name），
// 直接丢给模型既超长又看不出结构——需要先归类、聚合、排序。
//
// **本模块只做只读整理**：不删除、不移动、不上传、不改名。
// 写操作 API（delete_group_file 等）确实存在且会真实执行（已实测），
// 但那是高危能力，未纳入本模块——群文件里的 docx/pdf 删了不可恢复。
//
// 纯函数（无网络、无 IO），便于离线回归测试。

/** 扩展名 → 分类。按「用户找文件时会怎么想」分组，不按 MIME 教科书分类。 */
const EXT_CATEGORY = {
  // 图片
  jpg: '图片', jpeg: '图片', png: '图片', gif: '图片', webp: '图片', bmp: '图片', heic: '图片', svg: '图片',
  // 文档（可阅读的资料，群文件里最主要的一类）
  pdf: '文档', doc: '文档', docx: '文档', ppt: '文档', pptx: '文档', xls: '文档', xlsx: '文档',
  txt: '文档', md: '文档', csv: '文档', epub: '文档', mobi: '文档', azw3: '文档',
  // 音视频
  mp4: '音视频', mkv: '音视频', avi: '音视频', mov: '音视频', flv: '音视频', wmv: '音视频', webm: '音视频',
  mp3: '音视频', wav: '音视频', flac: '音视频', m4a: '音视频', aac: '音视频', ogg: '音视频', rmvb: '音视频',
  // 压缩包
  zip: '压缩包', rar: '压缩包', '7z': '压缩包', tar: '压缩包', gz: '压缩包', bz2: '压缩包', xz: '压缩包',
  // 程序（可执行文件，注意来源可信度）
  exe: '程序', msi: '程序', apk: '程序', dmg: '程序', deb: '程序', rpm: '程序', bat: '程序', sh: '程序',
  // 代码/工程
  js: '代码', ts: '代码', py: '代码', java: '代码', c: '代码', cpp: '代码', h: '代码', go: '代码',
  rs: '代码', json: '代码', xml: '代码', yml: '代码', yaml: '代码', html: '代码', css: '代码',
  java2: '代码',
  // 其他常见但值得单列
  torrent: '种子', mcworld: '游戏存档', ipa: '程序', vsix: '程序', psd: '素材', ai: '素材',
  sketch: '素材', fig: '素材', blend: '素材',
};

/** 分类展示顺序：把群里最常找的放前面。 */
export const CATEGORY_ORDER = ['文档', '图片', '音视频', '压缩包', '程序', '代码', '素材', '种子', '游戏存档', '其他'];

/**
 * 取文件扩展名（小写、不含点）。
 *
 * 特殊处理：QQ 会把**不允许直接传输的类型**改名加 `.1` 后缀（实测群里
 * `base.apk.1`、`apk-release.apk.1`），所以 `.1`/`.2` 这类纯数字尾巴要剥掉再判断，
 * 否则它们全被归进"其他"，而实际上都是 apk。
 */
export function extOf(fileName) {
  let name = String(fileName ?? '').trim();
  if (!name) return '';
  // 剥掉 QQ 加的 .1 / .2 之类纯数字后缀（可叠加）
  while (/\.\d{1,2}$/.test(name)) name = name.replace(/\.\d{1,2}$/, '');
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(name);
  return m ? m[1].toLowerCase() : '';
}

/** 文件 → 分类名。 */
export function categoryOf(fileName) {
  const ext = extOf(fileName);
  if (!ext) return '其他';
  return EXT_CATEGORY[ext] || '其他';
}

/** 人类可读的大小。 */
export function humanSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)}KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)}GB`;
}

/** 时间戳（秒）→ YYYY-MM-DD；非法返回空串。 */
export function dateOf(unixSeconds) {
  const t = Number(unixSeconds);
  if (!Number.isFinite(t) || t <= 0) return '';
  const d = new Date(t * 1000);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 把 OneBot 的原始文件列表规范成内部条目。
 * 只保留有文件名的条目（无名条目无法展示/搜索，跳过并计数）。
 */
export function normalizeEntries(rawFiles) {
  const list = Array.isArray(rawFiles) ? rawFiles : [];
  const out = [];
  let skipped = 0;
  for (const f of list) {
    if (!f || typeof f !== 'object') { skipped += 1; continue; }
    const name = String(f.file_name ?? '').trim();
    if (!name) { skipped += 1; continue; }
    out.push({
      name,
      size: Number(f.file_size) || 0,
      uploadTime: Number(f.upload_time) || 0,
      uploader: String(f.uploader_name ?? '').trim() || '(未知)',
      uploaderId: f.uploader != null ? String(f.uploader) : '',
      busid: f.busid != null ? Number(f.busid) : undefined,
      fileId: String(f.file_id ?? ''),
      downloadTimes: Number(f.download_times) || 0,
      category: categoryOf(name),
      ext: extOf(name) || '(无扩展名)',
    });
  }
  return { entries: out, skipped };
}

/**
 * 生成分类摘要。
 * @param {Array} rawFiles OneBot 原始列表
 * @param {{topUploaders?:number, recentDays?:number, now?:number}} opts
 * @returns {object} 摘要（供模型阅读 / 控制台展示）
 */
export function summarizeGroupFiles(rawFiles, opts = {}) {
  const { entries, skipped } = normalizeEntries(rawFiles);
  const topUploaders = Number(opts.topUploaders) || 8;
  const now = Number(opts.now) || Date.now();

  const totalSize = entries.reduce((a, e) => a + e.size, 0);

  // 按分类聚合
  const byCat = new Map();
  for (const e of entries) {
    const c = byCat.get(e.category) || { category: e.category, count: 0, size: 0, exts: new Map() };
    c.count += 1;
    c.size += e.size;
    c.exts.set(e.ext, (c.exts.get(e.ext) || 0) + 1);
    byCat.set(e.category, c);
  }
  const categories = [...byCat.values()]
    .map((c) => ({
      category: c.category,
      count: c.count,
      size: c.size,
      sizeText: humanSize(c.size),
      // 该分类下最多的几个扩展名（便于"这个分类里都有些什么格式"）
      topExts: [...c.exts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([ext, n]) => `${ext}×${n}`),
    }))
    // 排序：先按预设顺序（把最常找的文档/图片放前），未列出的按数量
    .sort((a, b) => {
      const ia = CATEGORY_ORDER.indexOf(a.category);
      const ib = CATEGORY_ORDER.indexOf(b.category);
      if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
      return b.count - a.count;
    });

  // 上传者聚合
  const byUser = new Map();
  for (const e of entries) {
    const u = byUser.get(e.uploader) || { uploader: e.uploader, count: 0, size: 0 };
    u.count += 1;
    u.size += e.size;
    byUser.set(e.uploader, u);
  }
  const uploaders = [...byUser.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, topUploaders)
    .map((u) => ({ ...u, sizeText: humanSize(u.size) }));

  // 时间范围
  const times = entries.map((e) => e.uploadTime).filter((t) => t > 0).sort((a, b) => a - b);
  const timeRange = times.length
    ? { earliest: dateOf(times[0]), latest: dateOf(times[times.length - 1]), span: `${dateOf(times[0])} ~ ${dateOf(times[times.length - 1])}` }
    : null;

  // 最近上传（默认近 7 天）
  const recentDays = Number(opts.recentDays) || 7;
  const since = now - recentDays * 24 * 3600 * 1000;
  const recent = entries
    .filter((e) => e.uploadTime * 1000 >= since)
    .sort((a, b) => b.uploadTime - a.uploadTime)
    .slice(0, 15)
    .map((e) => ({ name: e.name, sizeText: humanSize(e.size), date: dateOf(e.uploadTime), uploader: e.uploader, category: e.category }));

  // 重名（可能是重复上传，用于"要不要清理"的判断依据——但本模块**只报告不清理**）
  const nameCount = new Map();
  for (const e of entries) nameCount.set(e.name, (nameCount.get(e.name) || 0) + 1);
  const dupGroups = [...nameCount.entries()].filter(([, c]) => c > 1);
  const dupTotal = dupGroups.reduce((a, [, c]) => a + (c - 1), 0);

  // 按大小排行（找大文件，通常也是"占空间"的那批）
  const largest = entries.slice().sort((a, b) => b.size - a.size).slice(0, 8)
    .map((e) => ({ name: e.name, sizeText: humanSize(e.size), date: dateOf(e.uploadTime), category: e.category }));

  return {
    total: entries.length,
    skipped,
    totalSize,
    totalSizeText: humanSize(totalSize),
    categories,
    uploaders,
    timeRange,
    recentDays,
    recent,
    duplicates: { groups: dupGroups.length, extraCopies: dupTotal, samples: dupGroups.slice(0, 8).map(([name, count]) => `${name}（${count} 份）`) },
    largest,
  };
}

/**
 * 按条件筛选文件（供"群里有没有那个 xx""有哪些 PDF"这类问题）。
 * @param {Array} rawFiles
 * @param {{keyword?:string, category?:string, ext?:string, uploader?:string, minBytes?:number, maxBytes?:number, limit?:number}} q
 */
export function searchGroupFiles(rawFiles, q = {}) {
  const { entries } = normalizeEntries(rawFiles);
  const limit = Math.min(50, Math.max(1, Number(q.limit) || 20));
  const kw = String(q.keyword ?? '').trim().toLowerCase();
  const cat = String(q.category ?? '').trim();
  const ext = String(q.ext ?? '').trim().toLowerCase().replace(/^\./, '');
  const up = String(q.uploader ?? '').trim().toLowerCase();
  const minB = Number(q.minBytes) || 0;
  const maxB = Number(q.maxBytes) || 0;

  const hit = entries.filter((e) => {
    if (kw && !e.name.toLowerCase().includes(kw)) return false;
    if (cat && e.category !== cat) return false;
    if (ext && e.ext !== ext) return false;
    if (up && !e.uploader.toLowerCase().includes(up)) return false;
    if (minB && e.size < minB) return false;
    if (maxB && e.size > maxB) return false;
    return true;
  });
  // 排序：新的在前（找文件时通常关心最近传的）
  hit.sort((a, b) => b.uploadTime - a.uploadTime);
  return {
    matched: hit.length,
    returned: Math.min(limit, hit.length),
    entries: hit.slice(0, limit).map((e) => ({
      name: e.name,
      sizeText: humanSize(e.size),
      date: dateOf(e.uploadTime),
      uploader: e.uploader,
      category: e.category,
    })),
  };
}

/**
 * 把摘要渲染成给模型看的紧凑文本。
 * 目标：模型不必自己算，直接能转述给群友；同时长度可控（不会因为 1161 个文件爆上下文）。
 */
export function formatSummary(summary, opts = {}) {
  if (!summary || !summary.total) return '这个群还没有群文件。';
  const { maxChars = 1800 } = opts;
  const lines = [];
  lines.push(`群文件共 ${summary.total} 个，合计 ${summary.totalSizeText}${summary.timeRange ? `，时间跨度 ${summary.timeRange.span}` : ''}。`);
  lines.push('');
  lines.push('【按类型】');
  for (const c of summary.categories) {
    lines.push(`- ${c.category}：${c.count} 个 / ${c.sizeText}（${c.topExts.join('、')}）`);
  }
  if (summary.uploaders.length) {
    lines.push('');
    lines.push('【按上传者】');
    for (const u of summary.uploaders) lines.push(`- ${u.uploader}：${u.count} 个 / ${u.sizeText}`);
  }
  if (summary.recent.length) {
    lines.push('');
    lines.push(`【最近 ${summary.recentDays} 天新增】`);
    for (const r of summary.recent) lines.push(`- ${r.name}（${r.sizeText}，${r.date}，${r.uploader}）`);
  }
  if (summary.largest.length) {
    lines.push('');
    lines.push('【最大的几个】');
    for (const l of summary.largest) lines.push(`- ${l.name}（${l.sizeText}，${l.date}）`);
  }
  if (summary.duplicates.groups) {
    lines.push('');
    lines.push(`【重名】${summary.duplicates.groups} 组同名文件（多出 ${summary.duplicates.extraCopies} 份）——可能是重复上传`);
    for (const s of summary.duplicates.samples) lines.push(`- ${s}`);
  }
  let text = lines.join('\n');
  if (text.length > maxChars) text = text.slice(0, maxChars) + '\n…（内容过长已截断）';
  return text;
}
