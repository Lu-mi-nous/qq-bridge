import { registerBiliTools } from '../../plugins/bili/mcp-tools.js';
export function biliMcpHarness(config = {}, callService = () => ({})) {
  const tools = new Map();
  registerBiliTools({ config: { get: () => config }, mcp: {
    callService,
    registerTool: (name, description, inputSchema, handler, options) => tools.set(name, { name, description, inputSchema, handler, ...options })
  } });
  return tools;
}
