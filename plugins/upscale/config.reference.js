// 参考文档：宿主不导入此文件，也不据此校验配置。
// 超分插件配置说明（与 config-schema.js 的 socialV2.upscale 保持同形）。
export const configReference = {
  enabled: 'boolean',
  model: 'string',
  binDir: 'string',
  modelDir: 'string',
  timeoutMs: 'integer(1000..600000)',
  'cache.enabled': 'boolean',
  'cache.dir': 'string',
  'cache.maxAgeDays': 'number(1..365)',
  'cache.maxBytes': 'integer(1048576..10737418240)',
  'cache.sweepEveryHours': 'number(1..168)'
};

export default configReference;
