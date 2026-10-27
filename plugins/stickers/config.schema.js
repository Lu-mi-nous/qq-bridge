// 表情包插件配置说明（与 config-schema.js 的 socialV2.sticker 保持同形）。
export const configSchema = {
  enabled: 'boolean',
  syncTtlMs: 'integer(1000..3600000)',
  maxListCount: 'integer(1..1000)',
  includeInPrompt: 'boolean',
  promptMaxStickers: 'integer(0..100)',
  autoNudge: 'boolean',
  autoNudgeProbability: 'number(0..1)',
  autoNudgeMinGapMs: 'integer(0..86400000)',
  autoNudgeMaxPerHour: 'integer(0..100)',
  autoNudgeCandidates: 'integer(1..20)',
  'collect.enabled': 'boolean',
  'collect.maxPerMinute': 'integer(0..60)',
  'collect.maxPerHour': 'integer(0..600)',
  'collect.maxRemarkChars': 'integer(1..200)',
  'collect.maxUploadBytes': 'integer(1048576..33554432)',
  readLocalCache: 'boolean'
};

export default configSchema;
