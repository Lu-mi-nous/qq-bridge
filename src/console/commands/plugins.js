// R4.7-3：插件管理命令（加载/卸载 / 插件配置保存）。
//
// 加载/卸载只写 plugins.disabled（需重启桥接生效）；插件配置保存由插件自己的
// set() 校验和落盘，核心只做统一脱敏壳与错误反馈。

import { maskValue as defaultMaskValue } from '../../credentials-doc.js';

export function createPluginCommands({
  root,
  cfg = {},
  pluginHost,
  fs,
  path,
  log,
  maskValue
} = {}) {
  const logLine = (message) => { try { log?.(message); } catch { /* 日志失败不影响保存结果 */ } };

  /** POST /api/console/plugins/<id>/(load|unload) */
  function setEnabled(id, action) {
    const known = (pluginHost?.list?.() ?? []).some((plugin) => plugin.id === id);
    if (!known) return { ok: false, status: 404, error: `未知插件：${id}` };
    try {
      const file = path.join(root, 'config.json');
      const config = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!config.plugins || typeof config.plugins !== 'object') config.plugins = {};
      const disabled = new Set((config.plugins.disabled || []).map(String));
      if (action === 'unload') disabled.add(id); else disabled.delete(id);
      config.plugins.disabled = [...disabled].sort();
      fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
      if (!cfg.plugins || typeof cfg.plugins !== 'object') cfg.plugins = {};
      cfg.plugins.disabled = config.plugins.disabled;
      return {
        ok: true,
        id,
        disabled: action === 'unload',
        restartRequired: true,
        message: action === 'unload' ? '已卸载，重启桥接后生效' : '已恢复加载，重启桥接后生效'
      };
    } catch (error) {
      return { ok: false, status: 500, error: `保存插件状态失败：${error?.message ?? error}` };
    }
  }

  /** POST /api/plugins/<id>/config */
  async function saveConfig(pluginId, body = {}) {
    const key = String(body.key ?? '').trim();
    const items = pluginHost?.getContext?.(pluginId)?.console?.configItems;
    if (!items) return { ok: false, status: 404, error: '插件能力不可用' };
    const item = items.find((x) => x.key === key);
    if (!item) return { ok: false, status: 400, error: `未知配置项：${key}` };
    if (body.value === undefined) return { ok: false, status: 400, error: '缺少 value' };
    const value = typeof body.value === 'string' ? body.value.replace(/[\r\n]+/g, '').trim() : body.value;
    try {
      await item.set(value);
      let next = '';
      try { const got = await item.get(); next = got == null ? '' : String(got); } catch { /* 回读失败只影响预览 */ }
      logLine(`[插件配置] ${pluginId}/${key} 已更新${typeof value === 'string' ? `（${value.length} 字符）` : ''}`);
      return {
        ok: true,
        key,
        configured: !!next,
        preview: item.kind === 'secret' && next ? (maskValue || defaultMaskValue)(next) : '',
        restart: item.restart === true,
        applied: item.restart !== true
      };
    } catch (error) {
      return { ok: false, status: 400, error: `保存失败：${error?.message ?? error}` };
    }
  }

  return { setEnabled, saveConfig };
}
