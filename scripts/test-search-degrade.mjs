// 回归测试：搜索引擎「多词降级」识别与重试。
//
// 背景（2026-10-18 群友实测报障）：
// 群里问「怎么评价魔法少女的魔女审判」，机器人回"查了，只出来'魔法'百科和韩国电影《魔女》，
// 没找到这个作品"。复现后确认**不是模型不会搜**，是搜索引擎返回了降级结果而我们当成了成功：
//
//   q=魔法少女的魔女审判            → 萌娘百科 / 百度百科 / BWIKI  ✓ 全对
//   q=魔法少女的魔女审判 游戏        → 「魔法（传说中的神秘力量）」×8   ✗ 降级
//
// 触发点是**查询里出现分词**（多词），与空格编码无关（%20 / + 实测同样降级）；
// `+` 连写、加引号、加书名号也都不解决。
//
// 危害在于**静默**：降级结果仍是 8 条格式正常的结果，`searchWeb` 只看 length>0 就判定成功、
// 后续引擎不再尝试；模型拿到一堆「魔法」词条后如实说"没找到"——听起来像它不会搜。
//
// 本测试锁住三条不变量：
//   ① looksOffTopic 能把"结果与查询毫无字面交集"识别出来；
//   ② 多词查询降级时引擎会用实体词重试，并如实上报 retriedWith；
//   ③ 不能误伤正常结果（宁可少判降级，也不能把好结果丢掉——那会让机器人静默不答）。
//
// 2026-10-23 追加：查询「南京 今天 明天 天气预报」被降级成「南京市百科」，
// 旧判据只看到"南京"命中就放行。这里同时锁住"天气意图必须出现天气词"。
import { looksOffTopic, longestChunk, queryChunks, entityChunk, retryQueryFor, isWeatherQuery, weatherLocation } from '../src/web-search/engines/bing-html.mjs';

let pass = 0, fail = 0;
const check = (n, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };

console.log('── 1. 查询分词 ──');
{
  check('半角空格分词', queryChunks('a b c').length === 3);
  check('全角空格分词', queryChunks('魔法少女　游戏').length === 2);
  check('连续空格不产生空块', queryChunks('a   b').length === 2);
  check('去引号', queryChunks('"魔女审判" 游戏').join('|') === '魔女审判|游戏');
  check('去书名号', queryChunks('《魔法少女的魔女审判》游戏').join('|') === '魔法少女的魔女审判|游戏');
  check('单块原样', queryChunks('魔法少女的魔女审判').length === 1);
  check('空串不崩', queryChunks('').length === 0 && queryChunks(null).length === 0);
}

console.log('\n── 2. 最长词块（重试词的选择）──');
{
  check('取最长块（中文实体名）',
    longestChunk('魔法少女的魔女审判 游戏 评价 剧情') === '魔法少女的魔女审判',
    longestChunk('魔法少女的魔女审判 游戏 评价 剧情'));
  check('平局取靠前的', longestChunk('abc def') === 'abc');
  check('单块原样返回', longestChunk('魔法少女的魔女审判') === '魔法少女的魔女审判');
  check('英文查询取最长词', longestChunk('Arknights twitter official') === 'Arknights' || longestChunk('Arknights twitter official') === 'official',
    longestChunk('Arknights twitter official'));
}

console.log('\n── 3. 降级识别（真实故障现场）──');
{
  // 真实抓取到的降级结果（2026-10-18，bing-html，q=魔法少女的魔女审判 游戏）
  const degraded = [
    { title: '魔法 （传说中的神秘力量）_百度百科' },
    { title: '魔法 Wiki | Fandom' },
    { title: '魔法 （汉语词语）_百度百科' },
    { title: '魔法 - 萌娘百科 万物皆可萌的百科全书' },
  ];
  check('降级结果被识别（查询含"魔女审判"）',
    looksOffTopic(degraded, '魔法少女的魔女审判 游戏') === true);
  check('同样的结果对单字查询不算降级（无从判断）',
    looksOffTopic(degraded, '魔') === false);

  // 真实正常结果（q=魔法少女的魔女审判）
  const good = [
    { title: '魔法少女的魔女审判 - 萌娘百科 万物皆可萌 的 百科全书' },
    { title: '魔法少女的魔女审判 （2025年Acacia发行 的 文字冒险游戏 ...' },
    { title: '魔法少女的魔女审判 - 魔法少女的魔女审判 WIKI_BWIKI_哔...' },
  ];
  check('正常结果不被误判', looksOffTopic(good, '魔法少女的魔女审判') === false);
  check('正常结果对多词查询也不误判', looksOffTopic(good, '魔法少女的魔女审判 游戏') === false);

  // 韩国电影《魔女》——模型实际看到的那批
  const movie = [
    { title: '魔女 （韩国2018年朴勋政执导的悬疑电影）_百度百科' },
    { title: '魔女 (豆瓣)' },
    { title: '《魔女》-高清电影-完整版视频在线观看' },
  ];
  check('只匹配到"魔女"也算降级（缺"魔女审判"整块）',
    looksOffTopic(movie, '"魔女审判" 魔法少女 游戏 艾玛 橘雪梨') === true);

  // 标题里被搜索引擎插了空格的情况（实测「明日 方舟」）
  const spaced = [{ title: '明日 方舟 - Arknights' }, { title: 'Arknights' }];
  check('标题被插空格仍算切题', looksOffTopic(spaced, '明日方舟 2024 周年庆 活动 时间') === false);
}

