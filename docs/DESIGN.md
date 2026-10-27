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
| **会话模型** | 一个 QQ 会话 ↔ 一个 DSH 会话；人格支持全局默认 + 每群单独覆盖 |
| **控制台** | 自带 Web UI（`127.0.0.1:3100`），默认令牌鉴权；可显式设 `consoleAuth: false` 关闭令牌检查。`src/console-server.js` 只承载鉴权 / CSRF / Agent 白名单 / 404，路由按域放在 `src/console/routes/*.js`，由 `src/console/router.js` 分派；插件可经 `ctx.console` 贡献卡片与 `/api/plugins/<id>/*` 子路由 |

---

## MCP servers（由 DSH 的 MCP 客户端 spawn）

| Server | 文件 | 工具数 | 职责 |
| --- | --- | --- | --- |
| `snowluma` | `src/mcp-snowluma-safe.js` | 59 | QQ 动作安全子集：查状态/查群/收发消息/看图/超分/B站观看与搜索/图库/表情包/记忆/黑话/X 抓取 |
| `snowluma-host` | `src/mcp-host-server.js` | 3 | SnowLuma 探活；`start`/`stop` 需显式开启 `allowProcessControl` 且仅 `closed-agent` |
| `web-search-safe` | `src/mcp-web-search-safe.js` | 3 | 只读搜索；网页和图片 URL 抓取带 SSRF 防护 |

工具数按源码注册点统计，实际可见工具还受配置开关和 preset 限制。

---

## 状态层（R2）

JSON 状态统一走 `src/state/store.js` 的 `createJsonStore()`：

- **单一入口**：一个状态域只创建一个 store；迁移过的域禁止在业务代码里再直接 `readFileSync` / `atomicWriteJson` 同一个文件。
- **版本化**：文件顶层带 `__version`；旧文件按版本 0 读取，通过 `migrate(data, fromVersion)` 升级，不匹配时不猜测结构。数组状态用 `array:true`，磁盘格式为 `{__version, items:[]}`，旧裸数组自动识别。
- **原子写**：临时文件 + `renameSync` 替换，权限 `0600`；同步写入在 Node 事件循环内自然串行，`update(fn)` 拿到深拷贝后读改写。
- **损坏恢复**：解析失败先复制为 `.corrupt-<ISO 时间>`，再回落到默认值；缺文件只返回默认值，不主动落盘。
- **多进程状态**：`reloadOnMtime:true` 每次 `read()` 比对文件 mtime；桥接与 MCP 各持一个实例时，外部写入不会被旧内存副本覆盖（B 站记忆使用）。
- **迁移进度**：R2-1 接入 `sessions.json` / `social-v2.json`；R2-2 接入 `token-fuse-state.json` / `session-gap.json` / `shared-memory.json`；R2-3 接入 `slang.json` / `slang-session.json` / `stickers.json` / `image-lib/index.json` / `image-lib/recent-sent.json` / `image-lib/rejected.json` / `image-fetch-state.json` / `bili-memory.json` / `current-role.json` / `conversation-roles.json`。已迁移域在 `src/` 内不再有直接状态文件写入。

业务模块只依赖 store 的 `read/write/update`，不感知文件格式；新增持久字段时必须成对更新默认值、读写路径与往返测试。

---

## 插件宿主（R2.5）

可选功能通过 `src/plugins/host.js` 加载；核心不 import 插件实现。

- **目录**：第一方 `plugins/<id>/`，外部 `~/.qq-bridge/plugins/<id>/`
- **manifest**：`id/version/engines/enabledByDefault/configPath/configSchema/permissions/mcpTools/console`
- **上下文**：`ctx.config` 只读插件配置命名空间；`ctx.state` 限定 `state/plugins/<id>/`；`ctx.send` / `ctx.social` 必须声明权限；`ctx.log` 自动带插件 id
- **生命周期**：`load → start → stop`；单个插件失败只标记 `failed`，不阻塞核心
- **权限**：`network/state/send/mcp:register/console:route/prompt/process/secrets` 为声明式审计，不是沙箱；第一版只安装可信插件
- **TTS 试点**：`plugins/tts/` 接管探测、引擎生命周期、概率判定与语音发送；桥接只保留 `ttsPlugin` 包装和 `ttsSpeechParams` 查询。`GET /api/plugins` 返回插件清单（关于页显示）。
- **限制**：MCP 工具列表在 DSH 启动时确定，插件启停通常需要重启 DSH；控制台完整插件插槽在 R4。

新增插件时必须补 manifest、配置说明、插件测试与“关闭插件后核心仍可用”的缺席测试。

---

## 会话服务（R3-1）

QQ 会话 ↔ DSH 会话的映射、代际与并发创建统一走 `src/session-service.js` 的 `createSessionService()`。

