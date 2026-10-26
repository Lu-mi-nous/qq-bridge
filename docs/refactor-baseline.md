# 重构基线（R0）

> 采集时间：2026-10-25 ｜ 版本：0.4.0 ｜ 采集对象：独立重构工作副本（与发布树同源）
> 目的：为 R1~R6 提供"行为不变"的对照。任何阶段结束时，通过数与断言数不得低于本文件。

---

## 1. 静态指标

`npm run measure` 可复现。

| 指标 | 0.4.0 发布树（重构前） | R1 完成后 | 说明 |
| --- | ---: | ---: | --- |
| 源码文件 | 97 | 99 | 新增 `config-defaults.js` / `config-schema.js` |
| 源码行数 | 43,815 | 44,583 | +768（schema 与默认值） |
| `bridge.js` 行数 | 8,821 | 8,807 | 新增校验、移出启动摘要 |
| `console-server.js` 行数 | 7,013 | 7,001 | — |
| 测试脚本 | 128 | 129 | 新增 `test-config-schema.mjs` |
| 测试代码行数 | 22,861 | 22,996 | — |
| 控制台路由 | 151 | 152 | 新增 `/api/roles/delete` |
| 配置键（模板） | 447 | **479** | 模板由默认值生成，补齐缺失段 |
| 工具开关 | 56 | 56 | — |
| MCP 工具 | 65 | 65 | — |
| 循环依赖 | 0 | 0 | — |
| 注释占比 | 19.4% | 19.1% | — |

> 发布树的 `bridge.js` 比工作副本多约 200 行，是发布专用的可移植路径与角色删除端点补丁；
> 本表"重构前"沿用 [COMPLEXITY-0.4.0.md](archive/COMPLEXITY-0.4.0.md)（已归档）的口径；
> 现行口径见 [COMPLEXITY.md](COMPLEXITY.md)（2026-10-27 新基线，含 state 目录跳过修正）。

---

## 2. 测试基线

执行方式：暂时排除 `test-console.mjs`（它连接运行中的桥接，不属于代码回归），跑全量。

| 项目 | R0 基线 | R2-1 后 |
| --- | ---: | ---: |
| 通过 | **120 / 128** | **123 / 130** |
| 累计断言 | **4,631** | **4,770** |
| 环境不满足（服务未启动） | 7 | 7 |
| 真正失败 | 1 | **0** |

环境类（不计入回归）：

- `test-image-source.mjs`
- `test-local-e2e.mjs`
- `test-pixiv.mjs`
- `test-vision-dsh.mjs`
- `test-vision-gateway.mjs`
- `test-vision-media.mjs`
- `test-vision.mjs`

唯一失败：`test-token-ask-detect.mjs` 的「报表缓存目录存在」。
原因是**测试顺序依赖**：它要求 `state/token-report/` 已存在，而该目录由后面的
`test-token-report.mjs` 或启动桥接时创建。单独运行或先跑报表测试即通过（30/30）。
这是既有问题，记录在案，R5 一并修（测试自建所需目录或明确跳过）。

---

## 3. R1 新增的验证

`scripts/test-config-schema.mjs`（21 条断言）：

- 默认值自身通过 schema
- 类型错误被拒绝并给出字段路径（端口写成字符串、布尔写成字符串、白名单写成字符串）
- 未知键只告警，不阻塞；`tokenFuse.overrides` 的动态键不算未知
- 模板覆盖全部默认字段，密钥/路径留空，`images.enabled=true`、`privateMode=friends`
- 磁盘上的 `config.example.json` 与生成器输出逐字节一致（防漂移）

---

## 3A. R2 状态层基础设施

新增 `src/state/store.js` 与 `scripts/test-state-store.mjs`（49 条断言）：

