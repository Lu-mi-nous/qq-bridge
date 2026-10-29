# 复杂度基线（2026-10-29，v0.7.1）

> 评估对象：当前工作副本（`C:\qq-bridge`）；源码统计不含 `node_modules` 与根 `state/`，
> `state/` 的运行数据只作运行时快照单列。
> 采集命令：`npm run measure`（可加 `-- --json`）。本文件**取代 2026-10-28（v0.6.0）版本**，
> 作为后续开发、重构和发布对照的唯一边界值。历史对照见第 7 节。
>
> **2026-10-29 重估口径**：覆盖 R4.6（插件边界与 MCP 工具迁移）、T1–T5（回合收尾、工具面计量、
> Prompt 分层、Context 预算、Token 效率指标）与 R4.7（控制台用例层、路由组合根、DshEventPump 领域注入）
> 完成后的代码基线。静态数字来自 `measure --json`；测试通过数是一次测试运行快照；
> `state/` 是工作机运行时快照。三类数字不混用。
>
> **边界**：本文件是**代码与结构基线**，不是上线验收。生产桥接/DSH 已于 2026-10-29 23:01（Bridge 23:18 再次应用 T5 修复）重启，24h 灰度进行中。

---

## 1. 结论

**综合复杂度：中高（4.2 / 5）。**

这一版最大的变化不是行数，而是**依赖契约开始收口**：

- 0.4.0 的问题是「单文件失控」——`bridge.js` 8.8k 行 + `console-server.js` 7k 行，两座塔占源码 36%。
- 2026-10-28 的结论是「中高」，两座塔已拆掉，但控制台仍把 266 个平铺键塞给路由。
- 现在控制台入口是 **8 个领域对象**，19 个路由域全部改为每请求
  `ctx.readModels.*` / `ctx.commands.*`，单个路由最大解构 **3 项**（仅鉴权 helper）；
  `DshEventPump` 也从 70 个平铺依赖收为 **8 个领域接口**。
- 但 `bridge.js` 仍是 6,557 行、扇出 79；`facets.js` 成为新的 899 行/36 扇出装配点。
  **注入契约改善了，运行时状态、时序竞争和跨进程契约仍是主要难点**，不会因继续拆文件而消失。

一句话：**代码已经「拆得开」，依赖开始「收得住」，但运行态还没有「收得拢」。**

| 维度 | 0.4.0 | 2026-10-28 | 2026-10-29 | 判断依据 |
| --- | --- | --- | --- | --- |
| 代码规模 | 高 | 中高 | **中高** | 核心 38.7k，另有插件 14.9k、前端 9.4k；总量仍在涨 |
| 结构耦合 | 中高 | 中高 | **中** | 0 循环依赖；控制台 8 领域/路由最大 3 项；`bridge` 扇出 79、`facets` 36 |
| 运行时状态 | 高 | 高 | **高** | `main()` 5,384 行、5 个状态仓库、82 项 `state/`、397 MB |
| 时序/并发 | 高 | 高 | **高** | 每会话发送队列、回合 ID、唤醒合并、B 站 waiter、上下文轮换 |
| 外部集成 | 高 | 高 | **高** | 22 个外部域名、12+ 类服务、3 个 MCP 进程，缺契约测试 |
| 配置面 | 高 | 中 | **中** | 494 键已 schema 化、启动校验、模板自动生成 |
| 测试体系 | 中高 | 中 | **中** | 186 个脚本；14 个读 `bridge.js` 源码，52 个读任意 `src/` 源码 |
| 安全/授权 | — | 中 | **中** | 163 个控制台端点、58 条 Agent 白名单、默认拒绝；插件权限仅声明式 |
| 文档/认知 | 中高 | 中 | **中** | `AGENTS.md` 与验收报告较完整，但历史报告多、检索成本高 |

> 分数变化不代表代码变差了。**尺子**把状态所有权、跨进程契约和测试耦合计入复杂度；
> 按旧尺子（最大文件行数）这轮继续变好，按新尺子才能看到真正该修的地方。

---

## 2. 量化画像

