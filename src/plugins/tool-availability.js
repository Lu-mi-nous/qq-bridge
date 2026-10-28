import { PLUGIN_TOOL_OWNERS } from './tool-owners.js';

// 仅同步工具可见性；不导入插件实现。未取得运行时状态时 fail closed。
export function bindPluginToolAvailability(server, { readPlugins, owners = PLUGIN_TOOL_OWNERS }) {
  const handles = new Map();
  const declared = new Map(); // name -> { description, inputSchema, handle }（含核心工具，供 T2 计量）
  const register = server.tool.bind(server);
  server.tool = (name, ...args) => {
    const handle = register(name, ...args);
    // handle.inputSchema 是 SDK 已转换过的 JSON schema（zod shape → JSON schema），
    // 与模型实际收到的定义一致；不要用原始 args 里的 zod shape，否则体积会算错。
    declared.set(name, {
      description: handle?.description ?? '',
      inputSchema: handle?.inputSchema ?? {},
      handle
    });
    if (owners[name]) { handle.disable(); handles.set(name, handle); }
    return handle;
  };
  let pending = null;
  function refresh() {
    if (pending) return pending;
    pending = (async () => {
      let available = new Map();
      try {
        const plugins = await readPlugins();
        available = new Map(plugins.filter(p => p.available === true && Array.isArray(p.tools))
          .map(p => [p.id, new Set(p.tools)]));
      } catch { /* 桥接未启动或鉴权失败时隐藏插件工具。 */ }
      for (const [name, handle] of handles) {
        const enabled = available.get(owners[name])?.has(name) === true;
        if (handle.enabled !== enabled) enabled ? handle.enable() : handle.disable();
      }
    })().finally(() => { pending = null; });
    return pending;
  }
  // T2：当前真正对模型可见的工具（含核心工具），用于工具面计量。
  function enabledTools() {
    const tools = [];
    for (const [name, meta] of declared) {
      if (meta.handle && meta.handle.enabled === false) continue;
      tools.push({ name, description: meta.description, inputSchema: meta.inputSchema });
    }
    return tools;
  }
  return { refresh, enabledTools };
}