- 缺文件返回默认值且不创建文件；写入后读回一致
- 100 次连续 `update()` 后内存与磁盘均为完整 100 条，无临时文件残留
- 文件顶层写入 `__version`；旧版本文件经 `migrate(data, fromVersion)` 升级
- 损坏 JSON（含顶层数组、BOM 文件）先备份为 `.corrupt-<时间>`，再回落默认值
- `update(fn)` 支持原地修改或显式返回新对象；`clearCache()` 可重新读盘
- 数组状态 `array:true`：磁盘为 `{__version, items}`，旧裸数组可读；`reloadOnMtime` 支持跨进程热重载
- 接线断言：sessions / social-v2 / token-fuse / session-gap / shared-memory / slang / stickers / image-lib 三文件 / image-fetch-state / bili-memory / current-role / conversation-roles 均经 `createJsonStore`

接入范围（R2-1）：`state/sessions.json`、`state/social-v2.json`。重启后核对：会话映射 32 个、社交会话 32 个均保留；`social-v2.json` 首次保存带 `__version: 1`，`sessions.json` 保持原内容、下次保存时补版本号。

接入范围（R2-2）：`state/token-fuse-state.json`、`state/session-gap.json`、`state/shared-memory.json`。重启后三者均正常加载，前两者在下一次写入时带 `__version: 1`；共享记忆保留原 `version/updatedAt/people` 字段。

接入范围（R2-3）：`slang.json` / `slang-session.json` / `stickers.json` / `image-lib/index.json` / `image-lib/recent-sent.json` / `image-lib/rejected.json` / `image-fetch-state.json` / `bili-memory.json` / `current-role.json` / `conversation-roles.json`。数组型状态兼容旧裸数组；B 站记忆保留 mtime 热重载；桥接启动后 `stickers.json` 已由 98 条裸数组写成 `{__version:1, items:98}`，其余文件在首次业务写入时升级。

接入范围（R2.5）：`src/plugins/host.js` + `src/plugins/context.js` + `plugins/tts/`。插件 manifest 校验、动态加载、权限检查、状态路径隔离、生命周期启停；TTS 试点接管探测、引擎、概率判定与语音发送。桥接只保留 `ttsPlugin` 包装；`GET /api/plugins` 返回清单，关于页显示。MCP 工具热插拔仍受 DSH 启动时注册限制。

接入范围（R3-1）：`src/session-service.js`。`ensureSession` 的映射/代际/并发创建从 bridge 移出；`resetSession` 改用 `detachMapping()` 处理映射，再执行 bridge 侧业务清理。新增 `test-session-service.mjs` 17 项；bridge 启动后 32 个会话映射、18 个 sessionMeta 均保留。

接入范围（R3-2）：`src/social-service.js`。唤醒合并窗口、优先级、回复检查、有限睡眠、主动机会、启动补投从 bridge 移出；bridge 保留 `sendWakePromptV2` 与业务状态清理。新增 `test-social-service.mjs` 16 项；桥接启动实测合并窗口从 `bootstrap → poke → anyMessage → atMention` 升级并正常唤醒。

接入范围（R3-3）：`src/task-service.js`。命名定时任务、初始延迟、暂停/恢复、手动触发与状态查询统一托管；已迁移加入请求、上下文扫描/群名刷新、Token 统计、好友列表刷新。控制台新增 `/api/tasks` 清单与任务控制端点。新增 `test-task-service.mjs` 17 项；桥接实测 7 个任务运行，pause/resume/trigger 正常。

接入范围（R3-4）：`src/plugin-runtime.js`。插件宿主创建、启动/停止、TTS 能力查询从 bridge 收进运行时；bridge 只注入服务并读取 `tts()/ttsEngine()/ttsSpeechParams()`。新增 `test-plugin-runtime.mjs` 8 项；桥接启动后插件清单与任务清单正常。

接入范围（R3-5）：`src/image-facade.js`。图库实例、补货拉取、画风分、已发图清理与 `image-fetch-state` 从 bridge 收进门面；bridge 保留发图准入/来源预检/差评换图/发送编排。新增 `test-image-facade.mjs` 10 项；桥接启动正常。

接入范围（R3-6）：`src/sticker-service.js`。表情库同步、列表、备注、删除、收藏从 bridge 收进服务；bridge 保留表情挑选/发送/提示词接线。新增 `test-sticker-service.mjs` 12 项；桥接启动同步 100 个收藏表情正常。

