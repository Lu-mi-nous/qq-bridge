# 设计原则与架构

这些是踩坑踩出来的，改代码时请保持：

- **报错只给管理员**。任何异常都走 `notifyOwnerOfError`，绝不把内部机制暴露到群里（群友看到"系统令牌"这类字样非常出戏）
- **失败要显式**。读不到内容就如实说读不到，绝不让模型猜。验证页/空正文/取图失败都有明确的 `ok:false` 与可读原因
- **拦截要有逃生口**。硬拦截（如"有人在叫你，不能潜水"）必须只针对**真正未处理**的情况；否则模型会为了满足拦截而说出"汇报自己调度状态"这种怪话
- **措辞即功能**。提示词里写"必须说 X"，模型就会把 X 说给群友听。内部指令要写成背景事实，不要写成待办或宣言
- **别猜字段**。解析外部数据（卡片/文章/帖子）时用真实样本验证；字段顺序取反（如 B 站卡片的 `title` vs `desc`）会静默出错
- **宁可漏也不误伤**。正则/过滤尤其如此——脱敏误判会导致机器人静默不回复，比漏判更糟

> 改代码前请先读 **[AGENTS.md](../AGENTS.md)**（加功能要同步维护 README、写测试的两类断言、安全红线、改完怎么生效）。

---

---

## 架构

| 组件 | 说明 |
| --- | --- |
| **QQ 侧** | `@snowluma/sdk` 的 `SnowLumaWebSocketClient`（OneBot v11，自动重连） |
| **DSH 侧** | 复用官方 `@deepseek-ai/dsh-host-apiproxy` 的 `AbstractApiClient` 与 zod schema；桥接实现 Node 传输层（fetch unary + WS 下行事件流） |
| **会话模型** | 一个 QQ 会话 ↔ 一个 DSH 会话；人格/preset 可按模式切换 |
| **控制台** | 自带 Web UI（`127.0.0.1:3100`），默认令牌鉴权；可显式设 `consoleAuth: false` 关闭令牌检查 |

---

## MCP servers（由 DSH 的 MCP 客户端 spawn）

| Server | 文件 | 工具数 | 职责 |
| --- | --- | --- | --- |
| `snowluma` | `src/mcp-snowluma-safe.js` | 54 | QQ 动作安全子集：查状态/查群/收发消息/看图/超分/B站观看与搜索/图库/表情包/记忆/黑话/X 抓取 |
| `snowluma-host` | `src/mcp-host-server.js` | 3 | SnowLuma 探活；`start`/`stop` 需显式开启 `allowProcessControl` 且仅 `closed-agent` |
| `web-search-safe` | `src/mcp-web-search-safe.js` | 3 | 只读搜索；网页和图片 URL 抓取带 SSRF 防护 |

工具数按源码注册点统计，实际可见工具还受配置开关和 preset 限制。

---
