// weather.mjs — 实时天气引擎（Open-Meteo，免 key）
//
// 为什么单独做一个引擎：搜索引擎只会返回「南京天气预报」这类站点标题，
// 摘要里通常没有实际温度；模型要么再 web_fetch 一次，要么直接说"搜不到实况"。
// 2026-10-23 群友问「南京天气」时，Bing 还把多词查询降级成「南京市百科」，
// 模型因此回「搜不到」。这里用 Open-Meteo 的公开 API 直接拿结构化数据，
// 一次 web_search 就能回答"今天多少度、下不下雨"。
//
// 触发条件：query-plan.mjs 判定为天气意图且能提取出地点（如「南京 今天 明天
// 天气预报」→ 南京）。非天气查询直接返回空，不影响引擎链；地点 geocode 不到
// 也返回空，让后面 Bing/百度 继续试。
//
// API：
//   https://geocoding-api.open-meteo.com/v1/search?name=南京&language=zh
//   https://api.open-meteo.com/v1/forecast?latitude=..&longitude=..&current=..&daily=..
// 两者都免 key，直连实测可用；失败时若配置了代理会再走一次 proxyGet。

import { weatherLocation } from '../query-plan.mjs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// WMO weather code -> 中文
const WMO = {
  0: '晴',
  1: '晴间多云',
  2: '多云',
  3: '阴',
  45: '雾',
  48: '雾凇',
  51: '小毛毛雨',
  53: '毛毛雨',
  55: '大毛毛雨',
  56: '冻毛毛雨',
  57: '强冻毛毛雨',
  61: '小雨',
  63: '中雨',
  65: '大雨',
  66: '冻雨',
  67: '强冻雨',
  71: '小雪',
  73: '中雪',
  75: '大雪',
  77: '米雪',
  80: '小阵雨',
  81: '阵雨',
  82: '强阵雨',
  85: '小阵雪',
  86: '强阵雪',
  95: '雷暴',
  96: '雷暴伴小冰雹',
  99: '雷暴伴大冰雹',
};
const wmoText = (code) => WMO[Number(code)] ?? `天气码 ${code}`;

const geocodeCache = new Map(); // `${name}` -> { at, place }

// Open-Meteo 对部分外国城市的中文名只能搜到中国/加拿大同名小镇
// （「东京」→ 江苏一个镇，「伦敦」→ 加拿大 London）。常见城市补英文别名。
const CITY_ALIASES = {
  '纽约': 'New York City',
  '东京': 'Tokyo',
  '伦敦': 'London',
  '巴黎': 'Paris',
  '洛杉矶': 'Los Angeles',
  '旧金山': 'San Francisco',
  '华盛顿': 'Washington',
  '莫斯科': 'Moscow',
  '悉尼': 'Sydney',
  '新加坡': 'Singapore',
  '首尔': 'Seoul',
  '柏林': 'Berlin',
  '罗马': 'Rome',
  '迪拜': 'Dubai',
  '多伦多': 'Toronto',
  '温哥华': 'Vancouver',
  '大阪': 'Osaka',
  '京都': 'Kyoto',
};

