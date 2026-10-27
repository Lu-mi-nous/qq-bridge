// 测试辅助：读取控制台前端源码。
//
// C0 起 console.html 只保留 Shell 与卡片的旧标记，样式/脚本拆到
// public/console/styles/*.css 与 public/console/*.js。很多回归测试按“整页源码”
// 做字符串断言，这里把 HTML + public/console/** 的 JS/CSS 拼在一起，测试无需逐个改路径。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function readConsoleHtml() {
  return fs.readFileSync(path.join(ROOT, 'public', 'console.html'), 'utf8');
}

export function readConsoleUiSource({ unescape = false } = {}) {
  const parts = [readConsoleHtml()];
  const dir = path.join(ROOT, 'public', 'console');
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(js|css)$/i.test(e.name)) {
        let text = fs.readFileSync(p, 'utf8');
        // 卡片模块的 HTML 模板写在 JS 字符串里，源码中是 \"。
        // 需要按“渲染后的标记”做断言的测试可传 { unescape:true }。
        if (unescape && /\.js$/i.test(e.name)) text = text.replace(/\\"/g, '"');
        parts.push(text);
      }
    }
  };
  walk(dir);
  return parts.join('\n');
}
