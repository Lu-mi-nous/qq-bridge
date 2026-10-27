// B 站插件的凭据注册（文件读写由插件自己完成）。
export function createConfigItems(ctx) {
  const read = () => ctx.secrets.readJson('bili-auth.json') || {};
  return [
    {
      key: 'biliSessdata',
      label: 'B 站 SESSDATA（登录态）',
      group: '凭据',
      kind: 'secret',
      restart: true,
      doc: `## B 站 SESSDATA

B 站登录态 Cookie。配了之后搜索是个性化结果，并解锁视频字幕。

### 怎么取
浏览器登录 <https://www.bilibili.com>，F12 → Application → Cookies → bilibili.com，复制 \`SESSDATA\` 的 Value。

### 生效方式
⚠️ **需要重启桥接**——凭据只在启动时加载一次。

### 安全
存在 \`state/bili-auth.json\`，日志只输出「已加载 / 未配置 / 已失效」，不打印任何字符。`,
      get: () => String(read().SESSDATA || ''),
      set: (value) => {
        const obj = read();
        const v = String(value || '').trim();
        if (v) obj.SESSDATA = v; else delete obj.SESSDATA;
        ctx.secrets.writeJson('bili-auth.json', obj);
      }
    },
    {
      key: 'biliBuvid3',
      label: 'B 站 buvid3（设备号，可选）',
      group: '凭据',
      kind: 'secret',
      restart: true,
      doc: `## B 站 buvid3

设备标识，可选。不填时会自动生成匿名设备号，搜索仍然可用。

### 怎么取
与 SESSDATA 同一位置（F12 → Cookies → bilibili.com），找 \`buvid3\`。

### 生效方式
⚠️ **需要重启桥接**（与 SESSDATA 一起在启动时加载）。

### 安全
存在 \`state/bili-auth.json\`，日志不打印值。`,
      get: () => String(read().buvid3 || ''),
      set: (value) => {
        const obj = read();
        const v = String(value || '').trim();
        if (v) obj.buvid3 = v; else delete obj.buvid3;
        ctx.secrets.writeJson('bili-auth.json', obj);
      }
    }
  ];
}
