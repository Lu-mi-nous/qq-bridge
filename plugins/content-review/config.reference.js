// 参考文档：宿主不导入此文件，也不据此校验配置。
// 内容审查配置说明（与 config-defaults 的 xMonitor.review 同形）。
// 词表不进仓库：keywordsByCategory / blockedDomains 由使用者写进自己的 config.json。
export const configReference = {
  enabled: 'boolean',
  mode: "'warn' | 'block'",
  failClosed: 'boolean',
  maxChars: 'integer(100..20000)',
  timeoutMs: 'integer(1000..60000)',
  keywordsByCategory: 'object',
  blockedDomains: 'string[]',
  auditFile: 'string',
  auditMaxEntries: 'integer(100..100000)'
};

export default configReference;
