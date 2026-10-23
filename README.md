<p align="center">
  <img src="assets/icon.png" alt="qq-bridge" width="120">
</p>

<h1 align="center">QQ ↔ DeepSeek Harness 桥接</h1>

<p align="center">
  <b>让 DSH agent 住进 QQ 群</b> · 群友的消息变成提示词，回复、提问、工具审批回到 QQ<br>
  看图找图 · 自主发言 · 潜水唤醒 · B 站刷视频 · 联网检索 · 安全准入
</p>

<p align="center">
  <img alt="Node" src="https://img.shields.io/badge/Node-%E2%89%A522.13-339933?logo=node.js&logoColor=white&style=flat-square">
  <img alt="Platform" src="https://img.shields.io/badge/Platform-Windows-0078D4?logo=windows&logoColor=white&style=flat-square">
  <img alt="Tests" src="https://img.shields.io/badge/tests-106%20scripts-2ea44f?style=flat-square">
  <img alt="DSH" src="https://img.shields.io/badge/DSH-0.1.1--rc.2-6f42c1?style=flat-square">
  <img alt="License" src="https://img.shields.io/badge/License-MIT-blue?style=flat-square">
</p>

<p align="center">
  <a href="README.en.md">English</a> ·
  <a href="docs/FEATURES.md">功能详解</a> ·
  <a href="docs/CONFIGURATION.md">配置与运维</a> ·
  <a href="docs/MODEL_SETUP.md">模型接入</a> ·
  <a href="docs/CHANGELOG.md">更新日志</a>
</p>

---

## 这是什么

把 **QQ** 接进 **DeepSeek Harness (DSH)** 的桥接进程。核心链路很短：

```
QQ 消息 ──► SnowLuma（OneBot v11）──► 桥接进程 ──► DSH Web API (:3080)
                                          ▲              │
                                          └── 回复/提问/审批 ┘
```

在 `reserved2`（二代仿真）模式下，DSH 的 model 通过 MCP 工具**自主决定**看哪些消息、说什么、什么时候潜水——桥接负责给它真实的群聊状态（谁在叫你、未读几条、你刚说过什么），并守住安全边界。

---

## 功能一览

| 分类 | 能力 |
| --- | --- |
| **基础通信** | 群/私聊消息 ↔ DSH 会话（含入站语音转写）；提问转发、工具审批、`/reset` `/model` 等斜杠命令；群内 `/wl` 管白名单 |
| **上下文** | 引用解析（含被引用图片）、合并转发读取、`latest` 符号引用、情节记忆与长期记忆 |
| **图像** | 看图、超分放大、多源图库（safebooru / pixiv / yande.re）、画风打分、差评换图、反向搜图、指定图源 |
| **内容解析** | 微信公众号文章、QQ 分享卡片（B 站 / 小红书 / 音乐 / 位置） |
| **B 站** | 自主刷视频、观看记忆、口味归纳、主动推荐、字幕转文字 |
| **联网** | 可插拔搜索引擎（含免 key 天气）、带 SSRF 防护的 `web_fetch`、按 URL 看图 |
| **仿真调度** | 唤醒优先级、按优先级补发、潜水观察窗口、分条发送 |
| **互动** | 贴表情、表情包收藏、动图抽帧、黑话学习、长期记忆、点单掷骰、自动 @ |
| **其他** | GitHub 仓库截图、自拍形象图、功能声明图、X（推特）按需查询 |
| **安全** | 私聊准入三态、报错只私聊管理员、敏感信息脱敏、工具白名单 |

完整说明（含实现细节与边界条件）：**[docs/FEATURES.md](docs/FEATURES.md)**

---

## 快速开始

目标：从一台干净的 Windows 电脑开始，按顺序做完就能在群里收到回复。所有外部依赖的完整清单、版本要求与可选组件见 **[docs/DEPENDENCIES.md](docs/DEPENDENCIES.md)**。

> 默认端口：DSH `3080`、SnowLuma HTTP `3000`、OneBot WebSocket `3001`、控制台 `3100`。
> 全部用默认值时，配置里可以一字不改；改过端口就在第 3 步照实填写。

### 第 0 步 · 先看清需要什么

