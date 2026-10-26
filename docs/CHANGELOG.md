# 更新日志

> 按时间倒序记录「做了什么 + 为什么」。修 bug 优先写清真因，因为下次可能再遇到。

## 未发布

（暂无）

## 0.4.1（2026-10-27）

- **版本号统一为 0.4.1**（2026-10-27 用户要求）：`package.json` / `package-lock.json`、控制台关于页 fallback、三个 MCP server 的元数据、`plugins/qq-mode-console` 统一为 0.4.1；新增 `npm run version:set` 一键同步与 `test-version-sync` 护栏。
- **上游许可归属整理**（2026-10-27）：本仓库 fork 自 [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge)（MIT）。`LICENSE` 版权行改为本 fork 作者（Lu-mi-nous），上游的版权声明与 MIT 许可正文原样保留在 `THIRD_PARTY_NOTICES.md` §0。
- **重构 R2：状态层统一**（2026-10-26）：新增 `src/state/store.js`，22 个状态文件统一为原子写 + 版本迁移 + mtime 热重载的 JSON store；旧裸数组/带 BOM 文件兼容读取。
- **重构 R2.5：可选功能插件化试点**（2026-10-26）：新增 `src/plugins/host.js`、`src/plugin-runtime.js` 与 `plugins/tts/`（manifest 校验、权限、生命周期），GPT-SoVITS 语音合成整体出核；`GET /api/plugins` 上线。
- **重构 R3：bridge 拆分完成**（2026-10-26）：会话、社交调度、任务、加入请求、Token、图库、图片请求、表情库、媒体、社交消息、入站派发、引用解析、报错通道、B站/超分装配逐个出核为独立模块；`bridge.js` 8,621 → **6,475 行**（目标 < 6,500）。
- **重构 R4：控制台路由分域 + 插件 UI 插槽**（2026-10-27）：154 条路由从 console-server 拆到 `src/console/router.js` + 19 个域模块（端点总数 155），`console-server.js` 7,191 → **601 行**，只留鉴权 / CSRF / agent 白名单 / 404；插件可贡献控制台卡片（`ctx.console.registerCard`）与子路由（`registerRoute`），`/api/plugins` 暴露卡片元数据，关于页新增插件卡片槽。新增 `test-console-router` 11 项。
- **复杂度基线重估**（2026-10-27）：`docs/COMPLEXITY.md` 重写为 R4 后新基线，综合评级「中」（0.4.0 为「中高偏上」）；0.4.0 旧评估归档 `docs/archive/`；修正测量脚本误跳 `src/state/` 的口径问题。
- **关于页新增「开发日志」按钮/弹窗**（2026-10-25）：`GET /api/dev-log` 读取更新日志并按 `###` 分组返回，展示副本脱敏会话号/QQ/群名/本机路径。
- **控制台按钮点按反馈**（2026-10-26）：普通按钮统一补一层更轻的下沉与压暗；`prefers-reduced-motion` 下位移与滤镜全部关闭。
- **大肥鱼人格自然接梗**：优先回敬群友原词，支持轻歪解、顺势加码、复读变奏与隔几条消息回收，没人接就收；表情按语境使用，不设轮次指标。
- **修复群 100002005 Token 熔断后仍继续发言**（2026-10-26 用户反馈）：熔断原先只拦「新唤醒」入口，走等待/繁忙路径仍会投递；现统一在发送队列前复查。
- **修复群 100002007 长等待卡死、繁忙 @ 丢失**（2026-10-23 用户反馈）：单个回合内连续调 `qq_wait_for_messages` 会在 quietMs 上限上无限延长；加绝对截止与回合数上限。
- **修复群 100002005「@ 不回」与搜图请求被吞**（2026-10-23）：`evaluateWakeTriggerV2` 把 @/提问降成低优先级被「唤醒频率超限」跳过；现 @/提问必达。
- **修复「试听按钮点了没有能听的音频」**（2026-10-22 用户反馈）：三个独立故障叠加——NLTK 缺数据 500、Windows 管道 GBK 解码把中文打碎、CSP 没放行 `media-src`/`connect-src` 拦掉 blob 音频；三处都修。

## 0.4.0 及更早（2026-10-25 发布快照及更早）

- **G1 记忆断层提醒**（2026-10-25）：新增 `src/session-gap.js` 与 `state/session-gap.json`，每个 QQ 会话记录最后一次完整处理时间；唤醒时若间隔超过 `gapMinutes`（默认 30 分钟）且未提示过，补一段「运行状态·背景补充」，超过 `longGapHours`（默认 6 小时）用「隔了很久」措辞。首次启动/正常连续对话不提示；关闭时 wake prompt 与旧版逐字节一致。控制台 24 卡新增「记忆断层提醒」面板（开关/阈值/长间隔）。新增 `test-session-gap.mjs` 17 项；全套 **120/128、4714 条断言**，8 个既有外部服务依赖，无真实失败。

- **版本号统一为 0.4.0**（2026-10-25 用户要求）：`package.json` / `package-lock.json`、控制台关于页 fallback、三个 MCP server 的元数据统一为 0.4.0；`GET /api/about` 直接读取 `package.json`。

- **控制台前端重构：侧栏分类导航 + 关于页**（2026-10-25 用户要求）：
  - 左侧新增浅色玻璃侧栏，按 **总览 / 运行与消息 / 内容与人设 / 群管理与安全 /
    媒体与能力 / 系统与配置 / 关于** 分类；24 张功能卡保留卡片式布局，按分类过滤。
  - 新增「关于」页：桥接版本、Node、平台/架构、SnowLuma 版本、项目仓库入口；
    新增 `GET /api/about`（版本从 `package.json` 与 SnowLuma `package.json` 读取）。
  - 详情页停在侧栏右侧（留 16px 间距），侧栏保持可点击；点分类/关于会先关闭详情，窄屏（≤900px）侧栏变成横向导航。
  - 关于页卡片复用摘要卡入场/悬停动画（错峰），新增能力概览与技术栈与链接卡；技术栈、官网/GitHub 与本项目全部做成同一风格的链接按钮。
  - 侧栏使用远端 README 的项目 `icon.svg` 作品牌标志，分类图标改为手绘线性 SVG（不再用字符）；关于按钮移到底部分隔线上方，字体放大，默认态有可见按钮底色/描边，悬停层级修正；全局动画统一为 .34s easeOutQuint。
  - `test-console-layout.mjs` 新增 18 项断言，212 项通过。

- **会话级 Token 熔断二期（F1~F3）**（2026-10-25）：新增 `src/token-fuse.js` 与 `state/token-fuse-state.json`，按自然日累计每个 QQ 会话的总输入（含缓存），支持 warn/fused 两级阈值与未缓存第二阈值；`assistant/message` 的 usage 增量计数，每 5 分钟落盘、重启保留、日切归零。熔断后拦截 `scheduleWakeV2` / 自动 `sendWakePromptV2` / B 站自主刷，管理员私聊与控制台手动操作放行；通知只私聊管理员，群里零提示。控制台 16 卡新增熔断面板（开关/全局默认阈值/每会话单独阈值/计数/解除），会话列显示群名/QQ 昵称，每行可保存自定义阈值且不会被全局保存覆盖；管理命令新增 `/tf` 与 `/tf off <key>`。默认关闭，关闭时行为与现状完全一致。新增 `test-token-fuse.mjs` 36 项；全套 **120/127、4693 条断言**，7 个既有外部服务依赖，无真实失败。

- **大肥鱼人格去除确认/记录腔**：原先外号示例里的「应了」、收藏台词里的「这张我收下了」和记忆提示会诱导出「认下了」「我记下了」等任务受理式回复；现改为直接顺着群友聊天，记忆与收藏动作不再汇报，并补回归断言。

- **新增「魔鱼」玩梗人格卡**：强调从当前上下文临时造梗，覆盖原词回敬、谐音双关、歪解、复读变奏与 callback，避免把热梗列表当回复库；认真求助和明确叫停时恢复正常交流。

- **上下文持久化 P2：跨会话人物记忆**（2026-10-25）：新增 `state/shared-memory.json` 与 `src/shared-memory.js`，只共享同一 QQ 号的稳定偏好（白名单谓语、confidence ≥ 0.8 且本地 hits ≥ 2），不共享聊天原文/episode/群名/群内事件。模型给的 `people[].id` 只接受 5~12 位纯数字，名字 id 通过 episode 消息的 sender→userId 反查，无法确定就跳过。私聊只处理/注入对方本人。唤醒时只注入「此人当前在本会话出现」的共享资料（最多 3 人 × 3 条 / 300 字），关闭时注入空串、行为与旧版一致。控制台 24 卡新增面板：默认开启，可关共享偏好、关私聊、调注入上限、查看/按人忘记/整体清空。默认不回填历史长期记忆。新增 `test-shared-memory.mjs` 34 项；全套 **120/127、4693 条断言**，7 个既有外部服务依赖，无真实失败。

- **Token 统计细化到会话级**（2026-10-25）：新增 `state/session-history.json` 记录 sessionId → QQ 会话的映射历史（创建/模式切换/上下文轮换/reset/删除五类轮换点全部接线，首次启用从压缩摘要回填）；`token-usage.json` 增加按 sessionId 的 `sessions` 桶和摘要器的 `summarizer` 桶，轮换后「累计」口径连续、「当前会话」只反映新 sessionId。控制台 16 卡新增按会话排行（当前/累计/未缓存/缓存读/输出/调用/摘要器），24 卡新增「今日 Token（累计）」列。摘要器 usage 通过 `onUsage` 回调记账，网关不返回 usage 时只记调用次数。新增 `test-session-history.mjs` 18 项；全套 118/125、4585 条断言，7 个为既有外部服务依赖，无真实失败。

- **重构第 4D / 4E 步完成代码收尾**（2026-10-25）：入站流程拆为准入、解析、分流三个可独立测试的阶段，模式派发保留在 bridge；图库发送接入每会话队列，社交状态持久化、B 站浏览/推荐、请求判定和角色卡读取移入独立模块。主文件由 10,042 降至 **8,621 行**，读 bridge 文本的测试由 46 减到 **10 个**，33 份旧备份校验后移出 src。补齐重启时自动 @ 冷却与待唤醒原因恢复、各重置入口的回合/waiter 清理，以及慢取图后的发送准入和同前缀目录越界检查。最终全量 **114/124、4479 条断言**，无新增失败；24 卡页面和隔离接口/回放通过，真实服务联调与 24h 灰度未完成。详见 [验收记录](refactor-4d-acceptance.md)。

- **重构第 4B 步：QQ 发送通道独立成 `src/pipeline/qq-send.js`**（2026-10-25）：`sendToQQ` / `sendBurstToQQ` / `sendMessagesV2`（含自动@/TTS 回退）/ `sendAsVoice` / `sendStickerV2` 抽到 `createQQSender(deps)`，bridge 只注入依赖并保留绑定；`bridge.js` 降至 10,628 行。`test-agent-send-guards` 第 3 节改为 `createQQSender` 行为断言（假 deps + 内存 bot），`test-auto-at` / `test-tts` / `test-tts-voices` 的发送路径断言同步指向 `pipeline/qq-send.js`。图库发图（`sendImageV2`）与图强耦合，留在 bridge，随第 4C/4D 步再处理。
- **重构第 4A 步：唤醒提示构建独立成 `src/pipeline/wake.js`**（2026-10-24）：`buildWakePromptV2` 的全部 prompt 文案与结构（角色卡/令牌/功能/Token/语音/记忆包/检索/参与度/表情策略/状态/唤醒原因分支）从 `bridge.js` 抽到 `createWakePromptBuilder(deps)`，bridge 只注入依赖并保留薄包装；`bridge.js` 降至 10,803 行。`test-role-injected-in-wake` 改为 import 行为断言（假 deps 直接构建 prompt），`test-context-memory` / `test-sticker-nudge` / `test-at-poke-reply` / `test-poke-status-line` / `test-poke-target` / `test-status-summary` / `test-token-ask-detect` / `test-tts` / `test-wait-guard` / `test-web-crawler` / `test-feature-menu` 的唤醒提示断言同步指向 `pipeline/wake.js`。
- **重构第 3 步（第二子批）：每会话发送队列 + 模式代际 + 回合 ID**（2026-10-24）：全局 `sendChain` 改为 `src/pipeline/send-queue.js` 的每会话发送队列，跨群发送不再头阻塞、单会话严格保序、失败不毒化后续；`state/sessions.json` 增加 `sessionMeta`，记录 mode + preset，模式/preset 变化时归档旧 DSH 会话并用新能力面重建（老状态无 meta 时按当前模式接管，不批量重建）；新增 `sessionId#turn` 回合 ID，`autoAtTurnDone` 按回合记录，B 站初判 waiter 只接受登记后对应回合的 `turn/end`，不再把别的回合文本当初判结果。新增 `test-send-queue.mjs`、`test-session-generation.mjs`，`test-auto-at` / `test-bili` / `test-agent-send-guards` 同步更新。
- **Token 统计口径修正：区分「总输入 / 未缓存 / 缓存读」**（2026-10-24 用户反馈「对不上实际消耗」）：
  - **实测对齐**：DSH `inputTokens` = 网关 `cache_miss_tokens`，`cacheReadTokens` =
    网关 `cache_hit_tokens`；provider 的 `prompt_tokens` = 两者之和。
  - 旧控制台把 `input` 单独标成「输入 tokens」，看起来只有 1.5 亿，实际总输入是 40 亿+
    （10-23 桥接 4.148B vs 网关同 UA 成功请求 4.266B，差 -2.8%；输出 -9.6%；调用 -6.6%）。
  - 控制台 16 卡、报表图、CLI 统一改为「**总输入（含缓存） / 未缓存 / 缓存读 / 输出 /
    缓存命中率**」，累计、按日、按模型都增加 `totalInput` / `totalTokens`。
  - 报表图按用户要求：删掉「近 7 天合计」，主卡改为「**今日总消耗**」和「**累计总消耗**」，
    小字标明未命中 token；最近 7 天和**按模型**都改成分色堆叠条（橙=未命中 / 蓝=命中 / 绿=输出），
    蓝段标**命中率**（未命中率不标），柱顶标总消耗；渐变绘制，色块边界像素级贴合。
  - 注意：网关的 `credit` 是计费单位，不是 token；桥接不采集 credit。
  - `test-token-report.mjs` / `test-token-usage.mjs` / `test-token-day-review.mjs` 已同步。

- **重构第 3 步（第一子批）：消息管线纯计算层独立成 `src/pipeline/`**（2026-10-24）：把 `identityTagOf`、发送者展示名、群角色、`isOwnerTurn`、媒体提示、入站提示拼装、`segmentsToText`、`normalizeMessagesInput` 从 `bridge.js` 抽到 `src/pipeline/{message-format,segments,text-normalize}.js`；`bridge.js` 降至 10,960 行，消息路径测试改为 import 行为断言。新增 `test-pipeline-message.mjs` 39 项；`test-member-roles` / `test-owner-identity` / `test-msg-normalize` / `test-share-card` 同步迁移。
- **上下文持久化 Phase 3 P1：积压可观测 + 记忆检索面板**（2026-10-24）：
  - 后端新增 **24h 检索覆盖率**（`journalCoverage`）、**召回次数/命中率/平均延迟**（`recall-audit.jsonl` 汇总）、**每会话积压告警阈值**（默认 200 警告 / 800 严重）和**全局积压趋势**（每 5 分钟采样，保留 24h）。
  - 控制台 24 号卡新增：积压趋势条、会话选择 + 记忆搜索框 + 时间线结果、覆盖率/召回列、每行「追赶」按钮（连续生成 episode 直到积压下降）、「重建索引」按钮。
  - 新增 `GET /api/socialV2/context-status` 字段（`coverage` / `recall*` / `backlogHistory` / `backlogLevel`）、`POST /api/socialV2/context-catchup`、`POST /api/socialV2/context-rebuild-index`；长期记忆详情弹窗新增「最近检索命中」审计。
  - 检索审计落在 `state/context/<key>/recall-audit.jsonl`（每会话保留 200 条）；积压历史落在 `state/context/backlog-history.jsonl`。
- **上下文超限自动轮换会话**（2026-10-24）：长寿命群会话的 DSH 历史会涨到模型上限以上，实测 `prompt_too_long: 1412836 tokens > 1048576 maximum`，且 DSH 自己的 `compaction/end` 也报同一个错——压缩请求本身超限，不会自愈，之后每轮都失败。桥接现在识别 `CONTEXT_WINDOW_EXCEEDED` / `prompt_too_long` / `context_length_exceeded`，摘除中毒会话（保留 bridge 侧 recentMessages / episodes / 长期记忆），用新会话重试一次；静默回合只轮换不重试，30 分钟冷却，失败只私聊管理员。新增 `test-context-recovery.mjs` 覆盖识别、轮换、冷却与重试分支。
- **重构第 2 步：管理命令独立成 `admin-commands.js`**（2026-10-24）：`/reset`、`/status`、`/role`、`/silent`、`/active`、`/recall`、`/wl` 与加好友/入群裁决从 `bridge.js` 的命令块迁出，识别、准入例外、执行收敛为三张表（`COMMANDS` / `JOIN_COMMANDS` / `PRE_ADMISSION`），`bridge.js` 降至 10,930 行。新增/调整 `test-admin-commands.mjs`、`test-whitelist-command.mjs`，改为直接 import 模块做行为断言，不再依赖源码文本。
- **重构第 1 步：控制台与 MCP 回调路由独立成 `console-server.js`**（2026-10-24）：144 个路由从 `bridge.js` 完整迁出，主程序从 17,170 行降至 11,217 行；稳定依赖显式注入，运行中状态通过 live getter/setter 访问，会话代际只经命令递增。Agent 权限改为 58 条实际 MCP 路由的显式允许清单，未列出的控制台接口默认拒绝；新增 `test-console-server.mjs` 并迁移相关路由断言。
- **修复 Agent 授权与发送结果语义**（2026-10-24 架构审查）：凭据和全量活动消息接口不再对 Agent 开放；自拍发布改为强制会话令牌的 POST，GET 仅保留预览；Header/Body 双令牌会对账并统一复查暂停与总开关。`sendToQQ` 原先吞掉 QQ 异常，导致入群通知失败不拒绝、B 站推荐失败仍记成功，现已真实传播失败且不影响后续队列；B 站推荐也会在最终发送前重新检查模式、暂停、白名单与静默。
- **大肥鱼人格：管理员 QQ 改为动态读取**（2026-10-24）：`qq_get_prompt` 返回 `ownerQQ`，人格卡不再写死 QQ；被问实现/管理员 QQ 时先查再报，查不到就只说"这个得问管理员"，不硬编。
- **控制台 02 会话映射显示名称 + 02b 消息列表撑满卡片**（2026-10-23 用户反馈）：
  - `/api/sessions` 增加 `kind/name`；复用上下文名称缓存（群列表 / 好友列表 /
    陌生人资料，5 分钟 TTL），历史私聊会话也补查昵称；前端每行显示
    「群名/昵称 + 号码」，不再只有 `group:123` / `private:456`。
  - 02b 整页视图改成纵向 flex：标题和工具行固定，消息列表吃满卡片剩余高度
    （`height: calc(100vh - 112px)`），不再固定 `max-height:460px` 留半屏空白。
  - `test-console-layout.mjs` 新增 7 项断言。
- **非白名单群 @ 机器人：直接回预设话术（不调用 DSH、不耗 token）**（2026-10-23 用户要求）：
  - 群聊里有人 @ 机器人、但该群不在白名单时，直接从几条预设话术中挑一条回复，
    带上**管理员 QQ** 和群号，让群友去找管理员；全程走 OneBot HTTP，
    不经过 DSH / 模型。
  - 同群 **10 分钟只回一次**（`socialV2.whitelistNotice.cooldownMs`），
    连续两次会换一条，避免复读；被显式拉黑的群、管理员自己 @、`closed-agent`
    模式都不触发。
  - 配置：`socialV2.whitelistNotice.{enabled,cooldownMs,messages}`；
    `messages` 留空用内置 3 条模板，支持 `{ownerQQ}` / `{groupId}` / `{groupName}`。
  - `test-whitelist-notice.mjs` 30 项（@ 识别、模板替换、群级限频、接线断言）。
- **控制台直接编辑人格卡**（2026-10-23 用户要求「人格卡不能直接在控制台修改」）：
  - 05 人格卡预览标题栏新增「群友Y1」：直接在 textarea 改 Markdown，
    **Ctrl+Enter 保存、Esc 取消**；保存后热更新（`currentRoleHint` 按 mtime 失效），
    下一轮对话即生效，不用重启桥接。
  - 后端新增 `POST /api/role-content`：与 GET 同一套角色名校验（防路径穿越）、
    512KB 上限；写前自动备份到 `roles/.backups/<角色>.<时间>.md`（每角色保留 20 份），
    再原子写入。
  - 编辑器底部实时显示字数/行数；超过 12000 字会明确提示「注入时会被截断」
    （与 `ROLE_HINT_MAX` 一致）。
  - 编辑期间 15 秒自动刷新不会覆盖正在改的内容；切换预览/群设置会提示未保存。
  - `test-console-layout.mjs` 新增 14 项断言（UI + 后端接线 + 备份/原子写）。

