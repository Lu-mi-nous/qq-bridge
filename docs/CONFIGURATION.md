# 配置与运维

> 快速上手见 [README 快速开始](../README.md#快速开始)；模型接入见 [MODEL_SETUP.md](MODEL_SETUP.md)；
> DSH 端安装见 [DSH_SETUP.md](DSH_SETUP.md)。

## 最小配置

```bash
cp config.example.json config.json      # Windows CMD: copy config.example.json config.json
```

至少填这几项：

```jsonc
{
  "snowluma": { "wsUrl": "ws://127.0.0.1:3001", "httpUrl": "http://127.0.0.1:3000", "accessToken": "" },
  "ownerQQ": 123456789,              // 管理员：唯一可执行管理命令/审批/closed-agent
  "allow": { "groups": [123456789], "private": [123456789], "privateMode": "friends" },
  "consoleToken": ""                 // 默认自动生成，完整值保存在 state/console-token
}
```

> ⚠️ `wsUrl` 是 WebSocket 端口，`httpUrl` 是 HTTP API 端口——填成同一个会报 HTTP 426。
> ⚠️ 把 agent 接入 QQ 等于把账号控制权交给模型，**建议先填白名单**。

---

## 配置字段

`config.example.json` 提供基础模板，部分可选功能使用代码默认值；桥接默认值见 `src/bridge.js` 的 `loadConfig()`，联网与 X 模块另有配置加载逻辑。常用字段：

| 字段 | 说明 |
| --- | --- |
| `dsh.baseUrl` / `provider` / `model` / `reasoningEffort` | DSH 地址与模型；模型选不上只打日志，不阻塞启动 |
| `snowluma.wsUrl` / `httpUrl` / `accessToken` | OneBot 连接信息 |
| `ownerQQ` | 管理员 QQ；留空时管理命令、审批和 `closed-agent` 无可用管理员，普通聊天仍按准入配置处理 |
| `agentPreset` | QQ 会话的 DSH preset，默认 `qq-chat` |
| `socialV2.agentPreset` | `reserved2` 用的 preset，默认 `qq-chat-v2` |
| `allow.*` / `deny.*` | 聊天模式的准入名单，`deny` 优先；群白名单与私聊策略分别判断 |
| `allow.privateMode` | `friends` / `all` / `list`（默认）；模板未写该字段时按 `list` 处理 |
| `socialV2.wake.*` | 唤醒/潜水/批窗口/防永眠参数；`preSleepReplyGraceMs`（默认 30000）= 本回合已发言后允许收尾的宽限 |
| `socialV2.wait.*` | 等待参数：`defaultMs`/`minMs`/`maxMs`、`defaultQuietMs`/`minQuietAfterNewMs`、`maxQuietMs`（单次静默上限，默认 15000）、`turnMaxCount`（单回合最多等待次数，默认 2）、`turnMaxMs`（单回合累计上限，默认 120000） |
| `socialV2.send.*` | 分条发送、频率上限、字长上限 |
| `socialV2.images.*` | 图库：开关、图源、上限、代理、冷却；`sources.pixiv.authFile`（默认 `state/pixiv-auth.json`，文件存在就带登录态，不存在则匿名——没有额外开关） |
| `socialV2.sticker.*` | 表情包：同步、收藏、备注 |
| `socialV2.tools.getFeatureMenu` | 功能声明图开关，默认 `true`；需本地 Chrome/Edge 生成首次缓存 |
| `socialV2.tools.tokenReport` | Token 用量图开关，默认 `true`；同样需本地 Chrome/Edge |
| `socialV2.tools.sendVoice` | 主动发语音工具 `qq_send_voice` 开关，默认 `true`；TTS 不可用时该工具不注册 |
| `socialV2.tools.crawl` | 按需爬网页 / 图片存表情工具 `qq_crawl_web` 开关，默认 `true` |
| `socialV2.comply` / `emojiReact` / `gifFrames` | 点单判定 / 贴表情 / 动图抽帧 |
| `socialV2.upscale` | 超分：`enabled`、`model`（默认 `upscayl-standard-4x`）、`binDir` / `modelDir`（Upscayl 安装路径）、`timeoutMs`；`enabled:false` 时小图回退 lanczos |
| `socialV2.upscale.cache` | 缓存：`enabled`、`dir`（默认 `state/upscale-cache`）、`maxAgeDays`（默认 3）、`maxBytes`（默认 500MB）、`sweepEveryHours`（默认 6）；超阈值按最旧优先删除 |
| `socialV2.bili` | B 站：`enabled`；`authFile`（默认 `state/bili-auth.json`，配了才有字幕）；`selfBrowsing.*`（`dailyBudgetSec` 默认 7200、`minIntervalMs`/`maxIntervalMs`、`scanSeconds`/`likedSeconds`、`framesPerSecond`=每秒取样帧数、`maxFramesTotal`=单次帧数上限、`tilesPerSheet`=每张拼图格数、`gameBoost`、`poolPages`、`search.*`、`seenCooldownMs`、`onlyWhenDiving`）；`asr.*`（`enabled`、`model`=本地目录或模型名、`cpuThreads` 默认 8、`timeoutMs`）；`share.*`（`minInterest`/`probability`/`minGapMs`/`askModel`）；`watchShared.*`；`memory.file`/`maxItems` |
| `socialV2.contextMemory.*` | 上下文记忆：`enabled`、`episodeEveryMessages`（默认 40）、`episodeIdleMs`、`episodeInputLimit`、`episodeKeep`、`compactionKeep`、`journalKeep`、`journalCompactBytes`、`longTermKeepPeople`/`longTermKeepFacts`/`longTermKeepThreads`、`memoryPackChars`、`gatewayUrl`/`model`/`apiKey`/`timeoutMs` |
| `socialV2.tts.*` | 语音合成：`enabled`（默认关）、`dir`（GPT-SoVITS 目录）、`probability`、`maxPerHour`、`maxChars`、`timeoutMs` |
| `socialV2.media.*` | 媒体：`maxMessageBytes`；`asr` 段在 `socialV2.bili.asr` 下配置 |
| `socialV2.githubShot.*` | GitHub 截图：`enabled`、`sliceHeight`、`maxHeight`、`waitMs`、`timeoutMs`、`proxy` |
| `socialV2.joinRequest.*` | 加好友/入群裁决：`enabled`、`autoApprove`（默认 `false`，fail-closed）、`ttlMs` |
| `imageReverseSearch.*` | SauceNAO 反向搜图（`apiKey`、`db`、`minsim`、`proxy`） |
| `webSearch.*` | 搜索引擎链与顺序（`engines` 数组，mtime 热加载） |
| `xMonitor.*` | X 按需查询：抓取条数、媒体、视频上限、代理、翻译；该名字沿用旧版，不表示定时监控 |
| `errorNotify.*` | 报错通知（`notifyOwner`、窗口） |
| `consolePort` / `consoleToken` / `consoleAuth` | 本地控制台；默认启用鉴权，空或不合法的令牌会回退自动生成；`consoleAuth: false` 显式关闭令牌检查，仍限定本机监听并检查写请求来源 |

> 真实 `config.json` 与 `state/` 不入公开仓库，仓库只提供脱敏模板。

---

---

## 运行模式

| 模式 | 用途 |
| --- | --- |
| `chat` | 允许的群 + 通过私聊准入策略的用户 → `qq-chat` preset，标准聊天 |
| `closed-agent` | 仅私聊 owner → `router-standard` 完整工具，在 QQ 上操控 DSH |
| `reserved` | 一代仿真：观望/活跃/试探/退场状态机，按空格分句，`[SILENT]` 表示潜水 |
| `reserved2` | **二代仿真（推荐）**：文本不自动转发，agent 用工具自主看消息、发言、等待、设置唤醒 |

模式在控制台切换，即时生效。

---

---

## 运行与运维

```bash
npm start          # 前台运行，不含崩溃自动重启
start.bat          # Windows 守护启动，退出后等待 5 秒重启（重复实例除外）
restart.bat        # 杀旧实例 → 清锁 → 重启（异常时用）
```

**要点**

- **只允许一个实例**（单实例锁；重复启动会被拒绝）
- 用 `start.bat` 启动，窗口别关——崩溃后 5 秒自动拉起
- **重启 DSH 不用动桥接**：桥接每 5 秒探活，DSH 重启期间消息入队缓存
- 手工修改桥接主配置通常需重启桥接；`roles/*.md` 与当前角色状态按 mtime 在后续提示词读取时更新
- 搜索引擎配置、X 查询配置按 mtime 热加载；MCP 的部分开关在进程启动时读取，修改 MCP 源码、挂载或 preset 后需重启 **DSH**（preset 模板改动先运行安装脚本同步）
- 修改 `src/feature-menu*.js` 后重启桥接加载新模块；可先执行 `npm run build:menu` 生成本地预览与缓存，HTML 预览文件本身不是菜单数据源

日志：

```
12:00:01 [bridge] SnowLuma 已连接：ws://127.0.0.1:3001
12:00:02 [bridge] 新会话 private:12345678 -> sess_xxxx
12:00:20 [bridge] agent 回复 (private:12345678) 42 字
```

---

---

## 测试

```bash
npm test                                # 跑全部（106 个脚本）
npm test -- share-card                  # 只跑名字含 "share-card" 的
node scripts/test-share-card.mjs        # 或直接跑单个
```

`npm test` 依次执行匹配脚本。部分测试会连接真实服务、修改测试状态或发送 QQ 消息，完整回归请使用测试账号与测试环境。菜单文案与安全契约可单独验证：

```
node scripts/test-feature-menu.mjs
node scripts/test-feature-menu.mjs --render  # 额外验证真实截图、并发合并和磁盘缓存，不发 QQ
```

测试汇总器按脚本名把部分失败归为「需外部服务」，并非对根因的诊断；这些失败也可能来自代码，应查看对应脚本的实际输出。目前这类失败不会让汇总器返回非零退出码，不能仅凭 `npm test` 退出码断言全套通过。顶部徽章是脚本数量，不是通过率或本次验证的断言总数。

**部分外部依赖示例**：

| 测试 | 依赖 |
| --- | --- |
| `test-vision*` / `test-local-*` / `test-model-route` | `local` provider 已注册、`state/vision-*.jpg` 等测试图片存在 |
| `test-mcp-*` / `test-onebot-connection` | SnowLuma / DSH 在运行 |
| `test-console` | 运行中的控制台及可用于测试的配置/状态 |

测试按模块组织，重点覆盖三类容易**静默**出错的场景：

| 类型 | 例子 |
| --- | --- |
| **安全断言** | 内网地址必须拒绝、令牌必须脱敏、发送目标必须命中白名单 |
| **"必须放行"断言** | 改脱敏正则时，正常句子不能被误判（误判 = 机器人静默不回复） |
| **真实数据夹具** | 微信文章页（gzip 2.46MB→0.57MB）、QQ 分享卡片（4 种真实形态）、X 帖子 |

---

---

## 目录结构

```
qq-bridge/
  AGENTS.md                # 开发约定：加功能要同步维护 README、测试怎么写、安全红线
  config.example.json      # 配置模板（脱敏）
  start.bat / restart.bat  # 守护启动 / 重启
  docs/
    PROJECT_GUIDE.md       # 项目说明书（架构、数据流、调试）
    DSH_SETUP.md           # DSH 端安装
    DEPENDENCIES.md        # 依赖清单（必需/可选组件、端口、环境变量）
    feature-comparison.md  # 功能对比（vs 原版）
    cache-hit-rate.md      # 缓存命中率实测分析
    topology.html          # 系统拓扑图（离线单文件，浏览器直接打开）
  dsh/agent-presets/       # qq-chat / qq-chat-v2 preset 模板
  plugins/qq-mode-console  # DSH 设置页 qq-mode 卡片
  roles/                   # 人格卡片（Markdown，热更新）
  public/console.html      # 本地控制台前端
  src/                     # 约 38.7k 行（.js/.mjs，排除备份）
    bridge.js              # 主程序（约 16.7k 行）
    dsh-client.js          # DSH API 客户端（WS 下行）
    mcp-snowluma-safe.js   # QQ 工具 MCP（58 工具）
    context-memory.js      # 情节记忆 / 全量消息日志 / 长期记忆
    cache-manager.js       # 磁盘缓存清单与清理
    token-usage.js         # Token 用量统计（zstd 多帧解析）
    web-crawler.js         # 按需爬网页 / 图片存表情
    mcp-host-server.js     # SnowLuma 进程控制 MCP
    mcp-web-search-safe.js # 联网 MCP（含微信文章解析、图片抓取）
    share-card.js          # QQ 分享卡片解析
    feature-menu.js        # 群友功能菜单（数据 + HTML 生成）
    feature-menu-css.js    # 菜单样式（HTML+CSS，力求精致美观）
    feature-menu-render.js # 菜单渲染（Chrome 无头截图 + 内容指纹缓存）
    weixin-article.js      # 微信公众号文章解析
    web-image-fetch.js     # 按 URL 取图（供模型看）
    image-*.js             # 图库 / 画风 / 反馈 / 搜图 / 存档
    x-monitor/             # X 帖子按需查询（抓取 / 渲染 / 翻译 / 缓存）
    web-search/            # 搜索引擎注册表（engines/ 即插件）
      query-plan.mjs       # 查询分词 / 实体词 / 天气意图 / 降级判定
      engines/weather.mjs  # Open-Meteo 天气引擎（免 key）
    proxy-tunnel.js        # CONNECT 代理隧道
    safe-fetch.js          # SSRF 安全抓取
    sensitive.js           # 脱敏正则
    meta-marker.js         # 剥离模型误写的元标记
  scripts/                 # 测试与运维脚本
  state/                   # 运行时数据（不入库）
  test-fixtures/           # 真实数据测试夹具
```

---

---

## 已知限制

- `chat` / `reserved` 的普通文本在回合结束后转发（不做流式逐字发送）；`reserved2` 在发送工具执行时发消息，无需等回合结束
- 当前桥接将图片与文字分条发送
- @ / 私聊虽有更高唤醒优先级，仍受繁忙状态、频率限制、暂停开关与模型决策影响，不保证每次即时回复
- 微信文章如果是图片帖，正文本身为空——内容在配图里，需 `web_view_image` 单独看图
- 真要求人工验证/付费墙的页面**不绕**：如实告知打不开
- `@snowluma/sdk` 的 npm 发布版有 ESM 扩展名 bug，靠 postinstall 补丁修复
- Windows 优先（ffmpeg 渲染、路径处理、启停脚本按 Windows 写的）

---
