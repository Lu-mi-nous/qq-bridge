// X 插件配置项（凭据文件与代理都由插件自己管理）。
function proxyOk(value) {
  return !value || /^https?:\/\/[^\s]+$/i.test(value);
}

export function createConfigItems(ctx) {
  const read = () => ctx.secrets.readJson('x-auth.json') || {};
  return [
    {
      key: 'xAuthToken',
      label: 'X (Twitter) auth_token',
      group: '凭据',
      kind: 'secret',
      restart: false,
      doc: `## X (Twitter) auth_token

X 账号的登录 Cookie 之一，用于按需拉取 X 帖子。

### 怎么取
浏览器登录 <https://x.com>，F12 → Application → Cookies → x.com，复制 \`auth_token\` 的 Value。

### 生效方式
改完**立即生效**（每次抓取现读）。

### 安全
存在 \`state/x-auth.json\`，日志不打印值。`,
      get: () => String(read().auth_token || ''),
      set: (value) => {
        const obj = read();
        const v = String(value || '').trim();
        if (v) obj.auth_token = v; else delete obj.auth_token;
        ctx.secrets.writeJson('x-auth.json', obj);
      }
    },
    {
      key: 'xCt0',
      label: 'X (Twitter) ct0',
      group: '凭据',
      kind: 'secret',
      restart: false,
      doc: `## X (Twitter) ct0

X 的 CSRF token，与 \`auth_token\` **配套使用**，两者缺一不可。

### 怎么取
与 auth_token 同一位置（F12 → Cookies → x.com），复制 \`ct0\` 的 Value。

### 生效方式
改完**立即生效**。

### 注意
两者必须来自同一次登录会话；ct0 会随会话刷新。`,
      get: () => String(read().ct0 || ''),
      set: (value) => {
        const obj = read();
        const v = String(value || '').trim();
        if (v) obj.ct0 = v; else delete obj.ct0;
        ctx.secrets.writeJson('x-auth.json', obj);
      }
    },
    {
      key: 'xMonitorProxy',
      label: 'X 抓取代理',
      group: '连接',
      kind: 'text',
      restart: false,
      doc: `## X 抓取代理

拉取 X（Twitter）帖子时用的代理。国内直连 x.com 不通，通常必须配。

### 格式
\`http://127.0.0.1:7897\`。

### 生效方式
改完**立即生效**。`,
      get: () => String(ctx.config.get().proxy || ''),
      set: (value) => {
        const v = String(value || '').trim();
        if (!proxyOk(v)) throw new Error('代理地址应形如 http://127.0.0.1:7897');
        ctx.config.set('proxy', v);
      }
    }
  ];
}
