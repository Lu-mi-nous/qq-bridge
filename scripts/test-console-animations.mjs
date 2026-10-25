// 回归测试：控制台「所有可展开元素都有动画」。
//
// 需求（2026-10-21 用户）：「之后把控制台所有能展开的元素都加上动画」。
//
// 控制台里有四类可展开元素，机制各不相同，这里逐类锁住：
//   ① <details>（黑话系统参数）——原生不支持高度过渡
//   ② 可收起卡片（06 一代仿真）——原来是 display:none 硬切
//   ③ 弹窗（黑话确认框）——原来是 display:none/flex 硬切
//   ④ 临时卡片（会话消息回看）——原来用 style.display 切换
//
// 统一做法：能用 grid-template-rows: 0fr↔1fr 的都用它（对"内容自然高度"过渡，
// 不用量像素、内容变了也不截断）；弹窗用 visibility+opacity+transform
// （display 无法过渡）。时长/缓动集中在 --anim-dur / --anim-ease。
import fs from 'node:fs';
import path from 'node:path';

let pass = 0, fail = 0;
const check = (n, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };

const root = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Z]:)/, '$1') + '/..';
const html = fs.readFileSync(path.join(root, 'public', 'console.html'), 'utf8');

console.log('── 0. 统一动画参数 ──');
{
  // 具体数值属于视觉设计，可能随控制台改版调整；这里只锁「集中定义 + 全局引用」。
  check('有统一时长变量', /--anim-dur:\s*[\d.]+s/.test(html));
  check('有统一缓动变量', /--anim-ease:\s*cubic-bezier/.test(html));
  check('动画统一引用变量', /var\(--anim-dur\)/.test(html) && /var\(--anim-ease\)/.test(html));
}

console.log('\n── 1. details（黑话系统参数）──');
{
  check('加了 animated-details 类', /<details class="animated-details"/.test(html));
  check('内容有 grid 包裹层 .details-anim', /class="details-anim"/.test(html));
  check('收起态 0fr + opacity 0',
    /details\.animated-details > \.details-anim \{[^}]*grid-template-rows: 0fr/.test(html));
  check('展开态 1fr', /details\.animated-details\[open\] > \.details-anim \{ grid-template-rows: 1fr/.test(html));
  check('有 transition', /details\.animated-details > \.details-anim \{[^}]*transition:/.test(html));
  check('内层 overflow:hidden（防内容变形/溢出）',
    /details\.animated-details > \.details-anim > div \{ overflow: hidden/.test(html));
}

console.log('\n── 2. 可收起卡片（06）──');
{
  check('不再用 display:none 硬切',
    !/\.collapsible\.collapsed > \.collapsible-body \{ display: none; \}/.test(html));
  check('改用 grid-template-rows: 0fr',
    /\.collapsible\.collapsed > \.collapsible-body \{ grid-template-rows: 0fr/.test(html));
  check('有 transition', /\.collapsible > \.collapsible-body \{[^}]*transition:/.test(html));
  check('有内层包裹 .collapsible-inner（防内容变形）',
    /class="collapsible-body"><div class="collapsible-inner">/.test(html));
  check('内层 overflow:hidden', /\.collapsible-inner \{ overflow: hidden/.test(html));
  // 折叠状态仍由既有 JS 的 .collapsed 类驱动（不要改成内联样式）
  check('仍由 .collapsed 类驱动', /classList\.toggle\('collapsed'/.test(html));
}

console.log('\n── 3. 弹窗（黑话确认框）──');
{
  check('不再用 display:none 控制显隐',
    !/\.modal-overlay \{[\s\S]{0,200}display: none/.test(html));
  check('使用 visibility:hidden 实现"不可见但可过渡"',
    /\.modal-overlay \{[\s\S]{0,340}visibility: hidden/.test(html));
  check('打开态 visibility:visible',
    /\.modal-overlay\.open \{[\s\S]{0,240}visibility: visible/.test(html));
  check('有 opacity 过渡', /\.modal-overlay \{[\s\S]{0,340}transition: opacity/.test(html));
  check('关闭时延迟隐藏（等动画走完）',
    /visibility 0s linear var\(--anim-dur\)/.test(html));
  check('弹窗本体有位移/缩放', /\.modal \{[^}]*transform: translateY\(10px\) scale/.test(html));
  check('打开态归位', /\.modal-overlay\.open \.modal \{ transform: translateY\(0\) scale\(1\)/.test(html));
  check('body 滚动不被锁死（pointer-events 控制交互）',
    /\.modal-overlay \{[\s\S]{0,340}pointer-events: none/.test(html));
}

console.log('\n── 4. 临时卡片（会话消息回看）──');
{
  check('用 card-hidden 类而非 style.display',
    /classList\.remove\('card-hidden'\)/.test(html)
    && /classList\.add\('card-hidden'\)/.test(html));
  check('没有残留的 style.display 切换',
    !/msgViewerCard'\)\.style\.display/.test(html));
  check('内容包在 .expandable-inner', /class="expandable-inner"/.test(html));
  check('内层有 transition', /\.expandable-inner \{[^}]*transition:/.test(html));
  check('收起时完全塌陷（max-height:0）',
    /\.expandable-card\.card-hidden \{[^}]*max-height: 0/.test(html));
  // 关键坑：把 display:grid 加在 .card 上会让 h2/row 变成 grid item，布局全变
  check('grid 只作用在内层，不作用在 .card 上',
    !/\.expandable-card \{[^}]*display: grid/.test(html));
  // 网格里的卡片默认 stretch，会被同行其它卡撑高，收起时不塌陷
  check('align-self:start（否则被网格撑高，收起不塌陷）',
    /\.expandable-card \{ align-self: start/.test(html));
}

console.log('\n── 5. 无障碍：减少动效 ──');
{
  check('有 prefers-reduced-motion 规则', /@media \(prefers-reduced-motion: reduce\)/.test(html));
  // 页面可能有多个 prefers-reduced-motion 块（例如 about 视图单独一块）；
  // 必须合并所有块检查，只取第一块会漏掉后面的展开/弹窗规则。
  const block = [...html.matchAll(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n  \}/g)]
    .map((m) => m[1]).join('\n');
  for (const sel of ['.role-seg', '.expandable-inner', '.expandable-card',
    'details.animated-details', '.collapsible', '.modal-overlay', '.modal', '.doc-overlay', '.doc-modal']) {
    check(`覆盖 ${sel}`, block.includes(sel), block.slice(0, 60).replace(/\s+/g, ' '));
  }
  check('用 !important 确保覆盖', /transition: none !important/.test(block));
}

console.log('\n── 6. 全量覆盖检查 ──');
{
  // 每一类都必须至少有 transition —— 防以后新增可展开元素时漏掉
  const kinds = [
    ['details', /details\.animated-details > \.details-anim \{[^}]*transition:/],
    ['collapsible', /\.collapsible > \.collapsible-body \{[^}]*transition:/],
    ['modal 遮罩', /\.modal-overlay \{[^}]*transition:/],
    ['modal 本体', /\.modal \{[^}]*transition:/],
    ['expandable 内层', /\.expandable-inner \{[^}]*transition:/],
    ['expandable 外框', /\.expandable-card \{[\s\S]{0,200}transition:/],
    ['role 段', /\.role-seg \{[^}]*transition:/],
    ['doc 遮罩', /\.doc-overlay \{[^}]*transition:/],
    ['doc 本体', /\.doc-modal \{[^}]*transition:/]
  ];
  for (const [name, re] of kinds) check(`${name} 有 transition`, re.test(html));
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