- **收藏表情超过 4MB 必失败 → 上传前自动压缩**（2026-10-23 群友「@dsh 这个存了」）：
  - **根因**：QQ 收藏表情走 highway 上传，单次 body 上限约 **4MiB**
    （实测 4,028,437 字节成功、4,222,487 失败）。超限时 Tencent 侧直接 RST，
    SnowLuma 只能把 `fetch failed` 透传给模型；模型以为是网络抖动，连续重试三次
    都失败，最后回「这张存不下来，等会儿再试」。
  - **修复**：`src/image-downscale.js` 新增 `shrinkStickerForUpload()`——GIF 优先
    降 fps/尺寸/调色板（实测 5.1MB → 2.9MB，保留动画），实在压不下去才退化为首帧
    静态图；静态图逐级缩到长边 ≤1568 的 JPEG。`collectStickerV2` 在上传前压到
    3.75MiB；仍超限则明确报「超过 QQ 收藏表情 4MB 上限」，不再让模型瞎猜。
  - 偶发 highway RST 增加一次 400ms 重试；新增配置
    `socialV2.sticker.collect.maxUploadBytes`（默认 4194304）。
  - **实测**：群里那张 5.1MB / 480×270 / 140 帧 GIF（消息 seq 5250）走真实
    `/api/socialV2/collect-sticker` 收藏成功，日志 `4.9MB → 2.9MB`；测试表情已删。
  - `test-image-downscale.mjs` 扩到 35 项（含真实 6.5MB GIF 压缩、4MiB 边界）。

- **上下文持久化 Phase 3 P0：检索式记忆 + 记忆治理**（2026-10-23 用户要求）：
  - **检索层**：新增 `src/memory-retrieval.js`，对 `messages.jsonl` + `episodes.jsonl`
    做本地 BM25 检索（中文 `Intl.Segmenter` + CJK bigram，无需向量库），支持时间范围、
    seq 排除、情节摘要加权和时间衰减。
  - 新增 `GET /api/socialV2/recall` 与 MCP 工具 `qq_recall_memory`，返回带时间、
    发送者、seq 的证据；唤醒提示在固定记忆包后追加最多 4 条「相关记忆」，
    并记录 `lastRecallChars/lastRecallSeqs` 便于审计。
  - **治理层**：同名人物的 QQ 号/群名片别名合并；`是/叫/身份/所在地` 等单值事实
    出现更高置信度新值时旧值标 `superseded`；`喜欢/在玩` 等多值事实保留并存；
    30 天未提及的 open 线索转 `stale`，半年低置信事实转 `stale`，记忆包与统计只
    展示 active/open 项。
  - 实测：`拔牙低烧` 能命中 10-22 的 episode；`原神` 能同时命中消息和 episode；
    `大肥鱼 B站` 能召回 `seq=41709/41710` 的 B 站卡片与 @。线上三个活跃群唤醒时
    `lastRecallChars` 约 168~292，检索片段已随固定记忆包进入提示。记忆包仍受 1,500 字符预算。
  - 新增 `test-memory-retrieval.mjs` 14 项、`test-memory-governance.mjs` 8 项；
    `test-context-memory.mjs` 扩到 76 项，`test-tool-flags.mjs` 49 项通过。

- **上下文记忆巡检：修复 episode 自动扫描饥饿**（2026-10-23 用户要求）：
  - **巡检发现**：26 个会话、53 条 episode、38 条压缩摘要、约 1.37MB 消息日志；
    但多个活跃群 `lastEpisodeAt` 停在 10-22 22:25 / 10-23 00:40，待总结数高达
    997、2614 条，记忆包长期不更新。
  - **根因**：自动扫描把“从未生成 episode、但只有 5~14 条消息”的私聊按
    `lastEpisodeAt=0` 排在最前，每 5 分钟占满 6 个名额；`makeEpisodeNow` 又因
    `not-enough` 直接返回，导致活跃大群永远轮不到。
  - **修复**：扫描候选先按 `episodeEveryMessages` / `idle + episodeIdleMinMessages`
    过滤，只有本轮真能生成 episode 的会话才入候选；每个会话每轮最多连续消化
    `sweepChunksPerKey=2` 段、单轮总量 `sweepMaxEpisodesPerRun=12` 段，避免活跃群
    追不上消息增速；扫描增加触发/候选/完成日志，异常有兜底日志。
  - **实测**：重启后 episode 53 → 77，人物 115 → 137，事实 226 → 332，
    未结线索 79 → 119；主群记忆包 622~833 字符，人物/稳定事实/线索/最近情节齐全。
    剩余大群积压仍在按每轮 2 段追赶（例如 100002005 约 2587 条）。
  - `test-context-memory.mjs` 扩到 73 项；新增候选过滤、单轮多段追赶与失败日志检查。

- **二代仿真（reserved2）控制台参数与界面重构**（2026-10-23 用户要求）：
  - 07 号卡从一张超长表单改成 **6 个参数页签**：唤醒 / 发送 / 等待与调度 /
    表情与上下文 / 工具开关 / 诊断；切换只切 `active` class，不移动或重建 DOM，
    原有控件 id 和保存逻辑全部保持兼容。
  - 等待与调度页新增可编辑硬参数：`wait.maxQuietMs`（单次静默上限，最大 15000ms）、
    `wait.turnMaxCount`（单回合最多等待次数，默认 2）、
    `wait.turnMaxMs`（单回合累计上限，默认 120000ms）。
  - 唤醒页新增 `wake.preSleepReplyGraceMs`（本回合已发言后允许收尾的宽限，默认 30000ms），
    用于避免活跃群“永远等不到 60 秒静默”的死循环。
  - 参数行改成标签紧跟控件，修掉原来标签被 flex 拉到半屏外、输入框散落两端的问题；
    07 摘要卡悬停文案同步显示「等待≤N次/Ms」。
  - 新增参数已写入 `config.example.json` 和运行配置；`test-console-layout.mjs`
    新增 10 项分组/绑定检查，`test-wait-guard.mjs` 新增 2 项参数检查。

- **修复 100002007 长等待卡死、繁忙 @ 丢失，并补看 B 站视频**（2026-10-23 用户反馈）：
  - **现象**：群 `100002007` 的 `turn 3576` 从 14:27 跑到 14:52，24 分钟没结束；
    期间所有消息都显示「会话繁忙」，群友 14:45:33 @ 它看 B 站卡片的请求没有回复。
  - **根因**：单个回合里连续调了 6 次 `qq_wait_for_messages`（`quietMs=75~80s`、
    `timeoutMs=150~180s`），旧实现会按 `timeout + maxQuietMs` 延长，单次实际
    107~245 秒，累计约 20 分 56 秒；同时群的 wakeConfig 是 `diving`，沉睡前
    观察要求连续 60 秒安静，活跃群永远满足不了，模型只能继续 wait。
  - **wait 修复**：`quietMs` 单独封顶 15 秒；单次等待绝对截止为
    `timeout + quietMs + 1s`；新增按 DSH turn 的硬上限（最多 2 次 / 累计 120s），
    超限返回 `forceWrapUp` 让模型立即结束回合；唤醒提示明确「已经发过言就不要再
    wait 守候」，回复检查也改为直接结束。
  - **丢 @ 修复**：繁忙入队时保存触发消息正文快照（`pendingWakeMessage`），
    旧队列只有 seq 时从完整 `messages.jsonl` 补正文；唤醒提示显式列出「此前繁忙
    期间漏看的消息」。引用目标被 `recentMessages` 挤出时也从 journal 找回。
  - **沉睡前死锁**：本回合已经发过言且距最后一次发言超过 30 秒时，不再强制
    等待连续 60 秒静默，避免活跃群无限循环。
  - **补看结果**：恢复 `seq=41710` 后，模型实际调用 `qq_watch_bili` 看完了
    `BV166nW6REyR`（《“大肥鱼适合做女朋友吗？”》，UP 学姐圆），并在群里回复了
    「夜老师你发那个视频我看了，开头就是我穿女仆装在路边喝汤吃油条」。
  - 新增 `test-wait-guard.mjs` 15 项；`test-pending-caller-guard.mjs` 36 项、
    `test-console-layout.mjs` 152 项、`test-v2-wait.mjs` 均通过。

- **控制台 10 白名单/管理员：修正悬停摘要**（2026-10-23 用户反馈）：
  - **现象**：鼠标悬停在 10 号卡上显示「群 0 · 私聊 0」，实际配置是
    9 个允许群、4 个允许私聊。
  - **根因**：名单改成单选下拉框后，摘要仍用 `select.value` 数条数——下拉框一次
    只承载一个值，所以永远只能得到 0 或 1；并且白名单是异步加载的，首次计算
    摘要时 `wlState` 还是空数组。
  - **修复**：改为数 `wlState.allowGroups / allowPrivate` 的完整数组长度；
    `refreshWhitelist()` 成功后立即重算摘要。正常态显示
    「群 9 · 私聊 4 ｜ 好友放行」，只有缺少管理员时才追加「无管理员」并亮红点。
  - 无头 Chrome 悬停实测摘要与 API 返回一致，文案单行不折行；
    `test-console-layout.mjs` 152 项通过。

- **控制台 24 上下文与记忆：刷新按钮加可见反馈**（2026-10-23 用户反馈）：
  - **现象**：点「刷新」后页面没有任何变化；接口其实有返回，但按钮在请求期间
    没有状态，数据不变时看起来就像没生效。
  - **修复**：请求加 `?t=Date.now()` 绕过缓存；点击后按钮变为「刷新中…」并禁用，
    完成后在按钮旁显示「已更新 HH:mm:ss」，失败显示「刷新失败，请查看状态行」；
    5 秒后自动清除成功提示。
  - 无头 Chrome 注入 700ms 网络延迟实测：请求 URL 带时间戳，刷新期间按钮禁用且
    显示「刷新中…」，完成后恢复并显示「已更新」；0 个页面异常。
    `test-console-layout.mjs` 149 项通过。

- **控制台 04 活动日志改为实时消息状态流**（2026-10-23 用户要求）：
  - 旧版是 append-only 文本，状态只会在新行里出现，不会原地变化；现在改为按
    **消息**聚合的状态行，每秒刷新。
  - 新增 `GET /api/socialV2/activity-feed`：从 `recentMessages / unread /
    pending / answeredSeqs / busy` 实时推导
    `未读 / 处理中 / 待回复 / 已回复 / 已读 / 已发送 / 语音已发`，每个会话取最近
    20 条、全局最多 120 条。
  - 前端改成带状态 pill 的滚动列表：保留滚动位置、语音消息单独标记
    `[语音]`，顶部显示待回复/处理中/未读/已回复/已发送计数；04 摘要卡同步显示
    实时计数。
  - `test-console-layout.mjs` 147 项、`test-context-memory.mjs` 69 项通过。

- **修复桌面「停止QQ机器人.bat」认不出桥接**（2026-10-23 用户反馈）：
  - **根因**：`stop-all.ps1` 只匹配命令行里的
    `qq-bridge-main\src\bridge.js` 绝对路径（`-like` 还把正斜杠路径视为不匹配），
    而实际实例是 `node src/bridge.js` 相对路径启动的，于是脚本报
    「桥接本来就没在运行」，双击也关不掉。
  - **修复**：识别顺序改为 **监听端口（`config.consolePort`，默认 3100）→
    `state\bridge.lock` 里的 PID → 命令行（正/反斜杠都认）**；相对路径实例再用
    进程加载的模块确认属于本项目，避免误杀别的项目同名脚本。`Stop-Process`
    之后会确认进程真的退出，停不掉如实报错而不是假装成功。
  - DSH / SnowLuma 也加了端口兜底；`-IncludeDsh` 的 MCP 识别兼容相对路径，
    并优先按「DSH 的子进程」判断。
  - 实测：`node src/bridge.js` 起的实例、仅监听 3100 的假进程、以及只写
    `bridge.lock` 的 PID 三条路径都能被识别并停止。

- **修复语音上下文标记 + 入站语音转写**（2026-10-23）：
  - **现象**：桥接按概率把一条文字回复改成 TTS 语音发出后，`recentMessages`
    仍把原文记成普通文字；模型下一轮不知道自己刚发的是语音。
  - **自己的实例已复现**：`group:100002004` 在 01:40:51 有
    `[TTS] 已发语音` 日志，同一时刻的 self message 却是纯文本
    「三千九百多个模型七百多 G…」，没有任何语音标记。
  - **修复**：`sendMessagesV2` 概率语音成功时返回 `{text, isVoice:true}`；
    `recordSentMessagesV2` 写入时加 `[语音] ` 前缀和 `isVoice` 字段（同时进
    journal）；主动 `qq_send_voice` 端点也写回 `recentMessages`，并更新
    `lastAiReplyAt/lastActionAt`，避免它发了语音却不算一次回复。
  - **入站语音转写**：收到群友语音时，从 record 段取 `file`，经 SnowLuma
    `get_record(out_format=wav)` 转成 wav，再交给本地 faster-whisper；转写文本以
    `[语音]（语音转文字：…）` 注入唤醒提示/上下文，同一消息缓存不重复识别；
    ASR 不可用或失败时保留 `[语音]` 占位，不影响文字消息。
  - **概率语音与引用**：原先只要回复带 `replyToMessageId`（新 guard 下大多数
    @ 回复都带）就直接跳过 TTS，群友感受就是“再也不发语音”；现在带引用目标
    仍可掷中语音。**实测 QQ 不支持 `reply + record` 同气泡**（客户端不渲染语音，
    只在通知里提示），所以语音改为单独 `record` 发送；桥接内部仍把这条算作对
    引用目标的回复（未读移除 / `answeredSeqs`），语音失败回退文字时保留引用。
  - `test-tts.mjs` 扩到 161 项（新增概率语音 isVoice、`[语音]` 标记、
    主动语音写回/回复时间、入站语音转写函数、语音 reply 段断言）。

- **上下文持久化 Phase 2：全量消息日志 + 长期记忆**（2026-10-23）：
  - **Phase 0/1 的实际缺口**：episode 只读 `recentMessages` 最近 100 条；一次突发
    超过 `episodeInputLimit=60` 时旧代码取 `slice(-60)`，会跳过中间段；300 条
    episode 只注入最近 2 条，认识的人/约定的事很快被挤出记忆包。
  - **Phase 2A 全量日志**：每个会话新增 `state/context/<key>/messages.jsonl`，
    入站消息和机器人自己的发言都按顺序落盘（保留 3000 条 / 2MB 整理）；生成
    episode 时合并 journal + recentMessages，按 messageId/seq 去重，按时间取
    **最早**一批 60 条，下一轮从 toSeq 继续，不再跳中间。
  - **Phase 2B 长期记忆**：episode 的 people/facts/threads 合并到
    `memory.json`（按 id/三元组/title 去重，人物 30 / 事实 80 / 线索 40）；
    历史 episode 可补种；记忆包新增「长期记忆·人物」「长期记忆·稳定事实」，
    线索优先取长期记忆里的 open 项。`context-clear` 只删派生记忆，保留消息日志。
  - **Phase 2C 扫描与展示**：sweep 按“最久没总结 + 实际积压”排队，待总结数按
    journal+recent 去重后的真实可处理量计算；24 号卡新增「日志」「长期（人物/事实/未结线索）」两列
    和全局长期记忆汇总。会话列优先显示群名/QQ昵称（下层保留群号/QQ 号），
    名称从 OneBot 群列表/好友列表读取并每 5 分钟刷新。点「长期」按钮打开详情弹窗，
    可分节查看人物/稳定事实/线索/最近 5 条情节，并支持「从 episode 重建」长期记忆。
  - **摘要器修复**：实测本机网关会忽略 system role，把抽取规则移到 user；
    支持 `response_format=json_object`，不支持时自动回退；模型会先写长
    reasoning，`max_tokens` 从 1200 提到 4000；首次 JSON 失败用 30 条短窗口重试。
  - **实测**：Phase 2 后 44 条 episode 补种出 101 人物 / 190 事实 / 71 条未结线索；
    `group:100002032` 手动总结 60 条生成 people 5 / facts 5 / threads 3，
    `group:100002005` 记忆包 754 字符（人物/事实/线索/最近发生齐全）。
  - `test-context-memory.mjs` 69 项、`test-console-layout.mjs` 147 项通过。

- **修复群 100002005「@ 不回」与搜图请求被吞**（2026-10-23）：
  - **根因 1**：`evaluateWakeTriggerV2` 先判断 `anyMessage`，把 @/提问/指定成员/
    关键词都降成低优先级；群一热闹就被「唤醒频率超限」跳过。
  - **根因 2**：`findCallersV2` 按 `lastAiReplyAt` 时间推断「已答」；机器人引用
    回复 A 后，同一批里没答的 B 也被算成 answered，`mark_read` 顺手标掉。
  - **修复**：触发判定按 `WAKE_PRIORITY` 从高到低排序；唤醒投递前若还有未答 @，
    强制升级为 `atMention`；新增持久化 `answeredSeqs`，只记录明确带
    `replyToMessageId` 的回复目标，旧状态加载时补种；guard 报错提示改用
    `qq_reply` / `replyToMessageId`。
  - **实测**：反向搜图正常（owner 引用的图命中 Danbooru 96.1%，作者
    yoshino ryou，额度 99/100）；修复后群里 `atMention@seq7194` 正常唤醒并
    发出 pixiv 图 148670939，新 @7198/7199 也按 atMention 排队。
  - `test-at-poke-reply.mjs` 42 项、`test-pending-caller-guard.mjs` 36 项等通过。

- **控制台：白名单/管理员改成下拉菜单管理**（2026-10-22 用户要求）：
  - 允许的群号、允许的私聊 QQ、管理员 QQ、拒绝的群号、拒绝的私聊 QQ
    五个字段从逗号分隔输入框改成单选 `<select>`；每行右侧是「＋ 添加」「删除」。
  - 添加/删除立即 `POST /api/whitelist` 并刷新顶部状态；管理员是单值，
    添加会替换当前管理员，删除会清空（二次确认，清空后 fail-closed）。
  - 空列表显示「— 暂无 —」；号码校验 5~12 位数字；重复、替换、清空都有提示。
    私聊准入策略仍是独立下拉；策略有未保存改动时，增删名单不会偷偷改策略，
    状态行会提醒点「保存白名单」。
  - 下拉展开的选项面板用 `oklch(99.4% .003 240)`，比收起时的 `--bg` 稍白；
    选中项用 `oklch(98.2% .008 240)` 做浅高亮（仍比收起填充白）。
  - 无头 Chrome 在 1400/390 宽度验证布局与增删请求（POST 用拦截，未改真实配置）；
    `test-console-layout.mjs` 新增 13 项，共 135 项通过。

- **控制台：摘要卡改为整页展开**（2026-10-22 用户要求）：
  - 点击摘要卡不再弹 M/L/XL 小窗，而是在卡片位置生成一块同尺寸的白色 ghost，
    用 `transform` 长到详情页大白卡的实际矩形，页面内容随后淡入。
  - **ghost 不带边框/阴影**：它会被 `transform` 放大，1px 边框和卡片阴影也会被
    放大成粗灰边；圆角按缩放比例反算，真实白卡的边框/阴影/内容等白面到位后再接管，
    结尾不会出现粗细跳变。
  - **没有用 View Transitions**：整页快照（24 张玻璃卡 + 详情表）截一次图就要
    几十毫秒，实测开页有 7 帧 >33ms。改成手动 FLIP（只动 transform /
    border-radius / opacity）后降到 0~2 帧 >33ms；同时暂停背景波浪 canvas、
    去掉详情顶栏的 `backdrop-filter`，避免动画期间抢合成器。
  - 缓动统一为 `cubic-bezier(.4, 0, .2, 1)`、约 0.54s；展开终点是详情页里
    大白卡的实际矩形（保留页面边距），不是整个视口。返回时整页背景淡出，
    同时大白卡缩回摘要卡，不再缩放整页、也不会出现整页白面铺满屏幕。
  - 顶栏新增「← 返回」按钮，`Esc` 同样返回；返回后焦点回到原卡片。
    `prefers-reduced-motion` 下不做动画，直接切换。
  - 详情仍是**原 DOM 节点移动**，24 号表格、02b 消息回看、3 秒轮询等既有逻辑不变。
    摘要网格只加 `inert`、不 `display:none`，卡片位置和页面滚动位置都保留；
    整页内打开黑话/凭据浮层时 `Esc` 不会误退整页。
  - 无头 Chrome 实测：展开/返回、reduced-motion、390px 窄屏均正常；
    `test-console-layout.mjs` 147 项、`test-console-animations.mjs` 50 项通过。

