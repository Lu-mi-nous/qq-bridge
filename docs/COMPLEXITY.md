# 复杂度基线（2026-10-27，R4 后）

> 评估对象：R4 + R4.5-1 后的工作副本（不含 `node_modules` / 根 `state/` / 模型文件）。
> 统计口径：`src/` 计入规模表；`plugins/`（第一方插件代码）单独一行，不计入 `src/` 汇总，也不改变历史对比口径。
> **本文件是新的复杂度基线**，替代 0.4.0 发布树的评估（已归档：
> [archive/COMPLEXITY-0.4.0.md](archive/COMPLEXITY-0.4.0.md)）。后续重构（R4.5 / R5）
> 以本文件数值为对照；指标用 `npm run measure` 采集，口径说明见第 6 节。

---

## 1. 结论

**综合复杂度：中（0.4.0 为「中高偏上」，降一档）。**

| 维度 | 0.4.0 | R4 后 | 判断依据的变化 |
| --- | --- | --- | --- |
| 代码规模 | 高 | **中高** | 总量 43.8k → 35.1k（-20%），另有插件 13.3k 单列；两者合计 48.3k（+10%），但头部从"两座巨塔占 36.1%"降到"一座 6.5k 占 18.4%" |
| 结构耦合 | 中高 | **中** | console 路由已分域（19 文件）；fan-out > 5 的模块只剩 2 个；依赖袋在消费侧收窄 |
| 运行时状态 | 高 | **高** | 定时器 77 → 48（task-service 托管），但多会话 × 时序竞争的本质没变 |
| 外部集成 | 高 | **高** | X 监控 P0 关闭后活跃外部面 12 类；11 个测试仍需真实服务 |
| 配置面 | 高 | **中** | R1 schema 化：启动校验、模板由 schema 生成，「模板缺段」类问题已消灭 |

一句话：**规模与结构风险已经压下来，剩下的难度集中在 bridge.js 的编排、
插件/DSH 的运行时时序竞争——C6 之后前端单体已拆掉，不再是主要瓶颈。**

---

## 2. 量化画像

| 指标 | 数值 |
| --- | ---: |
| 源码文件 / 行数（`src/`） | 110 / 35,854（`.js` + `.mjs`） |
| 插件代码（`plugins/`，单独计） | 61 / 13,492 |
| 测试脚本 / 行数 | 152 / 25,742 |
| 最近全量 | 138/149 通过、4,917 断言、11 个环境类失败、0 真实失败 |
| 控制台前端 | 9,274 行（C0~C6；`console.html` 126 + `public/console/**`） |
| 文档 | 2,422 行 / 13 份 |
| 配置键 / 工具开关 | 491 / 56 |
| MCP 工具 | 65（snowluma 59 / host 3 / web-search 3） |
| 控制台端点 | 159（主文件 2 + 概览 8 + 18 个域模块 149） |
| `state/` 直属条目 | 62（32 json / 6 log / 15 目录；含缓存、备份与测试残留） |
| 运行依赖 | 6 个 npm 包 |
| 循环依赖 | 0 |
| TODO / FIXME / HACK | 0 |
| 注释占比（源码） | 15% |

### 文件规模分布

| 行数区间 | 文件数 |
| --- | ---: |
| ≤ 100 | 23 |
| 101–300 | 53 |
| 301–600 | 23 |
| 601–1,000 | 9 |
| > 1,000 | 2 |

长尾继续健康（76 个文件 ≤300 行）。头部现状：

| 文件 | 行数 | 说明 |
| --- | ---: | --- |
| `src/bridge.js` | 6,469 | 编排入口 |
| `src/mcp-snowluma-safe.js` | 2,135 | MCP 工具 |
| `src/context-memory.js` | 806 | 上下文记忆 |
| `src/console/routes/10-images.js` | 804 | 图片域路由 |
| `src/console/routes/11-stickers.js` | 784 | 表情域路由 |
| `src/console/routes/14-bili.js` | 707 | B 站域路由 |
| `src/pipeline/dsh-events.js` | 697 | DSH 事件 |
| `src/config-defaults.js` | 672 | 配置默认值 |
| `src/auto-at.js` | 637 | 自动 @ |
| `src/console-server.js` | 632 | 控制台装配/鉴权 |

