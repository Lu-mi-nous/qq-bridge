// 插件 MCP 工具的统一测试夹具：用假的 ctx 注册全部已迁移插件的工具，
// 不启动运行时、不发请求。给 test-tool-flags 等静态清单测试用。
import { registerImagesTools } from '../../plugins/images/mcp-tools.js';
import { registerStickersTools } from '../../plugins/stickers/mcp-tools.js';
import { registerTtsTools } from '../../plugins/tts/mcp-tools.js';
import { registerUpscaleTools } from '../../plugins/upscale/mcp-tools.js';
import { registerXPostsTools } from '../../plugins/x-posts/mcp-tools.js';

const REGISTRARS = [registerImagesTools, registerStickersTools, registerTtsTools, registerUpscaleTools, registerXPostsTools];

export function pluginMcpHarness(config = {}, callService = () => ({})) {
  const tools = new Map();
  const ctx = {
    // 与真实 ctx 一致：get() 是插件域配置段；toolFlag() 只读 socialV2.tools。
    config: { get: () => config, toolFlag: name => config?.socialV2?.tools?.[name] },
    mcp: {
      callService,
      registerTool: (name, description, inputSchema, handler, options) =>
        tools.set(name, { name, description, inputSchema, handler, ...options })
    }
  };
  for (const register of REGISTRARS) register(ctx);
  return tools;
}