- **按需爬网页 / 图片存表情 / 分享卡片完整链接**（2026-10-22）：
  - **小红书卡片打不开的根因**：`appendSocialV2Message` 把 `text/plain` 硬切
    200 字，而分享链接在文本末尾，`xsec_token` 正好被切掉；实测缺 token 的
    item 页返回「小红书 - 你访问的页面不见了」。现在卡片消息放宽到 **1200 字**，
    并单独存 `shareUrl / shareCover / shareTitle / sharePlatform`；唤醒提示
    直接附带完整分享链接，`qq_get_*_messages` 也能拿到。
  - **新增 `src/web-crawler.js`**：所有请求走 `safe-fetch`（禁内网/环回/私网、
    DNS rebinding 与逐跳重定向校验、限量）；通用 HTML 提取标题/描述/正文/
    `img/src/data-src/srcset/og:image`；aigengtu 适配器直接读公开的
    `gallery-index.json`；图片下载后校验格式，webp 通过 ffmpeg 转 png。
  - **新增 `POST /api/socialV2/crawl` + MCP `qq_crawl_web`**：
    `mode=text/images/stickers`；`stickers` 走 SnowLuma 的 `add_custom_face`
    （本地路径/URL/base64 都支持），按 md5 去重，每次最多 3 张、每天 20 张、
    每小时最多 10 次爬取；`dryRun` 只下载校验，不写 QQ 收藏表情。
  - **工具开关 `crawl`** + preset 第 27 条：不绕过登录/验证码，
    打不开的页面如实告诉群友；aigengtu 可只传 query/category。
  - **实测**：aigengtu 索引 915KB，按 `DeepSeek` 返回作品；dryRun 下载
    webp→png 1.1MB、md5 去重正常；小红书无 token 返回
    `ok:false / needsLogin:true`。验证阶段**没有**往收藏表情写入测试图，
    `add_custom_face` 的参数/返回按 SnowLuma 源码核对，dryRun 覆盖了
    下载→校验→去重→转码全链路。
  - `test-web-crawler.mjs` 37 项（含 `LIVE_CRAWL=1` 实测）；`test-share-card`
    73 项、`test-mcp-safe`（确认 `qq_crawl_web` 注册）通过。

- **修复「@ 了几分钟没回」：mark_read 把新 @ 当已读**（2026-10-22）：
  - 现象：群友 20:18:59 @ 它去 aigengtu 找 DeepSeek 娘表情包，它 20:20:51
    `qq_mark_read` 时把这条 @ 一并标读，直到 turn 结束后靠 backfill 才在
    20:23:18 回复——延迟 4 分 19 秒，用户截图时回复还没发出。
  - 根因：拦截条件 `callerMsgs.pending.length && !repliedThisTurn` 中的
    `repliedThisTurn` 只看「本轮是否发过言」。机器人 20:14:38 已经发过言
    （早于新 @），这个条件为 true，于是新 @ 被放行标读。
  - 修复：`pending` 本身已按 `lastAiReplyAt` 判定「这条 @ 之后有没有发言」，
    拦截只看 `pending.length`，不再叠 `repliedThisTurn`；
    `qq_set_wake_config` 的潜水拦截同步修改。
  - `test-pending-caller-guard.mjs` 增加真实时间线回归（27 项通过），桥接已重启。

- **控制台：24 号上下文卡片 + 交互波浪 + 悬停光泽修复**（2026-10-22）：
  - **新增 24 上下文与记忆**：卡片从 `/api/socialV2/context-status` 拉 24 个会话的
    DSH 会话体积、压缩次数、情节条数、待总结消息、提示/记忆字符数；每行可「总结」
    （强制生成一条 episode）或「清空」（只删该会话的情节/压缩记忆，不动聊天记录）。
    摘要卡显示「共 N 个会话 · 会话文件 X MB · N 条情节 · N 条压缩摘要」。
  - **修复摘要卡悬停光泽**：原来 `::after` 在文字上方、且是覆盖整卡的高亮白渐变，
    悬停时会把标题/摘要洗白。现在卡片 `overflow:hidden + isolation:isolate`，
    内容抬到 `z-index:1`，光泽放在 `z-index:0`；同时把「整卡白闪」改成
    **窄光带扫过 + 跟随鼠标的柔光**（`--mx/--my` 由 delegated pointermove 写入）。
  - **仿 SnowLuma 登录页的「布在风中飘」背景**：固定 canvas，约 120 列密集
    竖线、点距 10~18px，中点二次曲线平滑。位移由三组低频正弦 + 一组横向
    大摆幅叠加，相位同时依赖 x/y，相邻竖线只差一点相位——整片布一起缓慢
    起伏，不会出现某几条线突兀地扭。鼠标经过时是宽高斯（σ≈220）的小阵风
    （最大 14px），没有硬边圆洞。线条中部 alpha .26、容器 opacity .75；
    aurora 光斑 18~24 秒漂移 + 透明度呼吸，线条色相约 80 秒缓慢漂移。
    `prefers-reduced-motion` 下只画静态一帧，不跑 rAF。
  - **窄屏排版**：≤640px 时 body 间距收紧、目录改横向滑动（不再占三行）、
    摘要卡单列、弹窗铺满。
  - **修复 24 号表格溢出**：容器原来只有 `max-height:420px` 没有 `overflow`，
    表格超出后直接画到容器外，盖住下面的说明文字与「刷新」按钮。现在容器
    横竖自滚（`max-height: clamp(240px,54vh,520px)`），表头 sticky，操作列
    右对齐不换行；30 秒刷新后会恢复原滚动位置。
  - **实测（无头 Chrome）**：24 张摘要卡 / 上下文弹窗 24 行数据正常，无 JS 异常；
    悬停时 `--mx/--my` 生效、`::before` 柔光可见、内容 `z-index:1` 压住光泽；
    波浪 canvas 约 10 万非透明像素；DSH 压缩摘要已真实捕获一条
    （`group:100002005 压掉 163k tokens`）；24 号弹窗在 1400/900 宽度下
    表格与说明文字均无重叠。
  - `test-console-layout.mjs` 105 项（新增 24 号卡、表格滚动、光泽分层、
    波浪/reduced-motion 断言）；`test-context-memory.mjs` 43 项、
    `test-console-animations.mjs` 50 项全过。

- **控制台改版：摘要卡网格 + 液态玻璃 + 卡片弹窗**（2026-10-22 用户要求，按 `qq-bridge-console-redesign.md` 实施；**同日后续已改为整页展开，见顶部条目**）：
  - **首页从卡片平铺改成一屏摘要卡**：卡片固定 136px 高、尺寸一致。
    **默认只显示序号和名称并居中**；鼠标悬停/键盘聚焦时名称整体上移、下方浮现 1~2 行功能简介。
    有待办的卡右上角呼吸圆点。
  - **点卡片打开详情弹窗**（M/L/XL 三档宽度；后改为整页视图）：`Esc` / 遮罩 / × 关闭，焦点自动还原到触发卡片，
    打开期间给背景网格加 `inert`。
  - **实现的关键决策：详情 DOM 原样保留、id 一个不改**。所有 `<section class="card">` 仍在
    `#detailPool` 里，点开时把**同一个节点**移进弹窗、关闭移回。因为是移动不是重建，
    3000 行既有 JS（getElementById / 事件绑定 / 3 秒轮询）零改动，弹窗内数据照常刷新。
  - **视觉**：oklch 令牌替换原 hex 配色（变量名不变，避免两套并存）；`.glass` 液态玻璃
    （摘要卡 12px / 弹窗 20px 背景模糊，顶部内高光）；摘要卡 stagger 入场 + 跟随鼠标的柔光；
    `prefers-reduced-motion` 下动效全部关闭。
  - **背景换成「布料」**：`#waveCanvas` 上画竖线，采样点按几组低频正弦沿高度叠出折痕；
    相位里带竖线的 x 系数，相邻线才会堆出明暗折痕（没有它就像一排直尺各自平移）。
    鼠标经过时附近的点被"拨"开，靠弹簧 + 阻尼回弹，并借相邻点耦合沿线传播。
  - **顶部目录已删除**（用户认为没必要）：一屏看完，跳转没有意义。
  - **踩到并修掉的坑**：
    ① `.grid { display:grid }` 压过 UA 的 `[hidden]`，详情池藏不住（摘要卡下面还排着所有详情卡）→
       加 `#detailPool[hidden] { display:none !important; }`；
    ② 黑话编辑弹窗原本在 `#detailPool` 内，池子一隐藏就永远打不开 → 移到 body 级；
    ③ 层级必须是 整页详情 900 < 黑话 1000 < 凭据说明 1200，否则嵌套浮层被盖住。
  - 02b 会话消息作为 02 的二级视图在弹窗内展开。
  - **数量摘要修正**：02/03 原来数「子节点个数」——列表被包在 `.sess-list` / `<table>` 里，
    子节点永远只有 1 个，于是 02 永远显示「1 个会话」、03 空着也显示「1 条待处理」。
    改为数真实行（`.sess-row` / `table tr` 减表头），空态 `.empty-state` 自然为 0。
  - **凭据卡多出的眼睛按钮**：说明文字里内联的 `<span class="cred-eye">👁</span>` 共用了
    眼睛按钮的 `position:absolute`，被定位到弹窗极右侧。改为绝对定位只作用于
    `.cred-input-wrap` 内的按钮，说明处用不带定位的 `.cred-eye-inline`。
  - 测试：`test-console-layout.mjs` 扩到 98 项（新增 4b 外壳章节：摘要卡/详情池/弹窗骨架/尺寸档/
    焦点与 inert/z-index/统一高度与悬停行为/数量摘要数真实行/折痕与回弹/reduced-motion 覆盖），
    并修掉因容器 section 与行内闭合标签而误报的旧断言；凭据测试同步加 3 项眼睛定位断言。
  - 协作约定：改版期间用 `public/console.html.lock` + `scripts/ui-lock.mjs` 加锁，
    避免同时改后端的 agent 反复轮询/改写半成品前端（完成并测试通过后已释放）。

- **上下文持久化 Phase 0/1：情节记忆 + 压缩摘要 + 记忆包**（2026-10-22）：
  - **现状问题**：长期上下文几乎全压在 DSH 会话文件上（24 个会话约 268MB 压缩后，
    最忙的群 78MB/31 次压缩）；桥接只有 recentMessages 100 条 + 少量人工记忆，
    中间没有"上周聊过什么"的层。DSH 压缩摘要虽然存在，桥接以前看不到。
  - **Phase 0**：
    - 捕获 `compaction/summary` 事件，落到 `state/context/<key>/compactions.jsonl`
      （独立目录，不塞进 social-v2.json），作为更早历史的兜底；
    - 记录每个会话最近一次唤醒提示长度/记忆包长度/会话文件大小，超过预算写日志；
    - 核对网关 `/v1/models`：`cn/global:deepseek-v4.1-flash` 的
      `context_length` 确为 1,000,000，`settings.yaml` 的声明是匹配的。
  - **Phase 1**：
    - 新增 `src/context-memory.js`：每累计 40 条新消息、或空闲 20 分钟且有 15 条以上，
      用本地网关（`cn:deepseek-v4.1-flash`）把最近 60 条压成一条结构化 episode
      （summary/topics/people/threads/facts，带 confidence，敏感信息脱敏）；
    - episode 存 `state/context/<key>/episodes.jsonl`（每会话最多 300 条）；
    - 唤醒时把最近 2 条 episode + 进行中的线索按 1,500 字符预算拼成记忆包注入，
      没有 episode 时回落到最近一次 DSH 压缩摘要；
    - 自动扫描每 5 分钟一次，每次最多 6 个最近活跃会话，串行调用避免打满网关；
      启动 90 秒后补扫一次；
    - 新增接口：`GET /api/socialV2/context-status`、
      `POST /api/socialV2/context-summarize`、`POST /api/socialV2/context-clear`。
  - **实测**：真实生成了 5 个群的 episode；唤醒 prompt 里出现
    `【长期记忆·最近发生】`，`lastPromptChars=10229`、`lastMemoryChars=191`；
    网关摘要单条约 5.6 秒。
  - `scripts/test-context-memory.mjs` 43 项（触发窗口、JSON 校验/脱敏、
    记忆包预算、摘要器 mock、桥接接线）。
  - 控制台卡片待前端重构锁解开后接入（数据来自 `context-status`）。

- **语音停顿更自然 + 音量过小修复**（2026-10-22 用户要求）：
  - **方案 B（韵律参数）**：把请求级参数暴露出来并接入控制台——语速 `speed`、
    分句停顿 `fragmentInterval`、`temperature`、`top_k`、`top_p`、
    分句方式 `textSplitMethod`（默认 `cut5`，按标点分句）。
    全部按请求现传，保存后**下一次合成即生效**，不需要重启。
  - **标点规范化**：合成前补句末标点、去掉 `[表情76]` / `[图片]` 占位符；
    长句完全没有逗号时，在第一个连接词（但是/所以/因为…）后补一个逗号，
    给模型换气点。只影响“念出来的文本”，不改实际发送的消息。
  - **响度**：实测 GPT-SoVITS 输出 RMS ≈ **-38 dBFS**、峰值 ≈ -21 dBFS，
    约为正常语音的 1/16，手机/群语音里几乎听不清。Python 侧增加
    **自动响度归一**（目标 RMS -20 dBFS，只提升不衰减）+ **峰值限制 -1.5 dBFS**；
    另有 `volumeGainDb` 手动增减。
  - **实测同一句**：RMS -38.1 → **-20.0 dBFS**，峰值 -22.9 → **-5.4 dBFS**
    （约 +18 dB），无削波。
  - 控制台新增：语速 / 停顿 / 温度 / top_k / top_p / 分句方式 / 额外音量 /
    标点规范化开关。
  - 缓存键包含全部韵律参数，改参数不会命中旧音频。
  - `test-tts.mjs` 增至 139 项。

- **音色归档 → 音色预设 + 按语气选参考音频**（2026-10-22 用户要求）：
  - **归档整理**：新增 `GPT_SoVITS/voices.json`，统一描述「音色 → 权重版本 →
    按情绪分类的参考音频」。爱弥斯的 v2Pro/v2ProPlus 两套权重 + 开心/中立/忧伤
    5 条参考全部登记；达妮娅原来散在 `output/slicer_opt/` 的 6.74 秒参考音频
    已归档到 `达妮娅/refs/中立/dania-neutral-1.wav`，台词同步写入 `.txt`。
  - **接好爱弥斯**：`socialV2.tts` 新增 `voiceId` / `weightsId` / `refMode`。
    当前选 `aemis` + `proplus`（v2ProPlus）；引擎启动时按预设加载权重，
    并继续按 SoVITS 权重自动识别版本（v2Pro/v2ProPlus 不会混用）。
  - **按语气选参考**：GPT-SoVITS 没有情绪参数，语气完全来自参考音频。
    桥接合成前用 `moodOfText()` 判断回复语气（开心/生气/难过/中性），
    从同情绪的参考里随机挑一条；同一情绪有多条时不会永远用同一条。
    参考音频是**每次请求**传的，换参考策略即时生效，不必重启。
    缓存键包含参考 id/路径，换情绪不会命中旧音频。
  - **控制台**：18 号卡片新增「音色预设 / 权重版本 / 参考音频」三个下拉 +
    参考台词预览；音色/权重是启动参数（需重启），参考策略即时生效。
  - **实测**：`tts-say` 带 `mood=happy` → `happy-2`、`sad` → `sad-1`、
    `speechless` → `neutral-2`；固定 `happy-2` 时按指定参考合成，均返回 200 WAV。
  - `scripts/test-tts-voices.mjs` 39 项；`test-tts.mjs` 121 项。

- **控制台的 TTS 权重一直没生效**（2026-10-22 排查发现）：
  - 现象：控制台模型设置里写的是「爱弥斯」权重，状态行也显示爱弥斯，
    但引擎实际加载的是 `tts_infer.yaml` 的 `custom` 段（dania）。
  - **根因**：`scripts/sovits-server.py` 只把 device/half 传给 `TTS_Config`，
    没有传控制台的 `gptModel` / `sovitsModel`；那两个路径只用于启动前的
    存在性探测，对实际加载没有任何影响。
  - **修法**：Node 通过 `QQB_SOVITS_T2S` / `QQB_SOVITS_VITS` 传绝对路径；
    Python 在 `TTS(cfg)` 之前覆盖 `cfg.t2s_weights_path` / `cfg.vits_weights_path`，
    并用 GPT-SoVITS 自带的 `get_sovits_version_from_path_fast` 按 SoVITS 权重
    自动识别版本（dania → `v2ProPlus`、爱弥斯 → `v2Pro`），避免版本混用。
  - 不让库把 `custom` 段写回用户的 yaml（把 `save_configs` 置空），
    GPT-SoVITS 仓库保持原样。
  - 状态接口新增「实际权重 / 版本」，控制台直接显示，不再出现
    “显示 A、实际跑 B”；实测加载为
    `爱弥斯v2pro-e15.ckpt / 爱弥斯v2pro_e8_s488 - .pth（v2Pro）`，
    试听接口返回 265KB WAV。
  - `scripts/test-tts.mjs` 增至 121 项。

- **语音合成路径手打太麻烦 → 加「选择…」按钮**（2026-10-22 用户要求）：
  - 引擎目录 / GPT 权重 / SoVITS 权重三个输入框各加一个「选择…」按钮：
    目录弹**文件夹选择**，权重弹**文件选择**（过滤 `*.ckpt;*.pth;*.pt;*.safetensors`）。
  - 为什么不用 `<input type=file>`：浏览器不会把选中文件的**绝对路径**交给 JS，
    而引擎要的正是本机绝对路径。所以由桥接起 PowerShell（`-STA` 才能弹 WinForms）
    在**运行桥接的这台电脑**上弹原生对话框。
  - 中文路径经 **UTF-8 无 BOM 临时文件**回传，不走 stdout 管道——避免
    PowerShell 5.1 / 控制台代码页把中文按 GBK 解码（TTS 试听已经踩过一次）。
  - 选中后立即标记 `dataset.edited`，60 秒轮询不会把刚选的路径冲回旧值；
    仍需点「保存参数」，模型设置重启后生效。
  - 同一时刻只允许一个选择窗口（`pickPathBusy`），连点不会叠出多个对话框。
  - `scripts/test-tts.mjs` 增至 115 项（新增按钮/端点/编码/轮询保护断言）。

- **`/yes 9` 裁决失败：邀请已被 QQ 自动同意**（2026-10-22 group:100002015）：
  - 现场：15:02:02 机器人被拉进「暴龙战士培训班」，桥接同一秒收到「入群」通知和
    「群邀请」事件；15:02:03 照常通知管理员「新的入群请求 #9」，15:02:46 管理员回
    `/yes 9` → `提交裁决失败 #9：matching group request not found`。
  - **根因**：QQ 侧已经自动同意了邀请（SnowLuma 日志同一秒有
    `入群 [dsh] 加入 100002015`），请求从 OneBot 的待处理列表消失。
    桥接仍把它当待裁决请求，提交时自然找不到 flag——不是权限或参数问题。
  - **修法（三层）**：
    ① 群邀请**入队前**查一次机器人是否已在群里（仅 `sub_type=invite`；`add` 是别人
       申请进群，不适用）。已在群就只发一句「已自动同意，无需裁决」，不再发请求卡片；
    ② 监听 `group_increase`，机器人自己进群时按群作废队列里的邀请并告知管理员，
       兜住「邀请事件先到、入群通知后到」的顺序；
    ③ 提交失败时区分「已在群」「请求已失效」「真实错误」，不再一律回“提交失败”。
  - `scripts/test-join-request.mjs` 增至 82 项（新增 `takeWhere` 与三层防线的接线断言）。

- **自动 @ 又选错人：不认群名片 + 短句蹭词压过精确命中**（2026-10-22，group:100002007）：
  - 现场：群友E说「@?！哦鲸鲸  ? ! 给我发张百亿鲸元券」，机器人发的券却 @ 了
    只说过「@…大肥鱼可爱」的群友B。日志
    `[自动@] @100002014 来源=hit:unread-match`。
  - **根因一：别名表缺"群名片"**。账号昵称是 `dsh`，但群里 @ 显示的是群名片
    `?！哦鲸鲸  ? !`；`selfNickname` 只取了账号昵称，于是所有 `@群名片` 都不算
    "在叫它"。群友E那条真正的请求被忽略，程序退到模糊字面匹配。
  - **根因二：短句的反向覆盖率被放大**。群友B那句话只有 6 个 2-gram，
    与券文案共享「大肥/肥鱼」2 个 → `2/6×0.6=0.20`；群友E的 4 个精确 gram
    （百亿/亿鲸/鲸元/元券）因为同窗口还说了 3 句闲话被拼成 24 个 gram →
    `4/24=0.1667`。**说得越多越吃亏，短句蹭个名字反而赢**。
  - **修法**：
    ① 入站时直接读 OneBot 的 `at` 段，把 `atSelf` 记到消息上（最可靠，不依赖别名）；
    ② 按群缓存机器人群名片（`ensureSelfCardV2`，10 分钟 TTL），自动@ 与
       `findCallersV2` 共用 `botAliasNamesV2`；
    ③ 内容匹配改为**逐条取最大重合度**，不再把同一人的多句话拼成一段；
    ④ 反向覆盖率只对 ≥8 个 gram 的文本启用；
    ⑤ 匹配前剔除机器人自己的名字（角色名/昵称/群名片），
       `@关键词` 形式的关键词也剔除；
    ⑥ `[自动@]` 日志补上重合度、命中原文与候选前三名。
  - `scripts/test-auto-at.mjs` 增至 131 项，新增第 14 节用本次真实 30 条未读回放；
    即使别名表仍缺群名片、消息也没有 `atSelf`，也不会再选中群友B。

