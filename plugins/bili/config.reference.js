// 参考文档：宿主不导入此文件，也不据此校验配置。
// B 站插件配置说明（与 config-schema.js 的 socialV2.bili 保持同形）。
export const configReference = {
  enabled: 'boolean',
  authFile: 'string',
  'memory.file': 'string',
  'memory.maxItems': 'integer(10..10000)',
  'asr.enabled': 'boolean',
  'asr.model': 'string',
  'asr.cpuThreads': 'integer(1..64)',
  'asr.timeoutMs': 'integer(5000..300000)',
  'selfBrowsing.enabled': 'boolean',
  'selfBrowsing.dailyBudgetSec': 'integer(60..86400)',
  'selfBrowsing.minIntervalMs': 'integer(60000..3600000)',
  'selfBrowsing.maxIntervalMs': 'integer(60000..7200000)',
  'selfBrowsing.maxSecondsPerVideo': 'integer(5..3600)',
  'selfBrowsing.framesPerSecond': 'number(0.1..4)',
  'selfBrowsing.maxFramesTotal': 'integer(8..120)',
  'selfBrowsing.framesDisliked': 'integer(1..60)',
  'selfBrowsing.framesLiked': 'integer(3..120)',
  'selfBrowsing.seenCooldownMs': 'integer(60000..2592000000)',
  'selfBrowsing.onlyWhenDiving': 'boolean',
  'selfBrowsing.categoryWeights': 'object',
  'selfBrowsing.shareProbability': 'number(0..1)'
};

export default configReference;