| 指标 | 数值 | 备注 |
| --- | ---: | --- |
| 核心源码（`src/`） | 169 文件 / **38,687 行** | `measure` 口径，平均 229 行/文件 |
| 第一方插件（`plugins/`） | 75 文件 / **14,889 行** | 按约定不计入核心汇总 |
| 控制台前端 | 41 文件 / **9,419 行** | `console.html` 仅 126 行 |
| 测试脚本 | 186 个 / **26,707 LOC** | `measure` 只统计 `scripts/test-*.mjs`；全部 `scripts/` 243 个 / 31,466 LOC |
| 最近全量（2026-10-29 本机） | **176 / 186 通过、5,934 断言** | 测试运行快照；10 个环境类失败、**0 真实失败**；`test-bridge-wiring` 另跑 95 通过（含 1 条新增按日透传断言） |
| 文档 | 41 份 / **3,728 行** | 采集时刻，含本文件；修订本文件会使该数变化 |
| 合计可读代码 | **约 93k 行** | 核心 + 插件 + 前端 + 测试 + 文档 |
| `bridge.js` | **6,557 行** | 占核心 16.9%；`measure` 口径 6,556 |
| `main()` 函数体 | **5,384 行** | 从 `async function main()` 到配对 `}`；到文件末尾为 5,414 行 |
| `console-server.js` | 657 行 | 只留鉴权/CSRF/静态资源/404 |
| 控制台端点 | **163 条** | 主文件 + 19 个域模块 + 插件插槽 |
| Agent 允许路径 | **58 条** | 未列入即默认拒绝 |
| MCP 工具（server 注册） | **40 个** | snowluma 34 / host 3 / web-search 3；插件工具另在 `plugins/*/mcp-tools.js` |
| 可见工具面（`tools/list`） | **58 个 / 47,275 字符 / ≈14,774 tokens** | 当前默认 `full`；`core` 为 12 / 11,667 / ≈3,646（-75.3%），详见 T2 验收 |
| 工具开关 | **55 个** | `TOOL_FLAGS` 条目；其中 4 个 `fixed`（不可关闭）。`config.socialV2.tools` 有 56 键，多出的 `sendFeatureMenu` 是历史残留、无开关 |
| 配置键 | **494 个** | schema 校验 + 模板生成 |
| 运行依赖 | 6 个 npm 包 | 零框架、零构建 |
| 循环依赖 | **0** | `measure` 全图扫描 |
| 扇出最大 | `bridge.js` 79、`console/facets.js` 36、`console-server.js` 25 | 其余 ≤9；`dsh-events` 已从 63 降到 6 |
| 扇入最大 | `safe-fetch.js` 7、`state/store.js` 6 | 共享基础设施复用健康 |
| 运行中会话 | 31 个映射 / 19 个带 `sessionMeta` | `state/sessions.json` |
| `state/` 直属条目 | **82 项 / 397 MB** | 运行时快照；`du` 分配块口径约 402 MB。含日志、备份、测试残留与缓存 |
| 注释占比 | 14.7% | TODO/FIXME/HACK 为 0 |
| 控制流代理 | if 3,678 / try 521 / await 648 | 定时器 40 含一次性超时；周期性调用点 5 处（bridge 2、image-facade 1、task-service 1、MCP snowluma 1） |

> **指标类型**：本表的静态指标由 `npm run measure` 直接产出（`structure` 段）；「运行中会话」是工作机
> 运行时快照（`runtimeSnapshot`），发布包可能裁剪 `state/`，不可静态复现；「最近全量」是一次测试运行
> 结果（TEST RUN SNAPSHOT），换机器/服务状态不同不保证复得。不要把三类数字混作同一种「源码事实」。

### 文件规模分布

| 行数区间 | 文件数 |
| --- | ---: |
| ≤ 100 | 61 |
| 101–300 | 78 |
| 301–600 | 21 |
| 601–1,000 | 7 |
| > 1,000 | 2 |

139 / 169 个核心文件 ≤300 行（82%），长尾健康；头部只剩 `bridge.js` 与 `mcp-snowluma-safe.js`：

