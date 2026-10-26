// 测试辅助：读取控制台源码。
//
// R4 把 154 条路由从 console-server.js 拆到 src/console/routes/*.js，
// 很多回归测试仍按「字符串搜索源码」的方式断言端点存在。这里把主文件与
// 分域路由模块拼在一起，测试不需要逐个知道某个端点搬到了哪个文件。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function readConsoleServer() {
  return fs.readFileSync(path.join(ROOT, 'src', 'console-server.js'), 'utf8');
}

export function readConsoleRoutes() {
  const dir = path.join(ROOT, 'src', 'console', 'routes');
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.js'))
    .sort()
    .map((f) => fs.readFileSync(path.join(dir, f), 'utf8'))
    .join('\n');
}

/** console-server.js + 全部路由模块。 */
export function readConsoleSource() {
  return `${readConsoleServer()}\n${readConsoleRoutes()}`;
}
