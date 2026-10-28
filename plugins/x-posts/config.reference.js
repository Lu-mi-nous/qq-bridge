// 参考文档：宿主不导入此文件，也不据此校验配置。
// X（Twitter）帖子插件配置说明（与 config-schema.js 的 xMonitor 保持同形）。
export const configReference = {
  proxy: 'string',
  translate: 'boolean',
  gatewayUrl: 'string',
  translateModel: 'string',
  maxCount: 'integer(1..5)',
  scanLimit: 'integer(1..50)',
  includeMedia: 'boolean',
  mediaDir: 'string',
  mediaTtlMs: 'integer(60000..86400000)',
  mediaSweepMs: 'integer(30000..3600000)',
  mediaMaxBytes: 'integer(1048576..2147483648)',
  mediaMaxFiles: 'integer(10..5000)',
  ownOnly: 'boolean',
  includeVideo: 'boolean',
  maxVideoBytes: 'integer(1048576..524288000)'
};

export default configReference;
