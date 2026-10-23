// 「自己刷 B 站」的调度与决策逻辑。
//
// 需求（2026-10-19）：「遇到自己喜欢的视频就多看一会，不喜欢的就划走，然后放在本地形成记忆」。
//
// 关键设计：**"多看一会 / 划走"用投入的帧数实现，不是真的等时间**。
//   - 划走：只看开头 4 秒、6 帧（足够判断"这是啥、我感不感兴趣"）
//   - 多看：看 12 秒、16 帧（能看出节奏、铺垫、梗的落点）
// 理由：模型不在时间维度上感知视频，"等 30 秒"对判断毫无帮助；而多抽几帧确实能让它看得更清楚。
// 这也正好对应每日 30 分钟额度——额度按"实际消耗的观看秒数"记账，不是挂钟时间。
//
// 另一个关键点：**先看标题/封面/UP主/分区做初筛，再决定要不要下载视频**。
// 人也是这样——刷到标题没兴趣的直接划走，不会点进去。这样能省掉大量下载。
import {
  fetchPopularVideos, fetchVideoInfo, fetchPlayUrl,
  grabVideoFrames, videoFramesHint, fetchSubtitles, subtitleSnippet,
  grabAudioTranscript
} from './bili.js';

/**
 * 群友常玩的游戏（2026-10-19 用户要求：「让它多看鸣潮、明日方舟、明日方舟：终末地、
 * 原神、崩坏：星穹铁道、绝区零、英雄联盟相关的视频，因为群里多数是玩这些游戏的人」）。
 *
 * 为什么用**标题/简介关键词**而不只是分区：这些游戏的视频分散在
 * 游戏/二次元/音乐/GMV 等多个分区里（例：K/DA 是音乐区、终末地过场动画在动画区），
 * 只看分区会漏掉一大半。而标题几乎一定会出现游戏名或常用简称。
 *
 * keywords 里同时放**官方全名 + 玩家常用简称**：
 *   - 鸣潮 / 鸣潮：Wuthering Waves
 *   - 明日方舟 / 方舟 / AK（"AK" 太泛，不用）
 *   - 终末地 / Endfield
 *   - 原神 / Genshin
 *   - 崩坏：星穹铁道 / 星穹铁道 / 崩铁 / Star Rail / HSR
 *   - 绝区零 / ZZZ / Zenless
 *   - 英雄联盟 / LOL / League of Legends / 撸啊撸
 */
export const GAME_KEYWORDS = [
  { name: '鸣潮', keywords: ['鸣潮', 'wuthering waves'] },
  { name: '明日方舟：终末地', keywords: ['终末地', 'endfield'] },
  { name: '明日方舟', keywords: ['明日方舟', 'arknights'] },
  { name: '原神', keywords: ['原神', 'genshin'] },
  { name: '崩坏：星穹铁道', keywords: ['星穹铁道', '崩铁', '星铁', 'star rail', 'honkai'] },
  { name: '绝区零', keywords: ['绝区零', 'zzz', 'zenless'] },
  { name: '英雄联盟', keywords: ['英雄联盟', 'league of legends', 'lol', 'lpl', '全球总决赛', 'k/da'] }
];

/**
 * 判断一条视频是否命中"群友常玩的游戏"。
 * 命中返回游戏名，否则返回 ''。
 *
 * @param {{title?:string, desc?:string, category?:string, tags?:string[]}} video
 */
export function matchGameKeyword(video) {
  const hay = [
    String(video?.title ?? ''),
    String(video?.desc ?? ''),
    String(video?.category ?? ''),
    ...(Array.isArray(video?.tags) ? video.tags : [])
  ].join(' ').toLowerCase();
  if (!hay.trim()) return '';
  // 顺序有讲究：先匹配更长的名字（"终末地" 要排在 "明日方舟" 前面，
  // 否则「明日方舟：终末地」会被判成普通方舟，标签就不准了）
  for (const g of GAME_KEYWORDS) {
    if (g.keywords.some((k) => hay.includes(k))) return g.name;
  }
  return '';
}

/**
 * 分区偏好权重（2026-10-19 用户要求「偏好改成二次元、游戏、科技、社会热点相关」）。
 *
 * 为什么用**权重**而不是白名单：白名单会让机器人只认这四个分区，热门榜里一旦
 * 没有它们就完全不刷（实测热门榜十个里有三四个是生活/搞笑/影视）。加权则在
 * 偏好品类缺席时仍会自然落到别的分区——这更像人「主要看这些，但也会随手点别的」。
 *
 * 权重是**相对倍率**：数字越大越容易被挑中，不是百分比。
 * 命中不了关键词时回落到 1（中性），不会被完全排除。
 */
export const DEFAULT_CATEGORY_WEIGHTS = {
  '二次元': 6,      // 番剧/动画/宅文化
  '游戏': 5,        // 游戏实况/解说/赛事
  '科技': 4,        // 数码/科普/编程
  '社会热点': 3.5,  // 时事/社会话题
  '知识': 3,
  '鬼畜': 2,
  '音乐': 1.5,
  '生活': 1,
  '搞笑': 1,
  '影视': 1
};

