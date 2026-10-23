# 模型接入方式

桥接进程本身**不直接连任何模型服务**。它只做两件事：

```
QQ ──► SnowLuma (OneBot v11) ──► 桥接 ──► DSH Web API (127.0.0.1:3080) ──► 模型
```

模型是在 **DSH 侧**配置的。桥接的 `config.json` 里 `dsh.provider` / `dsh.model` 只是告诉 DSH「这一轮用哪个 provider 下的哪个模型」，真正连到哪由 DSH 的 `~/.dsh/settings.yaml` 决定。

所以「换模型 / 换接入方式」= 改 DSH 的 provider 配置，而不是改桥接。

---

## 方式一：接本地模型网关（`vgw`）

适合已经在跑本地 OpenAI 兼容网关的情况（例如 `http://127.0.0.1:7863/v1`，把多个上游账号池聚合成 `cn:` / `global:` 这类虚拟模型名）。

### 1. DSH 侧配置 provider

编辑 `~/.dsh/settings.yaml`：

```yaml
llm-pi-ai:
  providers:
    vgw:
      displayName: 本地网关
      api: openai-completions
      baseURL: http://127.0.0.1:7863/v1
      apiKeyEnv: LOCAL_MODEL_API_KEY
      models:
        - id: cn:deepseek-v4.1-flash
          name: cn:deepseek-v4.1-flash
          contextWindow: 1000000
          maxTokens: 32768
          input:
            - text
            - image
          reasoningEfforts: false
agent-default-model:
  provider: vgw
  model: cn:deepseek-v4.1-flash
```

要点：

- `api` 必须是 `openai-completions`（网关说 OpenAI 兼容协议）。
- `apiKeyEnv` 写的是**环境变量名**，不是密钥本身；密钥放进 `~/.dsh/.credentials.yaml`：

  ```yaml
  refs:
    LOCAL_MODEL_API_KEY: local     # 多数本地网关不校验，填任意非空值
  ```

- `input` 里必须包含 `image`，否则群友发表情包/图片时模型「看不见」。
- `reasoningEfforts: false` 用于**不支持推理档位**的模型。若模型支持而这里写 false，切换档位会报 `does not support reasoning effort`。
- `contextWindow` / `maxTokens` 按网关 `/v1/models` 返回的真实值填，别照抄——填小了会上下文溢出。

### 2. 桥接侧指向它

`config.json`：

```json
{
  "dsh": {
    "baseUrl": "http://127.0.0.1:3080",
    "provider": "vgw",
    "model": "cn:deepseek-v4.1-flash",
    "reasoningEffort": ""
  }
}
```

### 3. 现成脚本

| 脚本 | 用途 |
| --- | --- |
| `node scripts/list-models.mjs` | 列出网关 `/v1/models` 全部模型 |
| `node scripts/switch-realm-model.mjs cn:deepseek-v4.1-flash` | 切模型（**推荐**：会保住看图能力） |
| `node scripts/model-picker.mjs` | 列表 + 交互选择，并标注真实可用性 |
| `node scripts/ensure-dsh-provider.mjs` | provider 丢失时自检自愈 |
| `node scripts/set-model.mjs <id>` | 切模型（**注意**：虚拟前缀名会被降级成纯文本，丢看图） |

> ⚠️ DSH 桌面端启动时会把 `~/.dsh/settings.yaml` 改名成 `.imported`，导致 provider 表变空、桥接报 `no adapter serves provider "vgw"`，表现为机器人不理人。开了桌面端之后跑一次 `node scripts/ensure-dsh-provider.mjs`。

---

## 方式二：接 DeepSeek 官方 API（API key）

不需要本地网关，直接用 `sk-` 开头的 DeepSeek API key。

### 1. 把 key 交给 DSH

推荐写进凭据文件（不要写进仓库里的 `config.json`）：

```yaml
# ~/.dsh/.credentials.yaml
refs:
  DEEPSEEK_API_KEY: sk-你的密钥
```

或用环境变量：

```bash
export DEEPSEEK_API_KEY=sk-你的密钥       # Windows PowerShell: $env:DEEPSEEK_API_KEY="sk-..."
```

### 2. 配置 provider

```yaml
llm-pi-ai:
  providers:
    deepseek:
      displayName: DeepSeek 官方
      api: openai-completions
      baseURL: https://api.deepseek.com/v1
      apiKeyEnv: DEEPSEEK_API_KEY
      models:
        - id: deepseek-chat
          name: DeepSeek Chat
          contextWindow: 128000
          maxTokens: 8192
          input:
            - text
          reasoningEfforts: false
agent-default-model:
  provider: deepseek
  model: deepseek-chat
```

### 3. 桥接侧

```json
{
  "dsh": {
    "baseUrl": "http://127.0.0.1:3080",
    "provider": "deepseek",
    "model": "deepseek-chat",
    "reasoningEffort": ""
  }
}
```

### 关于看图能力

DeepSeek 官方 API 的 `deepseek-chat` **只接受文本**。桥接会把图片转成文字描述或直接跳过，群里发图时体验会明显下降。需要看图就保留一个能看图的 provider（本地网关里的 vision 模型），两者可以同时存在于 `providers` 下，按需切换。

---

## 两种方式对比

| | 本地网关 (`vgw`) | DeepSeek 官方 API |
| --- | --- | --- |
| 需要本地进程 | 是（如 `:7863`） | 否 |
| 密钥存放 | `LOCAL_MODEL_API_KEY`（常为占位值） | 真实 `sk-` key，注意别泄漏 |
| 看图 | 取决于网关里的模型 | 官方 chat 模型不支持 |
| 多账号池 / 路由 | 支持（`cn:` / `global:` 前缀） | 不支持 |
| 计费 | 走网关背后的账号池 | 直接按官方价计费 |
| 适合 | 已有本地网关、需要多池和看图 | 只想快速跑通、纯文本聊天 |

---

## 排错

| 现象 | 原因 / 处理 |
| --- | --- |
| `no adapter serves provider "xxx"` | provider 不在 `settings.yaml` 里，或桌面端把它改名成 `.imported`。跑 `ensure-dsh-provider.mjs` |
| `does not support reasoning effort` | 模型不支持推理档位，但 provider 里写了 `reasoningEfforts`，或桥接 `reasoningEffort` 非空。都置空 / `false` |
| 503 无可用账号 | 网关侧账号池全被限流或熔断，与桥接无关；等冷却或换 realm（`cn:` ↔ `global:`） |
| 群友发图模型说看不到 | provider 的模型条目 `input` 缺 `image`，或选中的模型本身不支持图像 |
| 切换后仍用旧模型 | 桥接进程比配置文件旧，重启桥接；`config.json` 是 mtime 热加载但 provider 变更需 DSH 侧生效 |