console.log('\n── 3b. 站点名不得单独证明切题（第二次真实失败）──');
{
  // 2026-10-18 第二次报障：q=魔法少女的魔女审判 萌娘百科
  // 必应返回「魔法 - 萌娘百科 万物皆可萌的百科全书」——标题含"萌娘百科"，
  // 旧判据（任一词块命中即可）因此判定"切题"，降级结果又被当成成功。
  const degradedWithSite = [
    { title: '魔法 （传说中的神秘力量）_百度百科' },
    { title: '魔法 Wiki | Fandom' },
    { title: '魔法 （汉语词语）_百度百科' },
    { title: '魔法 - 萌娘百科 万物皆可萌的百科全书' },
  ];
  check('站点名命中不算切题（主实体缺失）',
    looksOffTopic(degradedWithSite, '魔法少女的魔女审判 萌娘百科') === true);

  // 但站点名本身作为主查询时是正常的（用户就是要找站点）
  const siteOnly = [
    { title: '萌娘百科 万物皆可萌的百科全书' },
    { title: '首页 - 萌娘百科' },
  ];
  check('只查站点名时不误判', looksOffTopic(siteOnly, '萌娘百科') === false);

  // 主实体命中、又带站点名 → 正常
  const goodWithSite = [
    { title: '魔法少女的魔女审判 - 萌娘百科 万物皆可萌 的 百科全书' },
  ];
  check('主实体 + 站点名都命中 → 切题', looksOffTopic(goodWithSite, '魔法少女的魔女审判 萌娘百科') === false);

  // 主实体没命中，但另一个实体块命中 → 允许（防标题改写误伤）
  const altEntity = [{ title: '橘雪莉 - 萌娘百科' }];
  check('另一实体块命中可放行（主块拼写不同）',
    looksOffTopic(altEntity, '魔法少女的魔女审判 橘雪莉') === false);
}

console.log('\n── 4. 边界（不能误伤）──');
{
  check('空结果不算降级（交给引擎链继续试）', looksOffTopic([], '任意查询') === false);
  check('null 不崩', looksOffTopic(null, '查询') === false);
  check('单字查询无从判断 → 不算降级', looksOffTopic([{ title: '魔' }], '魔') === false);
  check('查询全由单字块构成 → 不算降级',
    looksOffTopic([{ title: '随便什么' }], 'a b') === false);
  check('结果与查询有交集 → 不算降级',
    looksOffTopic([{ title: 'DeepSeek | Into the Unknown' }], 'DeepSeek V4.1 Flash 更新了什么') === false);
  // 英文查询大小写混写很常见；区分大小写会把正常结果误判成降级（误判=丢答案）
  check('英文大小写不敏感（arknights vs Arknights）',
    looksOffTopic([{ title: 'arknights official' }], 'Arknights twitter') === false);
  check('大小写不同但无交集仍判降级',
    looksOffTopic([{ title: '魔法（传说中的神秘力量）' }], 'MAGICAL girl witch trials') === true, '(英文查询 vs 中文结果)');
}

