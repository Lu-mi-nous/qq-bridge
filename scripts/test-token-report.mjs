// 回归测试：Token 用量报表（数据 → HTML → PNG → 发群）。
//
// 需求（2026-10-21 用户）：「让 bot 能够看到 token 消耗日志，能够以图片形式响应
// 群友要求 token 消耗量相关问题」。
//
// 本测试锁住七件事：
//   ① 口径正确：今日/昨日/近 N 天/累计的加总与日期补齐（周末没说话要画成空柱）
//   ② 缓存命中率不会算出 >100% 的荒谬值（分母必须含 cacheRead）
//   ③ 模型名清洗保留渠道差异（global / cn 是不同池，合并会误导）
//   ④ HTML 自包含、转义到位（模型名里有特殊字符不会破版）
//   ⑤ 空数据/损坏数据不崩，渲染成"没有记录"而不是一堆 0
//   ⑥ 摘要与报表数字同源（模型追问时不会答出和图上不一致的数）
//   ⑦ 接线：MCP 工具、工具开关、preset、桥接端点、控制台按钮都在
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildTokenReport, prettyModelName, humanAge, summarizeTokenReport } from '../src/token-report.js';
import { buildTokenReportHtml, escapeHtml } from '../src/token-report-html.js';
import { readConsoleSource } from './lib/console-src.mjs';

let pass = 0, fail = 0, skip = 0;
const check = (n, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };
const skipped = (n, why) => { skip++; console.log(`SKIP  ${n}  （${why}）`); };

const root = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Z]:)/, '$1') + '/..';

// 固定的"现在"，避免测试随真实时间漂移（跨日跑会随机失败）。
// 2026-10-21 20:00 +08:00 = 12:00 UTC
const NOW = Date.UTC(2026, 9, 21, 12, 0, 0);

// ── 1. 口径 ──
console.log('── 1. 口径 ──');
{
  const usage = {
    updatedAt: NOW - 5 * 60 * 1000,
    turns: 100,
    calls: 300,
    files: 3,
    days: {
      '2026-10-15': { input: 1000, output: 100, cacheRead: 10000, reasoning: 0, calls: 10 },
      '2026-10-19': { input: 5000, output: 500, cacheRead: 50000, reasoning: 0, calls: 50 },
      '2026-10-20': { input: 4000, output: 400, cacheRead: 40000, reasoning: 0, calls: 40 },
      '2026-10-21': { input: 3000, output: 300, cacheRead: 30000, reasoning: 0, calls: 30 }
    },
    models: {
      'global:deepseek-v4.1-flash': { input: 9000, output: 900, cacheRead: 90000, reasoning: 0, calls: 90 },
      'cn:deepseek-v4.1-flash': { input: 3000, output: 300, cacheRead: 30000, reasoning: 0, calls: 30 },
      'cn:glm-5.3': { input: 1000, output: 100, cacheRead: 10000, reasoning: 0, calls: 10 }
    }
  };
  const r = buildTokenReport(usage, { now: NOW });

  check('今日取对上', r.today.day === '2026-10-21' && r.today.input === 3000 && r.today.calls === 30);
  check('昨日取对上', r.yesterday.day === '2026-10-20' && r.yesterday.input === 4000);
  check('近 7 天包含今日与 10-15', r.recent.days === 7 && r.recent.input === 13000, String(r.recent.input));
  check('累计含全部天数', r.all.input === 13000 && r.all.calls === 130);
  check('天数覆盖正确', r.daysCovered === 4, String(r.daysCovered));
  check('首末日期正确', r.firstDay === '2026-10-15' && r.lastDay === '2026-10-21');

  // 柱状图必须按日历补齐 7 根，中间没说话的日子给 0（否则会画成"连续使用"）
  check('柱状图正好 7 根', r.bars.length === 7, String(r.bars.length));
  check('柱状图最后一天是今天', r.bars[6].day === '2026-10-21');
  const zeroDays = r.bars.filter((b) => b.total === 0).map((b) => b.day);
  check('空白日补成 0（不是缺行）', zeroDays.length === 3 && zeroDays.includes('2026-10-16'),
    zeroDays.join(','));
  check('空白日 pct 为 0', r.bars.filter((b) => b.total === 0).every((b) => b.pct === 0));
  check('峰值日 pct=100', r.bars[4].pct === 100, `10-19 → ${r.bars[4].pct}%`);

  // ② 缓存命中率：分母必须含 cacheRead，否则 30000/(3000) = 1000%
  check('缓存命中率不会超 100%', r.all.cacheHitRate <= 100, String(r.all.cacheHitRate));
  check('缓存命中率计算正确', r.today.cacheHitRate === 90.9,
    `30000/(3000+30000)=90.9%，实际 ${r.today.cacheHitRate}`);
  check('今日总输入 = 未缓存 + 缓存读', r.today.totalInput === 33000, String(r.today.totalInput));
  check('今日总 tokens 含输出', r.today.totalTokens === 33300, String(r.today.totalTokens));
  check('累计总输入包含所有缓存', r.all.totalInput === 143000, String(r.all.totalInput));
  check('柱状图用总 tokens（不是只算未缓存）', r.bars[4].total === 55500, String(r.bars[4].total));

  // ③ 模型名保留渠道
  check('模型名保留渠道前缀', prettyModelName('global:deepseek-v4.1-flash') === 'deepseek-v4.1-flash（global）');
  check('无前缀原样返回', prettyModelName('some-model') === 'some-model');
  check('空模型名有兜底', prettyModelName('') === '(未知模型)');
  check('两个渠道不合并', r.models.filter((m) => m.name.includes('deepseek-v4.1-flash')).length === 2);
  check('模型按总量降序', r.models[0].total >= r.models[1].total);
  check('占比合计约 100%', Math.abs(r.models.reduce((s, m) => s + m.share, 0) - 100) < 0.5,
    String(Math.round(r.models.reduce((s, m) => s + m.share, 0) * 10) / 10));

  // 新鲜度
  check('5 分钟前不算过期', r.stale === false && r.ageText === '5 分钟前', r.ageText);
  const old = buildTokenReport({ ...usage, updatedAt: NOW - 10 * 3600 * 1000 }, { now: NOW });
  check('10 小时前标记为过期', old.stale === true);
  check('ageText 说人话', humanAge(90 * 1000) === '2 分钟前' && humanAge(3 * 3600 * 1000) === '3 小时前');
}