| 类型 | 组件 | 用途 | 是否必需 |
| --- | --- | --- | --- |
| 运行时 | **Node.js ≥ 22.13** + npm | 桥接、MCP、测试脚本 | ✅ 必需 |
| 工具 | **Git** | 拉取代码、更新 | ✅ 必需 |
| 服务 | **DeepSeek Harness Web（DSH）** | 模型与 agent 运行时，默认 `127.0.0.1:3080` | ✅ 必需 |
| 服务 | **SnowLuma** | QQ ↔ OneBot v11 网关，需开启 WebSocket + HTTP API | ✅ 必需 |
| 模型 | DSH 里配置好的 provider（DeepSeek 官方 API 或本地 OpenAI 兼容网关） | 真正生成回复 | ✅ 必需 |
| 媒体 | **ffmpeg / ffprobe** | 图片缩放、GIF/视频抽帧、语音转码、webp 转 png | ⭐ 强烈建议 |
| 浏览器 | **Chrome 或 Edge** | 功能菜单、Token 报表、GitHub 截图、X 渲染 | ⭐ 截图类功能需要 |
| 语音 | **Python 3.10+** + GPT-SoVITS | 发语音（TTS） | 可选 |
| 语音 | **Python 3.10+** + faster-whisper | 语音转文字、B 站字幕兜底 | 可选 |
| 图像 | **Upscayl**（`upscayl-bin.exe`） | 小图超分 | 可选 |
| 网络 | HTTP 代理 | pixiv / GitHub / 部分境外站点 | 可选 |

### 第 1 步 · 安装并启动外部服务

