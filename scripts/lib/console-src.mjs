// 测试辅助：读取控制台源码。
//
// R4 把 154 条路由从 console-server.js 拆到 src/console/routes/*.js，
// R4.7 又把 token 读口径/命令拆到 src/console/{read-model,commands}/。
// 很多回归测试仍按「字符串搜索源码」的方式断言端点/口径存在；这里把
// 主文件、分域路由与用例层模块拼在一起，测试不需要逐个知道某段代码搬到了哪个文件。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function readConsoleServer() {
  return fs.readFileSync(path.join(ROOT, 'src', 'console-server.js'), 'utf8');
}

function readDirJs(rel) {
  const dir = path.join(ROOT, rel);
  if (!fs.existsSync(dir)) return '';
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.js'))
    .sort()
    .map((f) => fs.readFileSync(path.join(dir, f), 'utf8'))
    .join('\n');
}

export function readConsoleRoutes() {
  return readDirJs(path.join('src', 'console', 'routes'));
}

/** console-server.js + 全部路由模块 + 用例层（read-model / commands）。 */
export function readConsoleSource() {
  return `${readConsoleServer()}\n${readConsoleRoutes()}\n${readDirJs(path.join('src', 'console', 'read-model'))}\n${readDirJs(path.join('src', 'console', 'commands'))}`;
}
