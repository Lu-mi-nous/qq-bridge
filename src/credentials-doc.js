// 核心连接配置（SnowLuma / 控制台令牌）。
//
// 2026-10-27 起，插件自己的凭据/连接项由插件通过 `ctx.console.registerConfigItems()`
// 注册并保存；本文件只保留**不属于任何插件**的核心项，避免核心继续维护插件配置清单。
//
// 安全约定不变：
//   - GET 默认只返回「是否已配置」与脱敏预览；
//   - 点眼睛才单独请求该项明文（reveal=1&key=...）；
//   - 不写日志；落盘沿用 config.json。

/**
 * 每一项的元数据。
 *
 * 字段：
 *   - key        前端/接口用的唯一标识
 *   - label      控制台显示名
 *   - group      分组（凭据 / 连接）
 *   - kind       'secret' 打码；'text' 明文
 *   - where      'config' 写 config.json 的 path；'file' 写 state 下某个 json 的字段
 *   - path       config 的点路径 / file 的字段名
 *   - file       where='file' 时的文件名（相对 state/）
 *   - restart    改动后是否需要重启桥接
 *   - doc        markdown 说明（内联）
 */
export const CREDENTIAL_ITEMS = [
  {
    key: 'snowlumaAccessToken',
    label: 'SnowLuma accessToken',
    group: '凭据',
    kind: 'secret',
    where: 'config',
    path: 'snowluma.accessToken',
    restart: true,
    doc: `## SnowLuma accessToken

QQ 接入端（SnowLuma，OneBot v11）的鉴权令牌。

### 什么时候需要填
- SnowLuma 的 WebUI 里**开启了 access token 校验**时必须填
- 若 SnowLuma 没设 token（本机常见），这里留空即可

### 怎么取
打开 SnowLuma WebUI（默认 <http://127.0.0.1:5099>）→ 网络/OneBot 配置 →
查看「Access Token」字段。

### 生效方式
⚠️ **需要重启桥接**——连接参数在启动时读取。

### 排查
如果桥接日志出现连接被拒（401/403），多半就是这里的值与 SnowLuma 不一致。`
  },
  {
    key: 'consoleToken',
    label: '控制台访问令牌',
    group: '凭据',
    kind: 'secret',
    where: 'config',
    path: 'consoleToken',
    restart: true,
    doc: `## 控制台访问令牌

打开本控制台、调用管理 API 时用的令牌。

### 与「生成随机令牌」的区别
- 这里填的是**手动指定**的值（写进 \`config.json\`，你能看见、能再改）
- 留空时桥接会使用 \`state/console-token\` 里**随机生成**的令牌

### 怎么用
浏览器打开控制台时若要求输入，粘贴这里的值。

### 让它彻底不再问
把 \`config.json\` 的 \`consoleAuth\` 设为 \`false\`。
控制台仍只监听 127.0.0.1，写操作仍校验同源，安全性由"本机访问"保证。

### 生效方式
⚠️ **需要重启桥接**。

### 安全
至少 16 位。不要用你在别处用过的密码。`
  }
];

/** 按 key 取定义。 */
export function credentialByKey(key) {
  return CREDENTIAL_ITEMS.find((it) => it.key === key) || null;
}

/** 按 group 分组（控制台按组渲染）。 */
export function groupedCredentials() {
  const out = new Map();
  for (const it of CREDENTIAL_ITEMS) {
    if (!out.has(it.group)) out.set(it.group, []);
    out.get(it.group).push(it);
  }
  return [...out.entries()].map(([group, items]) => ({ group, items }));
}

/**
 * 脱敏预览：只露出足够确认"填没填、是不是这一串"的信息。
 *
 * 规则：长度 ≤ 8 全打码；否则露前 2 后 2，中间固定长度圆点。
 */
export function maskValue(value) {
  const s = String(value ?? '');
  if (!s) return '';
  if (s.length <= 8) return '•'.repeat(s.length);
  return `${s.slice(0, 2)}${'•'.repeat(Math.min(12, s.length - 4))}${s.slice(-2)}`;
}
