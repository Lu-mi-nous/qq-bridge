# X（Twitter）帖子插件（x-posts）

群友点名要看某个 X 账号的帖子时，按需拉取 → 翻译 → 渲染成卡片 PNG → 发到当前会话；
帖子里有视频时再单独发一条视频。

> **内容安全 P0（当前状态）**：`socialV2.tools.fetchXPosts=false`。此时
> MCP 不注册 `qq_fetch_x_posts`，桥接在拉取前直接 403。插件化不改变这道闸门；
> 审核流程（`docs` 里的工作计划阶段 6）完成前不要打开。

## 目录

| 文件 | 作用 |
| --- | --- |
| `manifest.json` | 插件声明：id / 配置路径 `xMonitor` / 权限 / 控制台卡片 |
| `index.js` | 构造 `XMonitor` 并暴露给运行时；控制台卡片（配置 + 登录态） |
| `lib/index.mjs` | `XMonitor`：抓取编排、账号解析、置顶跳过、按日/按小时筛选 |
| `lib/fetch.mjs` | GraphQL 抓取、翻页、置顶识别、视频变体选择 |
| `lib/auth-fetch.mjs` | 登录态（`state/x-auth.json`）加载与校验 |
| `lib/render.mjs` | 卡片渲染（ffmpeg，无需浏览器） |
| `lib/translate.mjs` | 翻译（走网关模型） |
| `lib/media-cache.mjs` | 配图/视频缓存与定期清理（`state/x-monitor-media`） |
| `config.schema.js` | 配置字段清单（可读版） |

## 谁在用它

- 桥接控制台端点：`POST /api/socialV2/fetch-x-posts`、`POST /api/socialV2/x-auth-check`；
  插件缺席时两处都返回 503；
- MCP 工具 `qq_fetch_x_posts` 只是 HTTP 客户端（走桥接），不直接 import 本插件；
- 本插件：实例构造、启动日志、控制台卡片。

## 配置（`config.json` → `xMonitor`）

```jsonc
{
  "proxy": "",              // 留空继承 socialV2.images.proxy
  "translate": true,
  "gatewayUrl": "",
  "translateModel": "",
  "maxCount": 5,
  "scanLimit": 12,
  "includeMedia": true,
  "mediaDir": "state/x-monitor-media",
  "includeVideo": true,
  "maxVideoBytes": 104857600
}
```

登录态在 `state/x-auth.json`（`auth_token` / `ct0`），不要提交进仓库。

## 已知限制

- 登录态会因改密码/登出失效，先打 `/api/socialV2/x-auth-check` 定位。
- 只能翻到有限历史（按需翻页），更早的帖子会如实返回"翻不到"。
- 超过 100MB 的视频会被跳过并说明原因。