/**
 * 把具体分区名（B 站的 tname，比如「网络游戏」「单机游戏」「科学科普」）
 * 归到上面的偏好大类。
 *
 * 为什么要归类：B 站分区很细（游戏下面还分 网络游戏/单机游戏/电子竞技），
 * 直接按 tname 精确匹配几乎命中不了任何权重。
 */
export function categoryGroup(category) {
  const s = String(category ?? '').trim();
  if (!s) return '';
  const rules = [
    [/番剧|动画|二次元|宅|虚拟主播|VOCALOID|MMD|手办|漫/, '二次元'],
    [/游戏|电竞|电子竞技|主机|手游|单机|网络游戏|GMV|实况/, '游戏'],
    [/科技|数码|科普|科学|机械|编程|AI|软件|硬件/, '科技'],
    [/热点|社会|时事|新闻|财经|法律|教育|三农|资讯/, '社会热点'],
    [/知识|人文|历史|纪录片|演讲|课程/, '知识'],
    [/鬼畜|音MAD|MAD|AMV/, '鬼畜'],
    [/音乐|翻唱|演奏|MV|舞蹈/, '音乐'],
    [/影视|电影|电视剧|综艺|影视杂谈/, '影视'],
    [/搞笑|整活|沙雕|娱乐/, '搞笑'],
    [/生活|美食|动物|萌宠|手工|家居|出行|穿搭|健身|运动|汽车/, '生活']
  ];
  for (const [re, group] of rules) {
    if (re.test(s)) return group;
  }
  return s; // 认不出的原样返回
}

/**
 * 取某视频的偏好权重。
 * @param {{category?:string,title?:string}} video
 * @param {object} weights 覆盖默认权重（来自配置）
 */
export function categoryWeight(video, weights = DEFAULT_CATEGORY_WEIGHTS) {
  const group = categoryGroup(video?.category);
  const table = weights && typeof weights === 'object' ? weights : DEFAULT_CATEGORY_WEIGHTS;
  if (group && Number(table[group]) > 0) return Number(table[group]);
  // 分区认不出时，用标题关键词兜底（热门榜有些视频 tname 是空的）
  const title = String(video?.title ?? '');
  for (const [name, w] of Object.entries(table)) {
    if (!Number(w) || w <= 1) continue;
    if (title.includes(name)) return Number(w);
  }
  return 1;
}

/**
 * 泛词黑名单：这些标签**只在 B 站原生标签里精确匹配**，不在标题/简介里做子串匹配。
 *
 * 为什么（2026-10-20 实测）：标题子串匹配会误伤——「莫斯科音乐厅恐袭」的标题里
 * 含「音乐厅」，于是被判成"你喜欢的音乐类"。这不是孤例，泛词都这样：
 * 「游戏」「实况」「生活」在标题里随处可见。
 *
 * 而且这些词**本来就被分区权重覆盖了**（音乐权重 1.5、游戏 5……），
 * 再算一次等于重复计分。所以它们只在"UP 主自己打的标签恰好叫这个"时才加分。
 */
const GENERIC_TAGS = new Set([
  '音乐', 'mv', '游戏', '实况', '影视', '电影', '电视剧', '动漫', '二次元',
  '生活', '搞笑', '科技', '数码', '舞蹈', '翻唱', '娱乐', 'vlog'
]);
/**
 * 判断一个"口味标签"是不是游戏名（含简称）。
 *
 * 为什么要剔除：游戏名已经通过 `gameBoost`（20 倍）单独加分了。
 * 如果记忆里的标签也有「鸣潮」「终末地」，它们会同时在 boost 里再乘一次，
 * 等于同一条视频被加了两次分——既重复计算，还会把其它内容挤掉。
 */
function isGameTag(name) {
  const s = String(name ?? '').trim().toLowerCase();
  if (!s) return false;
  return GAME_KEYWORDS.some((g) =>
    g.name.toLowerCase() === s || g.keywords.some((k) => k === s));
}

/**
 * 计算"历史口味"带来的倍率加成（1 ~ 2 倍）。
 *
 * 2026-10-20 修：原实现只在 `title + category` 里找标签，实测热门榜 50 条
 * 只有 10 条命中，而且明显误伤——10 条里有 4 条是**只靠分区名**命中的
 * （分区叫「音乐综合」就吃「音乐」标签），那是在把分区权重再算一遍。
 *
 * 现在的规则：
 *   - 匹配面 = **标题 + 简介 + UP主原生标签**（不看分区）
 *   - 剔除游戏名（见 isGameTag，避免与 gameBoost 重复计算）
 *   - 剔除单字/纯数字标签（"梗""3"这种匹配面太宽）
 *   - 泛词（见 GENERIC_TAGS）只在原生标签里精确认，不在标题里做子串
 *
 * @param {object} video
 * @param {Array<{name:string}>|string[]} likedTags taste().totalTags
 * @returns {number} 倍率
 */
