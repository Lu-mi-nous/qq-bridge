// TTS 的公开适配入口：仅公开插件启动与合成所需的既有契约。
// 引擎保留在核心，避免搬动基于模块目录定位的 Python 脚本与缓存路径。
// 导入不启动模型；调用方必须管理 createTtsEngine 的 shutdown 生命周期。
export {
  probeSovits,
  createTtsEngine,
  DEFAULT_SOVITS_DIR,
  DEFAULT_SPEECH_PARAMS,
  TTS_DEFAULT_PROBABILITY
} from '../tts.js';
