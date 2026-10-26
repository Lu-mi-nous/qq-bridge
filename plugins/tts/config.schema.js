// TTS 插件配置说明（R2.5 先作为可读清单；后续由宿主合并进 zod schema）。
export const configSchema = {
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

export default configSchema;