// ── 2. 空数据与坏数据 ──
console.log('\n── 2. 空数据与坏数据 ──');
{
  const empty = buildTokenReport({ days: {}, models: {} }, { now: NOW });
  check('空数据 hasData=false', empty.hasData === false);
  check('空数据不崩、字段齐全', empty.today.input === 0 && empty.all.calls === 0 && empty.bars.length === 7);
  const html = buildTokenReportHtml(empty);
  // 注意别拿 CSS 注释里的示例串（"1.06B"）当判据——那是样式说明文字，不是正文数字。
  // 正确判据：空态里**没有数字卡区**，只有一句"没有记录"的说明。
  check('空数据渲染成"没有记录"而不是一堆 0',
    /没有可统计的用量|还没有找到/.test(html) && !/class="stats"/.test(html));
  check('空数据摘要说明原因', /还没有任何 Token 用量记录/.test(summarizeTokenReport(empty)));

  check('null 不崩', (() => { try { return buildTokenReport(null, { now: NOW }).hasData === false; } catch { return false; } })());
  check('未统计过（updatedAt=0）不崩',
    (() => { const x = buildTokenReport({ days: {}, updatedAt: 0 }, { now: NOW }); return x.ageText === '从未统计'; })());
  check('坏值当 0 处理', (() => {
    const x = buildTokenReport({ days: { '2026-10-21': { input: 'abc', output: null } } }, { now: NOW });
    return x.today.input === 0 && x.today.output === 0;
  })());
}

