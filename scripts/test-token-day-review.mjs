// 回归测试：Token 用量「按日审阅」。
//
// 需求（2026-10-21 用户）：「token用量卡片增加按日审阅的下拉菜单（默认总计），
// 按模型改成选择的日期按模型调用的token数」。
//
// ── 为什么必须在解析层加 dayModels ──────────────────────────────────────
//
// 原来只有两个维度的**边际汇总**：days（按天）与 models（全时段）。
// 「10-19 那天哪个模型用得最多」是**联合分布**，从两个边际汇总**推不出来**
// （某模型跨 3 天共 10M，无法知道每天各多少）。所以必须在看到每条 usage 时
// 同时按 (天, 模型) 分桶。这是本测试最核心的断言之一。
//
// 本测试锁住：
//   ① 解析层真的产出 dayModels，且与 days 的边际合计一致（交叉校验）
//   ② 旧缓存（没有 dayModels 字段）不会被当成命中——否则升级后显示空表
//   ③ API：?date= 切换模型明细；非法日期 400；无数据日期返回 0 而不是报错
//   ④ 前端：下拉默认「总计」、选项覆盖全部天数（不只表格那 14 天）、
//      切换会重新请求、口径提示不写错天数
import fs from 'node:fs';
import path from 'node:path';

let pass = 0, fail = 0;
const check = (n, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };

const root = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Z]:)/, '$1') + '/..';
const usageSrc = fs.readFileSync(path.join(root, 'src', 'token-usage.js'), 'utf8');

const consoleServerSrc = fs.readFileSync(path.join(root, 'src', 'console-server.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public', 'console.html'), 'utf8');