- **管理员删不掉表情包**（2026-10-22 用户反馈「删不掉表情包」）：
  - 截图里管理员 @ 机器人「把这个表情包删了」，它先回「隔壁的鱼不归鱼管」，
    再回「删不掉，这边回的是没权限」。
  - **实测日志**：`[sticker] 拒绝删除表情：请求者不是管理员（group:100002005）`。
  - **根因是时序竞态**：`isOwnerTurn` 只看 `lastRequesterId`（**最后一条**入站消息的
    发送者）。实测时间线：
    ```
    13:55:48  管理员(100002000) 说「把这个表情包删了」
    13:56:06  群友群友D 发了个拍一拍 → lastRequesterId 被覆盖成群友
    13:56:35  模型这才调用 qq_delete_sticker → 判成"非管理员"，403
    ```
    管理员的请求被后续闲聊冲掉了——**群越热闹越容易出这问题**。
    模型从"看到消息"到"调用工具"可能隔几十秒（先回一句、再想、再调），
    这期间别人插话非常常见。
  - **修法**：额外记录 `ownerSpokeAt`（管理员最后一次发言时间），
    `isOwnerTurn` = 「最近一条是管理员」**或**「管理员在 N 分钟窗口内说过话」
    （默认 5 分钟，`socialV2.adminCommandWindowMs` 可调）。
  - **顺带修掉一个既有缺陷**：`lastRequesterId` / `lastRequesterRole`
    **只存不读**（saveSocialV2State 有、加载时没恢复）——所以每次重启后
    管理员的所有写操作都必然被判失败。已补上读取。
  - **preset 补指引**：原来没有任何"删表情"的说明，模型容易用俏皮话打岔。
    新增 25b：明确工具名、先确认删哪张、仅管理员可用（403 时如实说且不重试）、
    只删点名的那张、删完简短应一声。
  - **验证方式（重要）**：不拿真实表情试删——传一个绝不存在的 id
    （`DEADBEEF...`），权限通过时会报「找不到表情」，权限拒绝则 403。
    实测修复前 403、修复后 500「找不到表情」，**没有误删任何收藏**。
  - `scripts/test-owner-identity.mjs` 28 项（含"管理员说完被覆盖仍通过"这条核心场景）。

- **表情包几乎不用 → 桥接掷骰 + 按语气选候选**（2026-10-22 用户反馈
  「现在依旧极少调用表情包，给出一个解决方案，能够有更多机会并且根据回答语气
  选择合适表情包」）：
  - **实测证据**：`state/tool-calls.jsonl` 里 1999 次工具调用，`qq_send_sticker`
    只出现 **1 次**。根因不是没提示，而是三条叠加：
    ① 提示是**软建议**（"大约每 3~5 轮来一张就够"）——可以不选；
    ② 发表情要**额外一次工具调用**、还不能和文字同气泡，收益"可有可无"；
    ③ 没有外部触发，全靠模型自觉。
  - **解法：桥接掷骰定"发不发"，模型只挑"发哪张"**（与自动 @ 同一思路）。
    命中时把软策略换成**明确要求**："必须发一张"，并直接给出 2~3 个候选的具体
    `md5`（省掉一次 `qq_list_stickers`）。同时允许"真的不贴就跳过"，
    避免在严肃话题硬塞。
  - **按语气选候选**：把表情备注归到 10 个语气类（无语/搞笑/害羞/生气/难过/
    撒娇/赞同/疑惑/打招呼/得意），再用**对方最后说的那句话**判断语气
    （提示词生成时模型还没写回复，所以只能看已知上下文）。
    实测「行吧，随你」→ 无语脸、「哈哈哈哈」→ 搞笑图。
  - **候选要轮换**：原来的排序让 `useCount` 最高的永远排第 1，而模型总选
    "第 1 个"——实测连续三次都发同一张 `9FE3D97B`。加 0~400 的随机扰动
    （小于"语气匹配"的 1000，不破坏准确性），同一语气下 20 次出现 7 种不同首选。
  - **两笔账分开记**：`stickerNudgeTimes` = "要求过几次"（掷中即记），
    `lastStickerAt` / `recentStickers` = "真发过"。掷中但模型跳过时不该占用
    真发出的间隔。两者都进了 `saveSocialV2State` 的**白名单**（存与读都补了）。
  - 控制台「07 二代仿真模式」表情参数区新增：开关、每轮命中概率、最小间隔、
    每小时上限、候选数量（均可改，立即生效）。
  - 实测（临时调 100% 验证）：日志出现 `[表情] group:... 本轮要求发一张（语气=通用，
    候选 3 个）` → 随后 `[sticker] 工具发送表情 ...9FE3D97B...`，
    多个群都真的发了表情。
  - `scripts/test-sticker-nudge.mjs` 57 项。

- **TTS 参数改成可编辑 + 修改按钮**（2026-10-22 用户要求「触发概率、每小时上限、
  模型设置、字数等设成可变参数并提供修改按钮」）：
  - 控制台「18 语音合成」新增**修改参数**折叠区，分两组，因为**生效时机不同**：
    - **触发策略**（保存即生效）：触发概率、每小时上限、最长字数；
    - **模型设置**（保存后需重启）：引擎目录、GPT/SoVITS 权重、设备、线程、音色名。
    界面上直接标出「需重启」，并提供**保存并重启桥接**按钮（带确认框）。
  - **后端逐项 clamp，不信任前端**：概率接受 0~1 小数**也兼容 0~100 百分数**
    （>1 自动折算）；上限 0~60；字数 10~300；`enabled` 只认布尔。
    模型路径只做字符串化、**不校验存在性**——外接盘没插时不该拒绝保存其它参数。
  - **修掉一个 0 被当"没配"的 bug**：原来读参数写的是
    `Number(cfg?.x) || 默认值`，而 `maxPerHour: 0` 是**有意义的设置**
    （"不自动发，只在被要求时发"）——实测把它设成 0，状态接口却显示 3，
    看着像保存失败。现在统一走 `ttsNum(raw, dflt, min, max)`，7 处全部替换。
  - **回填不覆盖用户输入**：表单每 60 秒随状态轮询回填，但只填**用户没改过**的框
    （`dataset.edited`）；保存成功后清掉该标记，让后续轮询能正常同步。
    凭据卡片踩过同一个坑（"点一次保存只保存了最早改的那一个"）。
  - 实测：在浏览器里展开表单→回填正确（5% / 3 条 / 140 字 / 路径 / cuda）→
    改成 7% / 6 条 / 120 字→点保存→落盘 `{p:0.07,h:6,c:120}` 且表单保持用户输入。
  - `test-tts.mjs` 扩到 116 项。

- **控制台编号错乱 + 卡片留白，整体重排**（2026-10-22 用户反馈）：
  - **编号**：之前为少改代码，把语音合成/磁盘缓存塞成 `17b`/`17c`，
    加上原有的 `02b`，目录里出现三处字母后缀，且 `sec-19/20/21` 的 id
    与实际编号已经错位。现在**全部改成连续编号 01~23**，只保留 `02b`
    （它是 02 的"查看消息"子视图，语义上确实从属）。
    id 一并规整为 `sec-NN`，并核对了 23 张卡的「id / data-sec / sec-no」三者一致。
  - **留白**：实测（CDP 量每行卡片宽度之和 vs 网格宽）发现两处真空：
    - `17b`/`17c` 各占一行、宽 896px，右侧空 **456px**；
    - `16` Token 卡与 `17` 并排时，把 `17` 挤出单独一行。
    重排后：**16 与 17 各占整行**（表格与柱状图需要宽度），
    **18 与 19 各占一半并排**，全页每一行都填满。
  - **03 的"半屏空白"** 不是排版 bug，是空态只有一行字被同行卡片拉高。
    改成统一空态（图标 + 结论 + 说明它什么时候会有内容），并垂直居中——
    空白变成"有意留白"。用 `:has(> .empty-state)` 只在空态时切 flex，
    避免影响 02 会话列表的 block 流。
  - **06 的表单控件被推到最右**：整行宽（1352px）+ `label{flex:1}` 把输入框
    顶到右边缘，中间空出一千多像素。给表单区加 `max-width: 720px` 靠左聚拢。
  - **成对卡片高度** `--row-h: 520px` 由固定改成 `min-height:200px / max-height:520px`
    + 内容自适应：内容少的自然矮（同行仍由网格 stretch 对齐），
    内容多的到顶后内部滚动，不再硬撑。
  - 补测试：`test-console-layout` 增加"23 张卡的 id/sec-no 必须一致"，
    `test-tts` / `test-cache-manager` 的编号断言同步。

- **试听按钮点了没有能听的音频**（2026-10-22 用户反馈）：
  - **三个独立故障叠在一起**，症状都极像"功能没做完"，但根因完全不同：

    1. **缺 NLTK 数据** → 接口直接 500：
       `Resource 'cmudict' not found`。`g2p_en` 要它做英文音素转换，
       缺了要到**合成时**才炸。已加进 `setup-tts.mjs` 的检查与安装；
       注意代理环境下 NLTK 会以 SSRF 防护为由拒绝下载，必须
       `NLTK_ALLOW_PROXIED_URLOPEN=1` 放行。

    2. **中文被 GBK 解码** → 接口 200、但音频只有 0.5~1 秒的噪声：
       Windows 下 Python 子进程的管道 stdio 按系统 ANSI 代码页（cp936）解码，
       Node 写的 UTF-8 中文被打碎（实测「你好呀，我是达妮娅。今天也要开心哦。」
       18 字 → `len=28`、码点全是 `fffd`）。
       试过 `sys.stdin.reconfigure('utf-8')`、`PYTHONIOENCODING=utf-8`、
       `sys.stdin.buffer.readline()` —— **在管道下都不可靠**。
       最终改成**请求走文件**：Node 写 UTF-8 的 `.req-*.json`，stdin 只传绝对路径
       （纯 ASCII）。同一份 JSON 走文件读取实测 `len=18`、合成 3.46 秒、ASR 回识别
       「你好呀，我是丹妮娅，今天也要开心哦」。
       > 排查记录：`sys.stdin.reconfigure` 会让 `sys.stdin.buffer` 重新包装回 GBK，
       > 连 `.buffer` 都不安全。判断文本是否损坏要看**码点**（`ord(c)`），
       > 不要看 `repr` —— 日志本身的编码也会干扰判断。

    3. **CSP 拦掉 blob:** → 按钮点完"已合成"但播放器空白：
       `<audio src=blob:>` 走 media-src、页面内 `fetch(blob:)` 走 connect-src，
       而之前只给 `img-src` 放行过 blob:。已补 `media-src`/`connect-src`，
       `script-src` 仍限 `self`。这是**第二次**被 CSP 静默拦截（第一次是报表图预览）。

  - 实测验证：浏览器里真点「试听一句」，拿到 236KB / 3.7 秒音频，WAV 头解析正确；
    ASR 回识别内容与原文一致。
  - `test-tts.mjs` 扩到 96 项，含"请求走文件而非管道""不对 stdin 调 reconfigure"
    "CSP 放行 media-src/connect-src"等断言。

- **C 盘缓存清理 + 控制台卡片**（2026-10-22 用户要求「注意清理 C 盘缓存，并且控制台中
  给出对应功能卡片」）：
  - **占用大头在 C 盘**，而且会悄悄涨。本项目在 `E:`，但运行时产物落在用户目录：
    - `%LOCALAPPDATA%\Temp\ghshot-*` / `conshot-*`：每次截图起一个 headless Chrome，
      退出后**目录不一定被清掉**（进程被强杀/异常退出时残留）。实测积了 **45 个、648MB**。
    - `%TEMP%\G2PW*.zip`：部署语音引擎时下的压缩包，解压后无用（两份共 959MB）。
    - `~/.cache/huggingface`：底模下载缓存，底模落到项目目录后可删（607MB）。
  - 本次实际清理：**C 盘可用从 79G → 99G**。其中手删的部分是上面三类 + 项目自身缓存。
  - **控制台新增 17c「磁盘缓存」卡片**：逐项显示占用与文件数，分成
    「可清」与「保留」两类，点按钮清理并回报**实际释放量**。
  - **安全边界（本模块最重要的设计）**：
    - 只有 `kind: 'safe'` 会被删；`keep`（语音模型 2.9GB、图库、B 站观看记忆）
      **即使 API 里显式点名也不会动**——测试专门断言了这条。
    - 释放量按删除后重新核算，删失败的（被占用）不计入，**不虚报**。
    - 支持 `dryRun`：只算不删，先看清能省多少。
    - 只碰白名单目录，不做通配扫描。
  - `scripts/test-cache-manager.mjs` 38 项（含"显式点名 keep 项也不会被删"的实证）。

- **磁盘缓存清单重写：补齐漏项**（2026-10-22 用户反馈「还有没列出的可删除项」）：
  - 原清单只有 7 项，漏掉了 X 媒体缓存、X 发图临时中转、表情解析缓存、反向搜图缓存、
    功能菜单旧备份、媒体处理临时文件（`qq-ds-* / qq-up-* / qq-pub-* / qqgif-* / bili-* / biliasr-*`）、
    测试运行目录、调试截图等一整批。
  - 现在按 5 组展示：**聊天与媒体缓存 / 渲染与报表缓存 / 临时文件（C 盘）/ 开发与测试残留 / 保留**。
    实测从 7 项 237MB → **15 项 247MB**（多出约 10MB 之前完全看不见的可清项）。
  - 保留项也补全：语音模型、图库、黑话库、B 站记忆、情节记忆、**DSH 会话历史**、收藏原图，
    合计约 4.1GB——只展示占用，永不参与清理。
  - 清理确认框改为**按当前盘点清单动态生成**（原先写死文案，必然与后端清单漂移，
    这正是"还有没列出的项"的成因之一）。
  - `test-cache-manager.mjs` 更新到 57 项（新增项、分组一致性、动态确认框断言）。

- **语音合成：达妮娅音色，有概率发语音消息**（2026-10-21 用户要求「克隆一份 sovits
  用这个达妮娅音源让它有概率发出语音消息」→ 2026-10-22「这个能够做成可插拔的功能吗」）：
  - **可插拔**（与超分插件同一套约定）：`socialV2.tts.enabled` 不为 `true` 时
    **完全不加载**——不探测模型、不起进程、不占显存，桥接只发文字。
    探测失败（目录错/权重缺/底模缺）只记一行日志，桥接其余功能毫发无损。
    运行期合成失败**自动回退成文字**，绝不吞消息。
  - **不碰外部项目**：GPT-SoVITS 是独立仓库（默认 `~/GPT-SoVITS`），
    配置通过环境变量传入，不修改它的 `tts_infer.yaml`——用户更新它时不会冲突。
  - **音色来源**：ModelScope `villia/dania` 的成品权重（GPT `dania-e15.ckpt`
    155MB + SoVITS `dania_e16_s2192.pth` 173MB，v2ProPlus 版本），**无需训练**。
    参考音频与台词必须成对（写错会让语调对不上）。
  - **常驻进程**：实测模型加载 24.8 秒（含预热），但之后 **4 字 1.5 秒、42 字 2.9 秒**。
    每次重开进程等于每条都白付 25 秒，所以起常驻 Python 服务，`READY` 握手确认加载完成。
  - **概率由桥接掷骰**（默认 5%，每小时最多 3 条），模型不参与决策——
    与自动 @ 同一思路，避免"想起来就连发、想不起来一直不发"。
    只对**单条**文本回复生效；多段、含链接/代码、超过 140 字的不发。
  - 语音按文本指纹缓存（同句不重复合成），缓存在 `state/tts-cache/`。
  - 控制台新增 **17b 语音合成**卡片：状态（未启用/不可用+原因/可用）、音色、
    引擎目录、设备与加载耗时、触发概率、试听按钮（`/api/socialV2/tts-say` 返回 wav）。
    编号用 17b 而非顺延 18~21：TTS 与"刷视频"同属"机器人怎么表达自己"。
  - 实测：发送接口收到 11 字回复 → 1.79 秒合成 3.78 秒音频 → 群里实际收到语音。
  - `scripts/test-tts.mjs` 57 项（含真机合成、缓存命中、超长/空文本拒绝）。

- **B 站「视觉 + 听觉」**（2026-10-21 用户要求「设计新的可以让模型同时接收视觉和听觉
  信息的方案」）：
  - **先探测，再设计**。实测结论决定了方案形态：
    - 网关内容类型白名单**只接受 `text` 与 `image_url`**：`input_audio` / `audio` /
      `file` / `image` 一律 `code 11101 unsupported content type`；
    - `video_url` 能过网关解析，但模型侧明确拒绝（`deepseek-v4.1-flash` 答
      「无法查看该视频」；`gemini-3.5-flash` 返回空壳；`gpt-5.6-sol`/`gpt-5.5`/`glm-5.1`
      报参数错误；`glm-5v-turbo`/`glm-5.3` 说「不具备处理视频的能力」）；
    - DSH 的 `promptContentPartSchema` 只有 `text` / `image`。
    → **"听觉"必须以文字进入模型**，这不是退而求其次：转写后模型确实拿到了"说了什么"。
  - **方案：字幕优先，本地 ASR 兜底**。B 站 AI 字幕（`/x/player/v2`）覆盖多数热门视频且
    瞬时零成本，但有三个缺口：没登录就完全没有（`subtitles` 恒为空且 `code` 仍是 0，
    极易误判成"这条没字幕"）、冷门/纯音乐/外语常没字幕、字幕会省略语气词。
    ASR 直接听原始音轨，三类都能补。两者**互斥**（有字幕就不转写），
    避免同一段话给模型两遍。
  - **复用本机现成模型**（用户指定）：`E:\Program Files\FasterWhisperGUI\models\faster-whisper-large-v3`
    （3.1GB）。不重复下载。实测质量：large-v3 中文一字不差
    （「今天天气不错，我们一起去公园散步吧。记得带上那把红色的雨伞。」），
    而 `base` 后半句错成「戴上纳法红色的鱼闪」。
  - **常驻进程**：实测 large-v3 加载 ~8.5 秒，而识别 12 秒音频 ~10.7 秒、
    22 秒 ~12.3 秒、30 秒真实 B 站视频 ~14.4 秒——**耗时以固定开销为主**，
    每次重开进程等于白付 8 秒。所以 `scripts/asr-server.py` 常驻，
    通过 stdin/stdout 逐行传路径/JSON；服务端在 stderr 打 `READY {...}`，
    Node 侧据此判断"真的加载完了"，而不是猜时间。
  - **音频走 dash 独立音轨**（`fnval=16`），取**最低码率**（~64kbps）：
    转写只需听清说什么，高码率只会下载更慢、不会更准。
    实测某热门视频 30 秒音频不到 1MB。
  - ASR 失败不打断观看：提示词会写明「这一段没能获取声音内容：<原因>，
    请只根据画面判断，不要臆测台词」。
  - 控制台「17 B 站自己刷」新增**声音内容**区块：字幕可用性（取决于登录态）、
    ASR 状态/模型/线程/加载耗时、失败原因与重试倒计时，以及一句话结论。
    底部如实写明"模型只收文字和图片，听见的方式是把音轨转成文字"。
  - 实测端到端（禁用字幕强制走 ASR）：18.2 秒完成「抽帧 + 转写」，
    转写出真实视频台词「既然是折叠屏幕问题 逃不过折这个问题…
    零次折叠的iPhone 2 和500次折叠的iPhone 2 它们两者之间的折痕会有差别吗」。
  - `scripts/test-bili-av.mjs` 51 项，含真实转写（`The quick brown fox jumps over
    the lazy dog.` 8.7 秒听出）。

- **Token 用量「按日审阅」**（2026-10-21 用户要求「token用量卡片增加按日审阅的下拉菜单
  （默认总计），按模型改成选择的日期按模型调用的token数」）：
  - 卡片新增下拉，默认「总计（全时段）」；选中某天后「按模型」只显示**那一天的**模型调用量，
    并给出当天的输入/输出/缓存读/调用合计。选项覆盖**全部已统计的天**（API 给 30 天），
    而不是表格里的最近 14 天——审阅的价值就是能回看更早的日期。
  - **必须在解析层新增 `dayModels`**（日×模型联合分布）。原有两个维度都是**边际汇总**，
    推不出联合分布：某模型跨 3 天共 10M 时，无法知道每天各多少。
    所以看到每条 usage 时同时按 `(天, 模型)` 分桶。
  - **旧缓存兼容是个静默坑**：`state/token-usage.json` 里老缓存没有 `dayModels`，
    若只按 mtime/size 复用，升级后第一次统计会拿到 `undefined`，
    页面显示"这一天没有任何调用"——文件没变、数字却是 0，最难查的一类 bug。
    现在要求缓存里 `dayModels !== undefined` 才算命中，否则重解该文件。
  - API：`GET /api/socialV2/token-usage?date=YYYY-MM-DD|all`。服务端过滤而不是全量下发，
    避免 30 天 × N 模型的数据把响应撑大，也保证前后端口径只有一处计算。
    非法日期返回 400；无数据日期返回全 0（前端显示"这一天没有任何模型调用记录"）。
  - 选择在 60 秒自动刷新之间保留；选中的天若已不存在（跨天/清理）自动退回总计。
  - 顺手修掉一处**错口径文案**：全时段提示原写「14 天合起来」，但那个合计其实是
    全部天（实测 全时段 42,139 次 vs 最近 14 天 23,754 次，差了近一倍）。
  - 实测：10-20 选出两个模型，输入 133.78M + 42.22M = 176.00M（= 当天输入），
    调用 1494 + 2198 = 3692（= 当天调用），与按日表完全吻合。
  - `scripts/test-token-day-review.mjs` 31 项，含三重交叉校验
    （每天各模型之和 = 当天；dayModels 总量 = days 总量；每模型全局 = 其各天之和）。

