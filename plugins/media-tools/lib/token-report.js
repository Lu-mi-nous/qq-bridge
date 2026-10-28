// Token 消耗报表：把 state/token-usage.json 的聚合结果整理成"给人看"的报表数据。
//
// 需求（2026-10-21 用户）：「让 bot 能够看到 token 消耗日志，能够以图片形式响应
// 群友要求 token 消耗量相关问题」。
//
// ── 分三层，各管一件事 ──────────────────────────────────────────────────
//
//   token-report.js        纯数据：把按天/按模型的累计值算成今日、昨日、近 7 天、
//                          累计、每模型占比、每日柱状条的相对高度。**不做 IO、不渲染。**
//   token-report-html.js   纯字符串：数据 → 自包含 HTML（内联 CSS，无外部依赖）。
//   token-report-render.js IO：HTML → Chrome 无头截图 → PNG（按内容指纹缓存）。
//
// 为什么拆这么细：数据可以单测（不用浏览器、不用磁盘），渲染可以复用功能菜单那套
// 截图逻辑，桥接只负责"取数 → 渲染 → 发图"。三者任一坏了都能单独定位。
//
// ── 数值口径（很重要，别把"用量"说成"花费"）────────────────────────────
//
// inputTokens 是**逐次请求的输入**累加：同一段对话上下文每次请求都要重发一遍，
// 所以它天然远大于"实际新读进去的字数"。cacheReadTokens 更夸张——命中缓存的部分
// 也会计进 input？不会，DSH 里它们是分开的字段，本模块也分开显示。
// 图像里一律标"Token 用量"，不出现"花了多少钱"，因为没有单价数据，不该瞎算。
import { humanTokens } from '../../../src/plugin-api/format.js';

/** 上海时区的 YYYY-MM-DD。 */
function dayKeyOf(ms) {
  try {
    return new Date(Number(ms)).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
  } catch {
    return '';
  }
}

/** 日期字符串往前推 n 天（按日历日，不按 24 小时）。 */
function shiftDay(day, delta) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day ?? ''));
  if (!m) return '';
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/** 未命中缓存的输入。 */
const uncachedOf = (v) => Number(v?.input) || 0;
/** 总输入 = 未缓存输入 + 缓存读（即 provider 的 prompt_tokens）。 */
const totalInputOf = (v) => (Number(v?.input) || 0) + (Number(v?.cacheRead) || 0);
/** 总 token = 总输入 + 输出。 */
const totalTokensOf = (v) => totalInputOf(v) + (Number(v?.output) || 0);
const hitRateOf = (v) => {
  const total = totalInputOf(v);
  return total > 0 ? Math.round(((Number(v?.cacheRead) || 0) / total) * 1000) / 10 : 0;
};

/** 把若干天的用量相加。 */
function sumDays(days, keys) {
  const out = { input: 0, output: 0, cacheRead: 0, reasoning: 0, calls: 0 };
  for (const k of keys) {
    const v = days?.[k];
    if (!v) continue;
    out.input += Number(v.input) || 0;
    out.output += Number(v.output) || 0;
    out.cacheRead += Number(v.cacheRead) || 0;
    out.reasoning += Number(v.reasoning) || 0;
    out.calls += Number(v.calls) || 0;
  }
  out.totalInput = out.input + out.cacheRead;
  out.totalTokens = out.totalInput + out.output;
  out.cacheHitRate = hitRateOf(out);
  return out;
}

/**
 * 模型名清洗。
 *
 * 实测会话里出现的是 `global:deepseek-v4.1-flash`、`cn:deepseek-v4.1-flash` 这种
 * "供应商前缀:模型名"的形态。前缀对群友没意义（他们只关心用的什么模型），
 * 但**合并会误导**：同名模型走了两个渠道，实际是两个不同的计费/限流池。
 * 所以保留原名，只把前缀换成括号注释，让图上一眼看出「同一个模型还有两个来源」。
 */
export function prettyModelName(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '(未知模型)';
  const m = /^([a-z0-9_-]+):(.+)$/i.exec(s);
  if (!m) return s;
  return `${m[2]}（${m[1]}）`;
}

