// 参考文档：宿主不导入此文件，也不据此校验配置。
// 黑话插件配置说明（与 config-schema.js 的 slang 保持同形）。
export const configReference = {
  enabled: 'boolean',
  extractMinMessages: 'integer(1..1000)',
  extractCooldownMs: 'integer(0..86400000)',
  inferenceThresholds: 'integer[]',
  injectMax: 'integer(0..50)',
  learnerPreset: 'string',
  workspaceTitle: 'string',
  autoResearch: 'boolean'
};

export default configReference;