> 分支复杂度代理口径见归档文档 `docs/archive/COMPLEXITY-0.4.0.md`；本表按当前行数重排，不再混用旧口径。

**源码内两个最大文件合计 8,604 行，占 24.0%**（0.4.0 是 36.1%）；`bridge.js` 单独占 18.0%。C6 后 `public/console.html` 已降到 126 行，不再进入头部表。

---

## 3. 五维分析

### 3.1 规模：从"双头"变"单头"

> 控制台前端已拆为 Shell + 外置资产（C0，2026-10-27）：`console.html` 1,426 行，其余在 `public/console/`。
> C1（同日）加入卡片注册表与声明式渲染器：`console.html` 降到 1,403 行，新增 `public/console/core/{registry,renderer,api}.js`；24 张核心卡中 3 张已迁声明式。
> C2 第一批（同日）再迁 21 测试发送 / 23 后台引导，`console.html` 1,377 行，声明式核心卡累计 5 张。
> C2 第二批（同日）再迁 13 控制台访问令牌，`console.html` 1,369 行，声明式核心卡累计 6 张。
> C2 第三批（同日）再迁 22 桥接控制，`console.html` 1,361 行，声明式核心卡累计 7 张。
> C2 第四批（同日）迁 19 磁盘缓存为模块卡（`public/console/cards/19-cache.js`），`console.html` 1,350 行，已迁核心卡累计 8 张（7 声明式 + 1 模块）。
> C2 第五批（同日）迁 15 取图额度为模块卡（`public/console/cards/15-image-quota.js`），`console.html` 1,342 行，已迁核心卡累计 9 张（7 声明式 + 2 模块）。
> C2 第六批（同日）迁 03 挂起审批为模块卡（`public/console/cards/03-pending.js`），`console.html` 1,342 行，已迁核心卡累计 10 张（7 声明式 + 3 模块）。
> C2 第七批（同日）迁 01 运行模式为模块卡（`public/console/cards/01-runtime.js`），`console.html` 1,332 行，已迁核心卡累计 11 张（7 声明式 + 4 模块）。
> C2 第八~十批（同日）迁 04 活动日志（`04-activity.js`）、02 会话映射（`02-sessions.js`，02b 仍 legacy）、06 一代仿真（`06-reserved.js`），`console.html` 1,227 行，已迁核心卡累计 14 张（7 声明式 + 7 模块）。
> C2 收尾（同日）：24 张核心卡全部进入 registry/manifest 并有统一挂载点；其中 10 张复杂卡（05/07/08/09/10/16/17/18/20/24）先用 `legacy-adopt.js` 过渡模块接管 DOM，内部逻辑待 C4/C5 拆解。`console.html` 1,237 行。
> C5（同日）：旧卡片标记移入 `public/console/legacy-markup.js`，旧运行时移到 `public/console/cards/legacy-runtime.js`（文件名不再是 legacy.js）；CSS 拆为 `base.css` / `cards.css` / `components.css`；`console.html` 1,237 → **270 行**（≤300 目标）。
> C5 后续（同日）：17 B 站自己刷视频迁为独立模块 `17-bili.js`；真迁核心卡累计 15 张（7 声明式 + 8 模块），legacy-adopt 剩余 9 张。
> C5 继续（同日）：09 DSH 侧 MCP 工具迁为独立模块 `09-tools.js`；真迁核心卡累计 16 张（7 声明式 + 9 模块），legacy-adopt 剩余 8 张。
> C5 继续（同日）：10 白名单迁为独立模块 `10-whitelist.js`；真迁核心卡累计 17 张（7 声明式 + 10 模块），legacy-adopt 剩余 7 张（05/07/08/16/18/20/24）。
> C5 完成（同日）：16/18/20/08/05/07/24 全部拆为独立模块；24 张核心卡均为 7 声明式 + 17 模块，`legacy-adopt` 已清零；`legacy-runtime.js` 仅保留控制台外壳/摘要/详情/背景等公共运行时。
> C6（同日）：manifest v2 分区（core 20 / plugins 11 组）；app/core-surface、app/layout、app/plugin-surface、app/router；runtime 拆为 common/status/summary/devlog/visuals/boot/messages；`legacy-markup.js` 与 `legacy-runtime.js` 删除；about/02b/detail/模态标记移入 app 模块；`console.html` 126 行（≤150 DoD）。

