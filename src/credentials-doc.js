// 待配置项（凭据 / 密钥 / 关键连接配置）的定义与说明文档。
//
// 需求（2026-10-20 用户）：把所有待配置项（api key、cookie 凭据等）放到控制台，
// 做成密码样式（右侧有隐藏/显示按钮），旁边加说明文档链接，并支持保存；
// 需要重启才生效的要标明，重启按钮也放在这一块。
//
// ── 为什么文档写在代码里而不是 docs/*.md ──────────────────────────────────
//
// 用户选定「内联到控制台并做好弹出关闭动画」。内联意味着文档内容要能随控制台
// 页面一起下发；若放成独立 .md 文件，还得额外做静态路由 + 鉴权 + 跨域处理，
// 而这里的文档很短（每项十几行），放代码里最省事，也不会因为文件路径变化而 404。
// 长文档（如项目指南）仍在 docs/ 下，两者分工明确。
//
// ── 安全约定 ────────────────────────────────────────────────────────────
//
// 这些值**只在控制台与桥接之间**流转（127.0.0.1 + 同源校验）：
//   - GET 默认**只返回「是否已配置」与脱敏预览**，绝不把完整明文送到前端；
//     用户点「显示」后才单独请求该项明文（`reveal=1`）。
//   - 任何情况下**不写日志**。
//   - 落盘沿用原有位置（config.json / state/*.json），不新建明文集中文件：
//     集中一处反而扩大泄露面。

/**
 * 每一项的元数据。
 *
 * 字段：
 *   - key        前端/接口用的唯一标识
 *   - label      控制台显示名
 *   - group      分组（凭据 / 连接）
 *   - kind       'secret' 打码；'text' 明文（如代理地址）
 *   - where      'config' 写 config.json 的 path；'file' 写 state 下某个 json 的字段
 *   - path       config 的点路径 / file 的字段名
 *   - file       where='file' 时的文件名（相对 state/）
 *   - restart    改动后是否需要重启桥接
 *   - doc        markdown 说明（内联）
 */
