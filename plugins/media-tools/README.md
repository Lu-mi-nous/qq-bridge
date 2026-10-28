# 媒体工具插件（media-tools）

三个按需“生成一张图”的能力，都依赖本机 Chrome/Edge 无头模式：

| 能力 | 入口 | 说明 |
| --- | --- | --- |
| GitHub 仓库截图 | `qq_github_shot` / 控制台 11 卡 | 仓库首页**整页**截图，按 `sliceHeight` 分段（整页 1.5 万 px 直接发会被 QQ 压成细线） |
| 功能菜单图 | `qq_send_feature_menu` / 控制台 11 卡 | 按当前配置筛选群友可用能力，渲染成 PNG |
| Token 报表图 | `qq_token_report` / 控制台 16 卡 | 按日/按模型生成用量报表图，缓存可清理 |

## 目录

| 文件 | 作用 |
| --- | --- |
| `manifest.json` | 插件声明：id / configPath `socialV2` / 权限 / 控制台卡片 |
| `index.js` | 暴露三组能力 + 启动日志（浏览器是否可用）+ 控制台卡片 |
| `lib/github-shot.js` | GitHub 截图：URL 解析、分段、代理、超时 |
| `lib/feature-menu*.js` | 功能菜单：数据、HTML/CSS、渲染与缓存 |
| `lib/token-report*.js` | Token 报表：数据、HTML、渲染与缓存 |
| `config.reference.js` | 相关配置字段（`githubShot.*`、`tools.*`） |

## 谁在用它

- `src/bridge.js` 经 `src/media-tools-api.js` 网关调用；
- MCP 工具走 HTTP 调桥接；
- 控制台 05 / 11 卡。

插件缺席：网关调用抛“媒体工具插件未加载”，控制台/工具端点返回错误；
桥接启动与其它功能不受影响。

## 配置

```jsonc
{
  "socialV2": {
    "githubShot": { "enabled": true, "sliceHeight": 2400, "maxHeight": 12000, "waitMs": 3500, "timeoutMs": 90000, "proxy": "" },
    "tools": { "sendFeatureMenu": true, "tokenReport": true }
  }
}
```

- GitHub 直连不通时配 `githubShot.proxy`（或继承 `images.proxy`）；
- 截图整页约 1.5 万 px，必须分段；合并成一张会失去可读性。
