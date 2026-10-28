// 插件运行时装配（R3-4）：把宿主创建、启动、TTS 能力查询收在一处。
//
// bridge 只依赖这个运行时对象，不再直接知道 createPluginHost 的细节。
import { createPluginHost } from './plugins/host.js';
import { createContentReviewApi } from './content-review-api.js';
import { runtimeMcpTools } from './plugins/mcp-tools.js';

export function createPluginRuntime({
  root,
  log = () => {},
  getConfig = () => ({}),
  setConfig = null,
  services = {},
  dirs,
  only = null
} = {}) {
  const host = createPluginHost({ root, log, getConfig, setConfig, services, dirs });
  const contentReview = createContentReviewApi({ capabilities: host.capabilities });
  let started = false;

  async function startImpl() {
    if (started) return host.list();
    await host.load(only ? { only } : undefined);
    await host.start();
    started = true;
    return host.list();
  }

  async function stopImpl() {
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

  function upscale() {
    return host.get('upscale');
  }

  function xMonitor() {
    return host.get('x-posts')?.monitor ?? null;
  }

  function ttsEngine() {
    return tts()?.engine ?? null;
  }

  function ttsSpeechParams() {
    return tts()?.speechParams?.() ?? {};
  }

  let lifecycle = Promise.resolve();
  const enqueue = action => {
    const result = lifecycle.then(action);
    lifecycle = result.catch(() => {});
    return result;
  };
  const start = () => enqueue(startImpl);
  const stop = () => enqueue(stopImpl);
  return { host, start, stop, get, list, mcpTools: () => runtimeMcpTools(host), capabilities: host.capabilities, contentReview,
    tts, ttsEngine, ttsSpeechParams, upscale, xMonitor };
}