| 文件 | 行数 | 说明 |
| --- | ---: | --- |
| `src/bridge.js` | 6,557 | 编排入口与装配 |
| `src/mcp-snowluma-safe.js` | 1,150 | MCP 工具定义 |
| `src/console/facets.js` | 899 | ReadModel / Commands 装配 |
| `src/pipeline/dsh-events.js` | 815 | DSH 事件泵 |
| `src/context-memory.js` | 809 | 上下文记忆 |
| `src/config-defaults.js` | 675 | 配置默认值 |
| `src/console-server.js` | 657 | 控制台装配/鉴权 |
| `src/auto-at.js` | 637 | 自动 @ |
| `src/console/commands/stickers.js` | 617 | 表情命令层 |
| `src/console/commands/images.js` | 567 | 图片命令层 |

---

## 3. 九个维度

评分口径：1 低 / 2 中低 / 3 中 / 4 中高 / 5 高；权重见 3.10。

### 3.1 规模：4 / 5

- 核心 + 插件 + 前端 = **62,995 行**，测试另有 26.7k 行。总量比 0.4.0（43.8k）增长约 44%。
- 头部集中度继续下降：`bridge.js` 从占核心 43.1% 降到 **16.9%**；top2 从 36.1% 降到 **19.9%**。
- 插件化把实现移出了核心，却增加了**总代码量**（插件 14.9k）；这是有意的交换，
  不应再拿「核心行数下降」当作复杂度下降的唯一证据。

### 3.2 结构：4 / 5

健康面：

- 依赖图 **0 循环**；插件不 import `bridge.js`，只通过 `src/plugin-api/**` 使用核心能力。
- 19 个控制台路由模块、24 个 `pipeline/` 模块；零导出文件只允许入口/脚本。
- **控制台入口收口为 8 个领域对象**（`src/console/composition.js`）：config / sessions / messaging /
  social / media / context / plugins / operations；路由每请求读取 `ctx.readModels` / `ctx.commands`，
  最大解构 **3 项**（鉴权 helper）。
- **DshEventPump 收口为 8 个领域 / 70 键**（`src/pipeline/dsh-event-domains.js`），旧平铺调用仅保留
  归一化兼容；`dsh-events` 的静态扇出降到 6。

不健康面：

- `bridge.js` 扇出 **79**，`console/facets.js` 扇出 **36**：组合根本身变成了新的宽依赖点。
  这是「集中装配」的代价，不能再用继续摊平或继续加 wrapper 的方式解决。
- `bridge.js` 的 `main()` 仍有 **5,384 行**；incoming / wake / admin-commands / qq-send 等工厂
  仍是宽注入，但 R4.7 已证明可以按领域对象逐步收口。
- `flattenConsoleServices()` 兼容视图仍在；overview/plugin 已迁入读模型，session 读模型尚未单独抽出。

### 3.3 状态所有权：5 / 5

- `bridge.js` 仍直接持有 **5 个 JSON 状态仓库**（social / role / conversation-role / sessions / slang-session），
  其余仓库分散在服务与插件里；`state/store.js` 只提供机制，不是所有权中心。
- `main()` 内部仍是巨型闭包，所有模块最终都接进这个入口。
- 运行态规模：31 个 QQ 会话映射、19 个 `sessionMeta`；`state/` 82 项 / 397 MB（运行时快照）。
- 跨进程共享：桥接与 MCP 是两个进程，`bili-memory.json` 依赖 `reloadOnMtime` 防止互相覆盖；
  超分缓存也要求两个进程各自 `configureUpscaleCache()`。
- **跨文件一致性没有事务**：原子写只保证单文件不损坏，不保证 `sessions.json` 与 `social-v2.json` 同步。

### 3.4 时序/并发：5 / 5

- 周期性调用点 5 处（bridge 2 个裸 `setInterval` + 图库清理 + task-service + MCP snowluma），
  另有命名任务由 `taskService` 托管；`measure` 的「40 个定时器」把一次性超时也算进去了，
  评估时应区分——**真正难的不是数量，是时序语义**。
- 每会话发送队列、`sessionId#turn` 回合 ID、B 站初判 waiter、唤醒合并窗口、上下文超限轮换、
  发送工具成功追踪，都依赖事件顺序与回合边界。