export function tasteBoost(video, likedTags) {
  const list = Array.isArray(likedTags) ? likedTags : [];
  if (!list.length) return 1;
  const hay = `${video?.title ?? ''} ${video?.desc ?? ''}`.toLowerCase();
  const nativeTags = (Array.isArray(video?.tags) ? video.tags : [])
    .map((t) => String(t ?? '').trim().toLowerCase())
    .filter(Boolean);
  const native = new Set(nativeTags);
  if (!hay.trim() && !native.size) return 1;

  let hits = 0;
  const used = new Set();
  for (const t of list) {
    const name = String(t?.name ?? t ?? '').trim();
    // 单字标签（"梗""爽"）匹配面太宽，会把无关内容都算上
    if (name.length < 2) continue;
    const low = name.toLowerCase();
    if (used.has(low)) continue;
    if (isGameTag(name)) continue;
    // 泛词：只认原生标签的精确命中
    if (GENERIC_TAGS.has(low)) {
      if (native.has(low)) { hits += 1; used.add(low); }
      continue;
    }
    if (hay.includes(low) || native.has(low)) { hits += 1; used.add(low); }
  }
  // 上限 2 倍：少数几个标签不能垄断选片
  return 1 + Math.min(1, hits * 0.25);
}

/**
 * 计算"喜欢的 UP 主"带来的倍率加成（1 ~ 1.5 倍）。
 *
 * 为什么单独做（2026-10-20 实测）：模型自己写的标签只覆盖"类型"，
 * 而"同一个人做的内容"是比标签更硬的偏好信号。实测记忆里喜欢过两次以上的
 * UP 主（他说电影、ファル公、Misen-）一出现就是真正对味的那条。
 *
 * 门槛放在"喜欢过 ≥2 次"：只喜欢过 1 次可能只是那条视频火，不代表认这个 UP 主。
 *
 * @param {object} video
 * @param {Map<string,number>|object|Array<{name:string,count:number}>} ownerCounts
 *   喜欢过的 UP 主 → 次数。三种形态都接受：taste().owners 给的是数组。
 * @returns {number}
 */
export function ownerBoost(video, ownerCounts) {
  const owner = String(video?.owner ?? '').trim();
  if (!owner) return 1;
  let n = 0;
  if (ownerCounts instanceof Map) {
    n = Number(ownerCounts.get(owner)) || 0;
  } else if (Array.isArray(ownerCounts)) {
    n = Number(ownerCounts.find((o) => String(o?.name ?? '').trim() === owner)?.count) || 0;
  } else {
    n = Number(ownerCounts?.[owner]) || 0;
  }
  if (n < 2) return 1;
  // 2 次 → 1.25，3 次 → 1.35，4 次 → 1.45，5 次以上 → 1.5（封顶）
  return Math.min(1.5, 1 + 0.1 * n + 0.05);
}

/**
 * 从热门列表里挑一条"值得点开"的候选。
 *
 * 挑法（模拟"刷"而不是"按热度推荐"）：
 *   - 排除已看过且还在冷却期的（同一条视频不该反复刷）
 *   - **按分区偏好加权随机**，不是永远挑最高播放量的（否则行为太机械），
 *     也不是纯随机（那会有一半是生活/搞笑）
 *
 * @param {Array} list fetchPopularVideos 的结果
 * @param {(bvid:string)=>object|null} lookup 查记忆
 * @param {{now?:number, cooldownMs?:number, weights?:object, likedTags?:Array<{name:string,count:number}>,
 *   likedOwners?:Map<string,number>|object, gameBoost?:number, preferGames?:boolean}} opts
 *   likedTags：从记忆里归纳出的偏好标签，命中可额外加权（让"我喜欢什么"能自我强化）
 *   likedOwners：喜欢过的 UP 主 → 次数；≥2 次才加分（见 ownerBoost）
 */
export function pickCandidate(list, lookup, opts = {}) {
  const now = Number(opts.now) || Date.now();
  const cooldownMs = Math.max(0, Number(opts.cooldownMs) || 0);
  const weights = opts.weights || DEFAULT_CATEGORY_WEIGHTS;

  const fresh = (Array.isArray(list) ? list : []).filter((v) => {
    if (!v?.bvid) return false;
    const seen = lookup?.(v.bvid);
    if (!seen) return true;
    // 看过的：冷却期内跳过；超过冷却期允许再看（人会重看老视频）
    return (now - Number(seen.lastSeenAt || 0)) > cooldownMs;
  });
  if (!fresh.length) return null;

  // 把"喜欢过的标签"折成一个小的倍率加成，让偏好能自我强化。
  // 上限 2 倍，避免少数几个标签彻底垄断选片（见 tasteBoost 的注释）。
  const liked = Array.isArray(opts.likedTags) ? opts.likedTags.slice(0, 10) : [];

  // 群友常玩的游戏加成（用户明确要求"多看这些"）。
  // 倍率给得比分区权重高：热门榜里这七款游戏的视频只占很小一部分
  // （实测 150 条里约 4 条 = 2.8%），如果倍率不够，靠随机几乎刷不到——
  // 那就违背"群里多数是玩这些的人"这个前提。
  // 默认 20（用户指定）：实测选中率从 36%（10 倍）提到约 55%。
  // 但不设成"只刷这些"：仍保留其它内容的概率，否则行为太窄、也容易刷完重复。
  const gameBoost = Math.max(1, Number(opts.gameBoost) || 20);

  const scored = fresh.map((v) => {
    const game = opts.preferGames === false ? '' : matchGameKeyword(v);
    const owner = ownerBoost(v, opts.likedOwners);
    return {
      v,
      game,
      owner,
      w: Math.max(0.01,
        categoryWeight(v, weights)
        * tasteBoost(v, liked)
        * (game ? gameBoost : 1)
        * owner)
    };
  });
  const total = scored.reduce((a, s) => a + s.w, 0);

  // 加权随机
  let r = Math.random() * total;
  for (const s of scored) {
    r -= s.w;
    if (r <= 0) return s.v;
  }
  return scored[scored.length - 1].v;
}