- 服务持有映射读写逻辑；bridge 仍持有 `state` 与 `reverse`，通过显式 getter/回调注入，便于逐步迁移。
- `ensureSession(key)`：复用现有映射、缺 meta 接管、模式/preset 变化时调用 `retireForModeChange`、并发创建去重、创建期间 reset 时归档并拒绝旧会话。
- `detachMapping(key, reason)`：只处理映射/代际/历史/`sessionPromises`；群聊记忆、pending、发送队列等业务状态仍由 bridge 的 `resetSession` 清理。
- `sessionEpoch`、`sessionPromises` 仍是 bridge 的运行态，服务通过 `getEpoch()` / 注入 Map 读取；下一步可将它们完全收进服务。

回归测试：`scripts/test-session-service.mjs`（新建/复用/缺 meta/模式变化/代际/并发/失败/解除映射）。

---

## 社交调度服务（R3-2）

`src/social-service.js` 的 `createSocialService()` 接管「什么时候该唤醒」：

- `scheduleWake(key, reason)`：合并窗口、高优先级缩短等待、熔断/暂停/模式准入、繁忙时暂存原因
- `scheduleReplyCheck` / `setupSleepTimer` / `scheduleProactiveCheck`：回复检查、有限睡眠、主动机会
- `scheduleStartupBackfill`：重启后按未读数错开补投
- `clearTimers` / `clearAllTimers`：清理四类定时器与 `pendingWakeReasons`

真正投递仍由 bridge 的 `sendWakePromptV2` 完成；服务通过 `sendWakePrompt` 回调触发。busy/熔断/模式准入/状态读取均为显式回调，服务不直接读 bridge 闭包。

回归测试：`scripts/test-social-service.mjs`（优先级/合并/繁忙/熔断/暂停/回复检查/睡眠/主动检查/清理）。

---

## 任务服务（R3-3）

`src/task-service.js` 的 `createTaskService()` 统一托管命名定时任务：

- `define(name, { kind, everyMs, delayMs, initialDelayMs, run, enabled })`
- `start/stop/pause/resume/trigger/setEnabled/stopAll`
- `list()` 返回状态、运行次数、最近执行时间与错误
- interval 支持 `initialDelayMs`（先补跑一次再进入周期）；timeout 为一次性任务
- 手动触发不受暂停影响，但会记录 `runCount` 与错误

已迁移：`joinRequestStartup` / `joinRequestSweep` / `contextSweep` / `contextNames` / `tokenUsageFirst` / `tokenUsage` / `friendListRefresh`。
控制台新增 `GET /api/tasks` 与 `POST /api/tasks/<name>/(pause|resume|trigger|start|stop)`，仅控制台可用。

回归测试：`scripts/test-task-service.mjs`（interval/初始延迟/暂停恢复/one-shot/手动触发/错误/stopAll）。

---

## 插件运行时（R3-4）

`src/plugin-runtime.js` 负责插件宿主装配，bridge 不再直接创建 `createPluginHost()`：

- `createPluginRuntime({ root, log, getConfig, services, dirs, only })`
- `start()`：加载 + 启动插件，返回清单；重复调用幂等
- `stop()`：停止全部插件
- `get/list/host`：查询插件与宿主
- `tts()/ttsEngine()/ttsSpeechParams()`：TTS 能力查询，桥接发送层只依赖这三个薄接口

插件运行时把「宿主创建、TTS 能力读取、退出清理」收在一处；bridge 只负责注入服务与读取运行时。

回归测试：`scripts/test-plugin-runtime.mjs`（启动/停止/幂等/TTS 关闭态）。

---

## 图库门面（R3-5）

`src/image-facade.js` 的 `createImageFacade()` 接管图库存储与图源补货：

- `imageStore`：索引/已发图/拒绝名单（内部仍走 `image-store.js` 与 state store）
- `refreshImageLib(opts)`：冷却、并发去重、按源代理下载、画风分、`image-fetch-state` 落盘
- `startSentSweep()`：已发图 TTL 清理
- `imagesEnabled()`、`imageFetchedAt`、`imageFetching`、`lastFetchCorrections`、`styleCenter`

bridge 只保留发图准入、来源过滤/预检、差评换图与发送编排；图库补货不再写在 bridge 内。

回归测试：`scripts/test-image-facade.mjs`（开关/冷却/补货/去重/画风分/清理定时器）。

---

## 表情包服务（R3-6）

`src/sticker-service.js` 的 `createStickerService()` 接管本地表情库与 QQ 收藏表情接口：

- `sync(force)`：TTL 同步、合并 QQ 收藏、写本地缓存与状态文件
- `list/getImageEntry`：AI 列表与单表情图片条目
- `applyNote/setRemark`：本地认知与 QQ 备注
- `remove`：删前备份、调用上游、删后回读校验
- `collect`：从消息媒体收藏、4MiB 压缩、写备注

bridge 只保留表情挑选/发送/提示词接线；表情库 CRUD 不再写在 bridge 内。

回归测试：`scripts/test-sticker-service.mjs`（同步/缓存/列表/备注/删除/关闭/收藏错误）。

---

## 加入请求服务（R3-7）

