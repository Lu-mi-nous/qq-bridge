# 依赖清单

> 这份文档回答一个问题：**把项目搬到另一台机器，需要先装什么？**
> 快速上手步骤见 [README 的「快速开始」](../README.md#快速开始)；配置字段见 [CONFIGURATION.md](CONFIGURATION.md)。

## 1. 必需依赖

| 依赖 | 版本 / 说明 | 用途 | 检查命令 |
| --- | --- | --- | --- |
| **Windows 10/11 x64** | 主要支持平台（启停脚本、路径与渲染按 Windows 编写） | 运行环境 | `winver` |
| **Node.js** | **≥ 22.13**（`package.json` 的 `engines`） | 桥接、MCP、测试脚本 | `node -v` |
| **npm** | 随 Node 安装 | 安装依赖 | `npm -v` |
| **Git** | 任意近期版本 | 拉取代码、更新 | `git --version` |
| **DeepSeek Harness Web（DSH）** | `0.1.1-rc.2` 系列（与 `@deepseek-ai/dsh-host-apiproxy` 对齐） | 模型与 agent 运行时，默认 `http://127.0.0.1:3080` | `curl http://127.0.0.1:3080` |
| **SnowLuma** | 需支持 OneBot v11 的 WebSocket + HTTP API；本仓库按 `@snowluma/sdk` 1.14.x 开发 | QQ 网关，默认 `ws://127.0.0.1:3001`、`http://127.0.0.1:3000` | `node scripts/check-onebot-status.mjs` |
| **一个可用模型** | DeepSeek 官方 API key，或本地 OpenAI 兼容网关 | 生成回复 | DSH 里新建会话试一句 |

> DSH 与 SnowLuma 都是**独立项目**，不在本仓库内。本仓库只负责在它们之间做桥接。

## 2. npm 依赖（`npm install` 自动安装）

| 包 | 版本 | 用途 |
| --- | --- | --- |
| `@deepseek-ai/dsh-host-apiproxy` | `0.1.1-rc.2` | 复用 DSH 的 API client 与 zod schema |
| `@deepseek-ai/schemastery` | `^3.18.1` | DSH 配置 schema |
| `@modelcontextprotocol/sdk` | `^1.30.0` | MCP server 实现 |
| `@snowluma/mcp` | `^1.14.10` | SnowLuma MCP 工具 |
| `@snowluma/sdk` | `^1.14.0` | OneBot v11 WebSocket 客户端 |
| `zod` | `^4.4.3` | 参数校验 |

`npm install` 的 `postinstall` 会自动修补 `@snowluma/sdk` 的 ESM 打包问题。看到 `修补了 N 个文件` 即成功。

## 3. 强烈建议安装（多数媒体能力依赖）

| 依赖 | 说明 | 影响的功能 | 检查命令 |
| --- | --- | --- | --- |
| **ffmpeg + ffprobe** | 建议 6.0+，需包含 `scale` / `signalstats` / `libx264` | 图片缩放、GIF 抽帧、B 站视频抽帧、语音转码、webp→png、大图重编码 | `ffmpeg -version` / `ffprobe -version` |
| **Chrome 或 Edge** | 系统自带 Edge 即可；非标准路径设 `CHROME_PATH` | 功能菜单图、Token 报表图、GitHub 仓库截图、X 帖子渲染 | 打开浏览器关于页 |
| **中文字体** | 微软雅黑 / 思源黑体等 | 截图类功能的中文排版（缺失会回退，可能影响观感） | — |

安装 ffmpeg（Windows）：

```powershell
winget install Gyan.FFmpeg
# 或下载压缩包，把其中的 bin 目录加入 PATH，重开终端
```

> 没有 ffmpeg 时桥接仍可启动，但上述媒体功能会返回明确的 `ok:false` / 降级结果，不会假装成功。

## 4. 可选依赖（按功能开启）

### 4.1 语音合成（TTS）—— 让机器人发语音

| 依赖 | 说明 |
| --- | --- |
| **Python 3.10+** | `scripts/sovits-server.py` 的运行环境 |
| **GPT-SoVITS** | 独立仓库，默认 `~/GPT-SoVITS`，可用 `GPT_SOVITS_DIR` 或 `socialV2.tts.dir` 指定 |
| **达妮娅音色权重** | ModelScope `villia/dania`（GPT 155MB + SoVITS 173MB，v2ProPlus） |
| Python 包 | `torch==2.6.0+cu124`、`torchaudio==2.6.0`、`transformers`、`librosa`、`resampy`、`opencc`、`pytorch-lightning`、`peft<0.18`、`x-transformers`、`fast-langdetect`、`soundfile`、`budoux` |

一键检查 / 安装：

```bash
node scripts/setup-tts.mjs --check    # 只检查缺什么，不改系统
node scripts/setup-tts.mjs            # 克隆 GPT-SoVITS、下载权重、装 Python 包
```

装好后在 `config.json` 设 `socialV2.tts.enabled: true`。没有装时 `qq_send_voice` 工具**根本不会注册**，不影响其它功能。

> 显存：实测 RTX 4070 Laptop 8G（fp16）可用；纯 CPU 也能跑，但合成会慢很多。

### 4.2 语音识别（ASR）—— 听语音 / B 站字幕兜底

| 依赖 | 说明 |
| --- | --- |
| **Python 3.10+** + `faster-whisper` | `scripts/asr-server.py` 的运行环境 |
| **faster-whisper 模型** | 推荐 `large-v3`（约 3.1GB）；可用 `FASTER_WHISPER_MODEL` 指定本地目录，否则按模型名联网下载 |

```bash
python -m pip install faster-whisper
# 指定本地模型目录（可选）
set FASTER_WHISPER_MODEL=C:\models\faster-whisper-large-v3
```

用途：群友发语音时的转写、B 站视频没有字幕时的音轨转写。

### 4.3 超分放大 —— 小图变清晰

| 依赖 | 说明 |
| --- | --- |
| **Upscayl**（[官方下载](https://upscayl.pro/cn/download.html)） | 使用其中的 `resources/bin/upscayl-bin.exe`；`Upscayl.exe` 是 GUI 外壳，不能用于后台调用 |
| 模型文件 | 默认 `upscayl-standard-4x`，随 Upscayl 安装 |

配置 `socialV2.upscale.enabled: true`，并把 `binDir` / `modelDir` 指向 Upscayl 安装目录。未安装时该工具不注册，图片仍会用 ffmpeg lanczos 放大。

### 4.4 网络与第三方服务（按需）

| 服务 | 用途 | 配置 |
| --- | --- | --- |
| **HTTP 代理** | pixiv、GitHub、部分境外站点 | `images.proxy` / `githubShot.proxy` / `webSearch.proxy`，或环境变量 `HTTPS_PROXY` |
| **SauceNAO API key** | 以图搜图（每天 100 次免费额度） | `imageReverseSearch.apiKey`，控制台「20 凭据」也可填 |
| **pixiv 登录 Cookie** | pixiv 图源 | 控制台「20 凭据」或 `state/pixiv-auth.json` |
| **B 站 Cookie** | 个性化推荐、AI 字幕 | 控制台「20 凭据」或 `state/bili-auth.json` |
| **X（推特）凭据** | 按需查询帖子 | 控制台「20 凭据」 |
| **Open-Meteo** | 天气查询 | 免 key，直接可用（需要外网） |

### 4.5 本地模型网关（可选）

如果不用 DeepSeek 官方 API，而是本地 OpenAI 兼容网关（例如 `http://127.0.0.1:7863/v1`）：

- 网关需要支持 `chat/completions`，看图则模型条目要声明 `image` 输入；
- 在 `~/.dsh/settings.yaml` 配置 provider，桥接 `config.json` 的 `dsh.provider` / `dsh.model` 指向它；
- 详见 [MODEL_SETUP.md](MODEL_SETUP.md)。

## 5. 端口与网络

| 端口 | 服务 | 方向 |
| --- | --- | --- |
| `3080` | DSH Web API | 桥接 → DSH（本机） |
| `3000` | SnowLuma HTTP API | 桥接 → SnowLuma（本机） |
| `3001` | SnowLuma OneBot WebSocket | 桥接 ↔ SnowLuma（本机） |
| `3100` | 桥接控制台 | 浏览器 → 桥接（本机） |
| `5099` | SnowLuma WebUI（默认） | 浏览器 → SnowLuma（本机） |

以上都是**本机回环**地址，不需要对公网开放。若把 DSH / SnowLuma 装到另一台机器，请自行评估网络暴露面并加认证。

## 6. 磁盘与内存

| 项目 | 大致占用 |
| --- | --- |
| `node_modules/` | 100~200MB |
| faster-whisper large-v3 | ~3.1GB |
| GPT-SoVITS + 达妮娅权重 | ~2~4GB（含 Python 依赖） |
| Upscayl 模型 | ~100MB |
| `state/`（图库、缓存、会话） | 随使用增长；控制台「19 磁盘缓存」可清理 |

最低建议：4GB 可用内存、10GB 空闲磁盘；跑本地 TTS/ASR 建议 16GB 内存 + 支持 CUDA 的显卡（非必需）。

## 7. 环境变量速查

| 变量 | 作用 |
| --- | --- |
| `CHROME_PATH` | 指定 Chrome/Edge 可执行文件 |
| `GPT_SOVITS_DIR` | GPT-SoVITS 根目录（TTS） |
| `FASTER_WHISPER_MODEL` | faster-whisper 模型目录或名称（ASR） |
| `HTTPS_PROXY` / `HTTP_PROXY` | 下载依赖、访问境外站点时的代理 |
| `DSH_HOME` | DSH 配置根目录（默认 `~/.dsh`） |
| `SNOWLUMA_DIR` | SnowLuma 安装目录（启停脚本用） |

## 8. 最小安装 vs 完整安装

| 能力 | 最小安装 | 完整安装 |
| --- | --- | --- |
| 群聊文字收发 | ✅ Node + DSH + SnowLuma | ✅ |
| 看图 / 发图 / 分享卡片 | ✅（无 ffmpeg 时部分图片处理降级） | ✅ + ffmpeg |
| 功能菜单 / Token 报表 / GitHub 截图 | ❌ 需要 Chrome/Edge | ✅ |
| B 站看视频 / 动图抽帧 | ❌ 需要 ffmpeg | ✅ |
| 发语音 | ❌ 需要 Python + GPT-SoVITS | ✅ |
| 语音转文字 | ❌ 需要 Python + faster-whisper | ✅ |
| 小图超分 | ❌ 需要 Upscayl | ✅ |

## 9. 装完自检

```bash
node -v                 # ≥ 22.13
npm install             # 无报错，postinstall 显示修补文件数
node scripts/check-onebot-status.mjs
node scripts/setup-dsh.mjs
npm run self-test       # DSH 链路自检
npm test                # 全量回归（部分用例需要外部服务，见输出说明）
```

如果某项失败，先看 [README 的「卡住了？」](../README.md#卡住了) 与 [DSH_SETUP.md](DSH_SETUP.md#常见问题)。
