// 回归测试：控制台 Shell（C0）。
//
// 锁住拆分结果：console.html 只保留 Shell 与旧卡片标记；样式/脚本外置；
// Shell 暴露契约版本；legacy 仍是完整的旧实现（迁移期双轨）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};

const html = fs.readFileSync(path.join(root, 'public', 'console.html'), 'utf8');
const shell = fs.readFileSync(path.join(root, 'public', 'console', 'shell.js'), 'utf8');
const runtimeSummary = fs.readFileSync(path.join(root, 'public', 'console', 'app', 'runtime-summary.js'), 'utf8');
const cardDir = path.join(root, 'public', 'console', 'cards');
const appDir = path.join(root, 'public', 'console', 'app');
const ui = html + '\n' + fs.readdirSync(cardDir).filter((f) => f.endsWith('.js')).map((f) => fs.readFileSync(path.join(cardDir, f), 'utf8').replace(/\\"/g, '"')).join('\n') + '\n' + fs.readdirSync(appDir).filter((f) => f.endsWith('.js')).map((f) => fs.readFileSync(path.join(appDir, f), 'utf8').replace(/\\"/g, '"')).join('\n');
const css = ['base.css', 'cards.css', 'components.css'].map((f) => fs.readFileSync(path.join(root, 'public', 'console', 'styles', f), 'utf8')).join('\n');
const server = fs.readFileSync(path.join(root, 'src', 'console-server.js'), 'utf8');
const registry = fs.readFileSync(path.join(root, 'public', 'console', 'core', 'registry.js'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'public', 'console', 'core', 'renderer.js'), 'utf8');
const coreSurface = fs.readFileSync(path.join(root, 'public', 'console', 'app', 'core-surface.js'), 'utf8');
const pluginSurface = fs.readFileSync(path.join(root, 'public', 'console', 'app', 'plugin-surface.js'), 'utf8');
const lines = html.split('\n').length;

check('console.html 已降到 ≤300 行（C5 目标）', lines <= 300, String(lines));
check('样式已外置（三份 CSS）', ['base.css','cards.css','components.css'].every((f) => html.includes('/console/styles/' + f)) && !html.includes('<style>'));
check('主脚本已外置', ['runtime-common','runtime-status','runtime-summary','runtime-visuals'].every((f) => html.includes('/console/app/' + f + '.js')) && !html.includes('/console/legacy'));
check('Shell 模块已挂载', html.includes('/console/shell.js') && /type="module"/.test(html));
check('Shell 暴露契约版本', /contractVersion/.test(shell) && /console-shell-ready/.test(shell));
check('运行时摘要/消息模块已拆出', /function refreshSummaries/.test(runtimeSummary) && fs.existsSync(path.join(root, 'public', 'console', 'app', 'messages.js')));
check('样式文件包含卡片网格', /\.summary-grid/.test(css));
check('静态路由只服务 public/console 且限制扩展名',
  /pathname\.startsWith\('\/console\/'\)/.test(server)
    && /public', 'console'/.test(server)
    && /startsWith\(base \+ path\.sep\)/.test(server)
    && /'\.js': 'text\/javascript/.test(server));
check('静态路由路径穿越被拒', /decodeURIComponent/.test(server) && /not found/.test(server));

// ── C1：清单 / 注册表 / 声明式渲染 / 插件分类 ──────────────────────────
check('Shell 拉取控制台清单', /\/api\/console\/manifest/.test(registry) && /loadManifest/.test(shell));
check('注册表校验重复 id 与插件归属', /重复卡片 id/.test(registry) && /缺少 pluginId/.test(registry));
check('注册表按来源分组', /cardsForGroup/.test(registry) && /pluginGroups/.test(registry));
check('渲染器支持最小字段集', ['custom-note','text','input','number','switch','select','textarea','table','list','progress','actions']
  .every((type) => renderer.includes(`case '${type}'`)));
check('侧栏是基础/插件两分类', /data-group="core"/.test(html) && /data-group="plugins"/.test(html) && !/data-group="all"/.test(html));
check('插件功能独立视图', /id="pluginCategoryView"/.test(html) && /mountPluginSurface/.test(shell) && /function render/.test(pluginSurface));
check('基础卡挂载点由 core-surface 动态生成', /setAttribute\('data-card-mount', card\.id\)/.test(coreSurface) && /renderer/.test(shell));
check('声明式卡片样式已落地', /\.declarative-card/.test(css) && /\.plugin-category-view/.test(css));
check('关于页有插件开发者文档卡', /id="pluginGuideCard"/.test(ui) && /plugin-guide/.test(shell));
check('插件声明式卡会挂载', /mountDeclarativeCards\(registry\.pluginCards\)/.test(pluginSurface) && /plugin-card-body/.test(css));

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