console.log('\n── 5. 天气查询（2026-10-23 南京事故）──');
{
  check('实体词不是最长的类别词（南京 今天 明天 天气预报）',
    entityChunk('南京 今天 明天 天气预报') === '南京', entityChunk('南京 今天 明天 天气预报'));
  check('无空格时间前缀也能剥掉（今天南京天气）',
    entityChunk('今天南京天气') === '南京', entityChunk('今天南京天气'));
  check('日期不参与实体（南京天气 10月23日 气温）',
    entityChunk('南京天气 10月23日 气温') === '南京', entityChunk('南京天气 10月23日 气温'));
  check('天气查询重试词拼成「南京天气」',
    retryQueryFor('南京 今天 明天 天气预报') === '南京天气', retryQueryFor('南京 今天 明天 天气预报'));
  check('天气意图识别', isWeatherQuery('南京 气温') === true);
  check('地点提取', weatherLocation('今天南京天气') === '南京', weatherLocation('今天南京天气'));
  check('作品名里的天气不算天气查询', isWeatherQuery('天气之子 电影') === false);
  check('作品名实体保留「天气」', entityChunk('天气之子 电影') === '天气之子', entityChunk('天气之子 电影'));
  check('site: 查询不触发天气引擎', isWeatherQuery('site:mp.weixin.qq.com 南京天气') === false);
  check('site: 查询的实体忽略域名', entityChunk('site:mp.weixin.qq.com 南京天气') === '南京', entityChunk('site:mp.weixin.qq.com 南京天气'));

  // 真实故障现场：q=南京 今天 明天 天气预报，Bing 降级返回南京市百科/景点。
  const degraded = [
    { title: '南京市_百度百科', snippet: '南京市是江苏省省会，副省级市。' },
    { title: '南京必去景点大全（超详细），强烈推荐！ - 知乎', snippet: '南京市，简称宁，古称金陵。' },
  ];
  check('南京百科结果对天气查询算降级',
    looksOffTopic(degraded, '南京 今天 明天 天气预报') === true);
  check('南京百科结果对气温查询算降级',
    looksOffTopic(degraded, '南京 气温') === true);

  const goodWeather = [
    { title: '南京天气预报', snippet: '南京今天多云，20~25℃，明天阴，18~23℃。' },
  ];
  check('正常天气结果不误判',
    looksOffTopic(goodWeather, '南京 今天 明天 天气预报') === false);
  check('正常天气结果对「今天南京天气」也不误判',
    looksOffTopic(goodWeather, '今天南京天气') === false);
}

console.log('\n── 6. 源码接线（防漏接）──');
{
  const fs = await import('node:fs');
  const path = await import('node:path');
  const url = await import('node:url');
  const root = path.dirname(url.fileURLToPath(import.meta.url)) + '/..';
  const html = fs.readFileSync(path.join(root, 'src/web-search/engines/bing-html.mjs'), 'utf8');
  const rss = fs.readFileSync(path.join(root, 'src/web-search/engines/bing-rss.mjs'), 'utf8');
  const idx = fs.readFileSync(path.join(root, 'src/web-search/index.mjs'), 'utf8');
  const mcp = fs.readFileSync(path.join(root, 'src/mcp-web-search-safe.js'), 'utf8');
  const plan = fs.readFileSync(path.join(root, 'src/web-search/query-plan.mjs'), 'utf8');
  const weather = fs.readFileSync(path.join(root, 'src/web-search/engines/weather.mjs'), 'utf8');

  check('bing-html 降级后重试', /looksOffTopic\(first, query\)/.test(html) && /fetchOne\(retryQuery\)/.test(html));
  check('bing-html 使用实体词重试（不是最长词块）', /retryQueryFor\(query\)/.test(html));
  check('判定函数集中在 query-plan 并导出', /export function looksOffTopic/.test(plan) && /export function entityChunk/.test(plan) && /looksOffTopic/.test(html));
  check('bing-rss 复用同一判定', /from '\.\/bing-html\.mjs'/.test(rss) && /looksOffTopic/.test(rss) && /retryQueryFor/.test(rss));
  check('searchWeb 把 retriedWith 透传给调用方', /if \(res\?\.retriedWith\) extra\.retriedWith/.test(idx));
  check('MCP 工具把 retriedWith 告知模型', /retriedWith: result\.retriedWith, note/.test(mcp));
  check('MCP 提示模型不要把窄查询结果当成原查询答案', /不要把这些结果当成原查询的直接答案/.test(mcp));
  check('MCP 告知模型天气数据可直接引用', /Open-Meteo 的实时观测/.test(mcp));
  check('降级时返回空结果而不是无关条目', /results: \[\], degraded: true/.test(html));
  check('默认引擎链包含 weather', /DEFAULT_ENGINES = \['weather'/.test(idx));
  check('天气引擎调用 Open-Meteo geocoding + forecast',
    /geocoding-api\.open-meteo\.com/.test(weather) && /api\.open-meteo\.com\/v1\/forecast/.test(weather));
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