- 历史高频故障（@ 错人、长等待卡死、繁忙时丢消息、引用错消息）全部属于这一层，
  单元测试最难覆盖，**拆分模块不会自动消除**。

### 3.5 外部集成：5 / 5

- 外部域名 **22 个**，覆盖 12+ 类服务：SnowLuma/OneBot、DSH、B 站、Pixiv、图站、
  SauceNAO、搜索引擎、GitHub、微信公众号、X/Twitter、天气/地图、TTS/ASR、Upscayl、Chrome、ffmpeg。
- 进程边界：1 个桥接主进程 + 3 个 MCP stdio 子进程 + 外部守护进程；控制台与 Agent 回调共用 HTTP 服务。
- 插件工具已通过 Runtime 注册迁入 `plugins/*/mcp-tools.js`，但**契约测试仍缺失**：
  上游字段/行为变化只能靠线上报错发现；环境类测试需真实服务。

### 3.6 配置：3 / 5

- 494 个键，`config-schema.js` 启动校验，类型错误拒绝启动，模板由默认值生成。
- 「默认值三处漂移」已消灭；剩余风险是**键的数量与命名空间**，不是正确性。
- 55 个工具开关（`TOOL_FLAGS`，4 个 fixed）+ 58 条 Agent 路径构成第二套权限配置，
  需与 MCP 注册/路由闸门同步。

### 3.7 测试：3 / 5

- 186 个测试 / 26,701 LOC（measure）；runner 能区分「环境不满足」与「真实失败」。
- 2026-10-29 全套：**176/186 通过、5,934 断言、10 个环境类失败、0 真实失败**；`test-bridge-wiring` 另跑 95 通过。
  环境类为 SnowLuma / DSH / 图站 / 视觉 / Pixiv 网络等未满足。
- **14 个脚本直接读 `bridge.js` 源码**（冻结值，不得新增）。
  其中大部分是接线/结构护栏，仍有 **2 个从源码截函数执行**
  （`test-at-poke-reply`、`test-tts`），属于脆弱耦合。
- 把口径放宽到「读取任意 `src/` 模块源码」：**52 个脚本**（R4.7 命令层测试新增读 `commands/*.js` 后
  从 51 调整并登记）；源码截取共 4 个（`new Function` 3 个 + `indexOf('function')` 1 个）。
- 没有覆盖率工具；测试以行为断言为主，但外部服务相关脚本只能按退出码分类。

### 3.8 安全/授权：3 / 5

- 163 个控制台端点中，**58 条**允许 Agent 调用，其余默认拒绝；新增端点必须显式加入白名单。
- 40 个 MCP server 工具；55 个开关控制暴露面；插件工具另有 manifest `mcpTools` 声明与 Runtime 重查。
- 凭据默认不下发明文，只支持单条 reveal；日志脱敏；SSRF 统一走 `safe-fetch.js`。
- **插件权限是声明式审计，不是沙箱**：插件仍在主进程内运行。这是已知边界，
  不能把「声明了 permissions」当成隔离保证。

### 3.9 文档/认知：3 / 5

- `AGENTS.md` 覆盖配置、状态、测试、提示词、安全红线，质量高；本基线已更新到 0.7.1。
- R4.6 / T1–T5 / R4.7 各有验收报告，但历史报告数量多，检索成本高。
- 旧计划里的 `bridge.js` ≤9,000 等目标已被本节 G1 取代；后续文档引用数字必须带采集日期。

### 3.10 加权

| 维度 | 分数 | 权重 | 加权 |
| --- | ---: | ---: | ---: |
| 规模 | 4 | 10% | 0.40 |
| 结构 | 4 | 20% | 0.80 |
| 状态所有权 | 5 | 20% | 1.00 |
| 时序/并发 | 5 | 15% | 0.75 |
| 外部集成 | 5 | 10% | 0.50 |
| 配置 | 3 | 5% | 0.15 |
| 测试 | 3 | 7.5% | 0.225 |
| 安全/授权 | 3 | 7.5% | 0.225 |
| 文档/认知 | 3 | 5% | 0.15 |
| **合计** |  |  | **4.20 / 5（中高）** |

