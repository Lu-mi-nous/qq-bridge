// runtime-gate 只约束宿主 ctx 包装接口，不拦截插件直接使用 Node 或公共低层 API。
export const PLUGIN_PERMISSION_MODES = Object.freeze({
  network: 'audit-only',
  state: 'runtime-gate',
  send: 'runtime-gate',
  'mcp:register': 'runtime-gate',
  'console:route': 'runtime-gate',
  prompt: 'audit-only',
  process: 'audit-only',
  secrets: 'runtime-gate'
});
export const PLUGIN_PERMISSIONS = Object.freeze(Object.keys(PLUGIN_PERMISSION_MODES));

// 跨平台拒绝目录路径、父目录及 Windows 盘符/数据流；不承诺符号链接隔离。
export function isLocalFileName(value) {
  return typeof value === 'string' && value.trim().length > 0
    && !/[\\/:]/.test(value) && value !== '.' && value !== '..';
}
