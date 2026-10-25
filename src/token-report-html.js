// Token 消耗报表：数据 → 自包含 HTML（内联 CSS，无外部依赖）。
//
// 纯字符串拼接，不做 IO。渲染成 PNG 在 token-report-render.js。
//
// ── 视觉与功能菜单同一套语言 ─────────────────────────────────────────────
//
// 功能菜单海报已经在群里发过很多次，群友对那套深蓝头部 + 浅底白卡的样子有印象。
// 报表沿用同一套色板与字号层级，看起来是"同一台机器发出来的东西"，
// 而不是随便贴的一张贴图。宽度同样是 1080（QQ 缩略图在这个宽度下文字仍清晰）。
//
// ── 为什么图里要画柱状图而不是只列数字 ──────────────────────────────────
//
// 群友问"最近用了多少 token"，只给 7 行数字他们看不出趋势。一根柱子的高度
// 比"M 和 B 两个单位"直观得多。柱子用 div 的百分比高度实现——纯 CSS，
// 不引任何图表库（项目没有前端依赖，也不该为一张图引入）。
import { humanTokens } from './token-usage.js';

export function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export const REPORT_CSS = `
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  width: 1080px;
  color: #24324a;
  background: #eef3f7;
  font-family: "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif;
  -webkit-font-smoothing: antialiased;
}
.wrap { padding: 36px; background: radial-gradient(circle at 95% 0%, #e3edf7, transparent 45%), #eef3f7; }

/* ── 头部 ── */
.hero {
  display: flex; align-items: flex-end; justify-content: space-between; gap: 22px;
  padding: 34px 36px; border-radius: 24px;
  color: #fff; background: linear-gradient(120deg, #122943, #234864);
  box-shadow: 0 12px 30px rgba(26, 51, 78, .13);
}
.hero-txt { flex: 1; min-width: 0; }
.eyebrow { font-size: 18px; color: #abcfdf; letter-spacing: 2px; }
.eyebrow span { margin-left: 18px; padding-left: 18px; border-left: 1px solid #53758b; letter-spacing: 0; color: #d1e3ec; }
h1 { margin-top: 16px; font-size: 46px; font-weight: 700; line-height: 1.2; }
h1 small { display: block; margin-top: 8px; font-size: 22px; font-weight: 400; color: #c9e3ef; }
.asof { flex: none; text-align: right; font-size: 17px; color: #bcd7e4; line-height: 1.6; }
.asof b { display: block; font-size: 21px; font-weight: 600; color: #fff; }
.stale { display: inline-block; margin-top: 8px; padding: 5px 12px; border-radius: 999px; font-size: 15px; color: #122943; background: #ffd98a; }

/* ── 四个主数字 ── */
/* 列宽必须写 minmax(0, 1fr)。裸 1fr 等价于 minmax(auto, 1fr)，格子里的数字
   （34px 的 "1.06B" 加 tokens）会把最小内容宽度顶出去，整行溢出容器——
   实测第 4 张卡直接被截在图片右边缘之外。minmax(0,...) 才允许格子收缩。 */
.stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); align-items: stretch; gap: 18px; margin-top: 22px; }
/* 卡片内部用 flex 列 + sub 贴底：某张卡的副标题换行时（如"缓存命中"那句），
   四张卡仍保持等高，副标题一律落在同一条基线上，看起来才整齐。 */
.stat { display: flex; flex-direction: column; min-width: 0; padding: 22px 24px; border: 1px solid #d9e4ec; border-radius: 18px; background: #fff; box-shadow: 0 5px 12px rgba(26, 51, 78, .035); }
.stat .k { font-size: 17px; color: #60758a; }
.stat .v { margin-top: 10px; font-size: 34px; font-weight: 700; color: #19374d; letter-spacing: -.5px; white-space: nowrap; }
.stat .v em { font-style: normal; font-size: 18px; font-weight: 600; color: #4f899c; margin-left: 4px; }
.stat .sub { margin-top: auto; padding-top: 8px; font-size: 16px; color: #7a8fa2; }
.stat.accent { background: linear-gradient(150deg, #f4fbfd, #eaf4f8); border-color: #bcdde6; }

/* ── 区块 ── */
.sec { margin-top: 22px; padding: 26px 28px; border: 1px solid #d9e4ec; border-radius: 18px; background: #fff; box-shadow: 0 5px 12px rgba(26, 51, 78, .035); }
.sec-hd { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; }
.sec-hd h2 { font-size: 25px; font-weight: 700; color: #19374d; }
.sec-hd .hint { font-size: 16px; color: #7a8fa2; }

/* ── 柱状图 ── */
.chart { display: flex; align-items: flex-end; gap: 14px; height: 280px; margin-top: 22px; padding-top: 8px; }
.bar-col { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; height: 100%; }
.bar-val { font-size: 16px; font-weight: 600; color: #2a5f75; margin-bottom: 7px; white-space: nowrap; }
.bar-val.peak { color: #d08821; }
.bar-track { width: 100%; flex: 1; display: flex; align-items: flex-end; }
/* 用 CSS 渐变做色块：没有子元素高度取整，橙色/绿色边界能像素级贴合。
   颜色从下到上：命中缓存（蓝）→ 未命中（橙）→ 输出（绿）。 */
.stack { position: relative; width: 100%; border-radius: 8px 8px 3px 3px; overflow: hidden; min-height: 4px; background: #eef3f7; }
.stack.zero { background: #dfe8ee; }
.stack-label {
  position: absolute; left: 0; right: 0; bottom: 0;
  display: flex; align-items: center; justify-content: center;
  font-size: 12px; line-height: 1; font-weight: 700; color: #fff;
  text-shadow: 0 1px 2px rgba(0,0,0,.3); pointer-events: none;
}
.bar-col.peak .bar-val { color: #d08821; }
.bar-day { margin-top: 10px; font-size: 15px; color: #60758a; }
.bar-day.today { color: #19374d; font-weight: 700; }
.legend { display: flex; align-items: center; gap: 20px; margin-top: 14px; font-size: 15px; color: #60758a; }
.legend i { display: inline-block; width: 12px; height: 12px; border-radius: 3px; margin-right: 6px; vertical-align: -1px; }
.legend .hit { background: #4f899c; }
.legend .miss { background: #e8a33d; }
.legend .out { background: #6a9a63; }

/* ── 模型明细 ── */
.mrow { display: grid; grid-template-columns: 300px 1fr 118px 74px; align-items: center; gap: 16px; padding: 15px 0; border-bottom: 1px solid #eef3f7; }
.mrow:last-child { border-bottom: 0; }
.mname { font-size: 19px; font-weight: 600; color: #24455c; overflow-wrap: anywhere; }
.mbar { height: 16px; border-radius: 8px; background: #eef3f7; overflow: hidden; }
.mstack { position: relative; height: 100%; border-radius: 8px; overflow: hidden; }
.mstack-label {
  position: absolute; left: 0; top: 0; bottom: 0;
  display: flex; align-items: center; justify-content: center;
  font-size: 10px; line-height: 1; font-weight: 700; color: #fff;
  text-shadow: 0 1px 1px rgba(0,0,0,.3); pointer-events: none;
}
.mtotal { font-size: 19px; font-weight: 700; color: #19374d; text-align: right; }
.mshare { font-size: 16px; color: #60758a; text-align: right; }

/* ── 脚注 ── */
.foot { margin-top: 22px; padding: 20px 23px; border-left: 4px solid #4f899c; background: #e2edf1; border-radius: 0 12px 12px 0; }
.foot p { font-size: 17px; line-height: 1.72; color: #506d7e; }
.foot p + p { margin-top: 7px; }
.foot b { color: #244a5f; }
`;