async function fetchText(url, { timeoutMs, proxy, httpText }) {
  try {
    return await httpText(url, {
      timeoutMs: Math.min(timeoutMs || 6000, 6000),
      headers: { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9' },
    });
  } catch (error) {
    // Open-Meteo 国内可直连；直连失败且配置了代理时再走一次代理。
    if (proxy) {
      return await httpText(url, {
        proxy,
        timeoutMs: Math.min(timeoutMs || 6000, 6000),
        headers: { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9' },
      });
    }
    throw error;
  }
}

/** Open-Meteo geocoding 不认「南京市/江苏省」这类行政后缀，生成几个候选依次试。 */
function geocodeCandidates(name) {
  const key = String(name || '').trim();
  const set = new Set();
  if (CITY_ALIASES[key]) set.add(CITY_ALIASES[key]);
  set.add(key);
  const noSuffix = key.replace(/[市区县省]$/g, '').trim();
  if (noSuffix) set.add(noSuffix);
  const city = key.match(/^(.{2,8}?市)/)?.[1]?.replace(/市$/, '').trim();
  if (city) set.add(city);
  for (const token of key.split(/[\s\u3000]+/)) if (token.length >= 2) set.add(token.trim());
  // 「北京朝阳」「上海浦东」这类市+区连写：先试开头的市名，再试结尾的区名。
  for (const n of [2, 3]) if (key.length > n) set.add(key.slice(0, n).trim());
  // 「江苏南京」「内蒙古呼和浩特」这类没有空格的省+市：从尾部取 2~4 字再试。
  if (!/[\s\u3000]/.test(key)) {
    for (const n of [2, 3, 4]) if (key.length > n) set.add(key.slice(-n));
  }
  return [...set].filter(Boolean);
}

async function geocode(name, opts) {
  const key = String(name || '').trim();
  const cached = geocodeCache.get(key);
  if (cached && Date.now() - cached.at < 60 * 60 * 1000) return cached.place;

  // 不"第一个命中就返回"：`广东深圳` 的「广东」会命中重庆一个同名小镇，
  // `北京朝阳` 的「朝阳」会命中重庆朝阳镇。把所有候选都查一遍，按人口取最大，
  // 才能稳定落到深圳/北京这类真正的大城市。
  let bestOverall = null;
  let lastError = null;
  const deadline = Date.now() + Math.min(Number(opts?.timeoutMs) || 12000, 12000);
  for (const candidate of geocodeCandidates(key).slice(0, 6)) {
    if (Date.now() > deadline) break;
    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(candidate)}&count=3&language=zh&format=json`;
    let text;
    try {
      text = await fetchText(url, opts);
    } catch (error) {
      lastError = error;
      continue;
    }
    let data;
    try { data = JSON.parse(text); } catch { continue; }
    const list = Array.isArray(data?.results) ? data.results : [];
    if (!list.length) continue;

    // 中文查询优先中国境内地点；同名地点按人口降序（"南京"有多个同名村庄）。
    const hasChinese = /[\u4e00-\u9fff]/.test(candidate);
    const pool = hasChinese ? list.filter((r) => r.country_code === 'CN') : list;
    const places = (pool.length ? pool : list).slice().sort((a, b) => Number(b.population || 0) - Number(a.population || 0));
    const best = places[0];
    if (!best?.latitude || !best?.longitude) continue;
    // 原名直接命中一个大城市就不用再查变体了；但外国城市的中文名可能只命中
    // 小城市（伦敦→加拿大 London），已有更大的别名结果时不能提前返回。
    if (candidate === key && Number(best.population || 0) >= 100000
      && (!bestOverall || Number(best.population || 0) > Number(bestOverall.population || 0))) {
      geocodeCache.set(key, { at: Date.now(), place: best });
      return best;
    }
    if (!bestOverall || Number(best.population || 0) > Number(bestOverall.population || 0)) {
      bestOverall = best;
    }
  }
  if (bestOverall) {
    geocodeCache.set(key, { at: Date.now(), place: bestOverall });
    return bestOverall;
  }
  if (lastError) throw lastError;
  return null;
}

function fmtDay(dateStr) {
  const md = String(dateStr || '').slice(5);
  return md || dateStr;
}

/** 历史天气/超出预报窗口的日期不归本引擎管，交给搜索引擎。 */
function weatherDateAllowed(query) {
  const q = String(query ?? '');
  if (/(?:昨天|前天|上周|上星期|上月|去年|历史)/.test(q)) return false;
  const m = q.match(/(?:(\d{4})\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/);
  if (!m) return true;
  const now = new Date();
  const year = m[1] ? Number(m[1]) : now.getFullYear();
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const target = new Date(year, month - 1, day);
  if (Number.isNaN(target.getTime())) return true;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diffDays = Math.round((target - today) / 86400000);
  return diffDays >= 0 && diffDays <= 6;
}

function buildSnippet(place, data) {
  const cur = data?.current ?? {};
  const daily = data?.daily ?? {};
  const times = Array.isArray(daily.time) ? daily.time : [];
  const lines = [];
  const placeLabel = [place.name, place.admin1, place.country].filter(Boolean).join('，');
  const observed = String(cur.time || '').replace('T', ' ');
  lines.push(`${placeLabel} 实时天气（${observed}${data?.timezone ? `，${data.timezone}` : ''}）：`);
  lines.push(
    `当前 ${cur.temperature_2m}°C，${wmoText(cur.weather_code)}，体感 ${cur.apparent_temperature}°C，` +
    `湿度 ${cur.relative_humidity_2m}%，降水 ${cur.precipitation ?? 0}mm，风速 ${cur.wind_speed_10m}km/h。`
  );
  if (times.length) {
    lines.push('未来几天：');
    const labels = ['今天', '明天', '后天'];
    for (let i = 0; i < Math.min(times.length, 5); i++) {
      const label = labels[i] ?? fmtDay(times[i]);
      const max = daily.temperature_2m_max?.[i];
      const min = daily.temperature_2m_min?.[i];
      const pop = daily.precipitation_probability_max?.[i];
      lines.push(
        `- ${label}（${fmtDay(times[i])}）${wmoText(daily.weather_code?.[i])}，` +
        `${min}~${max}°C${pop == null ? '' : `，降水概率 ${pop}%`}`
      );
    }
  }
  return lines.join('\n');
}

export default {
  id: 'weather',
  label: '实时天气（Open-Meteo）',
  proxyRequired: false,

  async search(query, { count = 8, timeoutMs = 12000, proxy = '', httpText }) {
    const location = weatherLocation(query);
    if (!location) return { engine: 'weather', results: [] };
    if (!weatherDateAllowed(query)) return { engine: 'weather', results: [] };

    const opts = { timeoutMs, proxy, httpText };
    const place = await geocode(location, opts);
    if (!place) return { engine: 'weather', results: [] };

    const url = new URL('https://api.open-meteo.com/v1/forecast');
    url.searchParams.set('latitude', String(place.latitude));
    url.searchParams.set('longitude', String(place.longitude));
    url.searchParams.set('current', 'temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m');
    url.searchParams.set('daily', 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max');
    url.searchParams.set('timezone', place.timezone || 'auto');
    url.searchParams.set('forecast_days', String(Math.min(7, Math.max(3, Number(count) || 5))));

    const text = await fetchText(url.toString(), opts);
    let data;
    try { data = JSON.parse(text); } catch { return { engine: 'weather', results: [] }; }
    if (!data?.current) return { engine: 'weather', results: [] };

    const snippet = buildSnippet(place, data);
    return {
      engine: 'weather',
      results: [{
        title: `${place.name} 实时天气与天气预报`,
        url: `https://www.open-meteo.com/en/docs?latitude=${place.latitude}&longitude=${place.longitude}`,
        snippet,
        source: 'Open-Meteo',
        observedAt: data.current.time,
        timezone: data.timezone,
      }],
    };
  },
};