---

## 4. 剩余难点（按风险排序）

1. **`bridge.js` 的 `main()` 闭包**：5,384 行函数体、扇出 79。行数不是唯一问题，
   问题是**运行态编排边界仍集中在入口闭包**；只在触碰相关区域时按簇抽离，不做独立重写。
2. **控制台兼容视图与 session 读模型**：`flattenConsoleServices()` 还在；19 个路由域已迁完，
   但 session 读模型未单独抽出，后续新增接口不得再回填平铺 deps。
3. **状态目录与保留策略**：82 项 / 397 MB；其中 `image-lib` 191 MB、`refactor-backups` 71 MB、
   `tts-cache` 52 MB、`x-monitor-media` 42 MB（X 监控已因内容安全 P0 关闭）、`upscale-cache` 19 MB。
   需要在缓存清单里明确「保留 / 可清 / 过期」，避免状态目录继续混入备份与测试残留。
4. **时序竞争**：回合 ID、发送队列、waiter、唤醒合并、上下文轮换。只能靠事件夹具与灰度观测，
   不能靠「再拆一个模块」解决。
5. **外部契约缺失**：22 个域名、12+ 类服务；建议先补 OneBot/DSH/B 站三类夹具级契约测试。
6. **测试源码耦合**：读 `bridge.js` 的脚本 14 个、读任意 `src/` 的 52 个，其中 4 个仍在执行源码截取；
   冻结不增，逐步改为 import 行为测试。

---

## 5. 新开发基线（可执行门槛）

以下门槛取代旧计划的「`bridge.js` ≤9,000 行 / 读源码测试 ≤10」。旧目标已经完成或失去意义，
继续按它优化会鼓励无收益的机械搬迁。

### G1 结构

- 循环依赖必须为 **0**。
- `bridge.js` **≤6,800 行**（当前 6,557，允许 +5% 波动）；不再追求继续下降。
- 新增核心模块 **≤600 行**；超过需在提交说明里给出理由（配置表、协议定义类除外）。
- 零导出文件只允许既有入口；新增模块必须可 import 测试。

### G2 注入契约

- `createConsoleServer` 入口 **≤8 个领域对象**；禁止把领域重新摊平成全局 Service Locator。
- 单个路由模块从 `deps` 解构 **≤3 项能力**（当前最大 3，均为鉴权 helper）；
  业务依赖一律走 `ctx.readModels.<domain>` / `ctx.commands.<domain>`。
- `DshEventPump` 保持 **≤8 个领域 / ≤70 键**；新增依赖先进入所属领域，不得恢复平铺。
- 单工厂注入 >30 项（`incoming`、`wake`、`admin-commands`、`qq-send` 等）时，
  新增依赖必须先进领域对象，不得继续平铺。

### G3 状态

- 所有 JSON 状态必须经 `createJsonStore()`；禁止直接读写已迁移文件。
- `bridge.js` 直接持有的 JSON 仓库 **≤5 个**（当前 5），bridge 内裸 `setInterval` **≤2 个**（当前 2）；
  新增周期任务一律用 `taskService.define()`。
- 新增持久字段必须同时更新：`defaults()`、读取归一化、保存→新建→加载往返测试。
- 跨进程状态必须启用 `reloadOnMtime` 或有明确的单写者约定。

### G4 测试

- 新模块必须配 `scripts/test-<模块名>.mjs`；新断言计入总量。
- 全套 `npm test` 必须 **0 真实失败**；环境类失败单独列出，不得混入通过率。
- 读 `bridge.js` 源码的脚本 **≤14 且不得新增**；只允许接线/结构护栏，
  **禁止再新增「截取函数执行」**（现有 2 个逐步迁为 import 行为测试）。
- 读任意 `src/` 模块源码的脚本 **≤52 且不得新增**；`new Function` / 函数截取 **≤4 并逐步减少**。
- 新增外部服务依赖必须登记到 `NEEDS_SERVICE`，并说明失败是环境还是代码。

### G5 安全/授权

