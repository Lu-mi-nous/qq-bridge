// 回归测试：控制台整体排版与卡片编号。
//
// 需求（2026-10-21 用户）：「重新调整控制台前端排版以及卡片编号」。
//
// 背景：之前 12 号附近是 12a/12b/12c/12d/12e/12g 这种「插队式」编号，
// 实际文档顺序是 12e → 12a → 12g → 12c → 12d → 12b，既乱序又跳号。
// 现在统一为连续编号 01~21（02b 是 02 的子卡，保留字母后缀），
// 并按「运行态 → 需要人处理的 → 状态 → 内容 → 配置」重排，
// 顶部加了目录方便跳转。本测试锁住这些不变量。
import fs from 'node:fs';
import path from 'node:path';
import { readConsoleSource } from './lib/console-src.mjs';

let pass = 0, fail = 0;
const check = (n, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };

const root = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Z]:)/, '$1') + '/..';
const html = fs.readFileSync(path.join(root, 'public', 'console.html'), 'utf8');
const consoleServerSrc = readConsoleSource();

// 按文档顺序取出所有卡片编号
// 注意：06（一代仿真模式）是可折叠卡片，sec-no 写在折叠头部而不是 <h2> 里。
// 这里按"所有 sec-no"取，保证计数与实际卡片数一致。
const nos = [...html.matchAll(/<span class="sec-no">([^<]+)<\/span>/g)].map((m) => m[1]);

console.log('── 1. 编号连续性 ──');
{
  console.log('  文档顺序:', nos.join(' '));
  check('卡片数量 ≥20', nos.length >= 20, String(nos.length));

  // 纯数字的编号必须从 01 连续递增（02b 跳过）
  const numeric = nos.filter((n) => /^\d+$/.test(n)).map(Number);
  const sorted = [...numeric].sort((a, b) => a - b);
  check('数字编号无重复', new Set(numeric).size === numeric.length,
    numeric.join(','));
  check('数字编号连续（1..N 无跳号）',
    sorted.every((v, i) => v === i + 1),
    sorted.join(','));
  // 字母后缀是"子卡"标记：02b（会话消息回看）与 17b（语音合成）。
  // 2026-10-22 重排：17b/17c 曾为省事而用字母后缀，导致编号混乱，
  // 已升为正式编号 18/19。现在只允许 02b（02 的"查看消息"子视图，语义从属）。
  const subCards = nos.filter((n) => /[a-z]/i.test(n)).join(',');
  check('字母后缀只剩 02b（17b/17c 已升为正式编号 18/19）', subCards === '02b', subCards);

  // 每张卡的「id / data-sec / sec-no」必须三者一致。
  // 这是重编号时最容易漏的：只改目录没改 id，点击目录就跳不过去，
  // 而 DOM 里看不出问题（实测踩到 sec-19 里装着 21 号卡）。
  //
  // 2026-10-22 改版注意：
  //   a) 外面多了两个**容器** section（#summaryGrid、#detailPool），它们不是卡片；
  //   b) 文件里还有注释/JS 字符串提到 `<section ...>`，不能当成真标签。
  // 所以这里只认**行首**的 <section（真结构都单独占行），并用 match 的真实下标定位。
  {
    const bad = [];
    for (const m of html.matchAll(/^[ \t]*<section([^>]*)>/gm)) {
      const attrs = m[1];
      const id = (/id="([^"]+)"/.exec(attrs) || [])[1] || '';
      const ds = (/data-sec="([^"]+)"/.exec(attrs) || [])[1] || '';
      if (id === 'summaryGrid' || id === 'detailPool') continue;  // 容器，不是卡片
      // 只认"自己的标题里有编号"：<h2 ...><span class="sec-no">NN</span>
      const secEnd = html.indexOf('</section>', m.index);
      const head = secEnd > m.index ? html.slice(m.index, secEnd) : '';
      const no = (/<h2[^>]*>\s*<span class="sec-no">([0-9a-z]+)<\/span>/.exec(head) || [])[1];
      if (!no) continue;
      if (id !== `sec-${no}` && ds !== no) bad.push(`${id || '(no id)'} / no=${no}`);
    }
    check('每张卡的 id/data-sec 与编号一致', bad.length === 0, bad.slice(0, 3).join('; '));
  }
}

