// 参考文档：宿主不导入此文件，也不据此校验配置。
// 联网搜索配置说明（与 config-schema.js 的 webSearch 保持同形）。
export const configReference = {
  enabled: 'boolean',
  engines: 'string[]',
  maxResults: 'integer(1..20)',
  timeoutMs: 'integer(1000..60000)',
  totalTimeoutMs: 'integer(2000..180000)',
  proxy: 'string'
};

export default configReference;
