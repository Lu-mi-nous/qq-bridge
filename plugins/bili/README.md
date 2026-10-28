# B 站插件（bili）

搜视频、看画面与字幕/ASR、潜水时自己刷视频、跨群共享的观看记忆。

## 目录

| 文件 | 作用 |
| --- | --- |
| `manifest.json` | 插件声明：id / 配置路径 `socialV2.bili` / 权限 / 控制台卡片 |
| `index.js` | 暴露 lib 能力 + 启动日志 + 控制台卡片（配置状态、记忆文件） |
| `lib/bili.js` | B 站 API：取视频信息、字幕、热门/排行、取流、抽帧、观看记忆 |
| `lib/bili-auth.js` | 登录态加载、搜索（`-412` 的根因是没带 Cookie） |
| `lib/bili-browse.js` | 自主刷候选打分、观看深度、提示词、扫尾判定 |
| `config.reference.js` | 配置字段清单（可读版） |

## 谁在用它

- 核心网关 `src/bili-api.js`：动态装载本插件并转发。插件缺失时降级——
  同步函数返回安全空值、异步函数抛明确错误，桥接照常启动；
- `src/bili-bootstrap.js`（启动装配，仍在核心）：读凭据、建观看记忆、装 ASR、注册自主刷调度；
  插件缺失时只记一行日志并跳过；
- `src/pipeline/bili-runtime.js` / `bili-sharing.js`（编排，仍在核心）：自主刷流程、落脚群选择；
- MCP 工具 `qq_bili_search` / `qq_watch_bili` / `qq_bili_memory` / `qq_bili_record` 走 HTTP 调桥接；
- 控制台 14 卡。

## 配置（`config.json` → `socialV2.bili`）

```jsonc
{
  "enabled": true,
  "authFile": "state/bili-auth.json",
  "memory": { "file": "state/bili-memory.json", "maxItems": 2000 },
  "asr": { "enabled": true, "model": "", "cpuThreads": 4, "timeoutMs": 120000 },
  "selfBrowsing": {
    "enabled": true,
    "dailyBudgetSec": 7200,
    "minIntervalMs": 300000,
    "maxIntervalMs": 600000,
    "maxSecondsPerVideo": 240,
    "framesPerSecond": 1,
    "maxFramesTotal": 120,
    "onlyWhenDiving": true
  }
}
```

- 字幕接口必须登录才返回内容（不登录时 `code=0` 但 `subtitles` 为空，容易误判“没字幕”）；
- 没有字幕才走 ASR（本地 whisper，约 8 秒首次加载）；
- 观看记忆是**全局一份**，跨群共享；“喜欢/不喜欢”用帧数表达，不是真的等时长。

## 禁用

`socialV2.bili.enabled=false`（控制台 14 卡或配置文件）；或整个删掉 `plugins/bili/`，
此时网关降级、桥接启动不受影响。