const fmt = (x) => humanTokens(x);

/** 一张数字卡。 */
function statCard(label, value, unit, sub, accent = false) {
  return `<div class="stat${accent ? ' accent' : ''}">
    <div class="k">${escapeHtml(label)}</div>
    <div class="v">${escapeHtml(value)}${unit ? `<em>${escapeHtml(unit)}</em>` : ''}</div>
    <div class="sub">${escapeHtml(sub)}</div>
  </div>`;
}

/** 柱状图：未命中缓存 + 命中缓存 + 输出 的堆叠柱，顶端标总消耗。 */
function chartHtml(report) {
  const peakDay = report.bars.reduce((a, b) => (b.total > (a?.total ?? 0) ? b : a), null);
  const cols = report.bars.map((b) => {
    const zero = b.total <= 0;
    const peak = !zero && peakDay && b.day === peakDay.day;
    const h = zero ? 0 : Math.max(4, b.pct);
    const total = Number(b.total) || 0;
    const part = (v) => (total > 0 ? Math.max(0, Math.min(100, (Number(v) || 0) / total * 100)) : 0);
    const hit = part(b.cacheRead);
    const miss = part(b.uncachedInput ?? b.input);
    const out = part(b.output);
    const totalInput = Number(b.cacheRead) + Number(b.uncachedInput ?? b.input);
    const hitRate = totalInput > 0 ? (Number(b.cacheRead) / totalInput) * 100 : 0;
    const hitH = Math.max(0, 100 - out - miss);
    const hitEnd = Math.min(100, hitH + miss);
    const bg = `linear-gradient(to top, #347083 0 ${hitH}%, #d08821 ${hitH}% ${hitEnd}%, #6a9a63 ${hitEnd}% 100%)`;
    const label = !zero && hitH >= 12
      ? `<span class="stack-label" style="height:${hitH}%">命中 ${hitRate.toFixed(1)}%</span>`
      : '';
    const stack = zero
      ? '<div class="stack zero"></div>'
      : `<div class="stack" style="height:${h}%;background:${bg}" title="命中 ${escapeHtml(fmt(b.cacheRead))} · 未命中 ${escapeHtml(fmt(b.uncachedInput ?? b.input))} · 输出 ${escapeHtml(fmt(b.output))}">${label}</div>`;
    return `<div class="bar-col${peak ? ' peak' : ''}">
      <div class="bar-val${peak ? ' peak' : ''}">${zero ? '—' : escapeHtml(b.humanTotal)}</div>
      <div class="bar-track">${stack}</div>
      <div class="bar-day${b.day === report.today.day ? ' today' : ''}">${escapeHtml(b.label)}</div>
    </div>`;
  }).join('');
  return `<div class="chart">${cols}</div>`;
}