// ── 3. HTML ──
console.log('\n── 3. HTML ──');
{
  const usage = {
    updatedAt: NOW - 60 * 1000, turns: 9, calls: 19, files: 1,
    days: { '2026-10-21': { input: 1000, output: 200, cacheRead: 500, reasoning: 0, calls: 7 } },
    models: { 'evil<script>alert(1)</script>': { input: 1000, output: 200, cacheRead: 0, reasoning: 0, calls: 7 } }
  };
  const r = buildTokenReport(usage, { now: NOW });
  const html = buildTokenReportHtml(r, { title: 'Token 用量' });

  check('自包含（无外部资源）', !/<(?:img|link|script)[^>]+src=["']https?:/i.test(html) && !/@import/.test(html));
  check('内联了 CSS', /<style>/.test(html) && /\.chart\s*\{/.test(html));
  check('有量高脚本（Chrome CLI 无 full-page）', /data-h/.test(html) && /getBoundingClientRect/.test(html));
  check('模型名转义（不破版、不执行）', !/<script>alert/.test(html) && /&lt;script&gt;/.test(html));
  check('escapeHtml 处理引号', escapeHtml(`a"b'c<d>&`) === 'a&quot;b&#39;c&lt;d&gt;&amp;');
  check('标题出现在 h1 里', /<h1>Token 用量/.test(html));
  check('有过期提示位（未过期时不显示）', r.stale === false && !/数据已过期/.test(html));
  check('写清了"不是实时值"', /不是此刻的实时值/.test(html));
  check('写清了输入 token 是每次请求累加', /每次请求累加/.test(html));
  check('没有七天合计卡（用户要求删掉）', !/近 7 天合计|近 7 天总用量/.test(html));
  check('有今日总消耗/累计总消耗', /今日总消耗/.test(html) && /累计总消耗/.test(html));
  check('总消耗卡小字标未命中 token', /未命中 1.0K/.test(html));
  check('柱状图是分色堆叠（蓝/橙/绿渐变）', /linear-gradient\(to top/.test(html) && /#d08821/.test(html) && /#6a9a63/.test(html));
  check('按模型也是分色堆叠条', /class="mstack"/.test(html) && /linear-gradient\(to right/.test(html));
  check('命中率标在蓝段、未命中率已删除', /class="stack-label"[^>]*>命中/.test(html) && !/未命中 \d+(\.\d+)?%/.test(html));
  check('柱状图有图例', /class="legend"/.test(html) && /未命中缓存/.test(html) && /命中缓存/.test(html));
  check('柱顶显示总消耗', /class="bar-val"[^>]*>[^<]+/.test(html));
  check('没有编造金额', !/[¥$]\s*\d|元\/|美元|花费\s*\d/.test(html));

  const staleHtml = buildTokenReportHtml(buildTokenReport({ ...usage, updatedAt: NOW - 20 * 3600 * 1000 }, { now: NOW }));
  check('过期时显示黄标', /数据已过期/.test(staleHtml));
}

// ── 4. 摘要与报表同源 ──
console.log('\n── 4. 摘要同源 ──');
{
  const usage = {
    updatedAt: NOW - 60 * 1000, turns: 9, calls: 19, files: 1,
    days: {
      '2026-10-20': { input: 2000000, output: 200000, cacheRead: 0, reasoning: 0, calls: 11 },
      '2026-10-21': { input: 1000000, output: 100000, cacheRead: 0, reasoning: 0, calls: 7 }
    },
    models: { 'm': { input: 3000000, output: 300000, cacheRead: 0, reasoning: 0, calls: 18 } }
  };
  const r = buildTokenReport(usage, { now: NOW });
  const s = summarizeTokenReport(r);
  check('摘要含今日总输入（1.00M）', /今日.*总输入 1\.00M/.test(s), s.split('\n')[0]);
  check('摘要含调用次数', /调用 7 次/.test(s));
  check('摘要含累计', /累计/.test(s) && /3\.00M/.test(s), s.split('\n')[3]);
  check('摘要与报表数字一致（今日 input）',
    String(r.today.input) === '1000000' && s.includes('1.00M'));
  check('摘要提到数据更新于', /数据更新于/.test(s));
}

// ── 5. 渲染（真实浏览器，可选）──
console.log('\n── 5. 渲染 ──');
{
  const { findBrowser } = await import('../src/feature-menu-render.js');
  if (!findBrowser()) {
    skipped('真实渲染 PNG', '本机没有 Chrome/Edge');
  } else {
    const { renderTokenReport, REPORT_WIDTH } = await import('../src/token-report-render.js');
    const usage = {
      updatedAt: NOW - 60 * 1000, turns: 9, calls: 19, files: 1,
      days: {
        '2026-10-19': { input: 5000000, output: 500000, cacheRead: 0, reasoning: 0, calls: 40 },
        '2026-10-20': { input: 4000000, output: 400000, cacheRead: 0, reasoning: 0, calls: 30 },
        '2026-10-21': { input: 3000000, output: 300000, cacheRead: 0, reasoning: 0, calls: 20 }
      },
      models: {
        'global:deepseek-v4.1-flash': { input: 9000000, output: 900000, cacheRead: 0, reasoning: 0, calls: 80 },
        'cn:glm-5.3': { input: 3000000, output: 300000, cacheRead: 0, reasoning: 0, calls: 10 }
      }
    };
    const r = buildTokenReport(usage, { now: NOW });
    const t0 = Date.now();
    const out = await renderTokenReport(r, { force: true });
    const ms = Date.now() - t0;
    if (!out.ok) {
      check('渲染成功', false, out.error);
    } else {
      check('渲染成功', true, `${Math.round(out.bytes / 1024)}KB / ${ms}ms`);
      check('宽度固定 1080', out.width === REPORT_WIDTH, String(out.width));
      check('高度合理（不是一整条细线）', out.height > 400 && out.height < 4000, String(out.height));
      check('单次渲染在 15 秒内', ms < 15000, `${ms}ms`);
      // 第二次必须命中缓存（同一份数据不该重复起浏览器）
      const again = await renderTokenReport(r);
      check('同数据第二次命中缓存', again.ok && again.cached === true);
      check('缓存文件在 state/token-report 下', /state[\\/]token-report[\\/]token-report-[0-9a-f]{16}\.png$/.test(out.file), out.file);
    }
  }
}

// ── 6. 接线 ──
console.log('\n── 6. 接线 ──');
{
  const bridge = readConsoleSource();

  const mcp = fs.readFileSync(path.join(root, 'src', 'mcp-snowluma-safe.js'), 'utf8');
  const preset = fs.readFileSync(path.join(root, 'dsh', 'agent-presets', 'qq-chat-v2', 'agent.cordis.yml'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'public', 'console.html'), 'utf8');
  const { TOOL_FLAGS, toolNamesOf } = await import('../src/tool-flags.js');

  check('MCP 注册了 qq_token_report', /server\.tool\(\s*\n?\s*'qq_token_report'/.test(mcp));
  check('MCP 工具受 tokenReport 开关控制', /cfg\.socialV2\?\.tools\?\.tokenReport !== false/.test(mcp));
  check('工具清单里有 tokenReport', TOOL_FLAGS.some((x) => x.flag === 'tokenReport' && x.tools.includes('qq_token_report')));
  check('工具清单总工具数已同步', toolNamesOf().includes('qq_token_report'));

  check('桥接有发群端点', /pathname === '\/api\/socialV2\/token-report'/.test(bridge));
  check('桥接有控制台预览端点', /pathname === '\/api\/socialV2\/token-report-image'/.test(bridge));
  check('发群端点要求 agent token', /发送 Token 报表必须携带 agent token/.test(bridge));
  check('发群端点检查工具开关', /v2ToolEnabled\('tokenReport'\)/.test(bridge));
  check('预览端点返回 PNG', /'content-type': 'image\/png'/.test(bridge));
  check('返回值带与图同源的摘要', /summary: summarizeTokenReport\(report\)/.test(bridge));
  check('支持 fresh 重算', /refresh'\) === '1'/.test(bridge) && /await refreshTokenUsage\(\{\}\)/.test(bridge));
  check('会清理旧报表缓存', /pruneTokenReportCache\(/.test(bridge));

  check('preset 有 Token 用量规则', /【Token 用量/.test(preset));
  check('preset 禁止编数字', /不要自己算，也不要凭印象编数字|不要编一段数字冒充统计/.test(preset));
  check('preset 工具清单列出报表工具', /qq_token_report：生成 \*\*Token 用量统计图\*\*/.test(preset));

  check('控制台有生成报表按钮', /id="tokenReport"/.test(html));
  check('控制台有预览容器', /id="tokenReportPreview"/.test(html));
  check('控制台预览不落明文令牌到 URL', !/token-report-image\?.*consoleToken/.test(html));

  // CSP 必须放行 blob:（2026-10-21 实测坑）：预览用 fetch → Blob → createObjectURL，
  // 而 `default-src 'self'` **不包含 blob: 协议**，图片会被静默拦掉——
  // img 在、complete=true、naturalWidth=0，页面上只剩 alt 文字，控制台也无报错。
  // CSP 现在是**多行字符串拼接**（2026-10-22 为加 media-src/connect-src 拆开的），
  // 所以不能再用 `'...': "([^"]+)"` 抠单行字面量——那样只能拿到第一段。
  // 改成：把整个 SECURITY_HEADERS 块取出来，去掉换行与 + 拼接符，再按分号判断。
  const cspBlock = (() => {
    const i = bridge.indexOf("'Content-Security-Policy':");
    if (i < 0) return '';
    const j = bridge.indexOf('Cache-Control', i);
    return bridge.slice(i, j).replace(/\s*\+\s*/g, '').replace(/\\n/g, '');
  })();
  check('CSP 放行 blob: 图片', /img-src[^;]*blob:/.test(cspBlock), cspBlock.slice(0, 90));
  check('CSP 没有放宽 script-src 到 blob:', !/script-src[^;]*blob:/.test(cspBlock));
  check('CSP 仍限制脚本为 self', /script-src 'self'/.test(cspBlock));

  // 默认开启
  
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} 通过 / ${fail} 失败${skip ? ` / ${skip} 跳过` : ''}`);
process.exit(fail === 0 ? 0 : 1);
