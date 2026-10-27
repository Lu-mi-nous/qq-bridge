# 超分插件（upscale）

把过小的图片放大变清晰：优先走 **Real-ESRGAN**（调用本机装好的
[Upscayl](https://github.com/upscayl/upscayl) 的 `upscayl-bin.exe`），失败或没装时由核心
自动退回 ffmpeg lanczos——**插件缺席不影响桥接出图**。

## 目录

| 文件 | 作用 |
| --- | --- |
| `manifest.json` | 插件声明：id / 配置路径 `socialV2.upscale` / 权限 / 控制台卡片 |
| `index.js` | 生命周期：启动自检、缓存清理定时器、控制台卡片状态 |
| `lib/upscale.js` | 实现本体：探测、模型选择、缓存、调用 upscayl-bin、`shrinkForPublish` |
| `config.schema.js` | 配置字段清单（可读版） |

## 谁在用它

- 桥接出图管线：`src/image-downscale.js` 动态 import `lib/upscale.js`（失败静默回退 lanczos）；
- MCP 进程：`src/mcp-snowluma-safe.js` 直接 import `lib/upscale.js` 注册 `qq_upscale_image`；
  文件缺失/损坏时**不注册工具**，MCP 照常启动；
- 本插件：启动自检 + 缓存定时清理 + 控制台卡片。

所以整个 `plugins/upscale/` 删掉也不会让桥接或 MCP 起不来，只是丢掉超分能力。

## 配置（`config.json` → `socialV2.upscale`）

```jsonc
{
  "enabled": true,
  "model": "upscayl-standard-4x",
  "binDir": "",          // 空 = C:\Program Files\Upscayl\resources\bin
  "modelDir": "",        // 空 = C:\Program Files\Upscayl\resources\models
  "timeoutMs": 120000,
  "cache": { "enabled": true, "dir": "", "maxAgeDays": 3, "maxBytes": 524288000, "sweepEveryHours": 6 }
}
```

- 只处理**静态图**且只放大**小图**（长边 < 400）；动图先由上层抽帧。
- 连续失败会熔断 10 分钟，避免一张图把每条消息都拖到超时。
- 缓存目录默认 `state/upscale-cache`，控制台「缓存管理」可查看/清理。

## 禁用

控制台「工具开关」关掉 `qq_upscale_image`，或把 `socialV2.upscale.enabled` 设为 `false`。
两种做法都只影响超分，桥接其余功能不变。
