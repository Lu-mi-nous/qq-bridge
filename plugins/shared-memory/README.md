# 跨会话人物记忆插件（shared-memory）

同一 QQ 号在不同群里保持一致的“人设认知”，但**只共享结构化资料**，不共享群聊原文。

## 目录

| 文件 | 作用 |
| --- | --- |
| `manifest.json` | 插件声明：id / 配置路径 `socialV2.sharedMemory` / 权限 / 控制台卡片 |
| `index.js` | 启动日志（共享人数/偏好数）+ 控制台卡片；暴露 api |
| `lib/shared-memory.js` | 存储、身份解析、合并脱敏、注入片段、统计与清除 |
| `config.reference.js` | 配置字段清单（可读版） |

## 隐私边界（改这块前先读）

- 只存**结构化人物资料**：稳定偏好（白名单谓词）、confidence ≥ 0.8、本地 hits ≥ 2；
- **不存**聊天原文 / episode / 群名 / 群内事件；敏感信息（URL、电话、群关系词等）过滤；
- 身份只认 5~12 位纯数字 QQ 号；模型给的名字 id 要能经 episode 的 sender→userId 唯一反查；
- 私聊只处理和注入对方本人；`includePrivate` 可关；
- **注入点在核心**：`pipeline/wake.js` 调 `formatSharedMemoryForWake`，本插件只提供数据与格式化；
- 控制台 24 卡可见、按人忘记、整体清空。

## 谁在用它

- `src/bridge.js`：episode 后合并（`mergeEpisodeToSharedMemory`）、唤醒注入（`formatSharedMemoryForWake`）；
- `src/console-server.js` / 16-context 路由：统计、列表、忘记、清空；
- 插件缺席：`src/shared-memory-api.js` 网关降级，桥接照常启动。

## 配置（`config.json` → `socialV2.sharedMemory`）

```jsonc
{
  "enabled": true,
  "shareProfiles": true,
  "includePrivate": true,
  "excludeKeys": [],
  "maxPeople": 2000,
  "maxTraitsPerPerson": 20,
  "maxPromptPeople": 3,
  "maxPromptTraits": 3,
  "maxPromptChars": 300,
  "ttlDays": 180,
  "identityTtlDays": 365
}
```
