import fs from 'node:fs';
import path from 'node:path';
import { createPluginRuntime } from '../plugin-runtime.js';

// MCP 独立进程只启动自己需要的插件；配置读取失败时不加载任何插件。
export async function createProcessPluginRuntime({ root, only, log = () => {}, dirs, services = {} } = {}) {
  if (!Array.isArray(only) || only.some(id => typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id))) {
    throw new TypeError('独立进程必须显式提供有效的插件 only 清单');
  }
  const getConfig = () => {
    try { return JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8').replace(/^\uFEFF/, '')); }
    catch { return { plugins: { disabled: only } }; }
  };
  const runtime = createPluginRuntime({ root, only, dirs, getConfig, log, services });
  await runtime.start();
  return runtime;
}