export const CREDENTIAL_ITEMS = [
  {
    key: 'reverseSearchApiKey',
    label: 'SauceNAO API Key（反向搜图）',
    group: '凭据',
    kind: 'secret',
    where: 'config',
    path: 'imageReverseSearch.apiKey',
    restart: false, // 每次反查都现读 cfg，改完立即生效
    doc: `## SauceNAO API Key

反向搜图（以图搜图）用它查图片出处。**没配也能跑其他功能**，只是 \`qq_reverse_search\` 不可用。

### 怎么拿
- 打开 <https://saucenao.com/user.php?page=search-api>
- 注册/登录后，在 **API** 页能看到一串 32~40 位的 key
- 粘进这里保存

### 免费额度
- **每天 100 次**、**30 秒内最多 4 次**
- 同一张图 24 小时内命中缓存**不消耗额度**（按内容 sha1 分桶）
- 额度用完后当天无法再反查，次日自动重置
- 控制台「12c 取图额度」卡片能看剩余次数

### 生效方式
改完**立即生效**，不需要重启——每次反查都会读一次配置。

### 安全
只存在 \`config.json\`（已在 .gitignore）。日志与 API 返回都不打印明文，
控制台默认打码，点右侧眼睛才显示。`
  },
  {
    key: 'biliSessdata',
    label: 'B 站 SESSDATA（登录态）',
    group: '凭据',
    kind: 'secret',
    where: 'file',
    file: 'bili-auth.json',
    path: 'SESSDATA',
    restart: true,
    doc: `## B 站 SESSDATA

B 站登录态 Cookie。配了之后：**搜索是个性化结果**，并且**解锁视频字幕**。

### 为什么需要（两个实测结论）
- \`search/type\` 接口在**完全不带 Cookie** 时返回 \`-412 request was banned\`（风控），
   但只要带任意 \`buvid3\` 就能正常返回 20 条 —— 所以**搜索本身不需要登录**。
- 但字幕接口 \`/x/player/v2\` **必须登录**：不登录时 \`code\` 仍是 **0**、
   \`subtitles\` 只是空数组，分不清"没登录"和"这视频没字幕"。
   实测热门榜 12 条里 11 条有 \`ai-zh\` 字幕 —— 这是让机器人真正"听懂"视频的唯一途径
   （模型收不到音频流，见下方说明）。

### 怎么取
- 浏览器登录 <https://www.bilibili.com>
- F12 → Application（应用）→ Storage → Cookies → \`https://www.bilibili.com\`
- 找到 \`SESSDATA\`，复制它的 **Value**（很长，约 60~100 字符）

### 生效方式
⚠️ **需要重启桥接**——凭据只在启动时加载一次（\`loadBiliAuth\`）。
点下面的「重启桥接」按钮即可。

### 安全
存在 \`state/bili-auth.json\`（\`state/\` 已被 .gitignore）。
日志只输出「已加载 / 未配置 / 已失效」，**不打印任何字符**。

### 风险提示
SESSDATA 等同于你的登录态。不要分享给他人；退出登录或在 B 站改密码会使其失效。`
  },
  {
    key: 'biliBuvid3',
    label: 'B 站 buvid3（设备号，可选）',
    group: '凭据',
    kind: 'secret',
    where: 'file',
    file: 'bili-auth.json',
    path: 'buvid3',
    restart: true,
    doc: `## B 站 buvid3

设备标识。**可选**：不填时会自动生成一个匿名设备号，搜索仍然可用。

### 什么时候需要填
- 想让搜索使用与网页一致的设备指纹（更接近真人请求）
- 上游偶尔因为"设备号太新"触发验证时

### 怎么取
与 SESSDATA 同一个位置（F12 → Cookies → \`https://www.bilibili.com\`），
找 \`buvid3\`，复制 Value。

### 生效方式
⚠️ **需要重启桥接**（与 SESSDATA 一起在启动时加载）。

### 安全
存在 \`state/bili-auth.json\`，日志不打印值。`
  },
  {
    key: 'pixivPhpSessId',
    label: 'pixiv PHPSESSID（登录态，可选）',
    group: '凭据',
    kind: 'secret',
    where: 'file',
    file: 'pixiv-auth.json',
    path: 'PHPSESSID',
    restart: false, // 保存后桥接会重读并立即生效（见 bridge.js 的 applyPixivAuth）
    doc: `## pixiv PHPSESSID

pixiv 登录态 Cookie。**默认不需要填**——pixiv 的日榜/搜索接口匿名就能访问。

### 填它有什么好处
凭据只影响三件事，都不是"解锁新功能"：
- **匿名被限流时**（同一出口 IP 拉得太频繁，表现为 \`503\`）用登录态更容易通过
- 部分关键词搜索对未登录者返回空壳（\`error: true\` 但没有数据）
- 将来接入「关注画师」「收藏」这类个性化内容需要它

### 内容限制
- **R-18 内容永远过滤。** 无论登不登录，本适配器只保留全年龄（\`sexual/xRestrict === 0\`）。

### 怎么取
- 浏览器登录 <https://www.pixiv.net>
- F12 → Application（应用）→ Storage → Cookies → \`https://www.pixiv.net\`
- 找 \`PHPSESSID\`，复制 **Value**（约 40 位十六进制）

### 生效方式
保存后**立即生效**（桥接会重读凭据文件）。日志只写「已加载 / 匿名访问」。

### 安全与风险
- 存在 \`state/pixiv-auth.json\`（\`state/\` 已被 .gitignore），日志与接口都不打印值
- PHPSESSID 等同于你的 pixiv 登录态，不要分享
- ⚠️ 用**自己的账号**做程序化拉取，理论上存在被 pixiv 判为异常访问的风险
  （轻则要求重新验证，重则限制账号）。要不要填**由你决定**，不填也能用。`
  },
  {
    key: 'pixivDeviceToken',
    label: 'pixiv device_token（可选）',
    group: '凭据',
    kind: 'secret',
    where: 'file',
    file: 'pixiv-auth.json',
    path: 'device_token',
    restart: false,
    doc: `## pixiv device_token

pixiv 的设备标识 Cookie，**可选**，建议与 PHPSESSID 一起填。

### 为什么建议一起填
pixiv 会把 \`device_token\` 与登录态一起校验。只带 PHPSESSID 时，
偶尔会走"新设备验证"流程（表现为要求重新登录或返回空数据）。

### 怎么取
与 PHPSESSID 同一位置（F12 → Cookies → \`https://www.pixiv.net\`），找 \`device_token\`。

### 也可以整串粘
如果嫌一个个填麻烦，可以直接在 \`state/pixiv-auth.json\` 里写
\`{ "cookie": "PHPSESSID=...; device_token=..." }\`，整串原样使用。

### 生效方式
保存后**立即生效**。

### 安全
存在 \`state/pixiv-auth.json\`，日志不打印值。`
  },
  {
    key: 'xAuthToken',
    label: 'X (Twitter) auth_token',
    group: '凭据',
    kind: 'secret',
    where: 'file',
    file: 'x-auth.json',
    path: 'auth_token',
    restart: false,
    doc: `## X (Twitter) auth_token

X 账号的登录 Cookie 之一，用于**按需拉取 X 帖子**（\`qq_fetch_x_posts\`）。

### 为什么不配就拉不到
X 的搜索结果与用户时间线都要登录态。未登录只能看到极少量内容，
且很快会被要求验证。

### 怎么取
- 浏览器登录 <https://x.com>
- F12 → Application → Cookies → \`https://x.com\`
- 复制 \`auth_token\` 的 Value（约 40 位十六进制）

### 生效方式
改完**立即生效**（每次抓取现读）。若改了仍失败，检查同组的 \`ct0\`。

### 安全
存在 \`state/x-auth.json\`，日志不打印值。`
  },
  {
    key: 'xCt0',
    label: 'X (Twitter) ct0',
    group: '凭据',
    kind: 'secret',
    where: 'file',
    file: 'x-auth.json',
    path: 'ct0',
    restart: false,
    doc: `## X (Twitter) ct0

X 的 CSRF token，与 \`auth_token\` **配套使用**，两者缺一不可。

### 怎么取
与 auth_token 同一位置（F12 → Cookies → \`https://x.com\`），复制 \`ct0\` 的 Value。

### 注意
- \`ct0\` 会随会话刷新，如果一段时间后抓取开始失败，重新复制一次
- 两者必须来自**同一次登录会话**

### 生效方式
改完**立即生效**。

### 安全
存在 \`state/x-auth.json\`。`
  },
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

### 与下面那个「自动生成令牌」的区别
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
  },
  {
    key: 'imagesProxy',
    label: '图源代理（images.proxy）',
    group: '连接',
    kind: 'text',
    where: 'config',
    path: 'socialV2.images.proxy',
    restart: false,
    doc: `## 图源代理

访问境外图源（pixiv、yande.re）时走的 HTTP 代理。

### 为什么必须配
本机实测**直连这两个站会失败**：本地 DNS 被污染（pixiv 被解析到 Facebook 的 IP 段），
以及 yande.re 直连超时。走代理后由代理解析域名，可绕开污染。

### 格式
\`http://127.0.0.1:7897\`（Clash 默认端口）
也可以填 \`http://127.0.0.1:7890\`（Clash 旧版）等。

### 各源可单独覆盖
\`socialV2.images.sources.pixiv.proxy\` 与 \`...yandere.proxy\` 可单独指定；
留空则用这里的全局值。

### 生效方式
改完**立即生效**（每次抓图现读）。

### 注意
safebooru **直连即可**，代理只是它的超时兜底——不要为了它强制走代理。`
  },
  {
    key: 'githubShotProxy',
    label: 'GitHub 截图代理',
    group: '连接',
    kind: 'text',
    where: 'config',
    path: 'socialV2.githubShot.proxy',
    restart: false,
    doc: `## GitHub 截图代理

\`qq_github_shot\` 截图 GitHub 仓库首页时用的代理。

### 为什么必须配
实测本机**直连 github.com 会 \`ECONNRESET\`**，浏览器会截出网络错误页。

### 留空时
会自动回落到「图源代理」（\`socialV2.images.proxy\`）。两者通常可以是同一个。

### 格式
\`http://127.0.0.1:7897\`

### 生效方式
改完**立即生效**。`
  },
  {
    key: 'webSearchProxy',
    label: '联网搜索代理',
    group: '连接',
    kind: 'text',
    where: 'config',
    path: 'webSearch.proxy',
    restart: false,
    doc: `## 联网搜索代理

\`web_search\` 工具访问 Bing / DuckDuckGo 时用的代理。

### 什么时候需要
- 本机直连 Bing 被限流或超时
- 想固定搜索的出口地区

### 留空
直连（多数情况下可用；若日志出现大量超时再配）。

### 格式
\`http://127.0.0.1:7897\`

### 生效方式
改完**立即生效**。`
  },
  {
    key: 'xMonitorProxy',
    label: 'X 抓取代理',
    group: '连接',
    kind: 'text',
    where: 'config',
    path: 'xMonitor.proxy',
    restart: false,
    doc: `## X 抓取代理

拉取 X（Twitter）帖子时用的代理。**国内直连 x.com 不通**，通常必须配。

### 留空时
会回落到「图源代理」（\`socialV2.images.proxy\`）。

### 格式
\`http://127.0.0.1:7897\`

### 生效方式
改完**立即生效**。`
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
 * 为什么不露前 4 后 4：这些 key 常被截图分享，露太多等于泄露。
 */
export function maskValue(value) {
  const s = String(value ?? '');
  if (!s) return '';
  if (s.length <= 8) return '•'.repeat(s.length);
  return `${s.slice(0, 2)}${'•'.repeat(Math.min(12, s.length - 4))}${s.slice(-2)}`;
}
