# Plugin API

插件需要静态导入公共能力时使用此目录；优先使用宿主注入的 ctx。

目前公开 `media.js` 的 `imageSizeOf(buffer)`：读取 PNG/JPEG/GIF 文件头，未知或截断输入返回 null，无文件读写、网络或子进程副作用。原 image-downscale.js 同名导出作为核心兼容入口保留。

R4.6-3b 新增以下公共入口，原核心路径仅显式重导出同一实现：

| 入口 | 契约 | 使用边界 |
| --- | --- | --- |
| `storage.js` | `createJsonStore({file, version, defaults, migrate, log, array, reloadOnMtime})`，返回 read/write/update/flush/clearCache | 保留版本迁移、损坏备份、原子替换及旧数组兼容；不迁移现有状态文件。优先使用 ctx.state，只有需要既有文件路径的受信插件使用此底层入口。 |
| `network.js` | `proxyGet(url, options)` 返回 status/headers/body/url；`openTunnel(options)` 返回 socket；`isBlockedHost(host)` 检查已知内网字面量 | 复用原 HTTP CONNECT 与重定向检查；openTunnel 是不做目标审核的底层接口。proxyGet 不等同于 safeFetch 的 DNS 校验，不承诺代理端解析后的地址安全。 |

storage 的 update 仅保证同进程同步调用不交错，不提供跨进程事务；mtime 重载不是文件锁。调用方负责传入被授权的路径，公共函数本身不做宿主权限检查。

R4.6-3c 新增 `process.js` 的 `findFfmpeg()`、`findFfprobe()`、`resolveBin(binDir, name)`、`findUpscaylBin(options)` 和 `DEFAULT_BIN_DIR`。只定位文件，不启动进程或检查工具版本/执行权限。FFmpeg/FFprobe 依次检查 PATH 和原有常见目录，首次结果在进程内缓存；Upscayl 检查显式目录或默认安装目录。旧 gif-frames/upscale-bin 入口保留同一函数。

`media.js` 另公开 `looksLikeImageBuffer(buffer)`，识别 PNG/JPEG/GIF/WebP 的文件头，缺失、截断或未知格式返回 false。它不是完整解码校验，也不检查文件内容安全性；旧 safe-fetch 入口保留同一函数。

R4.6-3d 已补齐 logging、format、speech，并清除插件对非公共核心模块的直接导入。process 当前仅覆盖工具定位，未统一进程执行。这些入口不是 Node 沙箱，也不扩大插件已有权限；不要使用 export * 暴露未约定接口。

## 日志、格式化与语音契约（R4.6-3d）

- logging.js：SENSITIVE_RE 保持既有审计规则；createPluginLogger(id, sink) 为输出添加 [plugin:id] 前缀，宿主 ctx.log 复用此入口。优先使用 ctx.log，输出位置由宿主 sink 决定；函数不自动脱敏，不承诺日志中不会出现敏感信息。
- format.js：humanTokens(value) 提供既有 K/M/B 显示规则，不读取统计记录或磁盘。
- speech.js：仅公开 probeSovits/createTtsEngine/DEFAULT_SOVITS_DIR/DEFAULT_SPEECH_PARAMS/TTS_DEFAULT_PROBABILITY。它是核心语音引擎的稳定适配层，显式导出而非复制实现；保留核心实现以免改变 Python 服务脚本和缓存的根目录定位。导入不启动模型，调用者负责 shutdown 生命周期。
- TTS 的表情依赖通过 ctx.capabilities.get('stickers.instance') 逐次查询，缺席时使用 neutral，恢复后使用新实例。

本阶段只建立模块契约；manifest 事实源、权限约束和 MCP 工具注册仍按 R4.6-4/5 后续方案推进。
