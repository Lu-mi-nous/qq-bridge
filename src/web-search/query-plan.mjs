// query-plan.mjs — 搜索查询的意图解析与「降级」判定
//
// 背景（2026-10-23 群友报障「南京天气查不到」）：
//   用户问「南京天气」，模型搜的是 `南京 今天 明天 天气预报`。必应对多词查询
//   只匹配第一个词块，返回一堆「南京市/南京景点」；旧判据只要任一非站点词块
//   命中就当成切题（"南京"命中了），于是把这批无关结果当成搜索成功，模型
//   只能回「搜不到实况」。
//
// 这里把「查询分词 → 实体词 → 意图类别 → 重试词」从 bing-html.mjs 抽出来，
// 让所有引擎（含 weather 引擎）共用同一套判定，避免逻辑漂移。
//
// 关键原则：
//   1. 实体词选「最长的实义词块」，不是「最长的词块」——"天气预报"这种类别词
//      再长也不是用户要查的主体；
//   2. 时间词（今天/明天/10月23日…）、疑问词、通用请求词（评价/介绍/攻略…）
//      不参与实体选择；
//   3. 查询里有天气意图时，结果里必须出现天气类词，否则就是被上游降级了；
//   4. 单块查询（`怎么评价XXX` / `今天南京天气`）要先把修饰词剥掉再取实体。