`src/join-request-service.js` 统一好友/入群请求：队列、通知、自动同意、已自动同意竞态、提交裁决。
bridge 只保留 `bot.onRequest` / `bot.onNotice` 接线与 task-service 超时任务。

回归测试：`scripts/test-join-request-service.mjs`。

## Token 服务（R3-8）

`src/token-service.js` 统一 DSH 转录聚合、`token-usage.json` 落盘、摘要器记账与定时刷新。
bridge 只保留 `loadTokenUsage/refreshTokenUsage/recordSummarizerUsage/startTokenUsageScheduler` 薄包装。

回归测试：`scripts/test-token-service.mjs`。

## 图片请求服务（R3-9）

`src/image-request.js` 统一发图冷却、来源过滤、预检、原图收藏与来源标注。
bridge 只保留发送编排；`imageSendTimes` / `lastSentImage` / `imageFeedbackGate` / `sourceHints` 由服务暴露。

回归测试：`scripts/test-image-request.mjs`。

## 入站媒体服务（R3-10）

`src/media-service.js` 统一 OneBot 图片/表情取字节、MIME/尺寸解析、GIF 抽帧与模型预处理：

- `fetchOneBotImage` / `fetchFaceMedia`：安全文件名、URL、本地路径、base64 多路兜底
- `resolveMediaList` / `fetchMediaData`：单条消息媒体上限、图片炸弹像素限制、动图拼图、缩图/放大小图
- `getImageDimensions` / `mimeFromBuffer` / `mimeFromUrl`

bridge 只保留媒体编排与发送；语音转写仍留在 bridge（后续可再迁）。

回归测试：`scripts/test-media-service.mjs`。

## 社交消息引擎（R3-11）

`src/social-engine.js` 统一入站消息、拍一拍、机器人发言写入社交状态与 journal：

- 错误回显丢弃
- 媒体/forward 清洗与去重
- `lastRequesterId` / `ownerSpokeAt` / 点单字段
- recent/unread 有界与 journal 写入

回归测试：`scripts/test-social-engine.mjs`。

## 入站派发（R3-12）

`src/pipeline/dispatch-incoming.js` 的 `createIncomingDispatcher(deps)` 接管 `dispatchIncoming`：

- reserved2：消息入 social-v2、点单标记、黑话窗口、差评换图、图源记忆、唤醒触发
- 社交仿真：reserved 状态机、摘要、即时/延迟投递
- 普通模式：DSH 不可用入队、会话创建、媒体解析、prompt 投递

bridge 只注入依赖；派发策略不再写在 bridge 内。

## R3-13/14 收尾模块

- `src/pipeline/reply-target.js`：引用/回复目标解析（messageId / seq / 符号引用）、引用缓存、引用内转发登记。
- `src/error-service.js`：上游额度/限流拦截与「报错只私聊管理员」统一通道。
- `src/bili-bootstrap.js`：B 站记忆、凭据、字幕/ASR 与自主刷启动装配。
- `plugins/upscale/`（R4.5-1）：超分实现、缓存清理与可用性自检；核心保留 `src/upscale-bin.js` 供功能菜单同步探测。
- `plugins/web-search/`（R4.5-2）：搜索引擎链与回退（原 `src/web-search/`）；MCP 动态 import，缺失时不注册 `web_search`。
- `plugins/bili/`（R4.5-4）：B 站 API/搜索/观看/自刷/观看记忆（原 `src/bili*.js`）；核心经 `src/bili-api.js` 网关调用，缺席时降级。
- `plugins/images/`（R4.5-5a/5b）：图源/反查/归档/画风/反馈/Pixiv 凭据/图库存储（原 `src/image-*.js`、`image-store.js`）；核心经 `src/images-api.js` 网关调用；门面与发图请求仍在核心。
- `plugins/stickers/`（R4.5-6）：表情库/挑选/语气/提示词（原 `src/sticker-lib.js`、`sticker-pick.js`）；核心经 `src/stickers-api.js` 网关调用；服务层仍在核心。
- `plugins/slang/`（R4.5-7）：黑话库/候选提取/研究提示词/注入（原 `src/slang-learner.js`）；核心经 `src/slang-api.js` 网关调用。
- `plugins/shared-memory/`（R4.5-8）：跨会话人物记忆的存储/合并/脱敏/格式化（原 `src/shared-memory.js`）；核心经 `src/shared-memory-api.js` 网关调用，**唤醒注入点仍留核心**。
- `plugins/media-tools/`（R4.5-9）：GitHub 截图/功能菜单图/Token 报表图（原 `src/github-shot.js`、`feature-menu*.js`、`token-report*.js`）；核心经 `src/media-tools-api.js` 网关调用，缺席时按需调用抛错。
- `plugins/content-review/`（R4.5-10）：内容审查入口/本地规则/审计（默认关闭）；核心经 `src/content-review-api.js` 网关调用，P1 把审核接进 x-posts 拉取流程。

这些模块都由 bridge 显式注入依赖；bridge 只保留启动顺序与事件订阅。

---