平均 322 行 / 文件（不含 `plugins/` 的 13,492 行）。0.4.0 的 `bridge.js` + `console-server.js` 双巨塔（15.8k 行）
已经拆掉：console 侧变成 20 个文件 7,605 行（router + 19 个域模块，最大 802 行），
bridge 侧在 R2~R3 拆出 pipeline/（20 文件 3,787 行）、src/state/ 状态层与一批服务模块后停在 6,466 行（R4.5-1 又把超分实现移入 plugins/，再减 9 行接线）。
**剩余的头部问题只有两个：`bridge.js`（源码）与 `console.html`（前端）。**

### 3.2 结构：console 已收敛，bridge 仍是事实上的上帝对象

- `bridge.js` **扇出 74**（0.4.0 为 71）：依赖几乎全部模块——行数降了，接线面反而更宽，
  因为服务越多、注入越多。这是当前结构复杂度的**单点**。
- `console-server.js` 扇出 23、自身依赖 18 项（0.4.0 是 265 项平铺）；18 个路由模块
  各自从 `deps` 取 8~62 项切片，单模块可见面已收窄，但 **bridge 注入的 262 项依赖袋
  本身没有领域对象化**（R4-4b 未做）。
- 扇入最高的是 `src/state/store.js`（10）——共享基础设施被广泛复用，是健康信号；
  其次 `gif-frames` / `proxy-tunnel` / `safe-fetch`（8）。
- 无循环依赖，模块边界单向。

### 3.3 行为：时序与状态竞争仍是主战场

| 控制流代理 | 0.4.0 | 现在 |
| --- | ---: | ---: |
| `if` | 4,274 | 3,485 |
| `try` | 678 | 514 |
| `await` | 803 | 632 |
| 定时器 | 77 | 39 |

定时器下降来自 task-service 托管；其余同量级。历史上反复出现的
「@ 不回」「长等待卡死」「繁忙时丢消息」「引用错消息」依然是**时序与状态竞争**，
单元测试最难覆盖的部分，不随拆分而消失。

### 3.4 集成：12 类外部依赖，11 个测试要真实服务

DSH、OneBot/SnowLuma、safebooru、pixiv、yande.re、SauceNAO、4 个搜索引擎、GitHub、
微信公众号、GPT-SoVITS、ASR、Upscayl、Chrome/Edge、ffmpeg。
（X 监控自 2026-10-26 起因内容安全 P0 关闭，恢复需先过内容审查，见工作计划阶段 6。）
外部面没有收缩，只是少了一个活跃项；**契约测试仍然缺失**，上游变化只能靠线上报错发现。

### 3.5 配置：schema 化后风险降级

479 键由 `config-schema.js` 定义、模板自动生成、启动即校验；默认值三处漂移的
问题已被 R1 消灭。剩余风险只是键的**数量**（479 个组合空间），不是正确性。

---

## 4. 风险排序（当前）

1. **`bridge.js` 的状态中心化**：6,462 行、扇出 74，所有改动的必经之路；
   R4.5 插件化迁移是继续压它的主要手段
2. **`public/console/legacy.js` 前端单体**：5,413 行，仍是 24 卡的主要实现；
   C1 已把 Shell 与注册表拆出，C2 起按卡片域继续迁 `cards/*.js`
