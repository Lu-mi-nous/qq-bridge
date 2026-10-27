# 内容审查插件（content-review）

> **默认关闭。** 这是 X 转发内容安全审查（工作计划阶段 6）的落点：
> P0 全关 → P1 warn → P1 block → P2 图片/视频 → P3 fail-closed。
> 本插件目前提供 P1 需要的审核入口、本地规则与审计；把审核接进 x-posts 拉取流程
> 属于 P1 的接线步骤（在全部插件化完成后进行）。

## 目录

| 文件 | 作用 |
| --- | --- |
| `manifest.json` | 插件声明：id / configPath `xMonitor.review` / 权限 / 控制台卡片 |
| `index.js` | 生命周期 + 控制台卡片（开关/模式/审计摘要） |
| `lib/review.mjs` | `reviewText` 统一入口、本地规则、审计（JSONL）、统计 |
| `config.schema.js` | 配置字段清单（可读版） |

## 审核语义

- `reviewText(text, { cfg, modelReview })` 返回 `{ decision, action, categories, reason, hash }`；
- 本地规则：`keywordsByCategory`（按分类的关键词表）+ `blockedDomains`（危险域名）；
- 模型审核由调用方注入（只读、强制 JSON）；超时/格式错误按 `failClosed` 处理；
- `mode: 'warn'` 只写审计不拦；`mode: 'block'` 命中即拒发；
- 审计写到 `xMonitor.review.auditFile`（默认 `state/x-monitor/review-audit.jsonl`），
  **只存 hash / 分类 / 分数 / 动作 / 时间，不存原文**。

## 敏感词表为什么不进仓库

词表本身就是敏感内容。`keywordsByCategory` / `blockedDomains` 默认空，
由使用者在自己的 `config.json` 里维护；仓库只提供机制与示例结构，不提供词表。

## 配置（`config.json` → `xMonitor.review`）

```jsonc
{
  "enabled": false,
  "mode": "warn",
  "failClosed": true,
  "maxChars": 4000,
  "timeoutMs": 8000,
  "keywordsByCategory": {},
  "blockedDomains": [],
  "auditFile": "state/x-monitor/review-audit.jsonl",
  "auditMaxEntries": 2000
}
```

## 接入顺序（P1，尚未接线）

1. 在 `plugins/x-posts` 的拉取结果进入渲染前调用 `reviewText`（原文 + 译文 + 链接）；
2. 先以 `warn` 跑 1~2 天，看审计误报/漏报；
3. 稳定后切 `block`；P2 再加图片/视频审查；P3 补发送前 `decision === 'allow'` 硬闸门。
