# 插件开发指南（控制台卡片契约 v1）

> 适用：`plugins/<id>/` 下的可选插件。控制台只接受**声明式 JSON**、**iframe 面板**或**插件自注册配置项**，不接受插件提交 HTML/JS 片段。

## 1. 最小目录

```text
plugins/<id>/
├── manifest.json          # id/version/engines/configSchema/permissions
├── index.js               # create(ctx) 生命周期
├── console.card.json      # 可选：控制台卡片（推荐）
├── config.schema.js
└── README.md
```

`manifest.json` 至少声明：

```json
{
  "id": "example",
  "name": "示例插件",
  "version": "0.1.0",
  "engines": { "qqBridge": ">=0.5.0" },
  "configSchema": "config.schema.js",
  "permissions": ["state", "console:route"]
}
```

## 2. 生命周期

```js
export function create(ctx) {
  ctx.log('loaded');
  return {
    async start() {},
    async stop() {}
  };
}
```

`ctx` 提供 `config`、`state`、`log`、`events`、`console.registerCard()`、`console.registerRoute()` 等窄接口；插件不能直接拿核心依赖袋。

### 2.1 启用与卸载

- 侧栏的「插件管理」独立页面用卡片列出全部插件（包括没有控制台卡片的插件），每张卡右侧是苹果式开关（开=加载、关=卸载）；插件功能页只显示已加载插件的摘要卡。
- 按钮只修改 `config.json` 的 `plugins.disabled` 数组；宿主启动时跳过列表中的插件，因此变更后必须重启桥接生效，控制台会显示重启按钮。
- 插件无需实现额外钩子；`create(ctx)` 不被调用就代表已卸载。已禁用插件仍会以 `status:"disabled"` 出现在管理列表中，方便重新加载。

## 3. 控制台卡片

`console.card.json` 示例：

```json
{
  "id": "example",
  "kind": "plugin",
  "pluginId": "example",
  "title": "示例插件",
  "description": "一句话说明",
  "order": 120,
  "data": [{ "source": "/api/plugins/example/card", "as": "st" }],
  "sections": [
    { "type": "text", "label": "状态", "bind": "st.enabled", "map": { "true": "已启用", "false": "未启用" } },
    { "type": "switch", "label": "启用", "bind": "st.enabled" },
    { "type": "actions", "items": [
      { "label": "保存", "method": "POST", "path": "/api/plugins/example/config", "body": { "enabled": "$st.enabled" } }
    ] }
  ]
}
```

- `kind` 必须是 `plugin`，`pluginId` 必须与插件 id 一致。
- `sections[].type` 支持：`text` / `input` / `number` / `switch` / `select` / `textarea` / `table` / `list` / `progress` / `custom-note` / `actions`。
- 动作 `path` **必须**以 `/api/plugins/<id>/` 开头；核心不会转发其它路径。
- 数据只从插件自己的 `/api/plugins/<id>/*` 路由读取；插件缺席时卡片不占位。

## 3.1 配置项自注册（凭据 / 连接 / 插件设置）

插件在 `create(ctx)` 里注册自己的配置项，核心只提供通用脱敏 UI 与 `GET/POST /api/plugins/<id>/config`，
不维护任何插件 key 清单：

```js
ctx.console.registerConfigItems([{
  key: 'exampleToken',
  label: '示例 Token',
  group: '凭据',              // 凭据 / 连接 / 设置
  kind: 'secret',             // secret | text | switch | number | select | textarea
  restart: false,             // 保存后是否需要重启桥接
  doc: '## 示例 Token\n\n怎么取：...\n\n生效方式：立即生效。',
  get: () => readMyToken(),
  set: (value) => writeMyToken(value)
}]);
```

- 配置项会按插件自动追加一张「配置 / 连接」摘要卡；插件不需要自己写前端。
- `get()` 返回当前值；`set(value)` 负责校验、写盘和热更新。抛错会原样反馈到控制台。
- `secret` 项必须声明 `secrets` 权限；GET 默认只回脱敏预览，`reveal=1&key=` 才回单条明文。
- 插件配置写入用 `ctx.config.set(相对路径, value)`（只允许自己的 `manifest.configPath` 命名空间）；
  凭据文件用 `ctx.secrets.readJson(name)` / `writeJson(name, obj)`，文件必须列进 manifest 的 `secrets` 白名单。
- `pluginHost.list()` 只暴露 `configItems` 元数据，不把 get/set 闭包带出插件上下文。

## 4. 权限与安全

| 权限 | 用途 |
| --- | --- |
| `network` | 访问外部网络 |
| `state` | 读写 `state/plugins/<id>/` |
| `send` | 通过桥接发 QQ 消息 |
| `mcp:register` | 注册 MCP 工具 |
| `console:route` | 注册 `/api/plugins/<id>/*` 控制台路由 |
| `prompt` | 参与提示词拼装 |
| `process` | 启动/探测本机进程 |
| `secrets` | 读写 manifest `secrets` 白名单里的凭据文件（日志不打印值） |

控制台卡片不允许 HTML/脚本；iframe 面板必须 `sandbox="allow-scripts"` 且**不带** `allow-same-origin`。插件不得把敏感词表、密钥或真实 QQ 号写进仓库。

## 5. 调试与测试

```bash
npm test
node scripts/test-console-card-contract.mjs
node scripts/test-plugin-host.mjs
```

- 卡片契约测试会扫描 `plugins/*/console.card.json`，校验 schema、命名空间与无 HTML。
- 插件缺席测试：临时把插件目录移走，控制台应正常加载且不出现空卡。
- 关于页「插件开发者文档」卡会实时显示插件清单与卡片状态；`GET /api/console/plugin-guide` 返回契约常量。