1. **安装 Node.js**：到 [nodejs.org](https://nodejs.org/) 装 LTS（必须 ≥ 22.13），装完在终端确认：

   ```bash
   node -v
   npm -v
   ```

2. **安装并启动 DSH Web**：按 DSH 官方说明安装，启动后确认端口可访问：

   ```bash
   curl http://127.0.0.1:3080
   ```

   返回任何 HTTP 响应都说明进程在跑；连接被拒绝则先解决 DSH。

3. **安装并启动 SnowLuma**：登录 QQ 后，在 SnowLuma WebUI 的 OneBot 配置里：
   - 开启 **WebSocket**（默认 `3001`）和 **HTTP API**（默认 `3000`）；
   - 两端 `accessToken` 设成同一个值（没有就留空）；
   - 记下实际端口，第 3 步要填。

4. **（建议）安装 ffmpeg**：Windows 可用 `winget install Gyan.FFmpeg`，或从 [ffmpeg.org](https://ffmpeg.org/download.html) 下载后把 `bin` 目录加进 `PATH`。装完确认：

   ```bash
   ffmpeg -version
   ffprobe -version
   ```

   > 没有 ffmpeg 也能启动，但看图/动图/视频/语音相关能力会退化或不可用。

5. **（可选）确认浏览器**：Windows 10/11 一般自带 Edge，无需额外安装；非标准路径可用环境变量 `CHROME_PATH` 指定。

### 第 2 步 · 获取代码并安装依赖

```bash
git clone https://github.com/Lu-mi-nous/qq-bridge.git
cd qq-bridge
npm install
```

`npm install` 会自动跑 `postinstall`，修补 `@snowluma/sdk` 的 ESM 打包问题——看到 `修补了 N 个文件` 就对了。

> **目录可以放在任意位置**：项目脚本按自身目录定位，不依赖固定的绝对路径。
> 但**移动目录后**要重跑一次 `node scripts/setup-dsh.mjs`，否则 DSH 里的 MCP/插件还指向旧路径。

### 第 3 步 · 生成配置

```bash
cp config.example.json config.json      # Windows CMD: copy config.example.json config.json
```

打开 `config.json`，**最少只需要改这四块**：

```jsonc
{
  // ① QQ 侧：照抄 SnowLuma 的端口与 accessToken
  "snowluma": { "wsUrl": "ws://127.0.0.1:3001", "httpUrl": "http://127.0.0.1:3000", "accessToken": "" },

  // ② 你自己：填你的 QQ 号，你才能用管理命令
  "ownerQQ": 123456789,

  // ③ 谁能用它：群的 QQ 号；私聊建议先只放自己
  "allow": { "groups": [123456789], "private": [123456789], "privateMode": "friends" },

  // ④ 控制台密码：留空会自动生成，写在启动日志里
  "consoleToken": ""
}
```

三个最常见的坑：

- ⚠️ `wsUrl` 是 WebSocket 端口，`httpUrl` 是 HTTP API 端口。**填成同一个会报 HTTP 426**。
- ⚠️ `ownerQQ` 是你自己的号，不是机器人的号。
- ⚠️ 群号不填的话，它在群里只会看着不说话——先把自己要用的群加进 `allow.groups`。

其余配置（图库、TTS、B 站、超分、上下文记忆等）都有安全默认值，可以跑通后再逐项开启。完整字段说明见 [docs/CONFIGURATION.md](docs/CONFIGURATION.md)。

### 第 4 步 · 安装 DSH 端（preset + MCP + 控制台插件）

```bash
node scripts/setup-dsh.mjs          # 默认安装到 DSH 的 web profile
# 如果 DSH 用别的 profile：node scripts/setup-dsh.mjs <profile名>
```

脚本会：安装 `qq-chat` / `qq-chat-v2` 两套 agent preset、在 profile 里挂载三路 MCP server、注册 `qq-mode-console` 控制台插件，并把默认模式设为 `reserved2`（二代仿真）。

装完**必须重启 DSH**，新的 preset 与 MCP 工具才会生效。验证方法见 [docs/DSH_SETUP.md](docs/DSH_SETUP.md#验证是否装好)。

### 第 5 步 · 启动并验证

```bash
npm start
```

启动日志出现这两行就成功了：

```
[bridge] SnowLuma 已连接：ws://127.0.0.1:3001
[bridge] 桥接已启动。按 Ctrl+C 退出。
```

然后：

1. 浏览器打开 `http://127.0.0.1:3100`，用启动日志里的控制台令牌登录；
2. 在群里 @ 它说一句话，确认能收到回复；
3. 想先单独验证 DSH 通不通：`npm run self-test`（建独立测试会话，不动现有会话）。

Windows 上也可以用 `start.bat` 启动，崩溃后会自动拉起；停止用：

```powershell
scripts/stop-all.ps1                    # 只停桥接，保留 QQ 登录
scripts/stop-all.ps1 -IncludeDsh        # 连 DSH / MCP 一起停
```

### 第 6 步 · 按需开启可选能力

| 想用的能力 | 还需要准备 | 怎么开 |
| --- | --- | --- |
| 看图 / 发图 / 图库 | 无（SauceNAO key、pixiv Cookie 可选） | `socialV2.images.enabled: true`，见 [docs/CONFIGURATION.md](docs/CONFIGURATION.md) |
| 语音合成（发语音） | Python 3.10+、GPT-SoVITS 与达妮娅权重 | `node scripts/setup-tts.mjs --check` → `node scripts/setup-tts.mjs`；再设 `socialV2.tts.enabled: true` |
| 语音转文字 / B 站字幕兜底 | Python 3.10+、faster-whisper 模型 | 配 `socialV2.bili.asr`，模型目录可用 `FASTER_WHISPER_MODEL` 指定 |
| 小图超分 | Upscayl（`resources/bin/upscayl-bin.exe`） | `socialV2.upscale.enabled: true`，`binDir` 指向 Upscayl 安装目录 |
| 功能菜单 / Token 报表 / GitHub 截图 | Chrome 或 Edge | 默认开启；非标准路径设 `CHROME_PATH` |
| 联网搜索 / 天气 | 无（天气走 Open-Meteo，免 key） | 默认开启；境外站点可配 `webSearch.proxy` |
| B 站自主刷 / 看视频 | ffmpeg；登录 Cookie 可选（字幕需要） | `socialV2.bili.enabled: true` |
| X（推特）按需查询 | 代理、登录凭据 | 见 [docs/CONFIGURATION.md](docs/CONFIGURATION.md) |
| GitHub 仓库截图 | 代理（本机直连 GitHub 可能 ECONNRESET） | `socialV2.githubShot.enabled: true`，配 `githubShot.proxy` |

### 第 7 步 · 升级与迁移到另一台机器

**升级代码**：

```bash
git pull
npm install
node scripts/setup-dsh.mjs      # 目录没变也建议跑一次，确保 MCP 路径最新
# 重启 DSH，再重启桥接
```

**迁移到另一台机器**时，除了代码，还要带走这些**本地数据**（都在 `.gitignore` 里，不会被提交）：

| 路径 | 内容 |
| --- | --- |
| `config.json` | 你的配置（含 QQ 号、端口、令牌） |
| `state/` | 会话映射、图库索引、记忆、黑话、缓存索引等运行状态 |
| `roles/*.md` | 人格卡（仓库自带示例，自己加的也要带走） |
| `assets/deepseek娘.png` | 自拍形象图（仓库已自带一张，可替换） |
| `~/.dsh/.agent-presets/` | DSH 端 preset（重跑 `setup-dsh.mjs` 会重建） |

新机器上按第 1~5 步重装依赖后，把上面这些覆盖进去即可。**不要**直接拷贝 `node_modules/`，平台/路径不同会出问题。

---

### 卡住了？

| 现象 | 多半是 |
| --- | --- |
| 启动就报 HTTP 426 | `wsUrl` 和 `httpUrl` 填成同一个端口了 |
| 群里 @ 它不理 | 群号没加进 `allow.groups`；或 DSH 没起来（`curl http://127.0.0.1:3080` 试一下） |
| 日志有 `图库 未启用` | 配置里缺 `images` 段，`qq_send_image` 等工具不会注册。补上后重启，见 [docs/CONFIGURATION.md](docs/CONFIGURATION.md#配置字段) |
| 发送报 HTTP 401 / unauthorized | `snowluma.accessToken` 与 SnowLuma 两端设置的 token 不一致 |
| 控制台打不开 / 401 | 用启动日志里的 `consoleToken`；端口被占用时看 `consolePort` |
| 想先确认 DSH 通不通 | `npm run self-test`（建独立测试会话，不动现有会话） |
| 图片/视频能力报 ffmpeg 缺失 | 装 ffmpeg 并把 `bin` 加进 `PATH`，重开终端 |
| 截图类功能报找不到浏览器 | 装 Chrome/Edge，或设 `CHROME_PATH` |
| 改了代码或换了目录 | 换目录后要重跑 `node scripts/setup-dsh.mjs`；改 MCP/preset 要重启 **DSH** |
| 想确认 OneBot 连接 | `node scripts/check-onebot-status.mjs` |

更多排查：[docs/DSH_SETUP.md](docs/DSH_SETUP.md) ｜ 完整配置项：[docs/CONFIGURATION.md](docs/CONFIGURATION.md) ｜ 依赖清单：[docs/DEPENDENCIES.md](docs/DEPENDENCIES.md)

---

## 文档索引

| 文档 | 内容 |
| --- | --- |
| [docs/FEATURES.md](docs/FEATURES.md) | 功能详解：每项能力的实现细节、边界、踩过的坑 |
| [docs/CONFIGURATION.md](docs/CONFIGURATION.md) | 配置项、运行模式、运维、测试、目录结构 |
| [docs/DEPENDENCIES.md](docs/DEPENDENCIES.md) | 依赖清单：必需/可选组件、端口、磁盘、环境变量、最小安装 |
| [docs/MODEL_SETUP.md](docs/MODEL_SETUP.md) | 模型接入：本地网关 / DeepSeek 官方 API |
| [docs/DSH_SETUP.md](docs/DSH_SETUP.md) | DSH 端安装细节与排错 |
| [docs/DESIGN.md](docs/DESIGN.md) | 设计原则、架构、MCP server 划分 |
| [docs/CHANGELOG.md](docs/CHANGELOG.md) | 更新日志 |
| [AGENTS.md](AGENTS.md) | 开发约定（改代码前先读） |
| [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) | 第三方组件许可、SnowLuma 使用边界、数据出机清单 |

---

## 来源与许可

本项目基于 **[Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge)** 修改而来，原项目以 MIT 许可发布。

原始版权声明见 [LICENSE](LICENSE)（MIT，**原样保留，请勿删除**）。
第三方组件归属、其各自许可、SnowLuma 的使用边界与数据出机清单见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

> **合规提醒**：SnowLuma 是独立第三方项目，与腾讯/QQ 无隶属关系，仅供学习与技术研究；
> 使用前请阅读其 EULA 与《QQ 用户协议》。
