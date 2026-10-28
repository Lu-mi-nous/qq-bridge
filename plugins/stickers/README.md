# 表情包插件（stickers）

表情库同步、按语气挑候选、自动催图、群友收藏、删除与备注。

## 目录

| 文件 | 作用 |
| --- | --- |
| `manifest.json` | 插件声明：id / 配置路径 `socialV2.sticker` / 权限 / 控制台卡片 |
| `index.js` | 暴露 lib/pick 能力 + 启动日志 + 控制台卡片 |
| `lib/sticker-lib.js` | 表情库索引、同步合并、备注、删除、收藏、缓存图写盘、提示词片段 |
| `lib/sticker-pick.js` | 按语气挑候选、催图文案、语气分类 |
| `config.reference.js` | 配置字段清单（可读版） |

## 谁在用它

- `src/sticker-service.js`（服务层，仍留核心）：同步/列表/备注/删除/收藏；
- `src/bridge.js`：挑选候选、提示词、缓存图、使用计数；
- MCP 工具（`qq_list_stickers` / `qq_send_sticker` / `qq_collect_sticker` 等）走 HTTP；
- 控制台 11 卡。

插件缺席：`src/stickers-api.js` 网关降级（读取给空值、`writeStickerCacheImage` 抛错），
桥接照常启动，表情功能等同关闭。

## 配置（`config.json` → `socialV2.sticker`）

```jsonc
{
  "enabled": true,
  "syncTtlMs": 60000,
  "maxListCount": 100,
  "includeInPrompt": true,
  "promptMaxStickers": 8,
  "autoNudge": true,
  "autoNudgeProbability": 0.33,
  "autoNudgeMinGapMs": 180000,
  "autoNudgeMaxPerHour": 6,
  "autoNudgeCandidates": 3,
  "collect": { "enabled": true, "maxPerMinute": 2, "maxPerHour": 10, "maxUploadBytes": 4194304 },
  "readLocalCache": true
}
```

- 表情库与图片库是两套存储：表情在 `state/stickers.json` + 缓存目录，图片在 `state/image-lib/`；
- 删除表情有独立的三道防线（服务层），插件化不改这些约束。