- 新增 Agent 可调用端点必须加入 `AGENT_ALLOWED_PATHS` 并补 `test-console-server` 断言；默认拒绝。
- 新增 MCP 工具必须同步 `tool-flags.js`、路由闸门（如涉及端点）与白名单；漏一项测试必须失败。
- 凭据只在单条 `reveal` 时下发；日志/返回值不得含凭据；抓取必须复用 `safe-fetch.js`。
- 加好友/入群默认 fail-closed；报错只私聊管理员；不绕验证码/付费墙/登录墙。
- 插件权限继续按「声明式审计」表述，**不得宣称沙箱隔离**。

### G6 文档

- 每次剪版运行 `npm run measure -- --json`，更新本文件与 README 徽章；
  数字优先引用 `structure` / `runtimeSnapshot` 段，不再手工统计。
- 计划/评估文档引用行数时必须带采集日期；已被超越的目标要标注「已达成/已取代」。
- 功能变化同步 README「功能」+「更新日志」；版本号只经 `npm run version:set`。

### G7 发布

- 0 真实失败 + 控制台基础卡逐卡冒烟 + 行为变化 24h 小群灰度。
- 剪版流程按 `docs/VERSIONING.md`；未灰度完成不得把阶段完成写成「整体验收通过」。

---

## 6. 变更放大清单

| 任务 | 必须改的地方 | 处数 |
| --- | --- | ---: |
| 加 MCP 工具 | `mcp-snowluma-safe.js` 或插件 `mcp-tools.js` 注册 → `tool-flags.js` → 路由闸门 → `AGENT_ALLOWED_PATHS`（如涉及端点）→ 测试 | 4–5 |
| 加控制台端点 | `console/routes/NN-*.js` handler → 该模块 `routes` 清单 → `read-model` / `commands` → `facets.js` 装配 → Agent 白名单（如需）→ 前端卡片 → `test-console-server` | 4–6 |
| 加插件 | `plugins/<id>/manifest.json` → `index.js` → `lib/` → `src/<domain>-api.js` 网关 → 缺席降级测试 | 5 |
| 加持久字段 | `defaults()` → 读取归一化 → 往返测试 →（跨进程时）`reloadOnMtime` | 3–4 |
| 加周期任务 | `taskService.define/start` → 测试（自动获得控制台任务端点） | 1–2 |
| 改提示词 | `pipeline/wake.js` 或 `message-format.js` → 同步 `~/.dsh/.agent-presets/` → 重启 DSH | 2 |

---

## 7. 与旧基线对照

| 指标 | 0.4.0 | 2026-10-27 | 2026-10-28 | 2026-10-29 |
| --- | ---: | ---: | ---: | ---: |
| 核心文件 / 行数 | 97 / 43,815 | 110 / 35,854 | 110 / 35,782 | **169 / 38,687** |
| 插件（单列） | — | 61 / 13,492 | 66 / 13,843 | **75 / 14,889** |
| `bridge.js` | 8,821 | 6,462 | 6,500 | **6,557** |
| `console-server.js` | 7,013 | 632 | 632 | **657** |
| `console.html` | 8,545 | 126 | 126 | **126** |
| 控制台端点 | 151 | 159 | 161 | **163** |
| 控制台路由最大解构 | — | — | 62 | **3** |
| `DshEventPump` 注入 | — | — | 63 项平铺 | **8 领域 / 70 键** |
| 读 `bridge.js` 源码的测试 | 54 | 10（记录值） | 14 | **14** |
| 读任意 `src/` 源码的测试 | — | — | 51 | **52** |
| 配置键 | 447 | 491 | 492 | **494** |
| 循环依赖 | 0 | 0 | 0 | **0** |
| `state/` 直属条目 | — | 62 | 65 / 382 MB | **82 / 397 MB** |
| 注释占比 | 19.4% | 15% | 15% | **14.7%** |

> 2026-10-29 的核心行数与测试数增长，主要来自 R4.7 新增的 `console/read-model/*`、
> `console/commands/*` 与对应行为测试；路由文件本身变薄，但用例层把行数移到了新模块。
> MCP server 内 `server.tool` 计数从 65 降到 40，是 R4.6-5 把插件工具迁到
> `plugins/*/mcp-tools.js` 的结果，**不是能力删除**。