/** 模型明细行。 */
function modelRowsHtml(report) {
  if (!report.models.length) return '<p class="hint" style="margin-top:14px">还没有按模型的统计。</p>';
  return report.models.map((m) => {
    const total = Number(m.total) || 0;
    const input = Number(m.input) || 0;
    const cacheRead = Number(m.cacheRead) || 0;
    const output = Number(m.output) || 0;
    const pct = (v) => (total > 0 ? Math.max(0, Math.min(100, v / total * 100)) : 0);
    const hit = pct(cacheRead);
    const miss = pct(input);
    const out = pct(output);
    const totalInput = input + cacheRead;
    const hitRate = totalInput > 0 ? (cacheRead / totalInput) * 100 : 0;
    const hitEnd = Math.min(100, hit + miss);
    const bg = `linear-gradient(to right, #347083 0 ${hit}%, #d08821 ${hit}% ${hitEnd}%, #6a9a63 ${hitEnd}% 100%)`;
    // 命中段够宽才标；模型条整体很窄时小字会糊成一团
    const hitPx = (Math.max(1, m.pct) / 100) * 400 * (hit / 100);
    const label = hitPx >= 70
      ? `<span class="mstack-label" style="width:${hit}%">命中 ${hitRate.toFixed(1)}%</span>`
      : '';
    return `<div class="mrow">
      <div class="mname">${escapeHtml(m.name)}</div>
      <div class="mbar"><div class="mstack" style="width:${Math.max(1, m.pct)}%;background:${bg}">${label}</div></div>
      <div class="mtotal">${escapeHtml(m.humanTotal)}</div>
      <div class="mshare">${escapeHtml(String(m.share))}%</div>
    </div>`;
  }).join('');
}

/**
 * 生成报表 HTML。
 *
 * @param {object} report buildTokenReport() 的返回值
 * @param {{title?:string, now?:number}} opts
 */
