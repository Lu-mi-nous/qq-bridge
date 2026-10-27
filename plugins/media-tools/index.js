// 媒体工具插件（R4.5-9）。
//
// 三个“生成一张图”的能力：
//   ① GitHub 仓库首页整页截图（分段，避免被 QQ 压成细线）；
//   ② 群友功能菜单图（按当前配置筛选能力）；
//   ③ Token 用量报表图（按日/按模型）。
//
// 它们都靠无头 Chrome；插件缺席时网关调用抛明确错误（控制台/工具端点各自 try/catch），
// 桥接启动与其它功能不受影响。
import * as github from './lib/github-shot.js';
import * as menu from './lib/feature-menu.js';
import * as menuRender from './lib/feature-menu-render.js';
import * as report from './lib/token-report.js';
import * as reportHtml from './lib/token-report-html.js';
import * as reportRender from './lib/token-report-render.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConfigItems } from './config-items.js';

export function create(ctx) {
  ctx.console?.registerCard?.({
    id: 'media-tools',
    title: '媒体工具（截图 / 菜单 / 报表）',
    description: 'GitHub 仓库截图、功能菜单图、Token 用量报表图；都依赖本机 Chrome/Edge。',
    endpoint: '/api/plugins/media-tools/card'
  });
  ctx.console?.registerConfigItems?.(createConfigItems(ctx));
  ctx.console?.registerRoute?.('/api/plugins/media-tools/card', (req, res, url, helpers) => {
    const cfg = ctx.config.get() || {};
    const browser = (() => {
      try { return menuRender.findBrowser() || ''; } catch { return ''; }
    })();
    helpers.sendJson({
      ok: true,
      id: 'media-tools',
      githubShot: cfg.githubShot?.enabled !== false,
      featureMenu: cfg.tools?.sendFeatureMenu !== false,
      tokenReport: cfg.tools?.tokenReport !== false,
      browser: browser ? 'found' : 'missing'
    });
  });
  const panelFile = path.join(path.dirname(fileURLToPath(import.meta.url)), 'console.panel.html');
  ctx.console?.registerRoute?.('/api/plugins/media-tools/panel', (req, res) => {
    try {
      const html = fs.readFileSync(panelFile);
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; connect-src 'none'; frame-ancestors 'self'",
        'x-content-type-options': 'nosniff',
        'cache-control': 'no-store'
      });
      res.end(html);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('panel not found');
    }
  });

  function start() {
    const cfg = ctx.config.get() || {};
    if (cfg.githubShot?.enabled === false && cfg.tools?.sendFeatureMenu === false && cfg.tools?.tokenReport === false) {
      ctx.log('三个媒体工具都已在配置中关闭');
      return;
    }
    let browser = '';
    try { browser = menuRender.findBrowser() || ''; } catch {}
    ctx.log(`已加载：GitHub 截图${cfg.githubShot?.enabled === false ? '关闭' : '开启'}，功能菜单${cfg.tools?.sendFeatureMenu === false ? '关闭' : '开启'}，Token 报表${cfg.tools?.tokenReport === false ? '关闭' : '开启'}；浏览器 ${browser ? '可用' : '未找到（生成类工具会失败）'}`);
  }

  function stop() { /* 无自有定时器：截图/渲染都是按需一次性进程 */ }

  return { start, stop, github, menu, menuRender, report, reportHtml, reportRender };
}