console.log('\n── 2. 编号与文档顺序一致（不再乱序）──');
{
  // 数字部分必须严格递增（带字母后缀的子卡插在父编号之后是允许的）
  let prev = 0;
  let ok = true;
  for (const n of nos) {
    if (/[a-z]/i.test(n)) continue;
    const v = Number(n);
    if (!(v > prev)) { ok = false; break; }
    prev = v;
  }
  check('编号随文档顺序递增', ok, nos.join(' '));

  // 曾经的乱序特征：12 后面跟着 12a/12e/12g 这类
  check('不再有 12a~12g 这类插队编号', !/sec-no">12[a-z]</i.test(html),
    (html.match(/sec-no">12[a-z]</i) || []).join(','));
}

console.log('\n── 3. 关键卡片编号 ──');
{
  const findNo = (title) => {
    const m = new RegExp(`<span class="sec-no">([^<]+)</span>${title}`).exec(html);
    return m ? m[1] : '';
  };
  check('控制台访问令牌 = 13', findNo('控制台访问令牌') === '13', findNo('控制台访问令牌'));
  check('加好友 / 入群请求 = 14', findNo('加好友 / 入群请求') === '14', findNo('加好友 / 入群请求'));
  check('取图额度 = 15', findNo('取图额度') === '15', findNo('取图额度'));
  check('Token 用量 = 16', findNo('Token 用量') === '16', findNo('Token 用量'));
  check('B 站自己刷视频 = 17', findNo('B 站自己刷视频') === '17', findNo('B 站自己刷视频'));
  check('凭据与连接配置 = 20', findNo('凭据与连接配置') === '20', findNo('凭据与连接配置'));
  check('安全拦截通知 = 12', findNo('安全拦截通知') === '12', findNo('安全拦截通知'));
}

console.log('\n── 4. 目录已移除（2026-10-22 用户要求）──');
{
  // 首页已经是一屏摘要卡，目录不再有存在价值（用户明确要求删掉）。
  check('不再有目录容器', !/id="toc"/.test(html));
  check('不再有 data-toc 目录项', !/data-toc=/.test(html));
  check('目录样式已清理', !/\.toc-item/.test(html) && !/\.toc-list/.test(html));
  check('目录点击处理器已移除', !/\[data-toc\]/.test(html));
}

console.log('\n── 4b. 摘要卡 + 全页详情外壳（2026-10-22 改版）──');
{
  // 首页 = 摘要卡网格；24 个详情卡全部收进 #detailPool 由 JS 搬进整页。
  check('有摘要卡网格容器', /class="summary-grid" id="summaryGrid"/.test(html));
  check('有详情卡容器', /class="grid" id="detailPool"/.test(html));
  // 关键坑：`.grid { display:grid }` 会压过 UA 的 [hidden]，池子藏不住
  check('详情池 hidden 时确实隐藏（!important 兜住 .grid）',
    /#detailPool\[hidden\] \{ display: none !important; \}/.test(html));
  check('JS 初始化时隐藏详情池', /DETAIL_POOL\.hidden = true/.test(html));
  check('有生成摘要卡的函数', /function buildSummaryCard\(/.test(html));
  check('有初始化入口且首屏调用', /function initConsoleShell\(/.test(html) && /^initConsoleShell\(\);/m.test(html));
  // 02b 是 02 的二级视图，不单独占摘要卡
  check('02b 不单独建卡', /if \(no === '02b'\) continue;/.test(html));
  check('02b 在 02 全页内展开', /DETAIL_PAGE\.body\.appendChild\(card\)/.test(html));

  // 全页详情骨架与可访问性（2026-10-22 用户要求：不弹窗，直接铺满整页）
  check('有整页详情容器', /<section class="detail-page" id="detailPage"/.test(html));
  check('整页默认 hidden', /id="detailPage"[^>]*hidden/.test(html));
  check('整页有返回按钮', /id="detailBack"/.test(html));
  check('整页有内容容器', /id="detailPageBody"/.test(html));
  check('整页有独立标题', /id="detailPageTitle"/.test(html) && /id="detailPageNo"/.test(html));
  check('不再有卡片弹窗外壳', !/id="cardModalOverlay"/.test(html) && !/class="[^"]*card-modal/.test(html));
  check('摘要卡用 aria-expanded/controls 表达展开状态',
    /aria-controls', 'detailPage'/.test(html) && /aria-expanded', 'false'/.test(html));
  check('点击摘要卡走整页打开函数',
    /addEventListener\('click', \(\) => openCardPage\(no, btn\)\)/.test(html));
  check('整页用轻量 FLIP 展开（不生成整页快照）',
    /const ghost = document\.createElement\('div'\);/.test(html)
    && /ghost\.className = 'detail-ghost'/.test(html)
    && /ghost\.style\.transform =/.test(html)
    && !/startViewTransition/.test(html));
  check('展开/返回用同一条缓动曲线',
    (html.match(/cubic-bezier\(\.4, 0, \.2, 1\)/g) || []).length >= 2);
  check('返回时内容先淡出（不压小文字）',
    /\.detail-page\.manual-exit \.detail-shell \{[\s\S]{0,120}?opacity: 0;/.test(html));
  check('展开终点是详情白卡矩形，不是视口',
    /const sectionRect = sec\.getBoundingClientRect\(\)/.test(html)
    && /Math\.min\(window\.innerWidth, sectionRect\.right\)/.test(html)
    && /Math\.min\(window\.innerHeight, sectionRect\.bottom\)/.test(html));
  check('返回时只缩大白卡（ghost 从 section 矩形开始）',
    /const rawFrom = sec\.getBoundingClientRect\(\)/.test(html)
    && /to\.left - from\.left/.test(html));
  check('展开 ghost 不带边框/阴影（避免放大成粗灰边）',
    /\.detail-ghost \{[\s\S]{0,520}?border: 0;[\s\S]{0,220}?box-shadow: none;/.test(html));
  check('详情内容在白面到位后才淡入',
    /\.detail-page\.manual-enter\.open \.detail-shell \{[\s\S]{0,140}?transition: opacity \.18s ease-out \.54s;/.test(html));
  check('打开整页时暂停背景波浪',
    /detailpagechange/.test(html) && /paused = !!e\.detail\?\.open/.test(html));
  check('返回按钮绑定 closeCardPage', /DETAIL_PAGE\.back\?\.addEventListener\('click', closeCardPage\)/.test(html));
  // 摘要网格不 hidden，只 inert：返回时卡片还在原位置
  check('整页打开时摘要网格保留布局（仅 inert）',
    /SUMMARY_GRID\.setAttribute\('inert', ''\)/.test(html) && !/SUMMARY_GRID\.hidden = true/.test(html));
  check('不再有弹窗尺寸映射', !/CARD_MODAL_SIZE/.test(html) && !/data-modal-size=/.test(html));
  check('整页可滚动且阻止滚动链', /\.detail-page \{[\s\S]{0,220}?overflow-y: auto;[\s\S]{0,120}?overscroll-behavior: contain;/.test(html));

  // 24 上下文与记忆（Phase 0/1）
  check('有上下文与记忆卡 24', /id="sec-24"/.test(html) && /sec-no">24</.test(html));
  check('上下文卡有状态/容器/刷新',
    /id="ctxStatusLine"/.test(html) && /id="ctxBody"/.test(html) && /id="ctxRefresh"/.test(html));
  check('上下文卡会拉 context-status',
    /function refreshContextStatus\(/.test(html) && /\/api\/socialV2\/context-status\?t=\$\{Date\.now\(\)\}/.test(html));
  check('24 刷新按钮有进行中/成功/失败反馈',
    /btn\.textContent = '刷新中…'/.test(html) && /已更新 \$\{new Date/.test(html) && /刷新失败，请查看状态行/.test(html));
  check('24 刷新期间禁用按钮防重复点击',
    /btn\.disabled = true/.test(html) && /if \(!btn \|\| btn\.disabled\) return;/.test(html));
  // 2026-10-22 用户截图：24 号弹窗里表格盖住说明文字和「刷新」按钮。
  // 根因是容器只有 max-height、没有 overflow，表格直接画到容器外。
  check('24 表格容器自己滚动（overflow:auto）',
    /#ctxBody \.ctx-scroll \{[\s\S]{0,180}?overflow: auto;/.test(html));
  check('24 不再用无 overflow 的内联 max-height',
    !/id="ctxBody"[^>]*max-height/.test(html) && !/<div class="scroll-area" style="max-height:420px">/.test(html));
  check('24 表格有横向滚动兜底', /#ctxBody \.ctx-table \{ min-width: 940px; \}/.test(html));
  check('24 表头滚动时固定在顶部',
    /#ctxBody \.ctx-table thead th \{[\s\S]{0,160}?position: sticky; top: 0;/.test(html));
  check('24 操作列右对齐且不换行',
    /#ctxBody \.ctx-table th:last-child,[\s\S]{0,200}?text-align: right; white-space: nowrap;/.test(html));
  check('24 说明文字在表格外（不会叠在行上）', /class="meta ctx-note"/.test(html));
  check('24 表有长期记忆列并注明三项含义', html.includes('>长期（人物/事实/未结线索）</th>') && /x\.longTerm/.test(html));
  check('24 表有消息日志列', html.includes('>日志</th>') && /x\.journalBytes/.test(html));
  check('24 会话列显示群名/QQ昵称', /x\.displayName/.test(html) && /keyLabel/.test(html));
  check('24 长期列可打开详情弹窗', /data-ctx-mem=/.test(html) && /id="ctxMemOverlay"/.test(html));
  check('24 长期详情有重建按钮', /id="ctxMemRebuild"/.test(html));
  check('24 状态行汇总长期记忆', html.includes('长期 ${t.people'));
  check('24 有记忆检索面板',
    /id="ctxSearchKey"/.test(html) && /id="ctxSearchInput"/.test(html)
    && /id="ctxSearchBtn"/.test(html) && /function ctxSearch\(/.test(html));
  check('24 有积压趋势与覆盖率/召回列',
    /id="ctxBacklogTrend"/.test(html) && /function renderBacklogTrend\(/.test(html)
    && html.includes('>覆盖 / 召回</th>'));
  check('24 有手动追赶按钮', /data-ctx-catchup=/.test(html) && /function ctxCatchup\(/.test(html));
  check('24 有重建索引入口',
    /id="ctxRebuildIndex"/.test(html) && /context-rebuild-index/.test(html)
    && /function ctxRebuildIndex\(/.test(html));
  check('24 长期详情显示检索命中审计', /最近检索命中/.test(html) && /data\?\.recallAudit/.test(html));
  check('24 有跨会话人物记忆面板',
    /id="ctxSharedPanel"/.test(html) && /id="ctxSharedEnabled"/.test(html)
    && /function loadSharedMemoryPanel\(/.test(html) && /shared-memory-config/.test(html));
  check('24 共享面板可忘记/清空',
    /data-shared-forget=/.test(html) && /shared-memory-forget/.test(html)
    && /shared-memory-clear/.test(html));
  check('24 有记忆断层提醒面板',
    /id="ctxGapPanel"/.test(html) && /id="ctxGapEnabled"/.test(html)
    && /function loadGapPanel\(/.test(html) && /gapNotice/.test(html));
  check('24 刷新后恢复表格滚动位置',
    /const prevTop = prevScroll \? prevScroll\.scrollTop : 0;/.test(html)
    && /nextScroll\.scrollTop = prevTop;/.test(html));

  // ── 数量类摘要必须数"真实行"，不能数子节点 ──
  // 事故（2026-10-22）：03 卡片显示「1 条待处理」，点开却是空的。
  // 因为列表渲染成一张 <table> / 一个 .sess-list 容器，子节点永远只有 1 个；
  // 02 也因此永远显示「1 个会话」。
  check('02 摘要数 .sess-row', /querySelectorAll\('#sessionList \.sess-row'\)\.length/.test(html));
  check('03 摘要数表格行并减去表头',
    /querySelectorAll\('#pendingList table tr'\)\.length/.test(html)
    && /pendingRows > 0 \? pendingRows - 1 : 0/.test(html));
  // 注释里会提到它的名字（记录为什么删掉），所以只断言"函数定义不存在"
  check('不再用"数子节点"的 summaryCountOf', !/function summaryCountOf\(/.test(html));

  // ── 卡片外观（2026-10-22 用户要求：统一尺寸、默认只显示序号+名称、悬停露出简介）──
  check('摘要卡固定高度（所有卡尺寸一致）',
    /\.summary-card \{[\s\S]{0,700}?height: 136px;/.test(html));
  check('摘要卡内容默认水平垂直都居中',
    /\.summary-card \{[\s\S]{0,400}?align-items: center;[\s\S]{0,120}?justify-content: center;[\s\S]{0,120}?text-align: center;/.test(html));
  check('序号+名称包成 .sc-main 整体',
    /const main = document\.createElement\('span'\);[\s\S]{0,120}?className = 'sc-main'/.test(html));
  check('悬停时名称整体上移',
    /\.summary-card:hover \.sc-main,[\s\S]{0,80}?transform: translateY\(-26px\)/.test(html));
  check('简介默认隐藏、悬停浮现',
    /\.summary-card \.sc-summary \{[\s\S]{0,500}?opacity: 0;/.test(html)
    && /\.summary-card:hover \.sc-summary,[\s\S]{0,80}?opacity: 1/.test(html));
  check('简介不占默认布局（绝对定位）',
    /\.summary-card \.sc-summary \{[\s\S]{0,140}?position: absolute;/.test(html));
  check('名称允许两行（长标题不截成省略号）',
    /\.summary-card \.sc-title \{[\s\S]{0,320}?-webkit-line-clamp: 2/.test(html));

  // 摘要卡悬停：光泽必须在内容下面，否则会盖住文字
  check('光泽分层：卡片 overflow + isolation',
    /\.summary-card \{[\s\S]{0,600}overflow: hidden;[\s\S]{0,200}isolation: isolate;/.test(html));
  check('光泽分层：内容抬到 z-index 1',
    /\.summary-card > \* \{ position: relative; z-index: 1; \}/.test(html));
  check('有跟随鼠标的柔光伪元素',
    /\.summary-card::before \{[\s\S]{0,300}radial-gradient\(240px circle at var\(--mx/.test(html));

  // 仿 SnowLuma 登录页的布料波浪
  check('有交互波浪画布', /id="waveCanvas"/.test(html) && /function initWaveField\(\)/.test(html));
  check('波浪监听鼠标并尊重 reduced-motion',
    /window\.addEventListener\('pointermove'/.test(html)
    && /prefers-reduced-motion: reduce/.test(html) && /reduce\.matches/.test(html));
  // 布料感来自「位移对 x 有足够导数」：相位里带 base 系数，相邻竖线才会堆出折痕
  check('折痕含随 x 变化的相位（布料堆积）',
    /function foldAt\(base, y, t\)[\s\S]{0,400}?base \* 0\.0120/.test(html));
  check('鼠标拨动后有回弹（弹簧）', /p\.v \+= \(target - p\.u\) \* 52 \* dt/.test(html));
  check('回弹有阻尼（不会一直抖）', /p\.v \*= Math\.exp\(-2\.4 \* dt\)/.test(html));
  check('相邻点耦合让波纹沿纤维传开',
    /\(\(up \+ dn\) \* 0\.5 - p\.u\) \* 34/.test(html));

  // 层级：整页视图必须低于黑话弹窗(1000)与凭据说明(1200)，否则被盖住
  check('整页视图 z-index 低于既有浮层',
    /\.detail-page \{[\s\S]{0,160}?z-index: 900;/.test(html));
  // 背景 inert（打开时焦点不跑到后面的摘要卡上）
  check('打开整页时给背景加 inert', /SUMMARY_GRID\.setAttribute\('inert', ''\)/.test(html));
  // 焦点还原
  check('返回后焦点还原到触发卡片', /card\.focus\(\{ preventScroll: true \}\)/.test(html));
  // Esc 返回（上层浮层打开时不误退）
  check('Esc 可返回功能列表',
    /e\.key !== 'Escape' \|\| !DETAIL_PAGE\.openNo/.test(html) && /closeCardPage\(\)/.test(html));
  check('上层浮层打开时 Esc 不误退整页',
    /\.doc-overlay\.open/.test(html) && /slangModalOverlay/.test(html));

  // 新动效必须全部纳入 reduced-motion：背景波浪、摘要卡入场、呼吸圆点
  check('reduced-motion 覆盖背景波浪',
    /@media \(prefers-reduced-motion: reduce\)[\s\S]{0,900}?\.wave-field \{ opacity: \.3; \}/.test(html));
  check('reduced-motion 覆盖整页动画',
    /\.detail-page\.manual-enter,[\s\S]{0,200}?\{ transition: none; \}/.test(html));
  check('reduced-motion 隐藏展开 ghost',
    /\.detail-ghost \{ display: none !important; \}/.test(html));
  check('reduced-motion 覆盖摘要卡入场',
    /\.summary-card \{ animation: none !important; opacity: 1 !important; transform: none !important; \}/.test(html));
  check('reduced-motion 覆盖呼吸圆点', /\.summary-card \.sc-dot \{ animation: none; \}/.test(html));
  check('reduced-motion 下名称/简介不做过渡',
    /\.sc-main, \.sc-summary \{ transition: none; \}/.test(html));
  check('动画时长统一走 --anim-dur', /animation: cardEnter var\(--anim-dur\)/.test(html));
}

console.log('\n── 4c. 04 活动日志：消息状态流 ──');
{
  check('活动日志改为消息状态流容器', /<div class="msg-feed" id="activity">/.test(html));
  check('有实时状态汇总行', /id="activityStatusLine"/.test(html));
  check('不再用 pre 承载活动日志', !/<pre id="activity">/.test(html));
  check('有状态 pill 样式', /\.msg-pill\.pending/.test(html) && /\.msg-pill\.processing/.test(html));
  check('1 秒轮询 activity-feed',
    /setInterval\(\(\) => \{ void refreshActivityFeed\(\); \}, 1000\)/.test(html));
  check('刷新时保留滚动位置', /const atBottom = feed\.scrollHeight - feed\.scrollTop - feed\.clientHeight < 30;/.test(html));
}

console.log('\n── 5. 布局类 ──');
{
  // 2026-10-21 改成 6 列基础网格（原来 auto-fit 恰好 3 列）：
  // 3 列放不下「2 张 + 2 张」的四卡分组（02/03/04/05），必然有一张落单、
  // 右侧空出整列。6 同时能被 2 和 3 整除，2 列组与 3 列组都能排满。
  check('基础网格是 6 列', /grid-template-columns: repeat\(6, minmax\(0, 1fr\)\)/.test(html));
  check('普通卡跨 2 列（= 原三列效果）', /\.grid > \.card \{ grid-column: span 2; \}/.test(html));
  check('成对卡跨 3 列（2×2 用）', /\.card\.card-half \{ grid-column: span 3; \}/.test(html));
  check('宽卡跨 4 列', /\.card\.card-2col \{ grid-column: span 4; \}/.test(html));
  // 特异度陷阱：`.grid > .card`(0,2,0) 会压过 `.span-all`(0,1,0)，
  // 实测导致 06/07/08 退化成窄卡挤一行。整行规则必须写成 .grid > .card.span-all。
  check('整行规则有足够特异度（否则被普通卡压过）',
    /\.grid > \.card\.span-all \{ grid-column: 1 \/ -1; \}/.test(html));
  check('旧的单类 .span-all 规则已移除', !/^\s{2}\.span-all \{ grid-column/m.test(html));
  check('窄屏退化为整行', /@media \(max-width: 900px\)[\s\S]{0,240}?grid-column: 1 \/ -1;/.test(html));
  check('旧的 cred-span2 已改名（不再只服务凭据卡）', !/cred-span2/.test(html));
  // Token 与凭据卡内容较宽，应跨两列
  check('Token 卡跨整行（表格+柱状需要宽度）', /class="card span-all" id="tokenCard"/.test(html));
  check('凭据卡跨两列', /class="card card-2col" id="credCard"/.test(html));
  // 02/03/04 三张成对布局；05 人格卡改为整行（按群列表需要宽度）
  for (const id of ['sec-02', 'sec-03', 'sec-04']) {
    check(`${id} 用成对布局`, new RegExp(`id="${id}" class="[^"]*card-half`).test(html));
  }
  check('05 人格卡改为整行', /id="sec-05" class="[^"]*span-all[^"]*role-card/.test(html));
  // 06/07 这类超大卡必须整行（用户明确要求「一代二代仿真模式这种超大卡片
  // 就用单列布局，不要改」）。取 class 属性判断，不依赖属性书写顺序。
  const classOf = (id) => {
    const tag = new RegExp(`<section[^>]*\\bid="${id}"[^>]*>`).exec(html)?.[0] ?? '';
    return /class="([^"]*)"/.exec(tag)?.[1] ?? '';
  };
  check('06 保持整行', /\bspan-all\b/.test(classOf('cardReserved')), classOf('cardReserved'));
  check('07 保持整行', /\bspan-all\b/.test(classOf('sec-07')), classOf('sec-07'));
  // 02b 收起时必须退出布局，否则它占中间一列，02 与 03 之间空出一整列
  check('02b 收起时 display:none（不占网格轨道）',
    /#msgViewerCard\.card-hidden \{ display: none; \}/.test(html));

}

console.log('\n── 6. 结构完整性 ──');
{
  // 2026-10-22 改版后多了两个容器 section（#summaryGrid / #detailPool），
  // 所以不能再"只数卡片开标签、却数所有闭标签"——那样会差 2。
  // 只数**行首**的标签：注释与 JS 字符串里也会提到 <section，不能算。
  const open = (html.match(/^[ \t]*<section\b/gm) || []).length;
  const close = (html.match(/^[ \t]*<\/section\b/gm) || []).length;
  check('section 开合平衡', open === close, `${open} vs ${close}`);
  // 重排时曾把某张卡的 </section> 弄丢，导致后一张卡嵌进前一张。
  // 判据要精确：只检查"相邻两张卡片之间有没有 </section>"——
  // 黑话弹窗那种 `</div>` 紧邻下一张卡的注释是合法的（弹窗是独立节点，不属于某张卡）。
  {
    const starts = [];
    const re = /<section[^>]*>/g;
    let m;
    while ((m = re.exec(html)) !== null) {
      const tag = m[0];
      // 容器不是卡片，跳过（否则它会把紧随其后的第一张卡算成"嵌套"）
      if (/id="(summaryGrid|detailPool)"/.test(tag)) continue;
      // 只看真正的"卡片" section（后面紧跟 h2 或折叠头里的 sec-no）
      const after = html.slice(m.index, m.index + 260);
      if (/<h2[^>]*>\s*<span class="sec-no">/.test(after) || /<span class="sec-no">\d+<\/span>/.test(after)) {
        starts.push(m.index);
      }
    }
    let nested = false;
    for (let i = 1; i < starts.length; i++) {
      if (!html.slice(starts[i - 1], starts[i]).includes('</section>')) { nested = true; break; }
    }
    check('相邻卡片之间有 </section>（无嵌套）', !nested, `卡片数 ${starts.length}`);
  }
}

console.log('\n── 7. 05 人格卡片：两段互斥，不溢出 ──');
{
  // 2026-10-21 用户反馈：点「新建人格」时元素溢出卡片。
  // 根因是卡片固定高度（.card-h）而新建表单更高，<details> 直接展开会顶出边界。
  // 修法：两段互斥 + grid-template-rows 高度动画，卡片加 overflow:hidden 兜底。
  check('05 卡有防溢出容器', /id="sec-05" class="[^"]*span-all[^"]*role-card/.test(html));
  check('.role-card 设 overflow:hidden（最后一道保险）', /\.role-card \{ overflow: hidden; \}/.test(html));
  check('有默认人格下拉', /id="roleDefaultSelect"/.test(html));
  check('有群列表容器', /id="roleGroupList"/.test(html));
  check('有群筛选输入', /id="roleGroupFilter"/.test(html));
  check('群行有人格下拉', /role-group-select/.test(html));

  check('有两段容器', /id="roleMainSeg"/.test(html) && /id="roleCreateSeg"/.test(html));
  check('两段用 grid 行高做动画',
    /\.role-seg \{[\s\S]{0,260}grid-template-rows: 0fr/.test(html)
    && /\.role-seg\.open \{ grid-template-rows: 1fr/.test(html));
  check('动画有过渡时长', /transition: grid-template-rows \.28s/.test(html));
  check('尊重"减少动效"偏好', /prefers-reduced-motion/.test(html));
  check('展开段可滚动', /\.role-seg\.active \{[\s\S]{0,180}overflow: auto/.test(html));

  // 不再是 <details> 直接展开（那就是溢出的来源）
  check('不再用 details 展开新建表单', !/<details[\s\S]{0,200}newRoleName/.test(html));

  // 切换逻辑
  check('有切换按钮', /id="roleToggleCreate"/.test(html));
  check('有取消按钮', /id="roleCreateCancel"/.test(html));
  check('切换函数存在', /function applyRolePanel/.test(html));
  check('收起段设 inert（避免 Tab 聚焦到看不见的输入框）', /setAttribute\('inert'/.test(html));
  check('按钮文案随状态切换', /'← 返回角色列表' : '＋ 新建人格'/.test(html));
  check('记住上次停留的段落', /qq-bridge-role-panel/.test(html));
  check('创建成功后自动收起表单', /applyRolePanel\('main'\), 350\)/.test(html));
  check('角色名必填校验', /角色名不能为空/.test(html));
}

console.log('\n── 8. 白名单/管理员：下拉菜单 + 增删按钮 ──');
{
  for (const id of ['wlGroups', 'wlPrivate', 'ownerQQ', 'dnGroups', 'dnPrivate']) {
    check(`#${id} 是下拉框`, new RegExp(`<select id="${id}"`).test(html));
  }
  check('每个下拉框右侧都有添加/删除按钮',
    (html.match(/data-wl-add=/g) || []).length === 5
    && (html.match(/data-wl-del=/g) || []).length === 5);
  check('旧的逗号分隔输入框已移除',
    !/<input[^>]*id="wlGroups"/.test(html)
    && !/<input[^>]*id="wlPrivate"/.test(html)
    && !/<input[^>]*id="ownerQQ"/.test(html)
    && !/<input[^>]*id="dnGroups"/.test(html)
    && !/<input[^>]*id="dnPrivate"/.test(html));
  check('增删会立即写回 /api/whitelist',
    /async function persistWl/.test(html) && /persistWl\(wlState\.privateMode/.test(html));
  check('管理员是单值下拉（不是多选列表）',
    /ownerQQ: \{ id: 'ownerQQ'[\s\S]{0,120}?list: false/.test(html));
  check('列表项下拉在空列表时显示占位',
    /— 暂无 —/.test(html));
  check('下拉展开面板比收起填充更白',
    /select option \{[\s\S]{0,120}?background-color: oklch\(99\.4% \.003 240\)/.test(html));
  check('选中项高亮仍比收起填充白',
    /select option:checked \{[\s\S]{0,120}?background-color: oklch\(98\.2% \.008 240\)/.test(html));
  check('下拉使用浅色原生控件',
    /select \{ color-scheme: light; \}/.test(html));
  check('10 悬停摘要按真实名单长度计数（不是下拉选中项）',
    /const groups = wlState\.allowGroups\.length/.test(html)
    && /const privates = wlState\.allowPrivate\.length/.test(html)
    && !/countList\(document\.getElementById\('wlGroups'\)\?\.value\)/.test(html));
  check('10 摘要只在缺少管理员时提示',
    /wlState\.ownerQQ \? '' : ' · 无管理员'/.test(html)
    && /attention: !wlState\.ownerQQ/.test(html));
  check('白名单异步加载完成后重算摘要',
    /updatePrivateModeHint\(pm, w\.friendCount\);\s*[\s\S]{0,180}?refreshSummaries\(\);/.test(html));
}

console.log('\n── 9. 07 二代仿真参数分组与新增等待参数 ──');
{
  check('07 有 6 个参数页签', (html.match(/data-v2-tab="/g) || []).length === 6);
  check('07 有 6 个参数面板', (html.match(/class="v2-panel/g) || []).length === 6);
  check('默认打开等待与调度页', /class="v2-panel active" data-v2-panel="wait"/.test(html));
  for (const id of ['v2WaitMaxQuietMs', 'v2WaitTurnMaxCount', 'v2WaitTurnMaxSec', 'v2PreSleepReplyGraceSec']) {
    check(`07 有 ${id}`, new RegExp(`id="${id}"`).test(html));
  }
  check('新增等待参数在 loadV2Config 中回填',
    /v2WaitMaxQuietMs'\)\.value = wt\.maxQuietMs/.test(html)
    && /v2WaitTurnMaxCount'\)\.value = wt\.turnMaxCount/.test(html)
    && /v2WaitTurnMaxSec'\)\.value = Math\.round\(\(Number\(wt\.turnMaxMs\)/.test(html));
  check('新增等待参数在 saveV2Config 中提交',
    /maxQuietMs: Math\.max\(0, Math\.min\(15000/.test(html)
    && /turnMaxCount: Math\.max\(1, Math\.min\(20/.test(html)
    && /turnMaxMs: Math\.max\(5000, Math\.min\(600000/.test(html));
  check('页签切换只切 class，不重建参数 DOM',
    /function setV2Tab\(tab\)/.test(html)
    && /panel\.classList\.toggle\('active', panel\.dataset\.v2Panel === tab\)/.test(html));
}
console.log('\n── 10. 05 人格卡在线编辑 ──');
{
  check('预览标题栏有编辑按钮', /id="roleEditBtn"/.test(html));
  check('有编辑区容器', /id="roleEditor"/.test(html) && /class="role-editor"/.test(html));
  check('编辑区是 textarea', /id="roleEditorText"[^>]*class="role-edit-area"/.test(html));
  check('有保存/取消按钮', /id="roleEditSave"/.test(html) && /id="roleEditCancel"/.test(html));
  check('编辑区能填满固定高度面板（flex）', /\.role-editor \{[^}]*flex: 1 1 auto/.test(html)
    && /\.role-edit-area \{[^}]*flex: 1 1 auto/.test(html));
  check('编辑中不被自动刷新覆盖', /if \(roleEditing\) return;/.test(html));
  check('切换预览前提示未保存修改', /function confirmDiscardRoleEdit\(\)/.test(html)
    && /人格卡还有未保存的修改/.test(html));
  check('超过 12000 字会提示截断', /ROLE_HINT_LIMIT = 12000/.test(html)
    && /超过 \$\{ROLE_HINT_LIMIT\} 字会被截断/.test(html));
  check('Ctrl+Enter 保存 / Esc 取消', /e\.key === 'Escape'/.test(html)
    && /e\.key === 'Enter' && \(e\.ctrlKey \|\| e\.metaKey\)/.test(html));
  check('保存走 POST /api/role-content', /api\('\/api\/role-content', 'POST', \{ name, content \}\)/.test(html));
  check('后端有 POST /api/role-content', /req\.method === 'POST' && url\.pathname === '\/api\/role-content'/.test(consoleServerSrc));
  check('保存前备份到 roles/.backups', /path\.join\(ROOT, 'roles', '\.backups'\)/.test(consoleServerSrc));
  check('原子写入角色文件', /atomicWriteText\(roleFile, next\)/.test(consoleServerSrc));
  check('README 不被当角色改', /if \(safe === 'README'\)/.test(consoleServerSrc));
}

console.log('\n── 11. 02 会话列表名称与 02b 消息填充 ──');
{
  check('会话行显示群名/昵称', /class="sess-name"/.test(html)
    && /x\.name \? \`<span class="sess-name">/.test(html));
  check('会话行仍保留 key 便于排查', /<code>\$\{esc\(x\.key\)\}<\/code>/.test(html));
  check('后端 /api/sessions 返回 name', /url\.pathname === '\/api\/sessions'[\s\S]{0,900}?name: contextDisplayName\(key\)/.test(consoleServerSrc));
  check('后端 /api/sessions 会刷新名称缓存', /url\.pathname === '\/api\/sessions'[\s\S]{0,300}?refreshContextNames\(false\)/.test(consoleServerSrc));
  check('02b 整页卡片高度撑满视口', /\.detail-page-body > #msgViewerCard \{[\s\S]{0,200}?height: calc\(100vh - 112px\)/.test(html));
  check('02b 消息列表吃满剩余高度', /\.detail-page-body > #msgViewerCard \.msglist \{[\s\S]{0,160}?flex: 1 1 auto/.test(html)
    && /\.detail-page-body > #msgViewerCard \.msglist \{[\s\S]{0,160}?max-height: none/.test(html));
  check('02b 标题/工具行不被压缩', /#msgViewerCard \.expandable-inner > \* \{[^}]*flex: 0 0 auto/.test(html));
}

console.log('\n── 12. 侧栏分类导航 + 关于页 ──');
{
  check('有左侧分类导航', /id="consoleSidebar"/.test(html) && /class="console-sidebar"/.test(html));
  check('侧栏使用项目 SVG 图标', /<use href="#qq-bridge-mark"/.test(html) && /class="side-ico"[^>]*><use href="#ico-/.test(html));
  check('关于按钮在侧栏底部（nav 之外）', /<div class="sidebar-bottom">[\s\S]{0,220}?data-group="about"/.test(html));
  check('侧栏按钮默认有可见样式', /\.side-item \{[\s\S]{0,260}?background: oklch\(100% 0 0 \/ \.52\)/.test(html));
  check('有总览/运行/内容/社群/能力/系统/关于', ['all','run','content','community','media','system','about'].every(g => new RegExp('data-group="' + g + '"').test(html)));
  check('摘要卡带分类字段', /btn\.dataset\.group = CARD_GROUPS\[no\]/.test(html));
  check('分类映射覆盖 24 张卡', (html.match(/'\d\d': '(run|content|community|media|system)'/g) || []).length >= 24);
  check('有关于页', /id="aboutView"/.test(html) && /id="aboutVersion"/.test(html) && /id="aboutNode"/.test(html));
  check('关于页版本/环境来自 API', /\/api\/about/.test(consoleServerSrc)
    && /snowlumaVersion/.test(consoleServerSrc) && /process\.version/.test(consoleServerSrc));
  check('详情页停在侧栏右侧（不压住侧栏）', /inset: 0 0 0 calc\(var\(--sidebar-w\) \+ 16px\)/.test(html));
  check('侧栏打开详情时仍可点击（不 inert）', !/consoleSidebar[^\n]*setAttribute\('inert'/.test(html));
  check('侧栏切换分类会先关闭详情', /if \(DETAIL_PAGE\.openNo\) closeCardPage\(\)/.test(html));
  check('分类/关于切换函数存在', /function applyConsoleGroup\(group\)/.test(html)
    && /function loadAboutPage\(\)/.test(html));
  check('关于页卡片复用入场动画（错峰）', /about-anim/.test(html) && /animation: cardEnter/.test(html) && /animation-delay: calc\(var\(--i/.test(html));
  check('关于页内容更丰富（能力/技术栈）', /能力概览/.test(html) && /about-feature-grid/.test(html) && /技术栈与链接/.test(html));
  check('关于页说明卡有开发日志按钮/弹窗',
    /id="devLogOpen"/.test(html) && /id="devLogOverlay"/.test(html)
    && /function openDevLog\(/.test(html) && /function refreshDevLog\(/.test(html));
  check('技术栈与链接合并为一张卡片', /class="card about-stack about-anim"/.test(html) && /class="about-link-grid"/.test(html) && /id="aboutRepo"/.test(html));
  check('包含本项目与各技术官网/仓库', /nodejs\.org/.test(html) && /github\.com\/SnowLuma\/SnowLuma/.test(html) && /deepseek-harness/.test(html) && /onebot-11/.test(html) && /ffmpeg\.org/.test(html) && /GPT-SoVITS/.test(html));
  check('窄屏侧栏横向导航', /@media \(max-width: 900px\)[\s\S]{0,500}?\.console-sidebar/.test(html));
}


console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
