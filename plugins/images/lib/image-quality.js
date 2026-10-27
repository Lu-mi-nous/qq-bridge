// 图片质量门：在入库前筛掉明显的低质图（"丑图"）。
//
// 设计依据：booru 系图站的人工标签本身就是成熟的质量信号——
// 画师崩了会打 `bad_anatomy`、草稿会打 `sketch`、画质差会打 `lowres`。
// 用这些现成信号比自己训模型更准（图站是几万人标注的），且零训练成本、可解释、可调。
//
// 三层过滤，由廉价到昂贵：
//   1) 标签黑名单：元数据层，零成本（不下载就能拒）
//   2) 分数下限：元数据层，零成本。社区投票是"好不好看"最直接的信号
//   3) 分辨率下限：元数据层，零成本
// 需要解码图片才能算的指标（清晰度/过曝等）不放在这里，避免拖慢实时拉取。

/** 明确表示低质/非成品的人工标签（booru 惯例）。命中即拒。 */
export const LOW_QUALITY_TAGS = new Set([
  // 非成品
  'sketch', 'rough', 'unfinished', 'wip', 'lineart', 'line_art',
  'monochrome', 'greyscale', 'greyscale_with_colored_background',
  // 画崩了（人工判定）
  'bad_anatomy', 'bad_proportions', 'bad_hands', 'bad_feet', 'bad_perspective',
  'bad_id', 'bad_pixiv_id', 'bad_twitter_id', 'bad_link',
  'extra_limbs', 'missing_limbs', 'fused_fingers', 'extra_fingers',
  // 画质问题
  'lowres', 'jpeg_artifacts', 'chromatic_aberration', 'blurry',
  // 明显干扰阅读的元素
  'watermark', 'sample_watermark', 'text_focus', 'english_text', 'speech_bubble',
  // AI 生成（风格不统一，通常不是用户收藏的那种手绘感）
  'ai-generated', 'ai_generated', 'novelai', 'stable_diffusion',
  // 三次元照片混入（用户要的是插画）
  'cosplay', 'photo', 'realistic',
]);

/** 分数下限（按源差异化：各站投票量级不同）。 */
export const SCORE_FLOOR = {
  safebooru: 5,   // 实测该站热门图可达 800+，个位数基本是冷门图
  yandere: 3,     // 量级较小（实测热门 50 左右）
  pixiv: 0,       // 日榜本身已是精选（rank→score 映射），不再二次卡
};

/** 分辨率下限：太小通常是缩略图/低质图。 */
export const MIN_PIXELS = 400 * 400;
export const MIN_SIDE = 400;

/**
 * 多人/群像标签。这些图**不是质量差**，只是不适合「指定某个角色」的场景。
 *
 * 为什么不塞进 LOW_QUALITY_TAGS：群像图往往画得很好、分数很高，
 * 但它同时带多个角色标签，于是**查任何角色都能命中它**。实测数据（296 张库）：
 *   群像图平均带 9.8 个角色标签（最多一张 201 个），单角色图只有 1.0 个；
 *   `doctor_(arknights)` 的候选里 78% 是群像，`honkai_(series)` 更是 89%。
 * 结果就是「要什么角色都发同一张群像」——群友要的是那个角色，不是大合照。
 *
 * 因此单独用「偏好降权」而不是直接丢弃：万一没有单人图，群像总比「没找到」好。
 */
export const GROUP_IMAGE_TAGS = new Set([
  'multiple_girls', 'multiple_boys', 'multiple_others',
  '2girls', '3girls', '4girls', '5girls', '6+girls',
  '2boys', '3boys', '4boys', '5boys', '6+boys',
  'group', 'crowd', 'ensemble', 'many_girls', 'many_boys'
]);

/** 判断是否是多人/群像图（任一群像标签命中即算）。 */
export function isGroupImage(entry) {
  return (entry?.tags ?? []).some((t) => GROUP_IMAGE_TAGS.has(String(t).toLowerCase()));
}

/**
 * 这张图带多少个「角色标签」（形如 `name_(franchise)`）。
 * 数字越大越可能是群像/合集图。
 */
export function characterTagCount(entry) {
  return (entry?.tags ?? []).filter((t) => /_\(.+\)$/.test(String(t))).length;
}

