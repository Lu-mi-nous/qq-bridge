// 回归测试：控制台的人格卡 Markdown 渲染（把角色卡渲染成可读 HTML，而不是源码）。
//
// 背景（2026-10-13 用户要求「把人格卡内容信息展示在相应卡片中（输出渲染后的 markdown
// 而不是源码）」）：控制台原来只有角色名标签，想看"它现在是什么性格"得去翻 roles/*.md。
//
// 为什么单独测渲染器：它是手写的极简实现（**故意不引第三方库**——只服务这一个用途，
// 支持角色卡实际用到的语法即可，实测 roles/*.md 只用到标题/有序无序列表/粗体/行内代码/引用/代码块）。
// 手写解析两条命脉：
//   ① **安全**：角色卡内容会进 innerHTML，必须先转义再拼标签，否则 <script> 会被执行；
//   ② **不残留标记**：`## 标题` 这类没解析干净就会明晃晃显示在页面上（等于没渲染）。
//
// 渲染器写在 console.html 的内联 <script> 里（前端逻辑，没独立模块），
// 所以这里从 HTML 里抽源码来跑——测的是真正跑着的那份实现，不是复制品。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConsoleUiSource } from './lib/console-ui-src.mjs';

let pass = 0, fail = 0;
const check = (n, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };

const root = path.dirname(fileURLToPath(import.meta.url)) + '/..';
// console.html 是 CRLF 落盘的（Windows 编辑器回写），正则里写 `\n` 匹配不到 `\r\n`，
// 于是一度报"抽不到 esc/renderMd"。先归一化再抽，避免测试对换行风格敏感。
const html = readConsoleUiSource().replace(/\r\n/g, '\n');

// 抽出 esc() 与 renderMd()（含其上方注释块）
const escSrc = /function esc\(s\) \{[\s\S]*?\n\}/.exec(html)?.[0];
const mdSrc = /\/\/ ── 极简 Markdown 渲染[\s\S]*?\nfunction renderMd\([\s\S]*?\n\}\n/.exec(html)?.[0];
if (!escSrc || !mdSrc) { console.log('❌ 抽不到 esc/renderMd，测试无法进行'); process.exit(1); }
const renderMd = new Function(`${escSrc}\n${mdSrc}\nreturn renderMd;`)();
const render = (s) => renderMd(s).replace(/\n/g, ' ');

console.log('── 1. 安全：必须先转义再拼标签 ──');
{
  const x = renderMd('<script>alert(1)</script>');
  check('script 标签被转义', x.includes('&lt;script&gt;') && !/<script>/i.test(x), render(x).slice(0, 80));
  const y = renderMd('<img src=x onerror=alert(1)>');
  check('img onerror 被转义', !/<img[^>]*onerror/i.test(y), render(y).slice(0, 80));
  const z = renderMd('**<b>粗</b>**');
  check('粗体里的 HTML 也被转义', !/<b>粗<\/b>/.test(z) && /&lt;b&gt;/.test(z));
  const q = renderMd('> <script>x</script>');
  check('引用行同样转义', !/<script>/i.test(q));
  const c = renderMd('`<script>y</script>`');
  check('行内代码同样转义', !/<script>/i.test(c) && /&lt;script&gt;/.test(c));
  const f = renderMd('```\n<script>z</script>\n```');
  check('代码块同样转义', !/<script>/i.test(f) && /&lt;script&gt;/.test(f));
  check('属性注入被转义（不能提前闭合标签）', (() => {
    // 若未转义，内容里的引号能闭合 class 属性 → 注入新属性
    const r = renderMd('" onmouseover="alert(1)');
    return !/onmouseover="alert/.test(r.replace(/&quot;/g, ''));
  })());
}

console.log('\n── 2. 标题 ──');
{
  check('h1 渲染成 md-h', /<h3 class="md-h">标题<\/h3>/.test(renderMd('# 标题')));
  check('h2 渲染成 md-h', /<h4 class="md-h">标题<\/h4>/.test(renderMd('## 标题')));
  check('h6 不超过 h6', /<h6 class="md-h">/.test(renderMd('###### 深')));
  check('标题字号层级被限制（# 不会生成 h1 抢占卡片标题）', !/<h1/.test(renderMd('# 一')) && !/<h2/.test(renderMd('# 一')));
}