/**
 * 根据"喜不喜欢"决定这次看多深。
 *
 * @param {boolean|null} liked
 * @param {{framesLiked?:number, framesDisliked?:number, maxSecondsPerVideo?:number}} cfg
 * @returns {{frames:number, seconds:number}} 这两个值用于抽帧与记账
 */
export function watchDepth(liked, cfg = {}) {
  const likedFrames = Math.max(3, Number(cfg.framesLiked) || 16);
  const dislikedFrames = Math.max(1, Number(cfg.framesDisliked) || 6);
  const maxSec = Math.max(2, Number(cfg.maxSecondsPerVideo) || 240);
  // 采样密度：默认 1 秒 1 帧（用户要求「帧间隔缩短一些，最好一秒取样一次」）。
  // 帧数会按秒数自动算，但**有上限**——单帧太小就看不清字幕了。
  // 所以调用方给 seconds，这里按 density 折算 frames，再按 framesPerSecondMax 封顶。
  const density = Math.max(0.1, Math.min(4, Number(cfg.framesPerSecond) || 1));
  const hardMax = Math.max(8, Math.min(120, Number(cfg.maxFramesTotal) || 120));
  const plan = (seconds) => {
    const sec = Math.min(maxSec, Math.max(1, seconds));
    return { seconds: sec, frames: Math.min(hardMax, Math.max(1, Math.round(sec * density))) };
  };

  if (liked === true) {
    // 喜欢：多看（默认 120 秒；1 秒 1 帧 → 120 帧）
    return plan(Number(cfg.likedSeconds) || 120);
  }
  if (liked === false) {
    // 不喜欢：划走（默认 6 秒，1 秒 1 帧 → 6 帧）
    return plan(Number(cfg.scanSeconds) || 6);
  }
  // 没判断出来（很少见）：取中间量
  const mid = Math.round(((Number(cfg.likedSeconds) || 120) + (Number(cfg.scanSeconds) || 6)) / 2);
  return plan(mid);
}

/**
 * 从模型回复里抠出第一段的判断结果。
 *
 * 为什么不能直接 JSON.parse：模型虽然被要求"只回一行 JSON"，但实际经常包一层
 * ```json 代码块、加一句"好的"，或者把 notes 写成中文标点。所以：
 *   ① 先把 ``` 围栏剥掉；
 *   ② 找第一个 { 到最后一个 } 之间的内容试解析；
 *   ③ 解析失败但正文里能看出"喜欢/不喜欢"时，退化成关键词判断；
 *   ④ 都不行返回 { liked: null }（桥接据此只保留第一段，不影响主流程）。
 *
 * @returns {{liked:boolean|null, interest:number|null, tags:string[], notes:string}}
 */