- **控制台 02/03 卡片中间空一列**（2026-10-21 用户反馈「中间有空白，对整个页面排版
  重新校对并修改」）：
  - **直接原因**：02b「会话消息回看」夹在 02 和 03 之间。它默认收起，高度已经归零，
    但**仍然占着一个 440px 的网格轨道**——02 在 x=24、02b 在 x=480(h=0)、03 在 x=936，
    中间那 440px 就是用户看到的空白。改成收起时 `display:none`（彻底退出布局）。
    **不能用 `grid-column: 1/-1` 代替**：那样它独占一行，02/03 是能相邻了，
    但会留下一条 0 高度 + 16px gap 的空行，还把 03 挤到下一行（实测更糟）。
  - **更深的原因**：网格是 `auto-fit minmax(340px,1fr)`，在常见窗口宽度下恰好 3 列。
    而 02/03/04/05 是四张同高（520px）的卡，**3 除不尽 4**——无论怎么排，
    总有一张落单、右侧空出两列。所以改成 **6 列基础网格**：普通卡跨 2 列
    （= 原 3 列效果），需要成对的卡（`.card-half`）跨 3 列，得到 2×2。
    6 同时能被 2 和 3 整除，2 列组和 3 列组都能排满。
  - **踩到特异度陷阱**：加 `.grid > .card { span 2 }` 后，`.span-all`（0,1,0）
    被它（0,2,0）压过，06/07/08 三张整行卡退化成 440px 窄卡挤在同一行，
    07 高 4601px 把另外两张一起撑到 7616px 的空白。整行规则必须写成
    `.grid > .card.span-all`（0,3,0）。
  - **一代/二代仿真模式（06/07）等超大卡保持整行单列**——用户明确要求，未改动。
  - 末尾 20「桥接控制」原本孤零零占一行（右侧空 896px），改与 21 并排（2 列 + 4 列）。
  - 窄屏（≤900px）统一退化成一列一个。
  - 实测：02/03 与 04/05 各占 668px 成 2×2；06(1091px)/07(4601px)/08(842px)
    各自整行；10/11/12 与 13/14/15 仍三列；16/17、18/19 宽+窄；20/21 并排。
    800px 窄屏下逐张单列，无错位。
  - 02b 展开验证：收起时 `display:none` / 0×0，展开后 1352px 满行、内容与标题正常
    （`display` 切换后补了一次强制 reflow，否则会丢掉 0fr→1fr 过渡）。

- **控制台「重启桥接」没效果**（2026-10-21 用户反馈）：
  - **根因**：`/api/restart` 只做 `releaseLock()` + `process.exit(0)`，
    把"重新启动"完全交给**外部守护窗口**（`start.bat` 的死循环）。
    而那个守护窗口只存在于"手动双击 start.bat"这一种情形；用 nohup / 计划任务
    / 别的方式拉起时，`exit(0)` 就是**彻底停服**——按钮看着"点了没反应"，
    实际是"点了就关了"。
  - 实测日志：19:52:12 打出「控制台：重启桥接」后退出，19:53:06 才出现新进程，
    中间空了 **54 秒**；而前端只轮询 **30 秒**就显示"桥接尚未恢复"。两个问题叠加。
  - **修法**：桥接**自己** spawn 一个 `detached` 子进程（`stdio` 重定向到
    `bridge.log`、`unref()`），父进程确认 spawn 成功后才退出；失败则 `exit 1`
    并如实记日志（不假装成功）。
  - **两个必须处理的竞态**：① 父进程 spawn 后到 exit 之间仍持锁，子进程直接抢
    会 `exit(2)`——所以带 `QQB_RESTARTED_BY` 的子进程先等锁文件消失（上限 5 秒）；
    ② **锁释放 ≠ 端口释放**，`:3100` 的监听可能晚几十毫秒才关，子进程此时 bind
    会 `EADDRINUSE → exit(2)`（服务彻底停），所以抢到锁后再探一次端口并等它放开
    （上限 5 秒）。
  - 前端两个按钮（凭据卡 / 桥接控制卡）轮询从 30 秒放宽到 60 秒，显示秒数进度，
    失败时明确指向 `state/bridge.log`；恢复后控制卡会自动刷新页面。
  - 实测：连续两次重启，各 **1 秒**恢复，PID 逐次更替，锁文件始终一致，
    日志无 `EADDRINUSE`，`/api/socialV2/config` 与 `tool-flags` 均 200。
  - `scripts/test-console-restart.mjs` 30 项（含"不许退回 exit-only"的反向断言）。

- **Token 用量报表图**（2026-10-21 用户要求「让 bot 能够看到 token 消耗日志，能够以图片
  形式响应群友要求 token 消耗量相关问题」）：
  - **群友问「用了多少 token」时，机器人直接发一张排版好的统计图**（1080 宽，
    与功能菜单同一套视觉语言）：今日输入/输出、近 7 天合计、累计、每日柱状图、
    按模型占比。走 `qq_token_report` → 桥接渲染 → OneBot 发图，与功能菜单、
    GitHub 截图同一条路（模型没有"发送任意图片"的能力，只能由桥接发）。
  - **返回里带与图同源的文字摘要**。这一步是关键：只给图的话，群友追问「那昨天呢」
    「哪个模型用得多」时模型会凭印象编——而编出来的数和刚发出去的图对不上。
    摘要和图上数字由同一个 report 对象生成，**同源**。
  - **口径写进图里**：输入 token 是**每次请求累加**（同一段上下文每轮都重发），
    所以它远大于"实际新读进去的字数"；缓存读单独统计。图上不出现任何金额——
    没有单价数据，不该瞎算。
  - **缓存命中率的分母含 cacheRead**（`cacheRead / (input + cacheRead)`）。
    只拿 input 当分母会算出 >100% 的荒谬值（实测 cacheRead 是 input 的 10 倍量级）。
  - **空心日补 0**：近 7 天按日历补齐，没说话的那天画灰色底线，
    否则 10-15 和 10-21 会被画成相邻两根，看起来像连续使用。
  - **模型名保留渠道**：`global:deepseek-v4.1-flash` 与 `cn:deepseek-v4.1-flash`
    显示成 `deepseek-v4.1-flash（global）` / `（cn）`，**不合并**——同名模型走两个池，
    是两个不同的计费/限流来源，合并会误导。
  - 数据默认取 6 小时内的统计（与原有定时任务同源）；群友明显在问"今天到现在"时
    模型可传 `fresh=true` 先增量重算（约 7 秒）。图上有「更新于 X 前」，
    过期会显示黄标，摘要里也标 `stale`。
  - 按 HTML 内容指纹缓存：数据没变就命中缓存（零渲染开销），变了自动换图；
    同时刻并发只渲染一次；旧图按数量/天数清理（每天都会产生新指纹文件）。
  - 控制台「16 Token 用量」新增「生成报表图」按钮 + 内联预览（右键可另存）。
  - **踩到 CSP 的坑**：预览用 `fetch → Blob → createObjectURL`，而控制台的
    `default-src 'self'` **不包含 `blob:` 协议**，图片被静默拦掉——
    `img` 在、`complete` 为 true、`naturalWidth` 却是 0，页面上只剩 alt 文字，
    控制台也不报错，极难查。已单独放行 `img-src 'self' data: blob:`，
    `script-src` 仍限制为 `self`。
  - **顺手修掉一个空壳开关**：控制台「功能菜单」开关的 flag 一直是
    `sendFeatureMenu`，而代码里（MCP 注册处与桥接端点）检查的是 `getFeatureMenu`——
    那个开关**拨了没反应**。`test-feature-menu.mjs` 里锁的还是那个错名字，
    等于测试在保护 bug，一并改正并加了反向断言。
  - `scripts/test-token-report.mjs` 73 项。

- **pixiv 凭据配置**（2026-10-21 用户要求「先把凭据配置接口做出来」）：
  - **先纠正一个前提**：当时 pixiv 全站 503 是**官方维护**，页面原文写着
    "pixiv is currently under maintenance ... October 22, 2026 (JST) ... update patch
    for a vulnerability"，与风控、与有没有 Cookie **完全无关**——任何凭据都无效。
    凭据真正有用的只有三种情况：匿名被限流、部分接口对未登录返回空壳、将来的个性化内容。
  - **默认匿名**：不新建 `state/pixiv-auth.json` 时，请求头里连 `cookie` 键都不出现，
    行为与改造前完全一致。没有额外的开关项——文件存在就带凭据，不存在就是匿名，
    否则用户填完凭据却「什么也没发生」，排查成本比它挡掉的风险高得多。
  - **凭据作用域**：Cookie 只加在 pixiv 适配器内部的 `apiFetch` 上，
    **不能**加在 `fetchFromSources` 那个所有源共用的 `jsonFetch` 工厂上——
    那样会把 pixiv 的登录态发给 safebooru / yande.re。图床探测（`i.pximg.net`）
    也不带：那里只需 `Referer`，跨域发会话 cookie 毫无意义。
  - **两种写法都收**：`{ PHPSESSID, device_token }` 分开填，或 `{ cookie: "PHPSESSID=...; ..." }`
    整串粘。整串若不像 Cookie 头（比如误粘了网址）直接拒绝，不会把网址当 cookie 发出去。
  - **503 的措辞分两种**：有凭据时说「维护或请求过密」，匿名时说「维护，或被限流，
    可配凭据后重试」，并标 `retryable`——不再让人误以为是标签写错、白改查询词。
  - 控制台「凭据与连接配置」新增 `pixiv PHPSESSID` 与 `pixiv device_token`，
    **保存后立即生效**（存完就地重读，不必重启）；文档里写明维护期无效与账号风控风险。
  - 顺手修了三个 pixiv 网络测试：上游维护期（整站 503）**跳过**而不是判红，
    否则维护一次就把整套回归打成红的，真正的回归会被淹没；代理不通/超时仍判失败。
  - `scripts/test-pixiv-auth.mjs` 51 项。

- **图片查询「经常查不到」**（2026-10-21 用户反馈）：
  - **根因**：`SCORE_FLOOR.safebooru = 5` 是**固定阈值**，依据是「该站热门图能到 800+」，
    但那个依据只对**角色图**成立。实测通用标签的分数天然低得多：
    `beach scenery` 中位 1 / max 7、`1girl landscape` 中位 2、`cat` 中位 3、
    `wuthering_waves` 中位 9。于是「beach/scenery」10 条**全部**被「分数 < 5」挡掉，
    日志只剩「拉取到 10 条但全被过滤」，看起来就是「这站查不到图」。
  - **改法**：阈值改为**按本批结果自己的分数分布**取（中位数的一半，向下取整），
    再与固定阈值取**更宽松**者——只放宽，不收紧，不会因为某批图分数低就把
    原本严格的高分源也放水。同时保留极低绝对底限（默认 1）挡掉真正 0 分的冷门图。
  - 实测（同一批查询，改前 → 改后）：`beach` 0→16 条、`scenery` 0→16、
    `1girl landscape` 0→18、`cat` 13 条不变、`wuthering_waves` 36 条不变、
    `rover_(wuthering_waves)` 2→12。

- **B 站推荐优先给活跃群**（2026-10-21 用户要求）：
  - **旧逻辑正好相反**：选落脚群用的是「`lastActionAt` 最久没动静」= 优先冷群，
    而推荐复用了同一个 key，于是推荐总发到没人说话的群（实测 9 个群有 2 个 24h 零发言）。
  - 活跃度 = 近 24h **群友**发言数（排除机器人自己）；不能用 `lastActionAt`
    也不能用 `recentMessages.length`（那是 100 条滚动窗口上限）。
  - 硬门槛 ≥1 条；候选内按活跃度**加权随机**（不是取最活跃，否则一个群天天被推）。
    实测：99 条 → 19.3%、69 条 → 13.4%、3 条 → 0.6%、0 条 → **0%**。
  - 落脚群与推荐目标分开选：刷视频可用冷群承载，推荐只用活跃群。
    没有活跃群时不推荐并说明原因。
  - 控制台「17 B 站自己刷视频」显示各群活跃度与可推荐状态。
  - `scripts/test-bili-share-activity.mjs` 26 项。

- **控制台所有可展开元素加动画**（2026-10-21 用户要求）：
  统一了四类元素的展开/收起动效，参数集中在 `--anim-dur`（0.26s）与 `--anim-ease`：
  - **`<details>`（黑话系统参数）**：原生不支持高度过渡，内容包一层 `.details-anim`
    （`grid-template-rows: 0fr ↔ 1fr` + `opacity`）。
  - **可收起卡片（06 一代仿真）**：原来 `display:none` 硬切，改成 grid 行高过渡。
  - **弹窗（黑话确认框）**：`display:none/flex` 无法过渡，改用
    `visibility + opacity + transform`；关闭时 `visibility` 延迟到动画结束才隐藏
    （`transition: ... visibility 0s linear var(--anim-dur)`），打开时立即可见。
  - **临时卡片（会话消息回看）**：原来用 `style.display` 切换，改成 `.card-hidden` 类 +
    内层 `.expandable-inner` 的 grid 过渡。
  - 统一覆盖 `prefers-reduced-motion`（系统开了"减少动态效果"就全部关掉）。
  - **踩到两个坑**：① 不能把 `display:grid` 加在 `.card` 上——会把 h2/row 变成 grid item，
    间距对齐全变样；必须包一层内层。② 网格里的卡片默认 `align-self: stretch`，
    会被同行其它卡撑到 520px，收起时**不塌陷**；要加 `align-self: start`。
  - 实测：`details` 展开 80ms 高度 226 → 稳定 279（有过渡）；06 卡片 1091 → 253 → 65；
    会话消息卡 0 → 114 → 136；弹窗 opacity 60ms 时 0.61、稳定 1，关闭后 `visibility:hidden`。
  - `scripts/test-console-animations.mjs` 50 项。

- **05 人格卡片：新建表单不再溢出**（2026-10-21 用户反馈「点新建人格时元素会溢出」）：
  - **根因**：那张卡是**固定高度**（`.card-h`，`--row-h: 520px`），而新建表单比
    「当前角色 + 人格卡预览」更高；原先用 `<details>` 直接展开，内容顶出卡片边界、
    盖到下一张卡（06）上。
  - **改法**：改成「两段互斥」——平时显示角色列表 + 预览，点「＋ 新建人格」把这段
    **收起**（高度→0）再展开表单，底部固定一个「＋ 新建人格 / ← 返回角色列表」切换按钮。
  - **动画**用 `grid-template-rows: 0fr ↔ 1fr`（`0.28s` 缓动）：它能对"内容自然高度"
    做过渡，不用事先量像素，内容变了也不会截断；再配 `opacity` 淡入。
    收起段同时加 `inert`，避免 Tab 键聚焦到看不见的输入框里。
  - **兜底**：卡片加 `overflow: hidden`，任何情况下都不外溢。
  - 创建成功后自动收回列表（新角色已出现在标签里），并记住上次停留的段落（localStorage）。
  - 实测：列表态 / 新建态 / 动画中途（切换后 120ms）三种时刻，底边都在卡片内 **-19px**，
    不溢出；点击创建 → 提示「✅ 已创建」→ 自动回列表，全流程正常。

- **控制台排版与卡片编号重排**（2026-10-21 用户要求）：
  - **编号乱序是历史遗留**：12 号附近原本是 `12a / 12b / 12c / 12d / 12e / 12g`，
    而文档顺序是 `12e → 12a → 12g → 12c → 12d → 12b`——既乱序又跳号（缺 12f）。
    现在统一为**连续 01~21**（`02b` 是 02 的子卡，保留字母后缀），并按时序重排：
    `12 安全拦截 → 13 访问令牌 → 14 加好友/入群 → 15 取图额度 → 16 Token 用量 →
    17 B 站 → 18 凭据与连接 → 19 测试发送 → 20 桥接控制 → 21 后台引导`。
  - **加顶部目录**：21 张卡平铺太长，顶部生成 22 个跳转胶囊（含 06 折叠卡），
    点击平滑滚动 + 目标卡闪一下（`toc-flash` 动画）。锚点兼容两种形式：
    新卡用 `id="sec-XX"`，已有专属 id 的卡（如 `biliCard`）用 `data-sec="XX"`，
    不破坏依赖这些 id 的 JS。
  - **布局类改名**：`cred-span2` → `card-2col`（不再只服务凭据卡），
    Token 卡与凭据卡跨两列，窄屏（<860px）退化成整行。
  - **重排时踩到一个坑**：脚本按段拼接时把「12 安全拦截通知」的 `</section>` 弄丢了，
    导致后面的卡片嵌进它里面。已修，并加断言
    「相邻卡片之间必须有 `</section>`」防止复发。
  - `scripts/test-console-layout.mjs` 26 项（编号连续性、目录完整性、锚点、布局类、结构闭合）。
  - 顺带修了 `test-wake-backfill-priority.mjs` 的过期断言：`poke` 早已进优先级表（35，
    「拍别人」低于普通消息），测试还要求它是 0；同时补了 `pokeSelf`（85，仅次于 @）的断言。

- **修「@ 它 / 戳它有时候不回」的三条链路**（2026-10-21 用户反馈）：
  - 用户的描述很具体：「现在@它或者戳它依旧有时候不回复」。分三条独立成因，都不是单一 bug。
  - **① 拍一拍不分对象**：`handlePokeNotice` 只要 `triggers.poke` 开着就一律
    `scheduleWakeV2(key,'poke')`，提示词又写「可能拍了你，也可能拍了别人」——模型看到"拍的是别人"
    就不回。日志实证：04:36~04:39 连续 5 次「戳了戳 你」，每轮都只输出"这轮先到这儿"。
    改为 `pokeSelf`（优先级 85，仅次于 @）+ `poke`（35，低于普通消息），两条提示词分别写明
    "**必须回应**，回个拍一拍或一句话"与"不是拍你，不必回"。
  - **② `pendingWakeReasons` 不持久化**：@ 到达时会话正忙 → 记进内存队列 → 回合结束补发；
    但回合中途重启/崩溃，队列全丢，那条 @ 永远不回。启动补投只救"未读还没被 mark_read"的。
    已加入 `saveSocialV2State` 白名单（`saveSocialV2State` 是白名单式序列化，新字段必须显式列出）。
  - **③ 收尾提醒只催收尾**：`buildWakeReminderPromptV2` 原本只给角色名 + "请设置下一次唤醒"，
    模型收到就直接潜水，把没回的 @ 带走。现在注入角色卡正文，并在有未读时先说
    「先别急着收尾」，点明"有人 @ 你/问你/拍你就先回应"。
  - 另有一条关键盲区：`findCallersV2` 刻意排除拍一拍（拍不是"叫你"），导致**状态里从来不显示"谁拍了你"**。
    现在【此刻状态】单独列「有人戳了你（某某）——这是冲你来的」，最多 3 条。
  - MCP 工具描述同步：不再说"包括拍你和拍别人"，改为"拍你时一定唤醒并且必须回应；拍别人只作低优先级提醒"。
  - 回归：`scripts/test-at-poke-reply.mjs`（37 项）+ `scripts/test-poke-status-line.mjs`（11 项，
    直接抽取 bridge.js 里那段代码在构造数据上跑）。
  - 注意：改 MCP 描述后**必须重启 DSH**——MCP 子进程属于 DSH，重启桥接不会重新拉起它们
    （本次踩到：桥接 13:46 重启、MCP 仍是 12:14 的旧进程）。

- **另两条「@ 不回」的根因**（同日继续排查，与上面三条独立）：
  - **④ 唤醒频率限流把 @ 和戳你一起饿死**：`唤醒频率超限，跳过` 在日志里出现 40 次，
    其中包含 `pokeSelf`——用户戳它、已排到高优先级、还缩短了等待，最后被这条限流直接丢弃。
    原因是 `anyMessage`/`probability` 这类低价值唤醒和 @ 共用同一个 `maxWakePerHour: 30` 配额，
    群一热闹就把额度吃光。改为：**优先级 ≥75 的唤醒（私聊/@/戳你/提问/名字）永不被限流丢弃**，
    超限时记 `唤醒频率超限但放行`；低优先级照旧受限以兜住成本。
  - **⑤ 状态摘要只截开头，把指令截没了**：群友发「[引用 …]（被引用的这条消息含 1 个图片…
    要看到它请调用 mcp__snowluma__qq_get_message_images，参数 key=…）@大肥鱼 超分一下」，
    桥接正确判成 `atMention`，但【此刻状态】只显示前 30 字 → 模型看到全是"请调用工具"的引用提示，
    **看不到「@大肥鱼 超分一下」**，于是输出「群里正聊游戏，没点我」就收尾了。
    改为：短消息原样，长消息保留开头 24 字 + **末尾 36 字**（指令通常在末尾）。
    「最近一条」的摘要同样修正。
  - 回归：`scripts/test-status-summary.mjs`（15 项，含事故原文回放）。