3. **依赖袋领域对象化未完成**：bridge 注入契约 262 项不变；console 侧只做了
   "消费面收窄"。改注入契约会牵动 19 个路由模块，需要单独一轮
4. **运行时状态文件的并发写**：原子写已有，跨文件一致性没有统一事务；
   `state/` 直属 62 项里混着日志、备份与测试残留，需要一次清点
5. **外部集成缺契约测试**：12 类依赖，11 个测试需要真实服务，离线无法全量验证

---

## 5. 判断与建议

**一句话：一个人能维护，且从"靠测试硬撑"回到"结构能讲清楚"的状态；
下一刀应该砍 console.html 和 bridge 的注入契约。**

按收益排序：

1. **R4.5 插件化迁移**（已在《重构方案》排定）：upscale / web-search / x / bili /
   images / stickers / shared-memory 逐个出核——直接削 bridge 扇出与行数
2. **console.html 拆分**：按 24 张卡的域拆成独立 JS 片段（构建期拼接或 ES module），
   让 test-console-layout 的断言能落到模块级
3. **R5 测试改造**：把 33 个"读源码字符串"的测试逐步改成行为测试
   （`scripts/lib/console-src.mjs` 是过渡产物，不是终点）
4. **R4-4b 依赖袋领域对象化**：console-server 侧已备好（模块按切片消费），
   改 bridge 注入契约时一次到位

---

## 6. 指标复现与口径说明

```bash
npm run measure            # 人类可读；--json 机器可读
npm test                   # 末尾输出「通过 N/M 累计断言 X」

# 控制台端点（R4 后按三处相加，measure 已内置）
grep -c 'url.pathname ===' src/console-server.js          # 内联（/ 页面与 401）
grep -rc "router\.\(get\|post\)(" src/console/routes/00-overview.js
grep -rc "^  \['" src/console/routes/*.js                 # 域模块 routes 清单

# 分支复杂度代理（本文口径）
node -e "const t=require('fs').readFileSync('src/bridge.js','utf8');
console.log((t.match(/\bif\s*\(/g)||[]).length+(t.match(/&&/g)||[]).length+(t.match(/\|\|/g)||[]).length+(t.match(/\?[^.:/]/g)||[]).length)"
```

**口径修正（2026-10-27）**：

- `measure-complexity.mjs` 原来按目录名跳过 `state`，把 `src/state/`（R2 状态层源码，
  158 行）也误跳了。已改为只跳根目录 `state/`。**0.4.0 ~ R3-14 的历史数字因此系统性
  偏低约 158 行**（如 45,927 实为 46,085），不影响结论，但跨文档对比时注意。
- 控制台路由计数从"数 `url.pathname ===`"改为"内联 + 概览注册 + 域模块清单"三处相加，
  与 `test-console-server.mjs` 的 158 断言同口径。
- 分支复杂度代理重新定义为 `if + && + || + ?:`，与归档文档的旧口径不可比。

---

## 7. 与 0.4.0 基线对照

| 指标 | 0.4.0（归档口径） | R4 后 | 说明 |
| --- | ---: | ---: | --- |
| 源码文件 / 行数 | 97 / 43,815 | 110 / 35,327（+插件 13,492） | 合计 +11%；含口径修正 +158 |
| 最大源码文件 | bridge 8,821 | bridge 6,462 | console-server 7,013 → **632** |
| 头部占比（top2） | 36.1% | 24.3% | 双塔 → 单塔 |
| 控制台路由 | 151 | 158 | 19 个域文件 + router（C1 manifest + C3 plugin-guide + C4 token panel） |
| console 依赖袋 | 265 项平铺 | 主文件 18 项 / 模块切片 8~62 | 领域对象化未做 |
| 定时器 | 77 | 39 | task-service 托管 |
| 配置键 | 447 | 489 | 已 schema 化 |
| 测试脚本 / 断言 | 129 / ≈4,600 | 149 / 4,917 | 含 11 个环境类失败（网络波动） |
| 循环依赖 | 0 | 0 | — |
| 注释占比 | 19.4% | 15.2% | — |
