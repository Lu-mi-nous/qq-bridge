// 联网搜索插件配置项。
export function createConfigItems(ctx) {
  return [
    {
      key: 'webSearchProxy',
      label: '联网搜索代理',
      group: '连接',
      kind: 'text',
      restart: false,
      doc: `## 联网搜索代理

\`web_search\` 工具访问 Bing / DuckDuckGo 时用的代理。

### 什么时候需要
本机直连 Bing 被限流、超时，或想固定搜索出口地区时。

### 格式
\`http://127.0.0.1:7897\`。

### 生效方式
改完**立即生效**。`,
      get: () => String(ctx.config.get().proxy || ''),
      set: (value) => {
        const v = String(value || '').trim();
        if (v && !/^https?:\/\/[^\s]+$/i.test(v)) throw new Error('代理地址应形如 http://127.0.0.1:7897');
        ctx.config.set('proxy', v);
      }
    }
  ];
}