/**
 * 数一下图里有几个「人」。booru 的 `1girl` / `1boy` / `2girls` 等人数标签比
 * `multiple_girls` 更常见也更精确（实测有图带 1girl 却无 multiple_girls）。
 * 用于兜底判定人数，避免只看 multiple_* 而漏判。
 *
 * @returns {number} 人数下界（识别不出时返回 0）
 */
export function personCount(entry) {
  let n = 0;
  for (const raw of entry?.tags ?? []) {
    const t = String(raw).toLowerCase();
    const m = /^(\d+)\+?(girls?|boys?|others?)$/.exec(t);
    if (m) {
      // `6+girls` 这类带加号的下界计 6
      n += Number(m[1]) || 0;
      continue;
    }
    if (t === '1girl' || t === '1boy' || t === '1other') n += 1;
  }
  return n;
}

/**
 * 是否应视为「群像」而降低优先级。
 *
 * 判定依据（按可靠性排序）：
 *   1. 标准群像标签（multiple_girls / 2girls / group …）——最可靠
 *   2. 人数标签合计 ≥ 2（1girl+1boy、2girls …）——覆盖没打 multiple_* 的图
 *   3. 角色标签数超阈值——覆盖「一堆角色但没有人数标签」的合集图
 *
 * 第 3 条阈值定得保守（默认 6）：实测误伤过带 1girl 的单人图（5 个角色标签），
 * 因为角色标签里还包含同一角色的不同形态/作品标注。宁可漏判也别把单人图当群像。
 */
export function isGroupLike(entry, opts = {}) {
  if (isGroupImage(entry)) return true;
  if (personCount(entry) >= 2) return true;
  const threshold = Number(opts.charTagThreshold ?? 6);
  return characterTagCount(entry) >= threshold;
}



/**
 * 判断一张图是否通过质量门。
 * @returns {{ok: boolean, reason?: string}}
 */
export function checkQuality(entry, opts = {}) {
  const tags = (entry?.tags ?? []).map((t) => String(t).toLowerCase());
  const source = String(entry?.source ?? '');

  // 1) 标签黑名单（可整体关闭，或用 extraDeny 追加）
  if (opts.useTags !== false) {
    const deny = opts.extraDeny ? new Set([...LOW_QUALITY_TAGS, ...opts.extraDeny.map((t) => String(t).toLowerCase())]) : LOW_QUALITY_TAGS;
    // 允许显式放行的标签（例如用户就爱看 sketch 风）
    const allow = new Set((opts.allowTags ?? []).map((t) => String(t).toLowerCase()));
    for (const t of tags) {
      if (deny.has(t) && !allow.has(t)) return { ok: false, reason: `低质标签 ${t}` };
    }
  }

  // 2) 分数下限（按源取阈值；未配置的源不卡）
  const floor = opts.scoreFloor ?? SCORE_FLOOR[source] ?? 0;
  if (floor > 0) {
    const score = Number(entry?.score) || 0;
    // score 为 0 可能是「新图还没人投票」而非「差」——但那正是冷门图，
    // 我们要的是已受认可的作品，因此同样拒绝（除非调用方放宽）。
    if (score < floor) return { ok: false, reason: `分数 ${score} < ${floor}` };
  }

  // 3) 分辨率下限
  const w = Number(entry?.width) || 0;
  const h = Number(entry?.height) || 0;
  if (w > 0 && h > 0) {
    if (w * h < (opts.minPixels ?? MIN_PIXELS)) return { ok: false, reason: `分辨率过小 ${w}x${h}` };
    if (Math.min(w, h) < (opts.minSide ?? MIN_SIDE)) return { ok: false, reason: `短边过小 ${w}x${h}` };
  }

  return { ok: true };
}

/**
 * 批量过滤，返回 { kept, rejected }（rejected 带原因，便于日志与调参）。
 */
export function filterByQuality(entries, opts = {}) {
  const kept = [];
  const rejected = [];
  for (const e of entries) {
    const v = checkQuality(e, opts);
    if (v.ok) kept.push(e); else rejected.push({ id: e?.id, reason: v.reason });
  }
  return { kept, rejected };
}