export function buildTokenReportHtml(report, opts = {}) {
  const r = report ?? {};
  const title = String(opts.title || 'Token 用量').trim().slice(0, 60) || 'Token 用量';

  if (!r.hasData) {
    return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=1080">
<title>${escapeHtml(title)}</title><style>${REPORT_CSS}</style></head>
<body><div class="wrap">
  <header class="hero"><div class="hero-txt">
    <p class="eyebrow">运行统计 <span>还没有数据</span></p>
    <h1>${escapeHtml(title)}<small>暂时没有可统计的用量</small></h1>
  </div></header>
  <section class="sec"><p class="foot" style="margin:0">还没有找到本项目的 DSH 会话记录。可能是桥接刚部署、会话还没产生用量，或会话目录结构与预期不同。</p></section>
</div></body></html>`;
  }

  const staleBadge = r.stale ? `<span class="stale">数据已过期（${escapeHtml(r.ageText)}）</span>` : '';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=1080">
<title>${escapeHtml(title)}</title>
<style>${REPORT_CSS}</style>
</head>
<body>
<div class="wrap">
  <header class="hero">
    <div class="hero-txt">
      <p class="eyebrow">运行统计 <span>总输入 / 未缓存 / 输出</span></p>
      <h1>${escapeHtml(title)}<small>统计了 ${r.daysCovered} 天（${escapeHtml(r.firstDay)} 起）·共 ${r.turns} 轮对话 / ${r.calls} 次请求</small></h1>
    </div>
    <div class="asof">
      <b>截至 ${escapeHtml(r.lastDay)}</b>
      更新于 ${escapeHtml(r.ageText)}
      ${staleBadge}
    </div>
  </header>

  <div class="stats">
    ${statCard('今日总消耗', fmt(r.today.totalTokens), 'tokens', `未命中 ${fmt(r.today.input)} · 缓存命中 ${r.today.cacheHitRate}% · ${r.today.calls} 次请求`, true)}
    ${statCard('今日输出', fmt(r.today.output), 'tokens', `昨日输出 ${fmt(r.yesterday.output)}`)}
    ${statCard('累计总消耗', fmt(r.all.totalTokens), 'tokens', `${r.daysCovered} 天 · 未命中 ${fmt(r.all.input)} · 缓存读 ${fmt(r.all.cacheRead)}`)}
  </div>

  <section class="sec">
    <div class="sec-hd">
      <h2>最近 ${r.bars.length} 天用量</h2>
      <span class="hint">分色柱：未命中缓存 + 命中缓存 + 输出；蓝段标命中率，顶端为总消耗</span>
    </div>
    <div class="legend">
      <span><i class="miss"></i>未命中缓存</span>
      <span><i class="hit"></i>命中缓存</span>
      <span><i class="out"></i>输出</span>
    </div>
    ${chartHtml(r)}
  </section>

  <section class="sec">
    <div class="sec-hd">
      <h2>按模型</h2>
      <span class="hint">共 ${r.modelCount} 个模型 · 橙=未命中 / 蓝=命中（蓝段标命中率） · 占比按累计总用量（含缓存）</span>
    </div>
    ${modelRowsHtml(r)}
  </section>

  <footer class="foot">
    <p><b>口径：</b>总输入 = <b>未缓存输入 + 缓存读</b>，对应 provider 的 prompt_tokens；输出是 completion_tokens。输入按<b>每次请求累加</b>——同一段对话上下文每轮都要重发一遍，所以它会远大于「实际新读进去的字数」。缓存读是命中缓存、无需重算的部分，通常按折扣计费，不是免费。</p>
    <p>图上的数字来自桥接的定时统计（约每 6 小时或跨天更新），不是此刻的实时值。只统计本项目自己的 DSH 会话，不含机器上其它项目。</p>
  </footer>
</div>
<script>
  // 高度由内容决定：Chrome CLI 没有 full-page，先量高再截（与功能菜单同一套办法）。
  (function () {
    function measure() {
      document.documentElement.setAttribute('data-h', String(Math.ceil(document.querySelector('.wrap').getBoundingClientRect().height)));
    }
    measure();
    document.fonts.ready.then(measure);
    window.addEventListener('load', measure);
  })();
</script>
</body>
</html>`;
}