- **修「总是戳同一个人」：给拍一拍一条不需要记 QQ 号的路**（2026-10-22 用户反馈）：
  - 现象：机器人反复拍 群友A，群里被问「怎么一直戳我」。
  - 根因是「信息不足 + 模型复用旧值」：
    ① `qq_send_poke` 必须传数字 QQ 号；
    ② 唤醒提示只说「有人戳了你（群友F）」——**只有名字，没有号**；
    ③ 上下文里唯一的号来自很早以前一次 `qq_get_recent_messages` 的结果
      （恰好是 群友A 的 `100002009`）以及它自己拍完后返回的 `targetUserId`；
    ④ 模型拿这个旧号顶上，一路拍十几次。
  - 修法（按用户要求，**不做连拍限流**）：
    - **状态行带号**：`有人戳了你（群友F QQ=100002013）`，并提示「回拍就传这个数字，
      或直接传 `targetUserId="latest"`；不要用记忆里别的号」。
    - **新增 `src/poke-target.js`**：`targetUserId` 支持 `latest`（最近戳你的人）/ 昵称，
      由桥接在**本会话**消息里换算。同名多人时**拒绝并列候选**（绝不猜）；查不到也拒绝。
      安全边界不变：只解析本会话收到过的消息，最终仍走 `modeAllowed` 校验。
    - **自己的拍一拍记录写名字**：`[拍一拍] 我拍了拍 100002009` → `[拍一拍] 你拍了拍 群友A`。
      既去掉了上下文里可被复用的裸号，也修掉它认不出「那是自己拍的」的问题
      （被质问时它答「戳你的人不是鱼」）。
    - MCP 工具描述同步三种填法，并警告「不要凭记忆填旧号」。
  - 回归：`scripts/test-poke-target.mjs`（37 项，含事故回放：`latest` 必须解析到群友F
    而不是上下文里的 群友A）。另修了两个旧测试里写死的文案断言与过窄的代码切片窗口。

- **修「群友发的图太大，机器人看不到就让人重发」**（2026-10-22 用户反馈）：
  - 现象：机器人在群里说「图没加载出来，你再发一次」。查日志发现是
    `图片 URL 抓取失败: 图片超过大小限制（8388608 字节）` —— `safeFetchBuffer` 一超限就 **reject**，
    桥接返回 null，模型完全没看到图，只能说"加载不出来"。而群友再发还是同一张，**永远加载不出来**。
  - 根因：把"内存保护"和"能不能看图"绑死了。桥接本来就有 `prepareImageForModel()`
    （缩图/超分/lanczos）能压图，前提只是**要有字节**。
  - 修法：
    ① `safeFetchBuffer` 新增 `partialOnOversize` 选项：超限时断开连接但**把已收到的前缀交出去**
      （默认仍 reject，安全语义不变；SSRF 校验仍在取字节之前）；
    ② 桥接取群消息图时上限放宽到 **4 倍（32MB）**，先尽量拿全图——完整图才能被 ffmpeg 正常重编码；
       `partialOnOversize` 只作最后兜底；
    ③ 走 `prepareImageForModel` 压缩后再喂模型，并在截断时记日志「画面可能不完整」便于排查；
    ④ MCP 的 `web_view_image`（按 URL 看图）同样启用，上限 2 倍。
  - 实测确认：截断到 256KB 的 PNG 仍能解码出**上半部分画面**（顶部内容可见），
    但 ffmpeg 会报 `chunk too big` 拒绝重编码——所以"尽量取全"是主路径，"取部分"只是兜底。
  - 回归：`scripts/test-image-oversize.mjs`（21 项）。测试**不能**起本地 HTTP 服务喂 `safeFetchBuffer`
    ——SSRF 防护会挡住 `127.0.0.1`（这是对的，别为测试削弱它）。

- **修「问 token 用量给不出图」：桥接自己认提问，不靠模型联想措辞**（2026-10-22 用户反馈）：
  - 现象：群里问「你用了多少token」能出图（历史成功 6 次），但换个说法就废了。
    实测 2026-10-21 group:100002004：
    - 「看看你吃了多少token」→ **没调工具**
    - 「你怎么这么能吃白饭」→ **没调工具**，反而编出「35.27B里prompt占35.25B」
    - 下一条又改口「我这边没有查自己用量的口子，只能看你们截的图」
    三类错误同时出现：**漏认说法 + 编数字 + 谎称没有能力**。
  - 根因：只靠工具描述里列的固定触发词（"用了多少/消耗多少/烧了多少"），
    而群友的说法是开放的（"吃了多少白饭""这么能吃"），**列举永远追不上**。
    模型对没列出的措辞不会主动联想，于是转向"自己估算"或"说没有"。
  - 修法三层：
    ① `buildTokenAskLineV2()`：桥接在唤醒提示里**自己认**（两段式判据：用量词 + 数量词，
      同时排除"token 是什么""你吃不吃 token"这类玩笑），认出来就注入
      `【本轮必须调 qq_token_report】` 的强制指令，位置紧跟点单判定；
    ② 提示词与 MCP 工具描述都补齐触发说法，并写明**不许估算、不许说没这个口子**；
    ③ 只扫最近 8 条未读，避免旧提问每轮都催它发图。
  - 另确认渲染链路本身没问题（浏览器正常、数据 34 天/9881 轮/43774 次都对）。
    之前群里那张"3 天 / 9 轮 / 3.00M"的图是**统计数据还不完整时期的缓存**
    （缓存键是 HTML 内容哈希，数据更新后会自动重渲染，不是 bug）。
  - 回归：`scripts/test-token-ask-detect.mjs`（33 项，含事故原话、误判排除、接线检查）。

- **Token 用量记录 + 每日更新 + 控制台展示**（2026-10-21 用户要求）：
  - 复用既有的 `scripts/token-usage.mjs` 解析思路（用户提示「直接复用」），抽成
    `src/token-usage.js`。原脚本已踩平两个坑：会话文件是 **zstd 多帧拼接**（须按魔数切帧）、
    **同一份 usage 在 chunk 与 message 各出现一次**（须去重，否则翻倍）。
  - **修两个问题**：① 模型归属——usage 事件没有 model 字段，它在 `request/header` 的
    `data.header.config.model`，且该事件没有 turn 字段，只能按时间顺序继承
    （旧脚本按 `data.model` 取，导致「按模型」只统计到 67/40006）；② 扫描范围——
    只认 `*-state-agents--` 且名字带本项目的目录，避开别的项目和测试工作区
    （391 文件 → 15 文件，今日用量不再虚高）。
  - **每日更新 + 落盘 + 写日志**：跨天自动重算、平时每 6 小时刷新；结果写
    `state/token-usage.json`，日志打「今日 / 累计」两行。
  - **GET 不现算**（全量扫描 13~16 秒会卡住控制台），只读缓存；重算走
    `POST /api/socialV2/token-usage-refresh` 后台跑。增量扫描用 `mtime+size` 指纹复用。
  - 控制台「16 Token 用量」：今日四项指标、累计、近 14 天趋势（条形对比）、按模型明细、
    手动重算按钮。
  - 顺手把**凭据卡片移出 3 秒轮询**：它每次重建 DOM 会冲掉正在输入的内容，
    这也是"保存只生效一项"的成因之一。
  - `scripts/test-token-usage.mjs` 39 项（含多帧解压、去重、模型归属、时区、增量缓存）。

- **SauceNAO 反查额度两处修正**（2026-10-21 用户反馈「反查额度好像有问题」）：
  - **被风控拦住时不该扣额度，但原先扣了**。旧逻辑是「拿到任何响应先 `commitQuota()`，
    再按错误文案正则决定是否 `refundQuota()`」；Cloudflare 挑战页的文案不在那条正则里，
    于是被 403 挡住也白扣一格。现在改成**只有 `parsed.ok === true`（真拿到结果）才记账**，
    风控页 / 非 JSON / 上游报错 / 连接失败一律不扣。实测修复后 `usedToday` 从 1 变回 0。
  - **挑战页判定误报**：原先只测 `/cloudflare/i`，而 SauceNAO 正常首页里也有
    `Cloudflare Web Analytics` 脚本注释 → 把正常页面当挑战页。现在要求真正的挑战特征
    （`Just a moment` / `cf-chl` / `challenge-platform`），并补了「HTTP 403 + 非 JSON」兜底。
  - **实测结论**：当前代理出口 IP 确实被 Cloudflare 标记（`403 + Cf-Mitigated: challenge`）。
    试过三组请求头（基础 / +Referer+Origin / +Sec-Fetch 全套）**全部 403**，
    所以这不是能靠改请求头绕过的；只能换代理节点。报错文案现在会明确写
    「不是 key 或额度问题」，避免被误当成额度耗尽。

- **凭据卡片三处修正**（2026-10-20 用户反馈）：
  - **连接类不再脱敏**：代理地址不是秘密，`kind:'text'` 的项直接显示明文且不显示眼睛按钮；
    只有真正的 key / Cookie（`kind:'secret'`）才打码。服务端对 text 类直接下发明文。
  - **弹窗关闭按钮 × 没居中**：原来用固定 30×30 + `line-height:1`，字形贴上沿。
    改为 `inline-flex` 居中 + `line-height:0`；顺带给标题加省略号防止把按钮挤走。
  - **「保存全部改动」只保存最早改的一项**——根因不是保存循环，是**刷新时清空了待提交表**。
    `loadCredentialItems()` 每次调用都 `CRED_EDITED.clear()`，而它会被首屏加载/保存后刷新/
    任何重建触发；用户改了几项、中途触发一次重建，未保存的编辑就没了。
    另外当时只有 `Set<key>`，值只存在 DOM 上，DOM 一重建连值也丢。
    改为 `Map<key, value>`：编辑即写值、渲染时回填、**只在保存成功后**移除成功的项。
  - 顺带修了 B 站分区缺失：新视频常 `tname/tname_v2` 全空、`tid` 又是新编号（121/162），
    补了几个 tid 映射 + 用 `tid_v2` 千位区间推大类兜底，不再出现"分区为空"导致权重统计缺项。

- **工具开关卡片重构 + 查漏补缺**（2026-10-20 用户要求「过于复杂，似乎还有遗漏项目」）：
  - **确实漏了 10 个**：`archiveImage` / `imageSource` / `reactMessage` / `rejectImage` /
    `refreshImageLib` / `reverseSearch` / `sendImage` / `getFeatureMenu` / `groupFiles` / `deleteSticker`
    都是真正生效（`v2ToolEnabled` 会检查）但在控制台**没有复选框**的——用户根本关不掉。
    另有 4 个无条件注册的只读工具（`qq_status` / `qq_list_groups` / `qq_get_group_members` /
    `qq_get_group_history`）没在任何地方说明。
  - **根因**：清单写死在控制台 HTML（30 个复选框），加工具时只改后端或只改前端就漂移。
    现在唯一来源是 `src/tool-flags.js`（51 个开关覆盖 55 个工具），控制台从
    `GET /api/socialV2/tool-flags` 渲染；保存时的白名单也由该清单派生。
    `test-tool-flags.mjs` 断言**清单与 MCP 注册工具完全一致**，以后漏登记会直接测红。
  - **视觉重做**：可搜索、按 9 个功能分组可折叠（折叠状态存 localStorage）、每组「全开/全关」、
    顶部「全部展开/收起 + 全开/全关（危险，带确认）」、危险项红边「慎关」、不可关闭项灰显带锁标记、
    关闭项整行变淡、顶部统计「已启用 N/总数，覆盖 M 个工具」。
  - **顺手修了一个自己引入的问题**：用 Python 批量改文件时在 Windows 上把多个文件转成了 CRLF，
    导致按 `\n` 做静态分析的老测试（test-msg-normalize / test-private-admission）报
    "fn end not found"。已全部转回 LF——**改文件时要注意换行符**。
  - `scripts/test-tool-flags.mjs` 47 项。

- **控制台「18 凭据与连接配置」卡片**（2026-10-20 用户要求）：
  把所有待配置项（API key、Cookie 凭据、代理）集中到一处，密码样式 + 右侧眼睛切换明文 +
  每项旁边 `?` 打开 markdown 说明，底部保存与重启。
  - **安全设计**：列表接口**默认不下发明文**，只回脱敏预览（前 2 后 2，中间固定长度圆点）。
    隐藏态输入框里装的就是这串脱敏值，用 `-webkit-text-security: disc` 渲染成黑色圆点；
    它是**真正的 input**（非 `div`、非 `type=password`），所以能选中/全选/复制——
    `password` 的选区与复制行为在各浏览器不一致，普通 input + CSS 才稳定。
    点眼睛才单条请求明文（`reveal=1&key=xxx`），再点收回填回脱敏串。
    因此隐藏态**页面从不持有完整密钥**；全选复制拿到的是脱敏串，要明文需先点眼睛
    （用户 2026-10-20 确认保持此取舍）。不用"一次 reveal 全部"，避免所有密钥同时进内存。
  - **需重启 vs 即时生效**分色标注：B 站 cookie / SnowLuma token / 控制台令牌只在启动时加载，
    标黄色「需重启」；其余标「即时生效」。保存后回 `applied` 字段，让前端能说清"到底生效没"。
  - 底部「重启桥接」复用既有 `/api/restart`，带确认框 + 重启后轮询等待恢复。
  - 说明文档在 `src/credentials-doc.js`（内联，弹窗用 `transform+opacity` 过渡动画，
    支持 Esc / 点遮罩关闭）。每项都写了怎么取、生效方式、安全提醒。
  - 保存前校验：代理必须 `http(s)://`、控制台令牌 ≥16 位、密钥过短拒绝。
    写入沿用原位置，**不新建集中明文文件**。
  - 顺手把 `image-reverse-search.mjs` 的 `apiKey` 从 `const` 改成可变的 `currentApiKey`
    + 导出 `setApiKey()`，这样改 key 不必重启桥接。
  - 卡片**跨两列**（约 700px），不占满整行：一列 340px 会把输入框压得看不见，整行又拉成长线。
    凭据项与连接项用**同一种输入框外观**，区别只在多一个眼睛按钮。
  - **保存只提交 `data-edited === '1'` 的项**——隐藏态里是脱敏串，若被当新值写盘
    会把真实密钥覆盖成一串圆点（这是最容易写错的地方）。
  - `scripts/test-credentials-panel.mjs` 80 项。

- **回复时按概率 @ 发出消息的人**（2026-10-20 用户要求）：
  - 新增 `src/auto-at.js` + `socialV2.send.autoAt` 配置（默认 `probability 0.3`）。
    发送链路本来就支持 `atUserId`（`qq_send_message` 一直有该参数），但模型几乎不主动传，
    而"偶尔点个名"属于发送外观、不是语义判断，交给桥接掷骰更稳定。
  - **@ 谁必须准确**，目标优先级：引用对象 > 未读里**按内容匹配出的人** > 最近一条他人消息（10 分钟窗口）。
    未读优先是关键——那才是"这次在叫它的人"；`recentMessages` 里混着它自己刚发的和早已聊完的旧话。
  - 排除：私聊、模型已显式传 `atUserId`（不叠加）、自言自语/收尾类（"哈哈哈""晚安"）、
    拍一拍（与 `findCallersV2` 判定一致）、非法 QQ 号、@ 自己。
  - 限流：同会话冷却 5 分钟、每小时最多 10 次，两者都**持久化**（`saveSocialV2State` 是白名单序列化，
    新字段不显式列出就会丢——命中过一次，`lastAutoAt` 没写进文件，冷却等于失效）。
  - `@` 只挂在第一条消息上，后续气泡不再重复点名。
  - 控制台改配置时对 `autoAt` 做归一化（概率 clamp 0~1，毫秒/次数非负取整）。
  - 回归：`scripts/test-auto-at.mjs`（66 项，含"按内容选人""拍一拍排除""持久化白名单""配置归一化"）。

- **再修「@ 错人」：内容匹配失败后不该退回"最近说话的人"**（2026-10-21 群截图复现）：
  - 现象：群友U 问「@大肥鱼 你用了多少token」，机器人回「喏，图来了」，却 **@ 了群友H**。
  - 复现链：查 DSH 会话里 `qq_send_message` 的实参，**没有 `atUserId`**（模型没 @），所以是桥接加的；
    回放当时数据发现 `pickUnreadTarget` 正确返回 null（「喏，图来了」与在场所有人的话零重合），
    **但紧接着的 recent 兜底按"谁最后说话"挑了群友H**。
  - 根因是把两种失败混为一谈：
    ①「未读里没有可定位的人」→ 信息不足，用 recent 兜底合理；
    ②「有未读但内容都不沾」→ 已有足够信息判断"这次不该点名"，兜底只会制造错误。
    现在只有 ① 才走 recent 兜底，② 直接返回 `no-match`（宁可不 @）。
  - 第二个根因：字面重合对**短回应**天然失效（「喏，图来了」不可能和问题有 2-gram 重合）。
    新增 `isAddressedToBot()`：未读里**明确在叫它**（@ 别名 / 引用它）的人优先，
    判据与 `findCallersV2` 同源（群昵称 + 角色名 + 唤醒关键词）。这比字面匹配可靠得多。
  - 别名列表由 `planAutoAtV2` 传入（`selfNickname` + 当前角色名 + 唤醒关键词）。
  - 回归：`scripts/test-auto-at.mjs` 扩到 96 项，含**该事故完整时间线回放**与
    `isAddressedToBot` 的 7 项判据（@角色名 / @群昵称 / 引用 / 只提名字不算 / @别人不算）。

- **修「引用合并转发时看不懂」：两个环节都在丢 forward id**（2026-10-22 用户截图）：
  - 现象：群友引用了一条「群聊的聊天记录」并问「@大肥鱼装AI 这个是什么」，
    机器人答「那条转发鱼打不开，id对不上」。群里还有其他人在正常聊天，只有这一处失灵。
  - 根因两处，缺一不可：
    ① `resolveReplyInfo()` 只收集 `image` / `face` 段，**`forward` 段被完全忽略** ——
       模型连转发 id 都拿不到，只能编个理由（"id 对不上"这句话是它自己编的，代码里没有）；
    ② 就算拿到 id，`qq_get_forward_msg` 还有道白名单
       （`seenInRecent` / `seenInUnread` / `seenForwardIds`），而**引用里的转发从来没被登记**，
       于是必然 404「不在当前会话可见范围内」。
  - 修法：
    - `resolveReplyInfo` 用现成的 `extractForwardIds()` 提取 id，写进 `info.forwardIds`，
      并**立刻登记到 `seenForwardIds`**（该 id 确实来自本会话收到的消息段，安全性不变）；
    - `buildReplyText()` 把 id 直接写进引用文案并点名用哪个工具读
      （原先 forward 段在引用文案里也被完全忽略，只处理 `mediaCount`）。
  - 输出形如：`[引用 群友M：[转发消息]]（被引用的这条消息是一条合并转发，id=ABC123。要看内容请调用 mcp__snowluma__qq_get_forward_msg，参数 id 直接用上面的值）`
  - 回归：`scripts/test-reply-image.mjs` 扩到 34 项（新增 9 项转发相关：id 露出、
    多 id、普通引用不污染、图片与转发共存）。

- **四修「@ 错人」：多个"在叫它"的候选时，不能只取最新的那个**（2026-10-22 用户截图）：
  - 现象：群友C 问「@大肥鱼装AI 能给我一些比较雷霆的奶龙图片吗？」，16 秒后
    群友D 也 @ 了机器人一句「那存这张，遇到不喜欢的就发出来」。
    机器人回「雷霆的奶龙没有，鱼这儿只有鲸鱼」——**却 @ 了群友D**。
    群里当场有人回复「你艾特错人了」。
  - 根因：两条都命中了 `unread-addressed`（都 @ 了机器人），而该分支**只按时间取最新**，
    于是选了后说话的群友D。但回复内容明明在回答 04:13:13 那个提问。
  - 修法：候选多于一个时，先按**回复内容与各候选话语的重合度**挑（`textOverlap`），
    取最高的；都沾不上（重合度全为 0，短回应场景常见）才退回"取最新"的老行为。
  - 顺带确认：这类"多个候选"是常见情形——群里经常是一人提问、另一人跟着 @ 它搭话。
  - 回归：`scripts/test-auto-at.mjs` 扩到 114 项，含本次事故时间线回放
    与"内容分不出时仍取最新"的对照用例。

