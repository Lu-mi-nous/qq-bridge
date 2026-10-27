// 媒体工具插件配置项。
export function createConfigItems(ctx) {
  return [
    {
      key: 'githubShotProxy',
      label: 'GitHub 截图代理',
      group: '连接',
      kind: 'text',
      restart: false,
      doc: `## GitHub 截图代理

\`qq_github_shot\` 截图 GitHub 仓库首页时用的代理。

### 为什么必须配
本机实测直连 github.com 会 ECONNRESET；留空时会自动回落到图源代理。

### 格式
\`http://127.0.0.1:7897\`。

### 生效方式
改完**立即生效**。`,
      get: () => String(ctx.config.get().githubShot?.proxy || ''),
      set: (value) => {
        const v = String(value || '').trim();
        if (v && !/^https?:\/\/[^\s]+$/i.test(v)) throw new Error('代理地址应形如 http://127.0.0.1:7897');
        ctx.config.set('githubShot.proxy', v);
      }
    }
  ];
}
