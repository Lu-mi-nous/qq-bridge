// 图片插件配置说明（与 config-schema.js 的 socialV2.images 保持同形）。
export const configSchema = {
  enabled: 'boolean',
  sources: 'object',
  maxFiles: 'integer(10..5000)',
  maxTotalBytes: 'integer(1048576..10737418240)',
  recentSendBlockMs: 'integer(0..86400000)',
  sendCooldownMs: 'integer(0..3600000)',
  maxSendPerMinute: 'integer(0..100)',
  maxSendPerHour: 'integer(0..1000)',
  feedbackCooldownMs: 'integer(0..3600000)',
  sourceHintTtlMs: 'integer(0..86400000)',
  fetchPerRun: 'integer(1..100)',
  minScore: 'number(0..1)',
  preferSingleCharacter: 'boolean',
  reverseSearchApiKey: 'string',
  proxy: 'string'
};

export default configSchema;
