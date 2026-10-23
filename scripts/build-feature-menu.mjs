// 预生成群友功能声明：只写本地 HTML/PNG，不连接 QQ 或调用模型。
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildFeatureMenuHtml, menuStats } from '../src/feature-menu.js';
import { avatarDataUrl, readFeatureMenuOptions, renderFeatureMenu } from '../src/feature-menu-render.js';

try {
  const options = readFeatureMenuOptions();
  const htmlFile = fileURLToPath(new URL('../docs/feature-menu.html', import.meta.url));
  const html = buildFeatureMenuHtml({ ...options, inlineImage: true, imageDataUrl: avatarDataUrl() });
  fs.writeFileSync(htmlFile, html, 'utf8');
  const result = await renderFeatureMenu({ ...options, force: process.argv.includes('--force'), log: console.log });
  if (!result.ok) throw new Error(result.error);
  console.log(JSON.stringify({ html: htmlFile, ...result, ...menuStats(options.config) }, null, 2));
} catch (error) {
  console.error(`功能菜单生成失败：${error.message}`);
  process.exitCode = 1;
}
