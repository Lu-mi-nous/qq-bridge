# 黑话插件（slang）

从群聊里抽候选词、按阈值确认后注入唤醒提示，避免模型听不懂群里的新梗。

## 目录

| 文件 | 作用 |
| --- | --- |
| `manifest.json` | 插件声明：id / 配置路径 `slang` / 权限 / 控制台卡片 |
| `index.js` | 暴露 learner 能力 + 启动日志 + 控制台卡片 |
| `lib/slang-learner.js` | 库读写、候选条目、抽取/研究提示词、JSON 解析、注入片段 |
| `config.schema.js` | 配置字段清单（可读版） |

## 谁在用它

- `src/bridge.js`：抽词/研究流程、唤醒提示里的黑话片段、控制台 02 卡的库操作；
- MCP 工具 `qq_slang_query` / `qq_slang_submit` 走 HTTP；
- 控制台 02 卡（黑话库、批量确认/拒绝、清空、抽取/研究按钮）。

插件缺席：`src/slang-api.js` 网关降级（`loadSlang=[]`、写操作跳过、提示词为空串），
桥接照常启动，黑话学习与注入等同关闭。

## 配置（`config.json` → `slang`）

```jsonc
{
  "enabled": true,
  "extractMinMessages": 10,
  "extractCooldownMs": 300000,
  "inferenceThresholds": [2, 4, 8],
  "injectMax": 8,
  "learnerPreset": "qq-chat",
  "workspaceTitle": "QQ 黑话学习",
  "autoResearch": true
}
```

- 候选词按出现次数跨过阈值才升级（`inferenceThresholds`），避免一次口误就入库；
- 学习会话与工作区名绑定：**改工作区名会让已有学习会话失效**（桥接会重置并记日志）；
- 与 `mcp__web-search-safe__web_search` 联动做词条研究（`autoResearch`）。
