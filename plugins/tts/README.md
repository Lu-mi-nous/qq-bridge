# TTS 插件（R2.5 试点）

由 `src/plugins/host.js` 加载，配置路径 `socialV2.tts`。

- `index.js`：探测 GPT-SoVITS、创建常驻引擎、概率判定、语音发送
- `manifest.json`：插件 id/版本/权限/配置路径
- `config.reference.js`：配置字段可读清单

关闭 `socialV2.tts.enabled` 时插件不创建引擎，桥接只发文字；插件加载失败也不会影响核心启动。

MCP 工具 `qq_send_voice` 仍由 `src/mcp-snowluma-safe.js` 在启动时按配置注册；修改插件允许清单后需要重启 DSH。
