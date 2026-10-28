import { registerMediaTools } from '../../plugins/media-tools/mcp-tools.js';
export function mediaMcpHarness(config = {}, callService = () => ({})) {
  const tools = new Map();
  registerMediaTools({ config: { get: () => config }, mcp: {
    callService,
    registerTool: (name, description, inputSchema, handler, options) => tools.set(name, { name, description, inputSchema, handler, ...options })
  } });
  return tools;
}
