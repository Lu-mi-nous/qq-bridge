// 插件运行时装配（R3-4）：把宿主创建、启动、TTS 能力查询收在一处。
//
// bridge 只依赖这个运行时对象，不再直接知道 createPluginHost 的细节。
import { createPluginHost } from './plugins/host.js';

export function createPluginRuntime({
  root,
  log = () => {},
  getConfig = () => ({}),
  services = {},
  dirs,
  only = null
} = {}) {
  const host = createPluginHost({ root, log, getConfig, services, dirs });
  let started = false;

  async function start() {
    if (started) return host.list();
    await host.load(only ? { only } : undefined);
    await host.start();
    started = true;
    return host.list();
  }

  async function stop() {
    if (!started) return;
    started = false;
    await host.stop();
  }

  function get(id) {
    return host.get(id);
  }

  function list() {
    return host.list();
  }

  function tts() {
    return host.get('tts');
  }

  function ttsEngine() {
    return tts()?.engine ?? null;
  }

  function ttsSpeechParams() {
    return tts()?.speechParams?.() ?? {};
  }

  return { host, start, stop, get, list, tts, ttsEngine, ttsSpeechParams };
}