/**
 * 生成报表数据。
 *
 * @param {{days?:Object, models?:Object, turns?:number, calls?:number, updatedAt?:number, files?:number}} usage
 *   state/token-usage.json 的内容
 * @param {object} opts
 *   - now         当前时间（默认 Date.now()；测试可注入）
 *   - recentDays  柱状图显示多少天（默认 7）
 *   - topModels   模型明细最多列几个（默认 5）
 *   - staleMs     超过多久算"数据过期"（默认 6 小时，供图上标注）
 * @returns {object} 供 HTML 渲染的纯数据
 */
export function buildTokenReport(usage, opts = {}) {
  const now = Number(opts.now) || Date.now();
  const dayCount = Math.max(3, Math.min(30, Number(opts.recentDays) || 7));
  const topModels = Math.max(1, Math.min(12, Number(opts.topModels) || 5));
  const staleMs = Math.max(0, Number(opts.staleMs) || 6 * 3600 * 1000);

  const days = usage?.days && typeof usage.days === 'object' ? usage.days : {};
  const models = usage?.models && typeof usage.models === 'object' ? usage.models : {};
  const allKeys = Object.keys(days).filter(Boolean).sort();

  const today = dayKeyOf(now);
  const yesterday = shiftDay(today, -1);

  // 近 N 天：**按日历补齐**（没说话的那天记 0），否则柱状图会把
  // 10-18 和 10-21 画成相邻两根，看起来像连续使用，其实是跳着的。
  const recent = [];
  for (let i = dayCount - 1; i >= 0; i--) {
    const d = shiftDay(today, -i);
    recent.push({ day: d, ...sumDays(days, [d]) });
  }

  // 柱高用**总 token**（未缓存输入 + 缓存读 + 输出），这才是 provider 口径。
  // 以前只算 input+output（漏掉 cacheRead），会把 4B 的日用量画成 150M 的柱子。
  const peak = Math.max(1, ...recent.map((d) => totalTokensOf(d)));
  const bars = recent.map((d) => ({
    day: d.day,
    label: d.day.slice(5),           // MM-DD
    input: d.input,
    uncachedInput: uncachedOf(d),
    cacheRead: d.cacheRead,
    output: d.output,
    calls: d.calls,
    totalInput: totalInputOf(d),
    total: totalTokensOf(d),
    // 相对高度（0~100）。空白天给 0，渲染层画成一条底线而不是齐平的柱子。
    pct: Math.round((totalTokensOf(d) / peak) * 100),
    humanTotal: humanTokens(totalTokensOf(d))
  }));

  const todaySum = sumDays(days, [today]);
  const yesterdaySum = sumDays(days, [yesterday]);
  const recentSum = sumDays(days, recent.map((d) => d.day));
  const allSum = sumDays(days, allKeys);

  // 按模型：按 (input+output) 降序，取前 N；剩下的合并成"其它"，
  // 避免模型一多就把图撑长（早期实测 6 个模型，再多就会挤）。
  const modelList = Object.entries(models).map(([name, v]) => ({
    raw: name,
    name: prettyModelName(name),
    input: Number(v.input) || 0,
    uncachedInput: Number(v.input) || 0,
    output: Number(v.output) || 0,
    cacheRead: Number(v.cacheRead) || 0,
    reasoning: Number(v.reasoning) || 0,
    calls: Number(v.calls) || 0,
    totalInput: totalInputOf(v),
    total: totalTokensOf(v)
  })).sort((a, b) => b.total - a.total);

  const shown = modelList.slice(0, topModels);
  const rest = modelList.slice(topModels);
  if (rest.length) {
    shown.push({
      raw: '(其它)',
      name: `其它 ${rest.length} 个模型`,
      input: rest.reduce((s, x) => s + x.input, 0),
      uncachedInput: rest.reduce((s, x) => s + x.input, 0),
      output: rest.reduce((s, x) => s + x.output, 0),
      cacheRead: rest.reduce((s, x) => s + x.cacheRead, 0),
      reasoning: rest.reduce((s, x) => s + x.reasoning, 0),
      calls: rest.reduce((s, x) => s + x.calls, 0),
      totalInput: rest.reduce((s, x) => s + x.totalInput, 0),
      total: rest.reduce((s, x) => s + x.total, 0)
    });
  }
  const modelPeak = Math.max(1, ...shown.map((m) => m.total));
  const modelRows = shown.map((m) => ({
    ...m,
    pct: Math.round((m.total / modelPeak) * 100),
    share: allSum.totalTokens > 0
      ? Math.round((m.total / allSum.totalTokens) * 1000) / 10
      : 0,
    humanTotal: humanTokens(m.total),
    humanInput: humanTokens(m.input),
    humanTotalInput: humanTokens(m.totalInput),
    humanOutput: humanTokens(m.output)
  }));

  // 缓存命中率：cacheRead / (input + cacheRead)。
  // 这是"这次请求里有多少是直接读缓存、不用重新算"的直观比例。
  // 分母用 input + cacheRead 而不是只 input：两个字段是分开统计的，
  // 只拿 input 当分母会算出 >100% 的荒谬值（实测 cacheRead 是 input 的 10 倍量级）。
  const cacheHitRate = (s) => {
    const denom = (Number(s.input) || 0) + (Number(s.cacheRead) || 0);
    return denom > 0 ? Math.round(((Number(s.cacheRead) || 0) / denom) * 1000) / 10 : 0;
  };

  const updatedAt = Number(usage?.updatedAt) || 0;
  const ageMs = updatedAt ? Math.max(0, now - updatedAt) : 0;

  return {
    generatedAt: now,
    updatedAt,
    // 数据来自哪次统计：图上要标出来，否则群友会以为这是"此刻实时"的数
    stale: !updatedAt || ageMs > staleMs,
    ageText: updatedAt ? humanAge(ageMs) : '从未统计',
    daysCovered: allKeys.length,
    firstDay: allKeys[0] ?? '',
    lastDay: allKeys[allKeys.length - 1] ?? '',
    turns: Number(usage?.turns) || 0,
    calls: Number(usage?.calls) || 0,
    files: Number(usage?.files) || 0,
    today: { day: today, ...todaySum, cacheHitRate: cacheHitRate(todaySum) },
    yesterday: { day: yesterday, ...yesterdaySum, cacheHitRate: cacheHitRate(yesterdaySum) },
    recent: { days: dayCount, ...recentSum, cacheHitRate: cacheHitRate(recentSum) },
    all: { ...allSum, cacheHitRate: cacheHitRate(allSum) },
    bars,
    models: modelRows,
    modelCount: modelList.length,
    // 没有数据时渲染层要显示"还没有用量记录"而不是一堆 0
    hasData: allKeys.length > 0
  };
}