---

## 8. 复现命令

```bash
npm run measure                    # 人类可读
npm run measure -- --json          # 机器可读
npm test                           # 全套；末尾打印通过数/断言数

# 关键结构指标
wc -l src/bridge.js src/console-server.js public/console.html
grep -lc "readFileSync([^)]*bridge" scripts/test-*.mjs | wc -l
node scripts/test-arch-boundaries.mjs
grep -rn "setInterval" src --include="*.js" --include="*.mjs"
du -sh state/* | sort -rh | head
```

`measure --json` 的 `structure` 段直接产出依赖袋宽度、路由最大解构、`main()` 跨度、
JSON store 数、工具开关/`fixed` 数、Agent 白名单数与周期性定时器调用点；
`runtimeSnapshot` 段产出 `state/` 条目数与表观大小。**不要再用 `grep -c` 估算这些值**——
它会把注释和嵌套对象算进去（`fixed: true` 就曾因此多算 1 个）。

---

## 9. 基线使用规则

1. **每个发布/阶段结束**重跑 `npm run measure` 与全套测试，更新第 2、7 节。
2. 通过数与断言数**不得低于上一版基线**；环境类失败单独列，不计入通过率。
   若外部服务在测试早期退出、导致断言数变少，记录环境差异与真实失败数，不把环境跳过误判为回归。
3. 新模块必须有测试；新断言计入总量。
4. 静态指标变化超过 5% 时，在阶段记录里说明原因。
5. 任何「继续压缩 `bridge.js`」的提案，必须先证明它降低了 G2/G3 的某项指标；
   单纯减行数不再算收益。

---

## 10. 阶段进展索引（2026-10-28 ~ 2026-10-29）

| 阶段 | 结果 | 验收 |
| --- | --- | --- |
| R4.6-1 ~ R4.6-5e | 插件边界、公共 `plugin-api`、manifest 语义、MCP 工具 Runtime 注册迁移完成；插件→非公共核心导入 0 | `docs/refactor-r4.6-acceptance.md` 及各分批报告 |
| T1 | 回复后自动收尾，未读含未答 @ 或水位缺失时不清；减少额外模型调用 | `docs/refactor-t1-acceptance.md` |
| T2 | 工具面计量（zod → JSON Schema）与 `qq-tool-profile`（默认 full） | `docs/refactor-t2-acceptance.md` |
| T3 | 唤醒提示按角色摘要/完整卡分层，分项字数进 `contextMetrics` | `docs/refactor-t3-acceptance.md` |
| T4 | 消息工具小窗口、工具结果预算、主动上下文轮换 | `docs/refactor-t4-acceptance.md` |
| T5 | 按回合采集 Token 效率、按天分桶、`metrics:turn --compare` 与五维分组 | `docs/refactor-t5-acceptance.md` |
| R4.7-1 | `createConsoleServer` 266 平铺键 → 8 领域对象 | `docs/refactor-r4.7-acceptance.md` |
| R4.7-2/3 | 19 个路由域迁入 `read-model` / `commands` 用例层 | 同上，326 条读模型断言 |
| R4.7-4 | 路由组合根：全部路由不再解构平铺 `deps`，最大 3 项鉴权 helper | 同上，`test-console-router` 40 条 |
| R4.7-5 | `DshEventPump` 70 平铺依赖 → 8 领域接口，旧调用经 `normalizeDshEventDeps` 兼容 | `test-dsh-event-domains` 10 条、`test-bridge-wiring` 95 条 |

**当前状态**：R4.7 本地代码收口完成；生产 Bridge + DSH 已于 2026-10-29 23:01 重启，24h 灰度观测进行中；`14 Token 卡`已接 T5 小表格，
full/core profile Token 对照已实测（full 58 工具/14,774 tokens，core 12/3,646，-75.3%）。
剩余是 `metrics:turn --compare` 同规模日对照与真实群质量回归；完成前不宣称整体上线验收通过。