- **三修「@ 错人」：拍一拍不能当"在叫它"，旧 @ 也有保质期**（2026-10-21 再次复现）：
  - 现象：群友D 问「那你怎么漏的」，机器人回「漏的是空气，别乱想」却 **@ 了「群友Y3」**，
    群里当场有人说「这啥鱼怎么老@错人」。回放确认走的是上一轮新增的 `hit:unread-addressed` 分支。
  - 根因 a：**拍一拍被当成"明确在叫它"**。`[拍一拍] 群友Y3 戳了戳 你` 的 `targetIsSelf` 为真，
    于是被选中；但拍一拍**没有说话**，不可能是回复对象。`pickUnreadTarget` 一直排除它，
    新加的 addressed 分支漏了同一层过滤 → 抽出 `isPokeMessage()`（同时认 `kind:'poke'`、
    `poke` 对象、文本前缀三种形态），两处共用。
  - 根因 b：**一个人几分钟前 @ 过它，就被当成"正在叫它"**。「群友C」13:08 叫过它，
    之后只发图片和拍一拍，13:12 仍被选中。现在每人**只看最近一条有实质内容的消息**
    （图片/表情/拍一拍不算实质内容），并且这条 @ 必须在 `addressedTtlMs`（默认 2 分钟）以内。
  - 回归：`scripts/test-auto-at.mjs` 扩到 110 项，含本次事故时间线回放、
    `isPokeMessage` 6 项判据、@ 信号时效 4 项。
  - 端到端实测：临时把概率设为 1 发一条，日志 `[自动@] group:... @100002000 来源=hit:unread`，
    且 `state/social-v2.json` 里 `lastAutoAt` / `autoAtTimes` 正确落盘。验证后已恢复 0.3。
  - **只在需要指明对象时才 @**（2026-10-20 用户要求）：
    「只在回复的消息不在当前会话中的最后一条时，或者要回复的是最后一条但距现在超过 1 小时时才 @；
    最后一条且时间相近直接发送即可」。
    - 道理：@ 的唯一作用是**指明在跟谁说话**。回刚才最后一条、就在几十秒内，谁都知道在回谁，
      @ 只是噪音；回更早的某条（中间有人插话）或最后一条已过去很久（怕对方以为你在自言自语）
      才需要点名。
    - 判据在 `shouldAutoAt`：目标不是"最后一条他人消息" → 要 @；是最后一条但超过
      `staleAfterMs`（默认 1 小时）→ 要 @；否则跳过（`skip:last-and-fresh`）。
    - 拿不到时间/位置信息时**倾向 @**——信息不足时点名比不点名安全，误解对象的代价更大。
    - **回同一个人多条时只在第一条 @**：单次调用内部由 `i === 0` 保证；跨调用则靠
      「本回合已 @ 过就不再 @」（`autoAtTurnDone`，用 `v2TurnStartAt` 对齐回合边界，
      无回合标记时用 90 秒窗口兜底）。实测模型会分三次调用发三句（17:55:43 / 17:55:56 / 17:56:09）。
    - **@ 与正文之间补一个空格**：`@` 是独立消息段、不是文本的一部分，不补分隔时 QQ 会显示成
      「@小明你好」，读着别扭还容易误以为后面那串是名字。只在**确实有 @** 且正文不以空白
      （含换行）开头时补——普通消息不加前导空格，自带空格的也不重复补。
      表情/图片路径（at + image，无文字）不需要。
  - **修「@ 错人」**（2026-10-20 群里实际发生，有人当场指出"@错人了吧"）：
    旧逻辑取"未读里最后一条他人消息"的作者，**完全不看这句话在回谁**。真实时间线是
    群友X4连发「明天开会的东西还没看完」「他妈的」，群友X1插了一句「我是153」，机器人回
    「这个点还没看完就别硬看了，明天顶着困去开会更亏」——明明在回群友X4，却 @ 了插话的群友X1。
    - 现在改为**按内容相关性选人**：把要发的回复与每个人说过的话做字面重合度比较，取最相关的那个人。
      上例中「还没看完」「开会」全部命中群友X4，「我是153」完全不沾（实测重合度 0.22 vs 0.00）。
    - 相似度用**中文 2-gram + 英文单词**：项目没有分词库，也不值得为这个功能引入一个；
      2-gram 是中文近似匹配的常规做法，实测能稳定区分。单字不参与（太容易误配），
      虚词组合（"的是""了也"）过滤掉。
    - 同一个人连发多条时**按人合并**比较——只看最后一句会丢掉关键信息。
    - 同分时取"最近说过话"的人；**谁都不沾就不 @**（新配置 `minOverlap: 0.12`），
      不再像以前那样硬指一个人。纯图片/表情的未读没有内容可比，退回"最近说话的人"。

- **角色卡正文注入唤醒提示（根治「极少回复表情包」）**（2026-10-20 用户反馈）：
  - 用户反馈机器人几乎不发表情。查下来不是表情功能坏了——`qq_send_sticker` 在 8/31~10/24 一共调用过 44 次，
    9/22 一天就有 13 次；但从 **10/16 起连续 5 天为 0**，同期 `qq_send_poke` 照常每天 10 次，所以既不是能力问题也不是模型问题。
  - 真因：`buildWakePromptV2()` 只注入 `【当前角色】大肥鱼（完整角色卡请调用 qq_get_prompt 查看）`，
    **角色卡正文从未进入唤醒提示**。实测 30 天里群聊唤醒 7605 次，`qq_get_prompt` 只被调用 26 次
    —— **99.7% 的回合模型根本没看过角色卡**，人格只剩一个名字。
  - 后果是角色卡里所有吃细节的指令都失效。表情尤其明显：角色卡写「表情是你的主武器，能发就发…多数轮次都该带表情」，
    而通用策略写「普通闲聊不用每条都配；大约每 3~5 轮来一张就够」——没有角色卡的强命令时，模型只按通用的保守措辞行事。
  - 修复：唤醒提示直接拼入 `currentRoleHintV2()` 的结果（含一代指令过滤与示例空格转换）。
    实测提示词从 3929 字增至 10512 字，角色卡正文与表情 id 均已在场。
  - 另修一处摩擦：`buildStickerContext()` 原来只给表情描述、不给 id，模型想发还得先调 `qq_list_stickers`（多一步往返）。
    现在每条带 `id=<md5>` 并注明可直接传给 `qq_send_sticker`；URL 仍不暴露（防上下文膨胀）。
  - 回归：`scripts/test-role-injected-in-wake.mjs`（12 项）+ `test-stickers.mjs` 新增 4 项 id 断言。
  - 排查脚本保留：`scripts/probe-sticker-calls.mjs`（按工具名统计真实 `tool/call`）、
    `scripts/probe-sticker-timeline.mjs`（按天看从哪天起停用）。

- **称呼不较真 + 角色卡不再被静默截断**（2026-10-20 用户反馈）：
  - 群里连发两条纠正称呼（「说了别喊这个，叫大肥鱼」）。根因是角色卡两处互相矛盾：
    雷点写着「被叫"AI"要反复纠正」，开头又写「任何情况下你都叫大肥鱼」——模型把纠正当成设定职责。
  - 改为：**别人喊什么就应什么**（喊错、起外号、"AI"都接），同一轮最多提一次自己的名字，
    别人再次喊错也不追着改；「名字不是雷点」明确写进雷点行。两版大肥鱼同步，并补了「被喊怪名字」的示例对。
  - 顺带修掉真 bug：`currentRoleHint()` 原来硬切 6000 字，而实际角色卡 6283 / 6946 / 7388 字，
    末尾整节（表情包体系 / 轻量记忆 / **被问长相时**）从未进入提示词——「禁写外貌」正在最后一节。
    上限提到 12000，超限改为**打日志**而不是静默截断。
  - 回归：`scripts/test-role-name-guidance.mjs`（31 项）。

- **系统拓扑图**：`docs/topology.html`（离线单文件，双击用浏览器打开；六层主链 + 代理/外部服务/落盘外围，悬停高亮关联连线）

- **加好友 / 入群请求通知管理员并等裁决**（2026-10-20 用户要求）：
  - 监听 OneBot 的 `request` 事件（`request_type: friend` 加好友、`group` + `sub_type: invite` 群邀请），
    私聊管理员并附短编号；管理员回 `/yes 2` / `/no 1` / `/pending` 裁决。
  - **默认不自动同意**（fail-closed）：加好友与入群都在扩张攻击面。超时（默认 5 分钟）自动拒绝。
  - **只认管理员私聊**的指令——群里的「同意」可能是群友说的，不能当账号级授权。
    多条待决时**必须带编号**，避免误批。
  - **踩坑**：队列加载时会把过期项静默丢弃，导致「QQ 侧从未收到拒绝、申请人一直挂着等」而日志空白。
    现在启动时单独捞出「重启前就已过期」的请求补发拒绝（实测日志 `启动时发现 1 条已超时的旧请求，已补发拒绝`）。
  - 队列落盘 `state/join-requests.json`，编号重启后继续递增不重排；控制台「14 加好友 / 入群请求」可见待决列表。
  - `scripts/test-join-request.mjs` 71 项。

- **GitHub 仓库首页整页截图**（2026-10-20 用户要求「能解析 GitHub 链接并把仓库首页整个截图并发送」）：
  - 模型工具 `qq_github_shot`，群友发 `github.com` 链接或说「看看这个仓库」时直接调用。
    支持完整链接 / `owner/repo` 简写 / 用户主页；`/issues`、`/tree/main/x` 等子页面归到仓库首页。
  - **整页约 15400px，必须分段**：一张发出去会被 QQ 等比压成灰色细线（文字 1~2 像素高）。
    按 2400px 切 5 张，每张 1400×2400，文字清晰。
  - **走 CDP 而不是 Chrome CLI**：功能菜单那套「`--dump-dom` 量高度 + `--screenshot`」只适用于
    自己生成的静态 HTML。外部页面量不到渲染高度、固定高度会留白/截断，高度还随宽度响应式变化。
    改用 `--remote-debugging-port=0` 起 headless Chrome，`Page.getLayoutMetrics` 取真实尺寸，
    `captureScreenshot` 的 `clip` 按段截（**不改视口大小**，否则触发重排导致各段错位）。
  - **必须走代理**：实测直连 `github.com` 会 `ECONNRESET`，代理从 `githubShot.proxy` 取、
    回落到 `images.proxy`。直连失败时错误信息会直接点明要配代理。
  - 同仓库同会话 30 秒去重；发送前过 agent token / 模式 / 暂停 / 静默四道闸；
    某张失败就停，一张都没发出去时明确报错。
  - 实测整页 15422px → 截 12000px → 5 张，19.6 秒；`scripts/test-github-shot.mjs` 54 项。

- **发图每小时上限 30 → 60，且同一张图 10 分钟内不重复发**（2026-10-20 用户要求）：
  - 上限来自实测：某群在 8:00~8:30 内发满 30 张，之后两次请求被拒（日志明确报"本会话每小时最多发 30 张图"）。
  - **重复发的根因不是"没做去重"，是线索存错了地方**：`pruneSent` 在 10 分钟后把发过的条目整个从
    index 删掉，同一张图再查询时重新拉取、`add()` 生成全新的 `useCount: 0` 记录，于是"新鲜度"
    判断认为它从没发过。日志实证 `pixiv:150564360` 在 4 分钟内发了 **3 次**。
  - 新增 `state/image-lib/recent-sent.json`（内容哈希 → 发送时间），**条目删了记录还在**。
    挑选时这一层是硬过滤：全被挡时宁可返回空让上层现拉新图，也不发重复的。
  - 三个配套修复：① dryRun（发图预检）也计入这一层，否则预检说"本地有图"却发不出；
    ② **差评换图跳过**这一层（被拒的图已移出库，再拦等于"不许换"）；
    ③ 被挡时的文案要说"刚发过、再等等"，**不能报"没找到"**——后者会让模型换词乱搜。
  - 配置：`socialV2.images.maxSendPerHour: 60`、`recentSendBlockMs: 600000`。

- **群友问自拍时，形象图会真的发到群里**（2026-10-20 用户要求）：原先 `qq_get_self_image` 只把图返回给模型看，群里什么也看不到——被要自拍时模型只能对着图描述一遍长相。
  现在这个工具**默认发送**，看图与发送合成一次调用。为什么不拆成两个工具：拆开后模型可能只调了"看图"忘了"发图"，或者被明确要图时仍然只描述。
  发图复用 `onebotSendImageFile`（456KB，走 `base64://` 内联，不触发临时 HTTP 兜底），并照旧过 reserved2 模式 / 总暂停 / 静默三道检查。
  发送失败时端点回 `sendError`，MCP 会把「图**没能发出去**」这句话写进给模型的内容里——否则它会以为发了，对群友说"图发你了"而实际没有。
  发完写入会话时间线，避免下一轮再发一次同一张。

- **控制台增加「12c 取图额度」卡片**（2026-10-20 用户要求「取图 API 额度能不能在控制台中加一个显示」）：
  把取图链路上**三类互相独立的上限**分开显示——它们都会表现成「取不到图」，混在一起排查会走错方向。
  - **SauceNAO 反查**：每天 100 次 / 30 秒 4 次。这是唯一「真的会用完」的上游免费额度，用完当天就不能反查。
  - **拉取冷却**：两次补货的最小间隔（默认 30 分钟），冷却中补货会被拒，但库里已有的图照发。
  - **图库容量**：300 张 / 256MB，满了淘汰最久未用的旧图，不影响继续取图。
  - 顺带显示每会话发送限频、各图源开关与有无代理（「某个源没开」常被误当成额度问题）。
  - 实现细节：`image-reverse-search.mjs` 的 `stats()` 补了 `remainingToday` / `windowUsed` / `windowResetMs`。
    **窗口用量按当前时刻重新过滤 `hits`**，不直接用 `hits.length`——后者要等下次请求才清理过期时间戳，会显示虚高数字。
    剩余次数也由服务端算，避免前端跨天重置口径不一致。
  - 实测当前状态：反查 100/100 可用（缓存 15 张）、图库 **118 张 / 233MB（91%）**——容量已接近上限，开始淘汰旧图了。

- **重构第 4C 步：DSH 事件泵独立成 `src/pipeline/dsh-events.js`**（2026-10-25）：按事件类型分派回合、工具、压缩摘要、提问/审批和学习会话，统一正常断流与异常断流清理；`currentTurnBySession` 记录明确的回合编号和开始时间，迟到的旧回合/工具结果不再误清当前回合或吞掉回复。模式与学习会话标识实时读取，正常输出、静默、错误仅通知管理员等行为保持原有约定。点名未答判定与上下文轮换也改为可导入的函数，相关测试直接验证行为；新增 63 项事件回放测试和脱敏的真实 DSH 事件夹具。`bridge.js` 从 10,628 降到 **10,042 行**；隔离实例启动与 WebSocket → 本地 OneBot 替身回放通过。全套 **106/116、4434 断言**，10 个未通过脚本与基线一致（未启动服务/外部图站依赖），无新增失败；运行器仍因控制台 `ECONNREFUSED` 返回退出码 1。生产服务当前未启动，上线后的群消息验证及半天/24h 灰度仍待完成；图库发送留给 4D。

- **B 站「自己刷视频」+ 全局观看记忆**：机器人会在潜水时自己刷 B 站，遇到喜欢的多看一会、不喜欢的划走，并把感受存成**跨群共用**的记忆。
  - **"多看/划走"用帧数表达，不是真的等时间**（模型不在时间维度上感知视频）：不喜欢看开头 4 秒 6 帧，喜欢看 30 秒 24 帧。这既省带宽，也更接近真实的"扫一眼就划掉"。
  - **节奏与额度**：潜水时随机 5~10 分钟尝试一次；每天累计按**实际观看秒数**计，上限 **2 小时**（到点自动停）。群友发链接让他看**不占**这个额度——那是应要求观看，不是自己刷。
  - **不打扰正在聊的群**：只挑最空闲的群会话落脚，有未读/繁忙/正在活跃的群跳过。
  - **群友发 B 站链接或分享卡片时**，模型会主动调 `qq_watch_bili` 真的看一眼画面（支持 `b23.tv` 短链），而不是只看标题就回答。
  - **记忆是全局一份**（`state/bili-memory.json`），不挂在会话下：现有 activeTopic/memberImpressions 是群聊上下文、按群隔离是对的，但"我喜欢看什么"与群无关，在 A 群看过的 B 群也该记得。按 bvid 去重，记录标题/UP主/分区/标签/喜欢程度/兴趣分/备注；`qq_bili_memory` 可按标题/UP主/标签查，也会归纳"我的口味"（只统计喜欢的）。
  - **分区偏好**（2026-10-19 用户要求「偏好改成二次元、游戏、科技、社会热点相关」）：默认权重 二次元 6 / 游戏 5 / 科技 4 / 社会热点 3.5 / 知识 3，生活与搞笑为中性 1。**加权随机而非白名单**——热门榜里常常没有偏好品类，白名单会让它完全不刷；加权则自然落到别的分区，像人"主要看这些，也会随手点别的"。实测 2000 次抽样：四个偏好品类合计约 88%，生活+搞笑不到 10%。
  - **修「感兴趣的视频也看的时间很少」**：原喜欢档 12 秒 16 帧，占一条 6 分钟视频的 3%，实测模型只能说出"同一机位的明暗微变"；现在 **30 秒 24 帧**，同一视频能描述出"大厅 → 花盘特写 → 大厅全景 → 钩状物特写"多个场景。拼图仍是 1568×1565（192KB），耗时 1.95s vs 1.32s，代价可接受。
    同时改了提示词：明确写出"只截取了开头 N 秒（约占全长 X%），这是**片段**，不是整条视频；评价时别把开头当成全部内容"——否则模型会把 30 秒当成整条视频来夸或贬。
  - **两段式观看**（修「为什么总是 8s11 帧」）：原实现**先定看多深、再去看**，而"喜不喜欢"要看完才知道，所以永远走 `liked=null` 的中庸分支（8s/11 帧），`framesLiked`/`framesDisliked` 从未生效。现在改成三段：浅看 4s/6 帧 → 让模型**只回一行 JSON** 做初判 → `liked=true` 才追加到 30s/24 帧（追加是在同一视频上读更长的窗口，不是另截一段）。
    两个实现细节：① 初判的 waiter **只在回合有文本时才回填**——模型常先调工具再输出 JSON，工具调用会先结束一个空回合，若那时就 resolve 会拿到空串、被判"没判断出来"，等于又回到"永远只看 4 秒"；② 初判超时给 150 秒（可配 `judgeTimeoutMs`），实测 90 秒不够——有一次响应在超时后 1 秒才回来。
  - **群友常玩的游戏优先**（同日要求「多看鸣潮/明日方舟/终末地/原神/星铁/绝区零/英雄联盟，群里多数是玩这些的」）：按标题/简介/标签识别这七款（含简称 `星铁`/`崩铁`/`ZZZ`/`LOL`、英文名 `Endfield`/`Genshin`/`Star Rail`），命中给 **20 倍**权重（用户指定）。
    为什么需要这么大倍率：实测热门榜 150 条里只有约 4 条（2.8%）是这些游戏，不加成基本刷不到。实测选中率：无加成 ~3%、10 倍 36%、**20 倍约 55%**——明显偏向，但仍保留约一半其它内容，不至于只刷游戏。
    候选池也从单页扩到 **3 页热门（150 条）**。分区榜（`ranking/v2`）与搜索接口（`search/type`）实测持续返回 `-352`/`-412` 风控，不可用，所以没走那条路。
  - **修「刷到黑屏」**：MV/PV 常有 2~5 秒黑场淡入，浅看 4 秒正好整段落在黑场（实测 K/DA 官方 MV 拼图平均亮度 **5.0**，正常画面 31~78）。抽帧现在会测亮度（ffmpeg `signalstats` 的 YAVG），太暗自动把采样窗口往后挪（最多 2 次，阈值 18）；初判提示词也要求"画面暗不等于黑屏"，尽量从字幕/标题/分区推断内容。
  - **修「初判永远 liked=null」**：初判 prompt 是**直接投递**的，不走 `v2TurnStartAt` 那套唤醒标记，而复用 `collectors` 只在有标记时才创建 → 拿不到 `turn/end` → waiter 只能等到超时。现在给初判单独一个 `biliJudgeCollectors`。
  - **控制台可见**（同日要求「能看到是不是在刷视频」）：「12a B 站自己刷视频」卡片实时显示此刻在刷什么（阶段/标题/UP主/分区/落脚群）、今日额度进度条、口味归纳、最近看过，并带「现在刷一条」按钮手动触发。
    「现在刷一条」有两个容易写错的点（都踩过）：① 它是**手动触发**，必须跳过"距上次太近"的间隔限制，否则点了等于没点、却回一句"已触发"；② 端点要**等这次刷完再返回**，先回 `ok:true` 再异步跑会导致响应里没有结果、且二次 `sendJson` 触发 `Cannot write headers after sent`。现在返回里直接带"刷了哪个视频/几秒几帧"或被跳过的可读原因。
  - 技术要点：B 站接口需要 `origin` + `accept: application/json` 才返回 JSON（否则是风控 HTML）；播放地址免登录取 360P 即可；抽帧整图按**宽高双约束**压到 1568px 见方并转 JPEG（PNG 版 6.7MB → 422KB，否则移交模型的 base64 会过大）。
  - **1 秒 1 帧 + 拼图分页 + 字幕**（2026-10-19 用户要求「帧间隔缩短一些，最好一秒取样一次」「一定要把所有帧序列放在一张图上吗」「不能直接给模型视频和音频流吗」）：
    - 帧数改为 `秒数 × framesPerSecond`（默认 1），`maxFramesTotal` 封顶 120。原先 `framesLiked: 36` 写死，看 120 秒却只抽 36 帧 = 每 3.3 秒一帧。
    - **分页**：120 帧挤一张 1568px 图时每格只剩 **142×80**，字幕完全读不清。现在按时间切多张（每张 ≤30 格），实测 120 帧 → 4 张、单格宽 **261px（约 1.8 倍）**。每片独立探测宽高比、只解本片那段时间（`-ss`），不浪费解码。
    - **图注**写明"共 N 张、按时间先后排列"；`deliverBiliPrompt` / `judgeBiliScan` / `bili-watch` / MCP `qq_watch_bili` 全部遍历投递——只发第一张会让模型把前 1/4 段当成整条视频。
    - **视频/音频流进不去**：DSH 的 prompt 协议只有 `text` / `image`（`promptContentPartSchema`），网关 42 个模型也只声明 `supports_images`。改用**字幕**：`/x/player/v2` 取 B 站 AI 字幕（实测热门榜 12 条里 11 条有 `ai-zh`），只截观看窗口内的行拼进提示词，并存进记忆 1200 字。
    - **踩坑**：字幕接口不登录时 `code` 仍是 **0**、`subtitles` 只是空数组——分不清"没登录"和"没字幕"。所以显式返回 `noAuth`，启动时 `setBiliCookie()` 注入登录态；字幕 CDN（aisubtitle.hdslb.com）本身不需要 cookie。
  - 测试：`scripts/test-bili.mjs`（249 项，含链接解析四形态、多看/划走深度、密度换算、分页不丢帧与单格尺寸、字幕裁剪、每日额度、分区归类与加权分布、全局记忆跨进程一致、控制台接线、真实接口与抽帧体积）。