/** "3 分钟前" / "5 小时前" 这类人话。 */
export function humanAge(ms) {
  const s = Math.max(0, Math.round(Number(ms) / 1000));
  if (s < 60) return '刚刚';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.round(h / 24)} 天前`;
}

/**
 * 一句话摘要（给 MCP 工具返回给模型的文本用）。
 *
 * 为什么要给文本而不只给图：模型需要知道"图里是什么"，才能在群友追问时回答，
 * 也才不会在图发出去后又凭印象胡说数字。这段文字和图上数字**同源**。
 */
export function summarizeTokenReport(r) {
  if (!r?.hasData) return '还没有任何 Token 用量记录（可能是桥接刚启用，或 DSH 会话目录里没有本项目的记录）。';
  const f = (x) => humanTokens(x);
  return [
    `今日（${r.today.day}）：总输入 ${f(r.today.totalInput)}（未缓存 ${f(r.today.input)} / 缓存读 ${f(r.today.cacheRead)}，命中 ${r.today.cacheHitRate}%）/ 输出 ${f(r.today.output)}，调用 ${r.today.calls} 次`,
    `昨日：总输入 ${f(r.yesterday.totalInput)}（未缓存 ${f(r.yesterday.input)} / 缓存读 ${f(r.yesterday.cacheRead)}）/ 输出 ${f(r.yesterday.output)}，调用 ${r.yesterday.calls} 次`,
    `近 ${r.recent.days} 天：总输入 ${f(r.recent.totalInput)} / 输出 ${f(r.recent.output)}，调用 ${r.recent.calls} 次`,
    `累计（${r.daysCovered} 天，截至 ${r.lastDay}）：总输入 ${f(r.all.totalInput)}（未缓存 ${f(r.all.input)} / 缓存读 ${f(r.all.cacheRead)}，命中 ${r.all.cacheHitRate}%）/ 输出 ${f(r.all.output)}，调用 ${r.all.calls} 次`,
    `数据更新于 ${r.ageText}${r.stale ? '（已过期，图上的数字不是此刻实时值）' : ''}`
  ].join('\n');
}