export function parseScanVerdict(text) {
  const raw = String(text ?? '').trim();
  const empty = { liked: null, interest: null, tags: [], notes: '' };
  if (!raw) return empty;

  const cleaned = raw.replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start) {
    const body = cleaned.slice(start, end + 1);
    // ① 先试标准解析
    let obj = null;
    try { obj = JSON.parse(body); } catch {}
    // ② 失败再试"修一下再解析"：模型常在 notes 里写未转义的换行/引号，
    //    导致整段 JSON 解析失败、interest/tags 全丢（实测出现过
    //    "liked=true 但 interest=- tags=-" 的情况）。
    if (!obj) {
      const repaired = body
        .replace(/[\u0000-\u001f]+/g, ' ')          // 去掉裸控制字符（含换行）
        .replace(/,\s*}/g, '}')                      // 尾逗号
        .replace(/,\s*]/g, ']');
      try { obj = JSON.parse(repaired); } catch {}
    }
    // ③ 还不行：逐字段用正则抠（宁可只拿到部分，也别全丢）
    if (!obj) {
      const mLike = /"liked"\s*:\s*(true|false)/i.exec(body);
      const mInt = /"interest"\s*:\s*(\d{1,3})/i.exec(body);
      const mTags = /"tags"\s*:\s*\[([^\]]*)\]/i.exec(body);
      const mNotes = /"notes"\s*:\s*"([^"]*)"/i.exec(body);
      if (mLike || mInt || mTags) {
        return {
          liked: mLike ? mLike[1].toLowerCase() === 'true' : null,
          interest: mInt ? Math.min(100, Math.max(0, Number(mInt[1]))) : null,
          tags: mTags
            ? mTags[1].split(',').map((t) => t.trim().replace(/^["']|["']$/g, '')).filter(Boolean).slice(0, 6)
            : [],
          notes: mNotes ? mNotes[1].slice(0, 200) : ''
        };
      }
    }
    if (obj && typeof obj === 'object') {
      const liked = obj.liked === true ? true : (obj.liked === false ? false : null);
      const interest = Number.isFinite(Number(obj.interest))
        ? Math.min(100, Math.max(0, Number(obj.interest)))
        : null;
      const tags = Array.isArray(obj.tags)
        ? obj.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 6)
        : [];
      const notes = String(obj.notes ?? '').slice(0, 200);
      return { liked, interest, tags, notes };
    }
  }

  // 兜底：从自然语言里判断倾向。注意先判否定，否则"不喜欢"会被"喜欢"命中。
  if (/不感兴趣|不喜欢|没意思|无聊|划走|没兴趣|一般般/.test(cleaned)) {
    return { ...empty, liked: false, notes: cleaned.slice(0, 120) };
  }
  if (/感兴趣|喜欢|有意思|好看|不错|想继续/.test(cleaned)) {
    return { ...empty, liked: true, notes: cleaned.slice(0, 120) };
  }
  return empty;
}

/**
 * 两段式观看：先扫一眼做初判，觉得值得再多看一段。
 *
 * 为什么需要（2026-10-19 用户问「为什么总是只看 8s11 帧，不是说感兴趣就多看吗」）：
 *   原实现是**先定看多深、再去看**，而"喜不喜欢"要看完才知道——于是永远走
 *   `liked=null` 的中庸分支，`framesLiked`/`framesDisliked` 从未被用上。
 *   正确顺序是反过来：先浅看一小段拿到初判，再按初判决定要不要追加。
 *
 * 这不是"再多截一段视频"，而是**在同一条视频上追加时间窗口**：
 *   第一段 0~scanSeconds，第二段接着往下看，直到 likedSeconds。
 *   总时长仍受 maxSecondsPerVideo 与每日额度约束。
 *
 * @param {(opts:{seconds:number,frames:number})=>Promise<{ok:boolean, info?:object, grid?:object, error?:string}>} openSegment
 *   打开指定时间窗口的片段（调用方负责真正下载与抽帧）
 * @param {(scan:{grid:object, info:object}) => Promise<{liked:boolean|null, interest?:number, tags?:string[], notes?:string}>} judge
 *   根据第一次浅看的结果让模型判断喜不喜欢
 * @returns {Promise<{ok:boolean, info?:object, grid?:object, hint?:string, scan?:object, verdict?:object,
 *   segments:number, totalSeconds:number, totalFrames:number, error?:string}>}
 */
export async function watchInTwoPasses(openSegment, judge, cfg = {}) {
  const likedFrames = Math.max(3, Number(cfg.framesLiked) || 16);
  const dislikedFrames = Math.max(1, Number(cfg.framesDisliked) || 6);
  const likedSeconds = Math.min(Math.max(2, Number(cfg.maxSecondsPerVideo) || 240), Number(cfg.likedSeconds) || 12);
  const dislikedSeconds = Math.min(Math.max(2, Number(cfg.maxSecondsPerVideo) || 240), Number(cfg.dislikedSeconds) || 4);
  const budgetSec = Number(cfg.budgetSec);

  // 第一段：浅看。用"不喜欢"的深度做初判——像人扫一眼就知道要不要继续。
  // 这么定的理由：大多数视频是不值得看的，浅看省带宽；真喜欢再追加。
  const scanSeconds = dislikedSeconds;
  const scanFrames = dislikedFrames;
  const first = await openSegment({ seconds: scanSeconds, frames: scanFrames });
  if (!first?.ok) return { ok: false, error: first?.error || '第一次抽取失败', segments: 0, totalSeconds: 0, totalFrames: 0 };

  let verdict = { liked: null };
  try {
    verdict = (await judge({ grid: first.grid, info: first.info })) || { liked: null };
  } catch {
    // 判断失败就当"没判断出来"，仍把第一段给模型看
    verdict = { liked: null };
  }

  const liked = verdict.liked === true ? true : (verdict.liked === false ? false : null);
  const wantSeconds = watchDepth(liked, { framesLiked: likedFrames, framesDisliked: dislikedFrames, maxSecondsPerVideo: cfg.maxSecondsPerVideo }).seconds;
  const wantFrames = watchDepth(liked, { framesLiked: likedFrames, framesDisliked: dislikedFrames, maxSecondsPerVideo: cfg.maxSecondsPerVideo }).frames;

  // 只有"喜欢"且确实想看更久时才追加。不喜欢/没判断出来 → 就这一段。
  const canExtend = liked === true && wantSeconds > scanSeconds;
  const budget = Number.isFinite(budgetSec) ? Math.max(0, budgetSec) : Infinity;
  const allowSeconds = Math.min(wantSeconds, budget);
  if (!canExtend || allowSeconds <= scanSeconds) {
    return {
      ok: true,
      info: first.info,
      grid: first.grid,
      hint: first.hint,
      scan: first,
      verdict,
      segments: 1,
      totalSeconds: scanSeconds,
      totalFrames: scanFrames,
      extended: false
    };
  }

  // 第二段：接着往下看（时间窗口连续，不重复看开头）
  const second = await openSegment({
    seconds: allowSeconds,
    frames: Math.max(scanFrames, Math.min(likedFrames, wantFrames))
  });
  if (!second?.ok) {
    // 追加失败不影响已有结果：把第一段原样给模型
    return {
      ok: true,
      info: first.info,
      grid: first.grid,
      hint: first.hint,
      scan: first,
      verdict,
      segments: 1,
      totalSeconds: scanSeconds,
      totalFrames: scanFrames,
      extended: false,
      extendError: second?.error
    };
  }

  // 用第二段（时间更长的窗口）作为最终给模型看的画面——它已经包含开头
  return {
    ok: true,
    info: second.info || first.info,
    grid: second.grid,
    hint: second.hint,
    scan: first,
    verdict,
    segments: 2,
    totalSeconds: allowSeconds,
    totalFrames: second.grid.frames,
    extended: true
  };
}