- **接入 Real-ESRGAN 超分（复用本机 Upscayl，可选插件）**：小图放大从 ffmpeg lanczos 换成**超分优先**。
  lanczos 是插值——把像素平滑拉开，笔画边缘还是虚的；模型切 ~14px patch 时糊边正好落进边界。Real-ESRGAN 是生成式，会"画出"缺失的高频细节：同一张 180×90 文字截图，lanczos 版细笔画粘连，超分版边缘锐利、接近原生可读。
  - **没装 Upscayl 也完全不影响桥接**（这是设计要求）：① `qq_upscale_image` 工具在探测不到 Upscayl 时**根本不注册**（工具数 50→49），模型不会去试一个必然失败的工具；② 自动管线探测不到就直接走 lanczos，日志只说一句"不影响出图"；③ 文件在但**运行不正常**（驱动坏/DLL 缺失/假文件）时，连续失败 2 次后**熔断 10 分钟**，期间连进程都不起——避免每张小图都先等一次超时把回复卡死。
  - 自动管线：`prepareImageForModel` 先试超分，失败/未安装一律静默回退 lanczos。只对长边 <400 的图触发——否则每张正常照片都被放大，白烧 3 秒还改变原信息（实现时踩到的坑）。
  - 模型工具：`qq_upscale_image` 是**群友可主动要的能力**——说「帮我超分 / 放大一下 / 来个高清的 / 分辨率太低 / 糊了放大看看」这类话时模型直接调，不要求"看起来糊"作理由；即使模型觉得原图还行，群友明确要求了也照做。
    工具描述里写清了群友会说的原话、并要求不要回"我做不到"或"我只有收藏和发送"（实测模型看到「帮我超分」会立刻调用、`publish=true`）。
    另一种场景是模型自己看不清细节（远景小字、老照片、远处人脸），这时传 `publish=false` 只看不发，不刷群。
    **放大结果默认发回当前会话**，群友能看到（这正是"超分完没有把结果发回"的修复）。发送失败不影响模型看图和作答。
    preset（`qq-chat-v2`）与功能菜单图也同步列了这项能力——三处缺一处，群友就要么不知道能要、要么要了没人做。
    工具走 `?raw=1` 拿**原始像素**——否则桥接会先把小图 lanczos 放大到 1220px 再交给超分，等于对插值后的糊图超分，无收益且失真（实测 200×163 被预处理成 1220×994，工具只能报"原图已经很大"）。
  - **输入上限 4000（不是 1200）**：原先取 1200，结果群里真实的 879×1448、986×1659 全部被拒，模型只能反复回"原图已经够大"（用户反馈的现象）。实测这些图超分只要 1.5~1.6 秒、输出 234~327KB，完全可行。真正的约束在**输出**：`-w 1568` 把结果压到模型有效边长，否则 4x 会把 879×1448 放大成 3516×5792。
  - **大图回传不压缩**：桥接对超过 1.4MB 的图改用**临时回环 HTTP 托管**（起一个只服务这张图、发完即关的一次性服务），把 URL 交给 OneBot。
    为什么能这么做：查 SnowLuma 源码确认，那个 2MB 上限是 `readRequestBody(req, maxBytes = 2 * 1024 * 1024)`——**写死在函数签名里、没走配置**，超限直接 `req.destroy()`（所以客户端只看到 ECONNRESET）。但它只限制 **HTTP 请求体**；OneBot 读图走 `loadBinarySource()`，支持 base64 / http(s) URL / 本地文件路径，后两者请求体只有几十字节。
    实测：5.1MB 的图用这个方式正常发出；超分结果 **3.4MB 的无损 PNG 原样发到群里**（此前必须压到 286KB 才能发）。
  - 桥接的请求体上限仍全局 1MB，只对 `/api/socialV2/send-upscaled` 放宽到 8MB（`BIG_BODY_ROUTES` 白名单）。
  - **磁盘缓存 + 定时清理**：超分很贵（3~10 秒），而同一张图被反复超分很常见（群友重发同一表情包、模型对同一条消息看两次、桥接重启后重新处理未读）。结果按 `sha256(原图) + 模型 + 目标宽度` 缓存到 `state/upscale-cache/`，命中时 **3 秒 → 55ms**（实测跨进程也命中）。
    缓存**只增不减**（单张超分 PNG 3~7MB），所以有双阈值清理：超过 **3 天** 或总量超过 **500MB** 就按最旧优先删除。触发点有两处——每 20 次写入顺手清一次，加上每 6 小时的定时兜底（否则一张新图都没有时旧缓存永远不会被回收）。命中会刷新 mtime，避免反复命中的常用图被优先淘汰。
  - 细节：直接调 `resources/bin/upscayl-bin.exe`（真正干活的 ncnn 程序），不启动 Electron 外壳；7 个可用模型可按用途选（通用/最快/二次元/照片/强锐化…），模型不存在时自动回退默认；动图与超大输入明确拒绝并给中文原因。
  - 实测：RTX 4070 上 200×163 → 800×652 约 3 秒；真实群里那张 200×163 的表情包线条与色彩明显更干净。
  - 配置 `socialV2.upscale`（`enabled` / `model` / `binDir` / `modelDir` / `timeoutMs` / `cache.*`），`enabled:false` 可整体关闭。
  - 测试：`scripts/test-upscale.mjs`（124 项，含缓存命中/键区分/双阈值清理/安全默认，以及插件语义、熔断、MCP 按可用性注册）。
- **修复「动图被压成细长条」**：群友发现机器人回复"这动图被压成细长条了，只看出个戴帽子的金发小人在晃"。
  真因在排布：抽帧一直固定排成 `帧数 × 1` 的**一行**，20 帧时是 2400×120（宽高比 20:1）。视觉模型会把长边缩到约 1568px，于是每帧只剩 **78px** 宽，人脸糊成色块——而且**帧数越多越看不清**，与"多抽几帧看得更准"的初衷正好相反。
  改成**网格排布**（目标接近方形）：20 帧排成 5×4，单帧宽 320，整图 1600×1280，缩放后每帧仍有 **314px**（比原来清晰 4 倍）。帧数不足时用 `tpad` 克隆末帧补齐网格。
  顺带发现**大动图体积失控**：实测群里一个 10.8MB / 135 帧的动图，拼图 PNG 是 **3MB**（base64 后 4MB）——正是当初让 DSH 爆栈的量级。现在拼图超过 1.2MB 自动转 JPEG（q:v=6），同一张降到 **184KB**、体积降 94%，实测画质对表情包完全够用。桥接与 MCP 两处都改为使用返回的实际 mimeType（原先写死 `image/png`，转 JPEG 后会让下游按 PNG 解析）。
  提示文案同步改为按网格说明阅读顺序（"读完第一行再读下一行"），否则模型会横向一路读下去、把第二行当成更晚的独立事件。实测视觉模型能完整描述出"先鼓腮帮憋气、憋很久、最后放松"这一串动作。
  测试：`scripts/test-gif-frames.mjs` 扩到 47 项，新增宽高比 ≤2:1、每帧有效宽度 ≥200px、网格行列数、补帧、文案换行说明等断言。
- **修复「联网搜索查不到」：多词查询被上游降级后当成成功**：群里问「怎么评价魔法少女的魔女审判」，机器人回"只搜到'魔法'百科和韩国电影《魔女》"。
  实测真因在上游：`魔法少女的魔女审判`（单词）返回萌娘百科/百科/BWIKI 全对，但**标题后面只要多一个词**（`魔法少女的魔女审判 游戏`）就只返回「魔法（传说中的神秘力量）」×8。
  触发点是**查询里出现分词**，与编码无关（`%20` / `+`、加引号、加书名号、换 mkt 实测全部降级）。
  危害是**静默**：降级结果仍是 8 条格式正常的结果，`searchWeb` 只判 `length>0` 就成功、后续引擎不再尝试，模型拿到一堆「魔法」词条后如实说"没找到"——听起来像它不会搜。
  修法：多词查询若结果与查询毫无字面交集（判据 `looksOffTopic`），改用**最长词块**重试一次并如实上报 `retriedWith`；重试仍无交集则返回空结果，让引擎链继续试下一个（实测第 3 条查询降级后自动落到 DuckDuckGo，拿到 NGA 讨论帖）。
  **判据改过一版**：最初用"任一 ≥2 字词块命中即算切题"，结果 `魔法少女的魔女审判 萌娘百科` 仍被放过——降级返回的「魔法 - **萌娘百科** 万物皆可萌的百科全书」标题里正好含站点名。现在改为**主实体块（最长块）必须命中**，站点名（百科/wiki/官网/贴吧…）不能单独证明切题；同时保留"另一实体块命中可放行"，防标题改写误伤。
  工具侧同时告诉模型"本次结果来自检索 X，不要当成原查询的直接答案"。`bing-html` 与 `bing-rss` 共用同一判定，避免两处漂移。
  已知边界：错字/别名（`橘雪梨` → 必应纠错成 `橘雪莉`）无字面交集，重试后返回空——宁可报查不到，也不把「魔（汉语汉字）」当答案。
- **修「搜不到就拒绝回答」**：上一条只修了搜索，"搜不到"仍然会变成群友看到的"我搜不到这个作品，给我个日文名"。
  preset 里原本只写了"允许你多走几步换关键词"，没写**搜索失败时该用自己的知识回答**，于是模型把搜索当成唯一信息源。两个 preset（`qq-chat` / `qq-chat-v2`）都补了两条：搜两三次无实质结果就用自己知道的回答、只问真正必要的一个信息；结果标题与问题对不上时按"没搜到"处理，不要引用。
  顺带发现 `~/.dsh/.agent-presets/` 里安装的那份**已经和项目里的不一致**（缺形象图/查图来源/反向搜图三条能力说明，是之前某次改动漏同步），已一并同步并留了 `.bak-presync-*` 备份。
  测试：`scripts/test-search-degrade.mjs`（31 项，用真实抓取到的降级/正常结果做夹具）。
- **群白名单管理命令 `/wl`**：管理员可在群里直接 `/wl` 查看、`/wl add 群号 [群号...]` 加入、`/wl del 群号 [群号...]` 移出，不用开控制台也不用改 `config.json` 重启。
  改动**同时**写 `config.json`（原子写）与内存 `cfg.allow.groups`，立即生效且重启不丢；写盘失败时**不改内存**（否则进程内看似生效、重启即丢，症状比报错更迷惑）。
  三个必须处理的坑：① 准入闸门在命令处理之前，新群发的 `/wl add` 会被直接丢弃——加了一个很窄的例外（仅群聊 + 仅 `ownerQQ` + 确实是该命令，`closed-agent` 模式不例外）；② 删到空且 `allowAllWhenEmpty=false` 等于关掉所有群，回复里如实说明并给出加回方式；③ 移出当前群前先把话说完（移出后该群消息不再处理，但管理员仍可在该群发 `/wl add` 加回）。
  另：命令名刻意用 `/wl` 而非 `/allow`——`adminCmd` 的判定优先于 DSH 斜杠命令，名字越泛越容易与 DSH 自带命令撞车。
  测试：`scripts/test-whitelist-command.mjs`（64 项，含与 `allowed()` 语义一致性交叉验证）。
- **小图放大（修复「图很清晰但模型说糊」）**：视觉模型把图切成约 14px 的 patch，305×92 这类截图里中文只有约 12px 高（≈1 patch），笔画落不进 patch，模型只能看到糊块——这是**分辨率不足**而非画质压缩（实测 QQ 本地 `Ori` 原图目录里也是同一份 6790 字节）。
  修法与缩图相反：长边 <400 时用 ffmpeg lanczos 放大到 1220（实测 305×92 → 1220×368 后清晰可读）。两条交给模型的路径统一走 `prepareImageForModel`（**先缩大图防爆栈，再放大小图救可读性**，两条件互斥故串联安全）。
- **区分三种身份（后台管理员 / 群主 / 群管理员）**：消息前会带身份标记——【管理员】=配置里的 `ownerQQ`（唯一能执行管理操作）；【群主】= 群创建者；【群管理员】= 群内管理。
  三者**互相独立**（群主/群管理员未必是后台管理员，反之亦然），标记可叠加。群内身份取自 OneBot 事件的 `sender.role`（实测三值：owner/admin/member），与 `config.ownerQQ` 分开判定——**写操作权限只认后者**，群主也不能指使删表情/改备注。
- **删除收藏表情（模型工具 + 脚本双通道）**：模型侧新增 `qq_delete_sticker`（默认关闭，需 `socialV2.tools.deleteSticker=true`）——
  机器人现在能直接执行群友的删除请求，不再只能回"我只有收藏和发送两个动作"。
  **因为上游 `delete_custom_face` 不校验 emoji_id**（传假值也会真删），桥接侧加了三道防线：
  ① 默认关闭的独立开关 ② 删前用 `findSticker` 在本地库校验目标真实存在（传列表外的值直接拒绝）
  ③ 删前自动备份到 `state/stickers-deleted-*.json` + 删后回读校验确认真的消失。
  另外保留脚本通道 `scripts/delete-sticker.mjs`（`--list`/`--match`/`--md5`/`--apply`/`--restore`）供人工批量操作。
  原说明：`--list` 列收藏（含 md5）、`--match`/`--md5`/`--emoji-id` 指定目标、默认 dry-run、`--apply` 才真删且**删前强制备份**、`--restore` 一键恢复。
  之所以做成脚本而不给模型：实测 `delete_custom_face` **不校验 emoji_id**——传假值 "0" 也会真删掉一个表情（这次误删由排查过程造成，已用本地库 URL 恢复、md5 一致）。参数无效都能触发删除，交给模型就会「传错 ID 删掉别的、却以为删的是目标那个」。
- **搜图不再发群像图**：群像（多人/大合照）从候选里**排除**而非降权——池里没有单人图时返回空、由上层去外站现拉，拉不到就如实说没找到。依据：库里 90 个角色标签中有 65 个（72%）只有群像候选，降权挡不住，每次要这些角色都会发大合照。角色标签数阈值从 6 提到 10（避免误伤带多形态标签的单人图）；`socialV2.images.preferSingleCharacter: false` 可恢复旧的"有图总比没图好"。
- **修复本地图库标签大小写匹配**：`needle` 未小写化，导致含大写字母的标签查不到（实测 `Columbina_(Genshin_Impact)` 明明库里有图却返回 0）。
- **修复发图预检计数**：`dryRun` 原先返回 `pool.length`（只过标签/图源过滤），绕过群像排除与画风/质量分层，于是预检说"本地有图"而实际发不出去。现返回真实候选数。
- **群文件只读分类**：新增 `qq_list_group_files`（整体分类摘要 / 关键词搜索）与 `qq_group_file_stats`（容量），让机器人能回答「群里有什么文件」「有没有那个资料」「群文件满了吗」。按类型/上传者/时间聚合，识别 QQ 给不允许直传的类型加的 `.1` 后缀（如 `base.apk.1` → apk）。**只读**：不含删除/移动/上传——那几个写操作 API 实测存在且会真实执行，但群文件删了不可恢复，未纳入工具。
- **修复「引用图片看不到」**：群友引用手机拍的图时机器人回「加载失败」。真因是那张图 3.5MB/3072×4080，桥接按原图 base64 成 **4.75MB 字符串**，DSH 侧处理时爆栈（`Maximum call stack size exceeded`），模型只收到「image unavailable」。原有两道限制（8MB 字节 / 64M 像素）都按**原始**尺寸算，拦不住它。新增第三道：交给模型前用 ffmpeg 把超阈值大图缩到长边 ≤1568 并重编码 JPEG（实测 3.5MB→124KB，base64 从 4750KB 降到 165KB）；小图不动，缩图失败则原样返回（不让优化变成新的失败点）。
- **修复管理命令被挂起请求吞掉**：原先「挂起提问/审批」的判定在管理命令之前且条件含 isOwner，于是管理员在有挂起提问时发 `/status` 会被当成"回答"发给 DSH——命令不执行，回复却是"已回答"。现在管理员发**已知管理命令**时跳过挂起消费（判据用已知命令清单而非「以 / 开头」，以免抢走要转发给 DSH 的 `/model` 之类）。另：`/reset` 在无会话时补了反馈（原先静默，像是命令失效）。
- **控制台展示人格卡内容（渲染后的 Markdown）**：在「05 人格」卡片中间加了个带框滚动区（同活动日志那种框），把当前角色卡渲染成可读排版（标题/列表/粗体/行内代码/引用/代码块），不用再去翻 `roles/*.md`；数据来自新增的 `GET /api/role-content`。渲染器是手写的极简实现（前端只服务这一个用途，不引第三方库），**先转义再拼标签**防 XSS；角色名走 `sanitizeRoleName` + 严格相等校验，挡住路径穿越。
- **控制台：一代仿真模式卡片可收起**：标题右侧「收起/展开」按钮，状态存 localStorage（重开控制台仍保持），用于把这排很长的配置卡折起来。做法是通用 `.collapsible` + `.collapsible-body`，别的卡想收起加两个 class 即可。
- **控制台改浅色主题 + 整排卡片统一高度**：配色收敛到 CSS 变量（原来散落 7 处 `#343b49`、7 处 `#232833` 等硬编码色值，改主题必漏）；「会话映射/挂起审批/活动日志/人格」四张卡统一为 `--row-h`（520px）高度，内容多的在卡内滚动——之前是让卡片撑满本行，结果会话映射卡（8 个会话）把整排拉到很高、日志卡跟着变高，高度变成由溢出内容决定。另：会话映射改为「信息行 + 按钮行」布局（窄卡里表格会把按钮挤出可视区，按钮文字被压成「查看消」这种截断）。
- **控制台新增「会话消息回看」**：QQ 不会把机器人与**别人**的私聊显示给你（会话按账号隔离），现在可在控制台「02 会话映射」里点「查看消息」，回看任意会话最近 30/60/100 条（含机器人自己发的，以颜色区分）；面板也可看群聊，用于确认机器人到底说了什么。
- **修复「新加好友私聊不回」**：好友列表有 5 分钟缓存，刚加的好友不在缓存里会被当陌生人直接丢弃（表现为私聊不回人，且日志只有 `忽略未授权会话`）。现在私聊被拒时会强制刷新一次好友列表再定论，带 30 秒全局限流防被非好友刷爆。
- **功能声明校准与本地缓存**：修正“被叫必回、历史帖子任意查、原图直接发回”等过度承诺，按当前角色与功能开关生成 HTML/CSS 菜单，提供 `npm run build:menu` 预生成 PNG；完整 HTML 指纹失效、同内容并发合并、缓存可脱离浏览器复用，超高内容明确报错。
- **文档校准**：修正 X 按需查询、启动守护、私聊默认策略、管理员审批、角色热更新、二代发送时机及测试结果判读；取消过期的固定断言数徽章。
- **分享卡片解析**：群友发的 B 站/小红书/音乐/位置卡片不再只显示 `[卡片消息]`，解析出标题、真实链接、封面；封面可通过 `qq_get_message_images` 查看
- **按 URL 看图**：新增 `web_view_image` 工具，模型可直接看图片直链（含微信图片帖的配图）
- **微信文章抓取**：修复「环境异常」——真因是请求 UA 残缺被风控（换完整 UA 即可），另修复正文在 50KB 截断之后导致读不到的问题
- **自我总结抑制**：沉睡拦截不再把"已回过的 @"当理由（原先会逼模型说出"这些我都答过了"这类调度汇报）
- **私聊准入三态**：新增 `allow.privateMode`，`friends` 让好友自动放行，免去手动维护白名单（新加的好友无需重启即放行）
- **缓存命中率分析**：`docs/cache-hit-rate.md`（模型侧前缀缓存实测 97.4%）
- **测试基建**：新增 `npm test`（`scripts/run-all-tests.mjs`），按脚本名标记可能需要外部服务的失败；修掉 `test-console` 的四处假失败（创建人格不幂等、白名单恢复顺序错、真往虚构群发消息、Windows 上 `rmSync` 删不掉文件）与 `test-v2-wait` 的过期断言
- **识别上游 WAF 拦截**：网关出口 IP 被腾讯云 WAF 临时拦截时（`waf_ip_blocked`），归入"上游额度/限流"类统一处理；错误详情会剥掉整页 HTML 只留错误码与网关提示，避免管理员私聊被淹没
- **功能菜单图**：新增 `qq_send_feature_menu` 工具——群友问「你会啥」时发一张 HTML+CSS 排版的功能菜单 PNG（Chrome 无头截图、按内容指纹缓存、失败如实报"生成不了"而不编内容）
- **修复安全缺口**：功能菜单端点最初把 agent token 写成可选（`if (agentToken && ...)`），在控制台鉴权关闭时会跳过会话隔离检查。现已强制要求有效会话令牌（与 `send-image` 同规则）；控制台默认在令牌留空时自动生成令牌。
- **开发约定**：新增 `AGENTS.md`（加功能要同步维护 README、测试的两类断言、安全红线、改动生效对照表）

---