接入范围（R3-7~9）：`src/join-request-service.js`（加入请求队列/裁决/通知）、`src/token-service.js`（Token 聚合/摘要器记账/定时刷新）、`src/image-request.js`（发图冷却/来源过滤/预检/原图收藏/标注）。新增测试 11/9/12 项；桥接启动正常。

接入范围（R3-10~11）：`src/media-service.js`（OneBot 图片/表情取字节、MIME/尺寸、GIF 抽帧、缩图/放大小图）、`src/social-engine.js`（入站消息/拍一拍/机器人发言写入）。新增测试 10/13 项；桥接启动正常。

接入范围（R3-12）：`src/pipeline/dispatch-incoming.js`。`dispatchIncoming` 三条路径（reserved2 / 社交仿真 / DSH 投递）从 bridge 移入派发模块；bridge 只注入依赖。桥接启动正常。

接入范围（R3-13/14）：`src/pipeline/reply-target.js`（引用解析/缓存）、`src/error-service.js`（报错只私聊管理员）、`src/bili-bootstrap.js`（B站/ASR 启动装配）、`src/upscale-bootstrap.js`（超分自检）。桥接启动后 B站/ASR/超分/TTS 均正常；`bridge.js` 达到 **6,475 行 < 6,500**。

静态指标（R3-14 后）：源码 118 文件 / 45,927 行；`bridge.js` **6,475 行**、`console-server.js` 7,191 行、测试脚本 144 个 / 24,712 行、路由 154、配置键 479、循环依赖 0。

接入范围（R4）：控制台路由分域。新增 `src/console/router.js`（exact/prefix 匹配、按模块 `routes` 清单分派）与 `src/console/routes/00-overview.js` ~ `18-ops.js`。153 条端点全部搬出（主文件只留 `/` 页面与 401 提示），`console-server.js` 只保留鉴权 / CSRF / agent 白名单 / `/` 页面 / 404 兜底；文件从 **7,191 行降到 601 行**（measure 口径），最大路由模块 802 行（10-images）。依赖袋从 262 项降到 18 项，各域模块只从 `deps` 取自己用到的切片。插件控制台插槽（`ctx.console.registerCard/registerRoute`）与 `/api/plugins` 的 `console.cards` 元数据一并落地，控制台关于页新增插件卡片槽位。

迁移时修掉两个原有隐患：`send-burst` 与 `/api/send/*` 的 `catch` 回滚块引用了 `try` 内声明的 `st/now`（失败路径会抛 ReferenceError，把真实错误盖成 500），现已上提到 `try` 外；概览路由若沿用注册时的 `sendJson` 快照会 500，现统一从每请求 ctx 取。

静态指标（R4 后，`npm run measure`，含 2026-10-27 口径修正：`src/state/` 不再被当运行态目录跳过）：源码 139 文件 / 47,145 行；`bridge.js` 6,475 行、`console-server.js` **601 行**、测试脚本 145 个 / 24,969 行、控制台端点 155 个、配置键 479、循环依赖 0。

测试（R4）：新增 `test-console-router.mjs` 11 项——用桩依赖真正启动 HTTP 服务，覆盖分域 GET/POST 前缀、动态前缀路由、每请求 `sendJson/readBody`、插件路由转发、404 与 CSRF 415。全量 **134/145、4,885 断言、11 个环境类失败、0 个真实失败**；环境类失败为 SnowLuma/DSH/图站未启动，`test-console.mjs` 需要正在运行的桥接，已归入环境类。复杂度重估见 [COMPLEXITY.md](COMPLEXITY.md)（2026-10-27 新基线）。

测试（R2.5）：`test-plugin-host` 13、`test-tts` 162、`test-state-store` 49、`test-image-lib` 78、`test-bili` 294、`test-stickers` 57、`test-feature-menu` 124、`test-admin-commands` 123、`test-bridge-wiring` 87、`test-console-server` 29、`test-console-layout` 213 全部通过。全量首轮 **124/131、4,805 断言、7 个环境类失败、0 个真实失败**（基线 120/128、4,631 断言、1 个真实失败）。补插件清单断言后 `test-console-server` 单独 29/29；第二次全量中 `test-github-shot` 因 GitHub 页面高度波动偶发 1 失败，复跑 54/54 通过。

