// 参考文档：宿主不导入此文件，也不据此校验配置。
// TTS 插件配置说明（仅供阅读，不参与运行时校验）。
export const configReference = {
  enabled: 'boolean',
  dir: 'string',
  device: 'string',
  probability: 'number(0..1)',
  maxPerHour: 'integer(0..60)',
  maxChars: 'integer(20..300)',
  voiceId: 'string',
  weightsId: 'string',
  refMode: 'string',
  speed: 'number(0.8..1.2)',
  fragmentInterval: 'number(0.1..0.6)',
  temperature: 'number(0.5..1.2)',
  topK: 'integer(5..30)',
  topP: 'number(0.7..1.0)',
  volumeGainDb: 'number(-12..12)',
  punctuate: 'boolean'
};

export default configReference;