/**
 * 观看一条视频：取信息 → 取流 → 抽帧 → 返回给模型看的东西。
 *
 * @returns {Promise<{ok:boolean, info?:object, grid?:object, hint?:string, error?:string}>}
 */
export async function watchVideo(bvid, opts = {}) {
  const seconds = Math.max(1, Number(opts.seconds) || 8);
  const frames = Math.max(1, Number(opts.frames) || 9);
  try {
    let info = opts.info || await fetchVideoInfo(bvid);
    // cid 缺失时必须补一次 view 请求（2026-10-19 实测）：**搜索结果里 cid 恒为 0**，
    // 拿 0 去调 playurl 会直接 `-400 请求错误`，表现为"看视频失败"。
    // 热门榜/分区榜的结果是带 cid 的，所以只有"搜索来的候选"需要这一步。
    if (!Number(info?.cid)) {
      info = await fetchVideoInfo(info.bvid || bvid);
    }
    // 太长的视频也只看开头——判断"这是什么"不需要看完
    const play = await fetchPlayUrl(info.bvid, info.cid, { qn: opts.qn });
    const grid = await grabVideoFrames(play.url, {
      seconds,
      frames,
      // 跳过片头黑场（MV/PV 常有 2~5 秒黑场淡入），并把"太暗就自动往后挪"
      // 的开关一路传下去——2026-10-19 忘记传这两个参数，导致亮度检测形同虚设，
      // 模型仍报「黑屏」。
      skipSeconds: opts.skipSeconds,
      autoSkipDark: opts.autoSkipDark,
      // 帧多时按时间顺序切成多张图（每张最多这么多格）
      tilesPerSheet: opts.tilesPerSheet,
      timeoutMs: opts.timeoutMs
    });
    if (!grid) return { ok: false, info, error: '抽帧失败（视频可能受限或格式不支持）' };
    // 字幕：把"听到的话"也交给模型。
    // 画面只能看出"这是游戏实况还是 MV"，字幕能直接给出"在讲什么"。
    // 失败一律不影响主流程：没凭据/这条没字幕/网络失败都只是少一段文字。
    if (opts.subtitles !== false) {
      try {
        const sub = await fetchSubtitles(info.bvid || bvid, info.cid, {
          timeoutMs: Math.min(Number(opts.timeoutMs) || 12000, 12000)
        });
        if (sub.ok) {
          // 只取"实际看到的那段时间"：多给的部分会让模型以为视频后面讲了别的内容
          const from = Number(grid.skipSeconds) || 0;
          const text = subtitleSnippet(sub.lines, {
            from,
            to: from + seconds,
            maxChars: Number(opts.subtitleMaxChars) || 1200
          });
          if (text) {
            grid.subtitleText = text;
            grid.subtitleLan = sub.lan || '';
          }
        } else if (sub.reason === 'noAuth') {
          grid.subtitleReason = 'noAuth';
        }
      } catch {
        // 字幕是增强项，失败就静默跳过
      }
    }

    // ── ASR 兜底：字幕拿不到时，直接"听"音轨转成文字（2026-10-21 用户要求）──
    //
    // 为什么放在字幕之后：字幕**瞬时且零成本**，ASR 要 12~15 秒。
    // 只要字幕拿到了就不该再花这笔时间，所以严格前置 `if (!grid.subtitleText)`——
    // 两者绝不会同时出现（同一段话给模型两遍既浪费 token，
    // 还可能让它以为"说了两次"）。
    //
    // 会走到这里的三种情况：① 没配 B 站登录态（字幕恒为空，且 code 仍为 0）；
    // ② 这条视频本身没字幕（纯音乐/冷门/外语）；③ 字幕文本被时间窗过滤成空。
    if (!grid.subtitleText && opts.asr && opts.asrEnabled !== false) {
      try {
        const from = Number(grid.skipSeconds) || 0;
        // 窗口与画面对齐，但**至少 12 秒**：实测 ASR 耗时以固定开销为主
        // （6 秒片段也要 10 秒），多给几秒几乎不增加耗时，却可能多听到一句话。
        const asrSeconds = Math.min(60, Math.max(12, Number(seconds) || 0));
        const heard = await grabAudioTranscript(
          { bvid: info.bvid || bvid, cid: info.cid },
          {
            asr: opts.asr,
            fromSec: from,
            seconds: asrSeconds,
            timeoutMs: Number(opts.asrTimeoutMs) || 120000
          }
        );
        if (heard.ok) {
          grid.asrText = heard.text;
          grid.asrLang = heard.lang || '';
          grid.asrSec = heard.asrSec || 0;
        } else {
          // 记下原因但不打断流程：提示词里会说明"这段没听到声音"
          grid.asrReason = heard.error || '转写失败';
        }
      } catch (error) {
        grid.asrReason = String(error?.message ?? error);
      }
    } else if (grid.subtitleText) {
      grid.asrSkipped = 'hasSubtitle';
    } else if (!opts.asr) {
      grid.asrSkipped = 'noEngine';
    }

    return { ok: true, info, grid, hint: videoFramesHint(info, grid) };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

/**
 * 判断"这次该不该继续自己刷"——每日额度与间隔控制。
 *
 * @param {{budgetSec:number, todaySeconds:number, now?:number, lastAt?:number, minIntervalMs?:number}} opts
 * @returns {{allowed:boolean, reason?:string, remainingSec:number}}
 */
export function canSelfBrowse(opts = {}) {
  const budget = Math.max(0, Number(opts.budgetSec) || 0);
  const used = Math.max(0, Number(opts.todaySeconds) || 0);
  const remaining = Math.max(0, budget - used);
  if (budget > 0 && remaining <= 0) {
    return { allowed: false, reason: '今日额度已用完', remainingSec: 0 };
  }
  const now = Number(opts.now) || Date.now();
  const lastAt = Number(opts.lastAt) || 0;
  const minGap = Math.max(0, Number(opts.minIntervalMs) || 0);
  if (lastAt > 0 && (now - lastAt) < minGap) {
    return { allowed: false, reason: '距上次刷视频太近', remainingSec: remaining };
  }
  return { allowed: true, remainingSec: remaining };
}

/**
 * 调度下一次"自己刷"的时间点（随机区间，像人一样不固定）。
 * @returns {number} 毫秒间隔
 */
export function nextBrowseDelay(opts = {}) {
  const min = Math.max(1000, Number(opts.minIntervalMs) || 20 * 60 * 1000);
  const max = Math.max(min, Number(opts.maxIntervalMs) || 90 * 60 * 1000);
  return min + Math.floor(Math.random() * (max - min));
}

/**
 * 生成"自己刷"时给模型看的提示词。
 *
 * 措辞要点（按 AGENTS.md「提示词即功能」）：
 *   - 必须让它**自己判断**喜不喜欢，不能替它判断
 *   - 必须要求它给出结构化结果（liked / tags / interest / notes），否则记忆里全是空
 *   - 必须说清"这是你自己的时间，不是任务"——不然它会当成作业汇报
 *   - 不能透露内部机制（额度、帧数这些）给群友
 */
/**
 * 单段观看后的提示词（不喜欢/没判断出来时用）：直接要求记录感受。
 *
 * 与 buildScanPrompt 的区别：这个**已经看过**了，不需要再判断"要不要继续"，
 * 只需要如实记录。之所以保留"看一遍就记录"这条路径，是因为不感兴趣的视频
 * 本来就该浅看即止——像人扫一眼划走，不会再回去补看。
 */
export function buildBrowsePrompt(info, hint, grid) {  return `【你在自己刷 B 站】

你现在有点空闲，随手点开了一个视频（不是谁让你看的）：
标题：${info.title}
UP主：${info.owner || '未知'}｜分区：${info.category || '未知'}｜时长：${Math.floor((info.durationSec || 0) / 60)}分${(info.durationSec || 0) % 60}秒
简介：${(info.desc || '（无）').slice(0, 600)}

${hint}

看完之后，请用 qq_bili_record 记录你的真实感受（不要为了完成任务而编）：
- liked：你喜不喜欢（true/false）
- interest：兴趣分 0~100
- tags：2~5 个短标签（类型/题材/情绪，如「搞笑」「整活」「治愈」「技术向」）
- notes：一句话说说你为什么喜欢/不喜欢

如果喜欢、而且觉得值得，可以主动在群里提一句（像人分享刚看到的好东西），但不要每条都发。
如果觉得无聊，直接划走就好——不用跟任何人交代，也不用说自己"在看视频"。

【重要】这是你自己的空闲时间，不是工作汇报。不要在群里说"我在刷B站""我正在看视频"这类话。`;
}

/**
 * 第一段（浅看）的提示词：只要求判断，不要求记录。
 *
 * 为什么要拆成两个 prompt（2026-10-19 修「总是只看 8s11 帧」）：
 *   原实现一口气把"看 + 判断 + 记录"塞给模型，而抽多少帧在 prompt 发出前就定了，
 *   模型即使说喜欢也没有机会要求"再多看一会"。拆成两轮后，桥接能根据模型
 *   **本轮返回的结构化判断**决定要不要追加观看。
 *
 * 输出约定：模型必须回一行 JSON（便于桥接解析），而不是自由文本。
 * 这是"机器可读"的要求，所以措辞要明确，但**不能让模型在群里说出来**。
 */
export function buildScanPrompt(info, hint) {
  return `【你在自己刷 B 站】

你现在有点空闲，随手点开了一个视频（不是谁让你看的）：
标题：${info.title}
UP主：${info.owner || '未知'}｜分区：${info.category || '未知'}｜时长：${Math.floor((info.durationSec || 0) / 60)}分${(info.durationSec || 0) % 60}秒
简介：${(info.desc || '（无）').slice(0, 600)}

${hint}

这是**开头几秒**的画面，先扫一眼判断想不想继续看。
**只回一行 JSON**（不要别的文字，**不要调用任何工具**，群友看不到这个回合）：
{"liked": true 或 false, "interest": 0~100, "tags": ["标签1","标签2"], "notes": "一句话理由"}

⚠️ 这一轮**不要**调 qq_bili_record——记录会由系统在你决定之后统一处理。
你只要回答"喜不喜欢"，别的什么都别做。

规则：
- liked 是你真实的喜好。不感兴趣就填 false，这很正常——大多数视频扫一眼就划走。
- interest 用**绝对刻度**，不要集中在 60~70：
  · 0~20：无聊、甚至有点烦，想立刻划走
  · 30~45：看了一眼，没什么感觉，也不会想再看
  · 50~60：还行，看完就忘
  · 65~75：有意思，愿意看完；可能会去找同 UP 主的其它视频
  · 80~90：很喜欢，会主动搜同题材 / 想跟群友聊
  · 95~100：罕见。真的让你眼前一亮、想反复看的东西才给
  注意：大部分随手刷到的视频应该落在 30~60。**如果每条都给 70，这个分数就失去意义了**。
- tags 给 2~5 个短标签（类型/题材/情绪，如「搞笑」「整活」「治愈」「技术向」）。
- 填 false 时会就此打住，不会再看；填 true 会往后多看一段。所以**按真实感受填**，不要为了多看而填 true。
- 如果画面很暗或几乎全黑（片头黑场、暗调演出、夜景），**不要一句"黑屏，看不出内容"就完事**：
  尽量从残留画面、字幕、标题、UP主、分区推断这是什么内容；实在看不出再填 false，并在 notes 说明"画面太暗"。`;
}

/**
 * 第二段（喜欢后追加）的提示词：画面换成了更长的窗口，要求记录感受。
 */
export function buildExtendedPrompt(info, hint, scanNote) {
  return `【你在自己刷 B 站 · 继续看】

刚才扫了开头，你觉得有意思（${scanNote ? `你的初判：「${String(scanNote).slice(0, 60)}」` : '想再看看'}），于是往后多看了几秒。

标题：${info.title}
UP主：${info.owner || '未知'}｜分区：${info.category || '未知'}｜时长：${Math.floor((info.durationSec || 0) / 60)}分${(info.durationSec || 0) % 60}秒
简介：${(info.desc || '（无）').slice(0, 600)}

${hint}
（这次的时间窗口比刚才长，包含了刚才那几秒。）

看完后请用 qq_bili_record 记录真实感受：
- liked：仍觉得喜欢就 true；如果看久了反而没意思，如实填 false
- interest：0~100，**沿用初判的绝对刻度**（30~45=没感觉 / 50~60=看完就忘 / 65~75=愿意看完 / 80+=会主动找同题材）。看了更久之后可以上调或下调，但别因为"这次看完了"就默认加分。
- tags：2~5 个短标签
- notes：一句话说说为什么

【重要】群友之后可能追问「啥视频啊」「讲什么的」——notes 请写**具体内容**
（例如"某动漫解说：女主挪用三百万炒外汇加杠杆五分钟爆仓"，而不是"那种动漫解说"）。
简介系统会一起存进记忆，你不用自己抄。

如果确实很喜欢、觉得值得分享，可以偶尔在群里提一句（像人分享刚看到的好东西），但不要每条都发。
【重要】这是你自己的空闲时间，不是工作汇报。不要说你"在刷B站""正在看视频"这类话。`;
}