// ── 1. 解析层：dayModels 确实存在且自洽 ──
console.log('── 1. 解析层 ──');
{
  check('parseSessionFile 输出 dayModels', /dayModels/.test(usageSrc));
  check('按 (天, 模型) 同时分桶', /bump\(dayModels\[dk\] \|\| \(dayModels\[dk\] = \{\}\), m, u\)/.test(usageSrc));
  check('空结果也带 dayModels 字段（结构一致）',
    /return \{ days: \{\}, models: \{\}, dayModels: \{\}, turns, calls: 0, firstAt: 0, lastAt: 0 \}/.test(usageSrc));
  check('聚合层合并 dayModels', /for \(const \[d, mm\] of Object\.entries\(parsed\.dayModels/.test(usageSrc));
  check('返回值含 dayModels', /return \{ days, models, dayModels, turns, calls, sessions, cache, scanned, reused/.test(usageSrc));

  // ② 旧缓存兼容：这是最容易出静默 bug 的地方
  check('旧缓存（缺 dayModels）不算命中',
    /hit\.dayModels !== undefined/.test(usageSrc), '缺这个判断会让升级后首次统计显示空表');
  check('写缓存时带上 dayModels', /cache\[key\] = \{[\s\S]{0,200}?dayModels: parsed\.dayModels/.test(usageSrc));
}

// ── 2. 用真实数据做交叉校验（可选：会话目录存在时）──
console.log('\n── 2. 真实数据交叉校验 ──');
{
  const { aggregateTokenUsage } = await import('../src/token-usage.js');
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const sessionsRoot = path.join(home, '.dsh', 'sessions');
  let roots = [];
  try {
    for (const name of fs.readdirSync(sessionsRoot)) {
      if (name.includes('qq-bridge') && /-state-agents--$/i.test(name)) roots.push(path.join(sessionsRoot, name));
    }
  } catch { /* 没有目录就跳过 */ }

  if (!roots.length) {
    console.log('SKIP  真实数据校验（没有找到 qq-bridge 会话目录）');
  } else {
    const t0 = Date.now();
    // 只取少量文件，测试不该跑十几秒
    const agg = aggregateTokenUsage(roots, { cache: {}, maxFiles: 4 });
    const ms = Date.now() - t0;
    check('聚合产出 dayModels', !!agg.dayModels && Object.keys(agg.dayModels).length > 0,
      `${Object.keys(agg.dayModels || {}).length} 天 / ${ms}ms`);

    // **核心断言**：每天各模型的 calls 之和 == 当天 calls。
    // 这能抓出"分桶漏了一条"或"两个维度记到不同 usage 上"这类错误。
    let bad = [];
    for (const [day, mm] of Object.entries(agg.dayModels || {})) {
      const sum = Object.values(mm).reduce((a, v) => a + (Number(v.calls) || 0), 0);
      const dayCalls = Number(agg.days?.[day]?.calls) || 0;
      if (sum !== dayCalls) bad.push(`${day}: 模型合计 ${sum} ≠ 当天 ${dayCalls}`);
    }
    check('每天各模型 calls 之和 = 当天 calls', bad.length === 0, bad.slice(0, 3).join('; '));

    // 反过来：所有天所有模型加起来 == 全局 calls（两个维度必须闭合）
    const totalFromDays = Object.values(agg.dayModels || {})
      .reduce((a, mm) => a + Object.values(mm).reduce((b, v) => b + (Number(v.calls) || 0), 0), 0);
    check('dayModels 总量 = days 总量', totalFromDays === Object.values(agg.days || {})
      .reduce((a, v) => a + (Number(v.calls) || 0), 0), `${totalFromDays}`);

    // 每个模型出现在至少一天里，且该模型全局 calls 等于其在各天之和
    const perModel = {};
    for (const mm of Object.values(agg.dayModels || {})) {
      for (const [m, v] of Object.entries(mm)) perModel[m] = (perModel[m] || 0) + (Number(v.calls) || 0);
    }
    const mismatch = Object.entries(agg.models || {})
      .filter(([m, v]) => (Number(v.calls) || 0) !== (perModel[m] || 0))
      .map(([m, v]) => `${m}: 全局 ${v.calls} vs 按天 ${perModel[m] || 0}`);
    check('每个模型的全局 calls = 它各天之和', mismatch.length === 0, mismatch.slice(0, 3).join('; '));
  }
}

// ── 3. API 层 ──
console.log('\n── 3. API ──');
{
  check('支持 date 参数', /url\.searchParams\.get\('date'\)/.test(consoleServerSrc));
  check('date=all 走全时段', /dataParam === 'all'|dateParam === 'all'/.test(consoleServerSrc));
  check('非法日期返回 400', /date 应为 YYYY-MM-DD 或 all/.test(consoleServerSrc));
  check('按日期取 dayModels 分支', /data\.dayModels\?\.\[wantDate\]/.test(consoleServerSrc));
  check('返回值带 modelScope', /modelScope: wantAll \? 'all' : wantDate/.test(consoleServerSrc));
  check('返回值带 modelScopeUsage（当前口径合计）', /modelScopeUsage:/.test(consoleServerSrc));
  check('模型明细随日期切换', /const modelSource = wantAll \? \(data\.models \|\| \{\}\) : \(data\.dayModels\?\.\[wantDate\] \|\| \{\}\)/.test(consoleServerSrc));
  check('按会话表也随日期过滤', /scopeDay: wantAll \? '' : wantDate/.test(consoleServerSrc));
  check('返回值带 sessionScope', /sessionScope: sessionUsage\.scopeDay/.test(consoleServerSrc));
  // 落盘必须包含 dayModels，否则重启后丢失
  
}

// ── 4. 前端 ──
console.log('\n── 4. 前端 ──');
{
  check('有按日审阅下拉', /id="tokenDayPick"/.test(html));
  check('默认选项是总计', /<option value="all">总计（全时段）<\/option>/.test(html));
  check('选项用全部天数（不只表格那 14 天）',
    /const allDays = Array\.isArray\(r\.days\) \? r\.days : \[\]/.test(html)
    && /allDays\.map\(\(d\) => `<option value=/.test(html));
  check('切换会重新请求', /pickEl\.addEventListener\('change'[\s\S]{0,200}?refreshTokenUsage\(\)/.test(html));
  check('请求带上选中日期', /TK_SELECTED_DAY !== 'all'[\s\S]{0,120}?\?date=/.test(html));
  check('选择被保留（不因 60 秒轮询跳回总计）', /let TK_SELECTED_DAY = 'all'/.test(html));
  check('选中的天不存在时退回总计', /if \(!stillThere\) TK_SELECTED_DAY = 'all'/.test(html));

  // 口径提示不能写错天数（曾把"全时段"写成"14 天合起来"，两个数差了近一倍）
  check('全时段提示不写具体天数', /按模型显示全时段累计（所有已统计的天）/.test(html));
  // 只检查"会被渲染出来的字符串"，不查注释——注释里出现这几个字是在解释踩过的坑。
  const userVisible14 = /hintEl\.(?:textContent|innerHTML)\s*=\s*[`'"][^`'"]*14 天/.test(html);
  check('不出现「14 天合起来」这种错口径', !userVisible14);
  check('按模型的标题随日期变化', /按模型 · \$\{r\.modelScope\}/.test(html));
  check('按会话表使用 sessionScope', /const sessionScope = String\(r\.sessionScope \|\| 'all'\)/.test(html)
    && /当前会话当日/.test(html));
  check('数字列表头与内容右对齐', /\.tk-table th\.num, \.tk-table td\.num \{ text-align: right; \}/.test(html));
  check('按模型上方有合计行', /合计 总输入/.test(html));
  check('空日期有专门说明', /这一天没有任何模型调用记录/.test(html));
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
