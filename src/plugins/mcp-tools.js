// Runtime 提供给 MCP 传输层的工具描述；每次调用重新查询当前宿主上下文。
export function runtimeMcpTools(host) {
  const current = (id, name) => {
    const plugin = host.list().find(p => p.id === id && p.available && p.tools.includes(name));
    if (!plugin) return null;
    const tool = host.getContext(id)?.mcp?.tools.find(t => t.name === name);
    try { return tool?.isEnabled() ? tool : null; } catch { return null; }
  };
  const tools = [], names = new Set();
  for (const plugin of host.list()) {
    if (!plugin.available) continue;
    for (const name of plugin.tools) {
      const tool = current(plugin.id, name);
      if (!tool) continue;
      if (names.has(name)) throw new Error(`跨插件 MCP 工具重名：${name}`);
      names.add(name);
      tools.push({ name, description: tool.description, inputSchema: tool.inputSchema,
        handler: (...args) => {
          const active = current(plugin.id, name);
          if (!active) return { isError: true, content: [{ type: 'text', text: `插件工具不可用：${name}` }] };
          return active.handler(...args);
        }
      });
    }
  }
  return tools;
}
