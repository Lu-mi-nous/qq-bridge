// 黑话插件配置说明（与 config-schema.js 的 slang 保持同形）。
export const configSchema = {
  enabled: 'boolean',
  extractMinMessages: 'integer(1..1000)',
  extractCooldownMs: 'integer(0..86400000)',
  inferenceThresholds: 'integer[]',
  injectMax: 'integer(0..50)',
  learnerPreset: 'string',
  workspaceTitle: 'string',
  autoResearch: 'boolean'
};

export default configSchema;
