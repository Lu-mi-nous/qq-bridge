// 图片插件的配置项注册（由插件自己读取/校验/保存）。
import path from 'node:path';
import * as pixiv from './lib/pixiv-auth.js';
import * as reverse from './lib/image-reverse-search.mjs';

function proxyOk(value) {
  return !value || /^https?:\/\/[^\s]+$/i.test(value);
}

function reloadPixiv(ctx) {
  try {
    const file = path.join(ctx.root, 'state', 'pixiv-auth.json');
    const pa = pixiv.loadPixivAuth(file);
    pixiv.setPixivCookie(pa.loaded ? pa.cookie : '');
  } catch {}
}

export function createConfigItems(ctx) {
  return [
    {
      key: 'reverseSearchApiKey',
      label: 'SauceNAO API Key（反向搜图）',
      group: '凭据',
      kind: 'secret',
      restart: false,
      doc: `## SauceNAO API Key

反向搜图（以图搜图）用它查图片出处。**没配也能跑其他功能**，只是 \`qq_reverse_search\` 不可用。

### 怎么拿
打开 <https://saucenao.com/user.php?page=search-api>，登录后在 **API** 页复制 32~40 位 key。

### 免费额度
每天 100 次、30 秒内最多 4 次；同一张图 24 小时内命中缓存不消耗额度。

### 生效方式
改完**立即生效**，不需要重启。`,
      get: () => String(ctx.config.get().reverseSearchApiKey || ''),
      set: (value) => {
        const v = String(value || '').trim();
        if (v && v.length < 6) throw new Error('这个值太短了，确认没复制错吗？');
        ctx.config.set('reverseSearchApiKey', v);
        try { reverse.setApiKey?.(v); } catch {}
      }
    },
    {
      key: 'pixivPhpSessId',
      label: 'pixiv PHPSESSID（登录态，可选）',
      group: '凭据',
      kind: 'secret',
      restart: false,
      doc: `## pixiv PHPSESSID

pixiv 登录态 Cookie。默认不需要填；匿名被限流或需要个性化内容时再配。

### 怎么取
浏览器登录 <https://www.pixiv.net>，F12 → Application → Cookies → pixiv.net，复制 \`PHPSESSID\` 的 Value。

### 生效方式
保存后**立即生效**（插件会重读凭据文件）。

### 安全
存在 \`state/pixiv-auth.json\`，日志与接口都不打印值；R-18 内容始终过滤。`,
      get: () => String(ctx.secrets.readJson('pixiv-auth.json')?.PHPSESSID || ''),
      set: (value) => {
        const obj = ctx.secrets.readJson('pixiv-auth.json') || {};
        const v = String(value || '').trim();
        if (v) obj.PHPSESSID = v; else delete obj.PHPSESSID;
        ctx.secrets.writeJson('pixiv-auth.json', obj);
        reloadPixiv(ctx);
      }
    },
    {
      key: 'pixivDeviceToken',
      label: 'pixiv device_token（可选）',
      group: '凭据',
      kind: 'secret',
      restart: false,
      doc: `## pixiv device_token

pixiv 的设备标识 Cookie，可选，建议与 PHPSESSID 一起填。

### 怎么取
与 PHPSESSID 同一位置（F12 → Cookies → pixiv.net），找 \`device_token\`。

### 生效方式
保存后**立即生效**。`,
      get: () => String(ctx.secrets.readJson('pixiv-auth.json')?.device_token || ''),
      set: (value) => {
        const obj = ctx.secrets.readJson('pixiv-auth.json') || {};
        const v = String(value || '').trim();
        if (v) obj.device_token = v; else delete obj.device_token;
        ctx.secrets.writeJson('pixiv-auth.json', obj);
        reloadPixiv(ctx);
      }
    },
    {
      key: 'imagesProxy',
      label: '图源代理（images.proxy）',
      group: '连接',
      kind: 'text',
      restart: false,
      doc: `## 图源代理

访问境外图源（pixiv、yande.re）时走的 HTTP 代理。

### 格式
\`http://127.0.0.1:7897\`（Clash 默认端口）。

### 生效方式
改完**立即生效**（每次抓图现读）。`,
      get: () => String(ctx.config.get().proxy || ''),
      set: (value) => {
        const v = String(value || '').trim();
        if (!proxyOk(v)) throw new Error('代理地址应形如 http://127.0.0.1:7897');
        ctx.config.set('proxy', v);
      }
    }
  ];
}