/** 把查询拆成词块（半角/全角空格都算分隔）。 */
export function queryChunks(query) {
  return String(query ?? '')
    // 书名号/引号紧贴后续文字时先断开：`《魔法少女的魔女审判》游戏` 是两块，
    // 否则"游戏"会和标题粘成一个块，实体词也就变得过长。
    .replace(/([」』》])/g, '$1 ')
    .split(/[\s\u3000]+/)
    .map((s) => s.replace(/^["'「『《]+|["'」』》]+$/g, '').trim())
    .filter(Boolean);
}

/** 时间/日期类词块：不承载查询主体。 */
const TIME_WORD_RE = /(?:今天|明天|后天|大后天|昨天|前天|现在|当前|目前|今晚|今夜|明早|明晚|今天白天|今天夜里|本周|这周|下周|周末|未来(?:一|1|两|2|三|3|五|5|七|7)天|未来(?:一|1|两|2|三|3|五|5|七|7)周|一周|两周|三天|五天|七天|最近|这几天|近几天|今日|明日|早上|上午|中午|下午|晚上)/g;
const DATE_RE = /(?:\d{4}\s*年\s*)?\d{1,2}\s*月\s*\d{1,2}\s*[日号]?/g;

/** 天气类词：既是意图信号，也是类别词（重试时要拼回"南京天气"）。 */
const WEATHER_WORD_RE = /(?:天气预报|天气|气温|温度|多少度|几度|下雨|降雨|降水|台风|空气质量|雾霾|风力|湿度|预报)/g;
const WEATHER_INTENT_RE = /(?:天气|气温|温度|多少度|几度|下雨|降雨|降水|台风|空气质量|雾霾|风力|湿度|weather|temperature|forecast|rain)/i;
/** 判定"结果确实在讲天气"的宽口径（标题+摘要）。 */
const WEATHER_RESULT_RE = /(?:天气|气温|温度|预报|降雨|降水|下雨|湿度|风力|晴|阴|多云|雨|雪|°C|℃)/;
/** 作品名里可能含"天气"（如《天气之子》），带这些词时不按天气查询处理。 */
const NON_WEATHER_MEDIA_RE = /(?:电影|动画|动漫|游戏|小说|漫画|歌曲|专辑|角色|人物|作品|剧情|结局|主题曲)/;
/** 搜索运算符/URL：天气引擎不能把 site:xxx 或域名当地点。 */
const SEARCH_OPERATOR_RE = /^(?:site|inurl|intitle|filetype):/i;
const URL_LIKE_RE = /^(?:https?:\/\/|www\.)|\.(?:com|cn|org|net|edu|gov)\b/i;

/** 通用请求词块：不承载实体（单独出现时仍会保留）。 */
const GENERIC_CHUNKS = new Set([
  '评价', '评测', '介绍', '简介', '资料', '信息', '详情', '内容', '新闻', '最新',
  '消息', '相关', '是什么', '怎么样', '如何', '为什么', '多少', '哪里', '哪个',
  '推荐', '查询', '搜索', '攻略', '旅游攻略', '好玩的', '好吃的', '有什么', '值得',
  '电影', '动画', '动漫', '游戏', '小说', '漫画', '歌曲', '专辑', '角色', '人物', '作品',
]);

/** 单块查询里的疑问/请求前后缀。 */
const NOISE_PREFIX_RE = /^(?:请问|请|帮我|帮忙|麻烦|我想知道|想知道|查一下|查查|搜一下|搜搜|搜索|查询|看看|告诉我|怎么评价|如何评价|评价一下|介绍一下|简单介绍|科普一下|什么是|为什么|怎么|如何)+/;
const NOISE_SUFFIX_RE = /(?:怎么样|如何|是什么|是谁|在哪|为什么|吗|呢|啊|呀|吧|了)+$/;

/** 去掉查询里的修饰词，只留下实体候选。stripWeather=false 时保留"天气"（用于作品名）。 */
export function stripDecorations(chunk, { stripWeather = true } = {}) {
  let s = String(chunk ?? '');
  s = s.replace(TIME_WORD_RE, ' ');
  s = s.replace(DATE_RE, ' ');
  if (stripWeather) s = s.replace(WEATHER_WORD_RE, ' ');
  s = s.replace(NOISE_PREFIX_RE, ' ');
  s = s.replace(NOISE_SUFFIX_RE, ' ');
  s = s.replace(/[的地得]+$/g, ' ');
  s = s.replace(/[，。！？、；：,.!?;:"'“”‘’()（）[\]【】《》「」『』…—\-]/g, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * 实体词：查询里最长的「实义词块」。
 *
 * 为什么不是最长的词块：`南京 今天 明天 天气预报` 里最长的是"天气预报"，
 * 但它是类别词；按最长词块重试会去搜全国天气预报，永远搜不到南京。
 * 先剥掉时间/日期/天气/疑问词，再在剩余词块里取最长。
 */
export function entityChunk(query) {
  const q = String(query ?? '');
  const isMedia = NON_WEATHER_MEDIA_RE.test(q);
  const parts = queryChunks(q)
    .filter((p) => !SEARCH_OPERATOR_RE.test(p) && !URL_LIKE_RE.test(p))
    .map((p) => stripDecorations(p, { stripWeather: !isMedia }))
    .filter((p) => p.length >= 2);
  const meaningful = parts.filter((p) => !GENERIC_CHUNKS.has(p));
  const pool = meaningful.length ? meaningful : parts;
  if (!pool.length) {
    const whole = stripDecorations(String(query ?? ''));
    return whole || longestChunk(query);
  }
  let best = pool[0];
  for (const p of pool) if (p.length > best.length) best = p;
  return best;
}

/**
 * 兼容旧接口：最长词块（不做实体过滤）。
 * 保留给测试/外部调用；引擎重试请用 retryQueryFor()。
 */
export function longestChunk(query) {
  const parts = queryChunks(query);
  if (parts.length <= 1) return String(query ?? '').trim();
  let best = parts[0];
  for (const p of parts) if (p.length > best.length) best = p;
  return best;
}

/** 是否天气类查询（需要有可识别的实体地点）。 */
export function isWeatherQuery(query) {
  const q = String(query ?? '');
  if (NON_WEATHER_MEDIA_RE.test(q)) return false;
  if (SEARCH_OPERATOR_RE.test(q) || /(?:^|\s)site:|https?:\/\/|www\./i.test(q)) return false;
  return WEATHER_INTENT_RE.test(q) && Boolean(entityChunk(q));
}

/** 天气查询的地点；非天气查询返回 ''。 */
export function weatherLocation(query) {
  if (!isWeatherQuery(query)) return '';
  return entityChunk(query);
}

/**
 * 上游降级时的重试词。
 *   - 天气查询：`实体 + 天气`（"南京天气"）——比整句更容易命中天气页；
 *   - 其它查询：实体词本身（作品名/人名/品牌名）。
 * 返回空串表示"没有更窄的词可退"，引擎应如实返回空。
 */
export function retryQueryFor(query) {
  const entity = entityChunk(query);
  if (!entity) return '';
  const original = String(query ?? '').trim();
  if (isWeatherQuery(query)) {
    // 天气查询优先拼成「南京天气」；如果原查询已经是这个，就换「南京天气预报」，
    // 保证重试词与原文不同（否则引擎会认为无词可退）。
    const candidates = [`${entity}天气`, `${entity}天气预报`];
    return candidates.find((q) => q !== original) || '';
  }
  if (entity === original) return '';
  return entity;
}

/**
 * 查询里的"站点名/限定词"——不承载作品名的那类词块。
 *
 * 站点名在无关页面的站名部分也会出现（几乎所有萌娘百科页面标题都带"萌娘百科"），
 * 所以它不能单独作为"切题"的证据。
 */
const SITE_HINT_RE = /(百科|wiki|维基|官网|官方|网站|首页|贴吧|豆瓣|bilibili|b站|知乎|steam|萌娘|百度|谷歌|twitter|youtube|github|pixiv)/i;

/**
 * 结果是否与查询"毫无字面交集"（= 搜索引擎降级了）。
 *
 * 判据：
 *   ① 主实体词必须在结果（标题+摘要）里出现；主实体缺失时，允许另一个
 *      非站点名的实体词命中（防标题改写/拼词误伤），但站点名不算；
 *   ② 查询有天气意图时，结果里必须出现天气类词。这一条是 2026-10-23
 *      「南京 今天 明天 天气预报 → 南京市百科」事故的直接补丁：旧判据只
 *      看"南京"命中就放行，完全没注意结果里一个字都没提天气。
 */
export function looksOffTopic(results, query) {
  const parts = queryChunks(query).filter((p) => p.length >= 2);
  if (!parts.length) return false;              // 查询本身是单字/空：无从判断，视为切题
  if (!Array.isArray(results) || !results.length) return false;

  const norm = (s) => String(s ?? '').replace(/[\s\u3000]+/g, '').toLowerCase();
  const compact = norm(
    results.map((r) => `${r?.title ?? ''} ${r?.snippet ?? ''}`).join(' ')
  );

  const primary = norm(entityChunk(query));
  if (primary && !compact.includes(primary)) {
    const entity = entityChunk(query);
    const substantive = queryChunks(query)
      .map(stripDecorations)
      .filter((p) => p.length >= 2 && p !== entity && !GENERIC_CHUNKS.has(p))
      .map(norm)
      .filter((p) => p && !SITE_HINT_RE.test(p));
    if (!substantive.some((p) => compact.includes(p))) return true;
  }

  if (isWeatherQuery(query) && !WEATHER_RESULT_RE.test(compact)) return true;

  return false;
}