测试（R3-1）：`test-session-service` 17、`test-bridge-wiring` 88、`test-session-generation` / `test-dsh-events` / `test-admin-commands` 通过；桥接启动后会话映射与 sessionMeta 保留。全量 **125/132、4,824 断言、7 个环境类失败、0 个真实失败**。

测试（R3-2）：`test-social-service` 16、`test-token-fuse` 38、`test-at-poke-reply` 42、`test-bridge-wiring` 88 通过；桥接启动实测唤醒合并升级正常。全量 **126/133、4,841 断言、7 个环境类失败、0 个真实失败**。

测试（R3-3）：`test-task-service` 17、`test-console-server` 30、`test-bridge-wiring` 88、`test-context-memory` 92 通过；桥接实测 7 个任务运行，pause/resume/trigger 正常。全量 **127/134、4,859 断言、7 个环境类失败、0 个真实失败**。

测试（R3-4）：`test-plugin-runtime` 8、`test-plugin-host` 13、`test-tts` 162 通过；桥接启动后 `/api/plugins` 返回 `tts:started`，`/api/tasks` 返回 7 个任务。全量 **128/135、4,867 断言、7 个环境类失败、0 个真实失败**。

测试（R3-5）：`test-image-facade` 10、`test-image-lib` 78、`test-image-send` 24、`test-image-feedback` 42、`test-image-quota-panel` 30、`test-state-store` 49 通过；桥接启动正常。全量 **129/136、4,879 断言、7 个环境类失败、0 个真实失败**。

测试（R3-6）：`test-sticker-service` 12、`test-stickers` 57、`test-sticker-nudge` 43、`test-bridge-wiring` 88 通过；桥接启动同步 100 个收藏表情正常。全量 **130/137、4,891 断言、7 个环境类失败、0 个真实失败**。

测试（R3-7~9）：`test-join-request-service` 11、`test-token-service` 9、`test-image-request` 12、`test-join-request` 67、`test-token-usage` 54、`test-image-send` 24 通过；桥接启动正常。全量 **133/140、4,923 断言、7 个环境类失败、0 个真实失败**。

测试（R3-10~11）：`test-media-service` 10、`test-social-engine` 13 通过；桥接启动正常。全量首轮 **133/142、4,807 断言、7 个环境类失败**；修正 media 接线断言后 `test-bridge-wiring` 88/88，`test-github-shot` 仍有 GitHub 页面高度波动偶发失败。

测试（R3-12）：桥接启动正常，`test-pipeline-message` / `test-incoming` 等派发相关测试通过。全量首轮 **131/142、4,521 断言**；修正三处源码搬迁断言后 `test-auto-at` / `test-bridge-wiring` / `test-tts` 通过，`test-github-shot` 仍有页面高度波动偶发失败。

测试（R3-13/14）：`test-social-loop` 5、`test-reply-target` 7、`test-bili` 294、`test-upscale` 124、`test-token-fuse` 43、`test-wait-guard` 17 通过；桥接启动后 B站记忆/凭据/字幕/ASR、超分、TTS 插件全部正常。全量 **136/144、4,950 断言、8 个环境类失败、0 个真实失败**；`bridge.js` 达到 **6,475 行**，完成短期目标 <6,500。

---

## 4. 复现命令

```bash
npm run measure                 # 静态指标（可加 -- --json）
npm run gen:config              # 重新生成 config.example.json
node scripts/test-config-schema.mjs

# 全量测试（先排除需要运行中桥接的 test-console）
mv scripts/test-console.mjs scripts/test-console.mjs.disabled
npm test
mv scripts/test-console.mjs.disabled scripts/test-console.mjs
```

---

## 5. 基线使用规则

1. 每个重构阶段结束时重跑本文件第 2 节，断言数与通过数不得下降
2. 新增模块必须新增测试；新增断言计入总量
3. 环境类失败单独列出，不混入"通过率"
4. 静态指标变化超过 5% 时，在阶段记录里说明原因
