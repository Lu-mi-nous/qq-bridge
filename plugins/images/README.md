# 图片插件（images）

按标签/画师找图、图库补货与画风分、反查出处、收藏原图、差评换图、指定图源。

## 目录

| 文件 | 作用 |
| --- | --- |
| `manifest.json` | 插件声明：id / 配置路径 `socialV2.images` / 权限 / 控制台卡片 |
| `index.js` | 暴露 lib 能力 + 启动日志 + 控制台卡片（启用图源、反查、Pixiv 凭据） |
| `lib/image-sources.js` | 图源：safebooru / pixiv / yande.re 的搜索、标签解析、来源页 |
| `lib/image-reverse-search.mjs` | SauceNAO 反查（额度、缓存、站点名清洗） |
| `lib/image-archive.js` | 原图归档（回源取原图，非库内压缩版） |
| `lib/image-feedback.js` | 差评识别与冷却门 |
| `lib/image-source-hint.js` | “从 pixiv 找”这类图源提示解析 |
| `lib/image-style.js` | 画风向量提取与余弦相似度 |
| `lib/pixiv-auth.js` | Pixiv 凭据加载与请求头注入 |
| `lib/image-quality.js` | 画质门槛与群像判定 |
| `lib/image-store.js` | 图库索引/存储（R4.5-5b 迁入） |
| `config.reference.js` | 配置字段清单（可读版） |

## 谁在用它

- 核心网关 `src/images-api.js`（顶层 `await` 动态装载 + 降级默认值）：
  - `src/image-store.js`（图库索引，仍留核心）用 `isGroupLike`；
  - `src/image-facade.js`（图库门面，仍留核心）用图源/画风；
  - `src/image-request.js`（发图请求，仍留核心）用差评/来源提示/归档；
  - `src/pipeline/image-send.js` 用 `resolveTagName` / `sourcePageOf`；
  - `src/bridge.js` 用反查、反馈分类、来源提示、Pixiv 凭据。
- 插件缺席：网关降级（同步返回空值、异步抛“图片插件未加载”），桥接照常启动，
  图片能力等同关闭、图库仍可读已有文件。

## 暂留核心的部分

`image-facade.js`（图库门面）与 `image-request.js`（发图请求）仍在核心，它们是编排层；
存储 `image-store` 已随 5b 迁入本插件，核心经网关调用（缺席时给空 store）。

## 配置（`config.json` → `socialV2.images`）

```jsonc
{
  "enabled": true,
  "sources": { "safebooru": { "enabled": true }, "pixiv": { "enabled": true }, "yandere": { "enabled": true } },
  "maxFiles": 300,
  "maxTotalBytes": 268435456,
  "recentSendBlockMs": 600000,
  "sendCooldownMs": 30000,
  "maxSendPerMinute": 10,
  "maxSendPerHour": 60,
  "reverseSearchApiKey": "",
  "proxy": ""
}
```

- 图源开关决定“本地库 + 现拉”的范围；限定图源时**不会**退回其它站；
- 反查只在真拿到结果时扣额度；Pixiv 只需 `Referer` 即可匿名访问，登录态是增强。
