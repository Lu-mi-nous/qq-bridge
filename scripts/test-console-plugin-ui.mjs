// 回归测试：控制台 iframe panel 与插件 UI（C4）。
//
// 锁住 sandbox 安全边界、postMessage 白名单、Token/媒体工具 panel 路由，
// 以及关于页插件开发者文档卡的存在。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConsoleUiSource } from './lib/console-ui-src.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};

const shell = fs.readFileSync(path.join(root, 'public', 'console', 'shell.js'), 'utf8');
const appDir = path.join(root, 'public', 'console', 'app');
const html = readConsoleUiSource() + '\n' + fs.readdirSync(appDir).filter((f) => f.endsWith('.js')).map((f) => fs.readFileSync(path.join(appDir, f), 'utf8').replace(/\\"/g, '"')).join('\n');
const token16 = fs.readFileSync(path.join(root, 'public', 'console', 'cards', '16-token.js'), 'utf8');
const pluginSurface = fs.readFileSync(path.join(root, 'public', 'console', 'app', 'plugin-surface.js'), 'utf8');
const pluginManager = fs.readFileSync(path.join(root, 'public', 'console', 'app', 'plugin-manager.js'), 'utf8');
const pluginManageView = fs.readFileSync(path.join(root, 'public', 'console', 'app', 'plugin-manage-view.js'), 'utf8');
const overview = fs.readFileSync(path.join(root, 'src', 'console', 'read-model', 'overview.js'), 'utf8');
const overviewRoutes = fs.readFileSync(path.join(root, 'src', 'console', 'routes', '00-overview.js'), 'utf8');
const media = fs.readFileSync(path.join(root, 'plugins', 'media-tools', 'index.js'), 'utf8');
const mediaCard = JSON.parse(fs.readFileSync(path.join(root, 'plugins', 'media-tools', 'console.card.json'), 'utf8'));
const componentsCss = fs.readFileSync(path.join(root, 'public', 'console', 'styles', 'components.css'), 'utf8');

check('iframe 使用 allow-scripts', /sandbox=\\"allow-scripts\\"/.test(token16) && /setAttribute\('sandbox', 'allow-scripts'\)/.test(pluginSurface));
check('iframe 不带 allow-same-origin', !/allow-same-origin/.test(html) && !/allow-same-origin/.test(shell));
check('panel 高度经 postMessage 白名单', /console-panel-height/.test(shell)
  && /frame\.contentWindow !== event\.source/.test(shell));
check('Token 报表 panel 路由', /\/api\/console\/panel\/token-report/.test(overviewRoutes)
  && /content-security-policy/.test(overviewRoutes));
check('Token 卡嵌入 panel iframe', /data-panel-src=\\"\/api\/console\/panel\/token-report\\"/.test(token16));
check('媒体工具 panel 路由', /\/api\/plugins\/media-tools\/panel/.test(media));
check('媒体工具卡片声明 panel', mediaCard.panel === '/api/plugins/media-tools/panel');
check('插件 panel 也走 data-panel-src', /dataset\.panelSrc/.test(pluginSurface) && /hydratePanelIframes/.test(shell));
check('插件 surface 渲染不自递归调用 applyConsoleGroup', !/render\(group\)[\s\S]{0,500}applyConsoleGroup/.test(pluginSurface));
check('插件功能使用摘要卡布局', /pluginSummaryGrid/.test(html) && /summary-card glass/.test(pluginSurface)
  && /openDetail/.test(pluginSurface) && /kind: 'plugin'/.test(pluginSurface));
check('插件管理是独立页面', /id="pluginManageView"/.test(html)
  && /mountPluginManageView/.test(pluginManageView) && !/mountPluginManager/.test(pluginSurface));
check('卸载后广播插件状态以移除菜单卡', /plugin-state-change/.test(pluginManageView)
  && /onChange/.test(pluginManager));
check('侧栏有插件管理入口', /data-group="plugin-manage"/.test(html));
check('插件卸载后 manifest 不再返回其卡片', /disabledPlugins\.has\(plugin\.id\)/.test(overview));
check('插件管理使用苹果式开关', /plugin-manage-switch/.test(pluginManager)
  && /role', 'switch'/.test(pluginManager) && /aria-checked/.test(pluginManager)
  && /plugin-manage-knob/.test(pluginManager));
check('插件管理是卡片式布局', /plugin-manage-card/.test(pluginManager)
  && /plugin-manager-grid/.test(pluginManager)
  && /grid-template-columns:\s*repeat\(auto-fill,\s*minmax\(280px/.test(componentsCss));
check('卡片是透明玻璃（背景模糊 + 半透明渐变）', /\.plugin-manage-card[\s\S]{0,1100}backdrop-filter:\s*blur\(/.test(componentsCss)
  && /\.plugin-manage-card[\s\S]{0,900}oklch\(100% 0 0 \/ \.13\)/.test(componentsCss));
check('玻璃有指针高光与斜向反光', /\.plugin-manage-card::before[\s\S]{0,300}radial-gradient/.test(componentsCss)
  && /\.plugin-manage-card::after[\s\S]{0,300}linear-gradient\(115deg/.test(componentsCss)
  && /attachCardGloss/.test(html));
check('开关有平滑滑动动画', /\.plugin-manage-knob[\s\S]{0,500}transition:\s*transform\s*\.28s/.test(componentsCss)
  && /translateX\(20px\)/.test(componentsCss));
check('开关先即时反馈、失败再回滚', /plugin\.disabled = nextDisabled/.test(pluginManager)
  && /plugin\.disabled = wasDisabled/.test(pluginManager));
check('插件状态变更后显示重启按钮', /restartBar\.hidden = false/.test(pluginManager) && /textContent = '重启桥接'/.test(pluginManager));
check('重启条 hidden 时真正隐藏', /\.plugin-manager-restart\[hidden\][\s\S]{0,80}display:\s*none/.test(componentsCss));
check('待重启状态按配置/运行态判定', /runtimeDisabled/.test(pluginManager)
  && /needsRestart/.test(pluginManager) && /· 待重启/.test(pluginManager));
check('插件管理调用控制台插件接口', /\/api\/console\/plugins\//.test(pluginManager));
check('关于页插件文档卡存在', /id="pluginGuideCard"/.test(html));

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
