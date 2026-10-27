// 跨会话人物记忆配置说明（与 config-schema.js 的 socialV2.sharedMemory 保持同形）。
export const configSchema = {
  enabled: 'boolean',
  shareProfiles: 'boolean',
  includePrivate: 'boolean',
  excludeKeys: 'string[]',
  maxPeople: 'integer(1..100000)',
  maxTraitsPerPerson: 'integer(1..200)',
  maxPromptPeople: 'integer(0..20)',
  maxPromptTraits: 'integer(0..20)',
  maxPromptChars: 'integer(0..4000)',
  ttlDays: 'integer(1..3650)',
  identityTtlDays: 'integer(1..3650)'
};

export default configSchema;