console.log('\n── 3. 列表 ──');
{
  const ul = renderMd('- 甲\n- 乙');
  check('无序列表', /<ul class="md-ul">/.test(ul) && (ul.match(/<li>/g) || []).length === 2, '');
  const ol = renderMd('1. 甲\n2. 乙');
  check('有序列表', /<ol class="md-ol">/.test(ol) && (ol.match(/<li>/g) || []).length === 2, '');
  check('连续多个列表块正确闭合', (() => {
    const r = renderMd('- a\n\n1. b\n\n- c');
    const u = (r.match(/<ul class="md-ul">/g) || []).length, uc = (r.match(/<\/ul>/g) || []).length;
    const o = (r.match(/<ol class="md-ol">/g) || []).length, oc = (r.match(/<\/ol>/g) || []).length;
    return u === uc && o === oc && u === 2 && o === 1;
  })(), '');
  check('列表在标题前正确闭合', (() => {
    const r = renderMd('- a\n## 标题');
    return r.indexOf('</ul>') < r.indexOf('<h4');
  })());
  check('星号与加号也是列表', /<ul/.test(renderMd('* a')) && /<ul/.test(renderMd('+ a')));
}

console.log('\n── 4. 行内语法 ──');
{
  check('粗体', /<strong>加粗<\/strong>/.test(renderMd('**加粗**')));
  check('斜体', /<em>斜体<\/em>/.test(renderMd('*斜体*')));
  check('行内代码', /<code>代码<\/code>/.test(renderMd('`代码`')));
  check('粗体与代码混排', (() => {
    const r = renderMd('**粗** 和 `码`');
    return /<strong>粗<\/strong>/.test(r) && /<code>码<\/code>/.test(r);
  })());
  check('单个星号不误伤中文（无空格情况）', !/<em>/.test(renderMd('5*3=15')), render(renderMd('5*3=15')));
}

console.log('\n── 5. 引用 / 分隔线 / 代码块 ──');
{
  check('引用', /<blockquote class="md-quote">/.test(renderMd('> 引用')));
  check('多行引用合并到一个 blockquote', (() => {
    const r = renderMd('> a\n> b');
    return (r.match(/<blockquote/g) || []).length === 1 && (r.match(/<p>/g) || []).length === 2;
  })());
  check('分隔线', /<hr class="md-hr">/.test(renderMd('---')));
  const code = renderMd('```\nline1\nline2\n```');
  check('代码块保留换行', /<pre class="md-code">line1\nline2<\/pre>/.test(code), render(code).slice(0, 70));
  check('未闭合的代码块也能收尾', /<pre class="md-code">/.test(renderMd('```\nabc')));
}

console.log('\n── 6. 真实角色卡：不能残留 Markdown 标记 ──');
{
  const files = fs.readdirSync(path.join(root, 'roles')).filter((f) => f.endsWith('.md') && f !== 'README.md');
  check('roles/ 下有角色卡', files.length > 0, `${files.length} 个`);
  let allClean = true, detail = [];
  for (const f of files) {
    const md = fs.readFileSync(path.join(root, 'roles', f), 'utf8');
    const out = renderMd(md);
    // 只在段落文本里找残留标记（代码块内允许出现 # 与 *）
    const noCode = out.replace(/<pre[\s\S]*?<\/pre>/g, '');
    const residualHeading = (noCode.match(/<p>#{1,6} /g) || []).length;
    const residualBold = (noCode.match(/\*\*/g) || []).length;
    const residualList = (noCode.match(/<p>\s*[-*+]\s+/g) || []).length;
    if (residualHeading || residualBold || residualList) {
      allClean = false;
      detail.push(`${f}(标题${residualHeading}/粗体${residualBold}/列表${residualList})`);
    }
  }
  check('所有角色卡渲染后无残留标记', allClean, detail.join(' '));
  // 抽查大肥鱼：结构正确
  const big = renderMd(fs.readFileSync(path.join(root, 'roles/大肥鱼.md'), 'utf8'));
  check('大肥鱼有多个标题', (big.match(/class="md-h"/g) || []).length >= 10);
  check('大肥鱼的有序列表被解析', /<ol class="md-ol">/.test(big));
  check('大肥鱼的无序列表被解析', /<ul class="md-ul">/.test(big));
  check('渲染输出不为空', big.length > 2000, `${big.length} 字符`);
}

console.log('\n── 7. 边界输入不崩 ──');
{
  check('空串', renderMd('') === '');
  check('null', renderMd(null) === '');
  check('undefined', renderMd(undefined) === '');
  check('只有空行', renderMd('\n\n\n').trim() === '');
  check('CRLF 换行（Windows 编辑过的文件）', (() => {
    const r = renderMd('# a\r\n- b\r\n');
    return /<h3 class="md-h">a<\/h3>/.test(r) && /<li>b<\/li>/.test(r);
  })());
  check('纯文本仍是段落', /<p>普通一行<\/p>/.test(renderMd('普通一行')));
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
