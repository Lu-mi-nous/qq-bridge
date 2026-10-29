// R4.7-2：概览 / 插件读模型。
//
// 覆盖 about、插件清单、控制台插件管理列表、console manifest、插件开发指南、
// 工具开关、Token 报表 iframe 面板、插件配置项读取。
// 插件加载/卸载与配置写入在 `src/console/commands/plugins.js`。

import fs from 'node:fs';
import path from 'node:path';
import { CONSOLE_CONTRACT_VERSION, CONSOLE_GROUPS, coreManifestCards, pluginOwnedManifestCards } from '../core-cards.js';
import { PLUGIN_PERMISSIONS, PLUGIN_PERMISSION_MODES } from '../../plugins/host.js';
import { maskValue } from '../../credentials-doc.js';

export function createOverviewReadModel({
  root,
  cfg = {},
  pluginHost,
  TOOL_FLAGS = [],
  groupedToolFlags,
  toolNamesOf
} = {}) {
  const plugins = () => pluginHost?.list?.() ?? [];

  /** GET /api/about */
  function about() {
    let version = '';
    let snowlumaVersion = '';
    try { version = String(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version || ''); } catch { /* 忽略 */ }
    try {
      const home = String(cfg.snowluma?.homeDir || '').trim();
      if (home) snowlumaVersion = String(JSON.parse(fs.readFileSync(path.join(home, 'package.json'), 'utf8')).version || '');
    } catch { /* 忽略 */ }
    return {
      ok: true,
      name: 'WhaleTalk',
      version,
      snowlumaVersion,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      repo: 'https://github.com/Lu-mi-nous/whale-talk'
    };
  }

  /** GET /api/plugins：最小清单，不暴露内部实现或配置。 */
  function pluginList() {
    return { ok: true, plugins: plugins() };
  }

  /** GET /api/console/plugins：管理列表（含 disabled 配置态）。 */
  function adminPlugins() {
    const disabled = new Set((cfg.plugins?.disabled || []).map(String));
    return {
      ok: true,
      plugins: plugins().map((plugin) => ({
        id: plugin.id,
        name: plugin.name || plugin.id,
        version: plugin.version || '',
        description: plugin.consoleCard?.description || plugin.console?.cards?.[0]?.description || '',
        status: plugin.status || 'unknown',
        error: plugin.error || '',
        // disabled 只表示「配置要求卸载」；运行时是否已卸载看 status。
        disabled: disabled.has(plugin.id),
        cardCount: Array.isArray(plugin.console?.cards) ? plugin.console.cards.length : 0
      }))
    };
  }

  /** GET /api/console/manifest：核心卡 + 插件卡元数据（不含代码/HTML）。 */
  function manifest() {
    const list = plugins();
    const disabledPlugins = new Set((cfg.plugins?.disabled || []).map(String));
    const coreCards = coreManifestCards();
    const ownedCards = pluginOwnedManifestCards();
    const pluginGroups = [];
    list.forEach((plugin, pluginIndex) => {
      // 配置已卸载的插件不再贡献菜单卡片；即使进程还没重启也立刻从插件功能页消失。
      if (disabledPlugins.has(plugin.id)) return;
      const registered = Array.isArray(plugin.console?.cards) ? plugin.console.cards : [];
      const declarative = plugin.consoleCard && typeof plugin.consoleCard === 'object' ? plugin.consoleCard : null;
      // 功能归属该插件的核心模块卡（08/15/17/18）优先；与插件自己的 console.card.json 合并为一张。
      const owned = ownedCards.filter((card) => card.pluginId === plugin.id);
      const cards = [...(owned.length ? owned : (declarative ? [declarative] : registered))];
      const configItems = Array.isArray(plugin.console?.configItems) ? plugin.console.configItems : [];
      if (configItems.length) {
        cards.push({
          id: 'config',
          kind: 'plugin',
          owner: 'plugin',
          pluginId: plugin.id,
          title: '配置 / 连接',
          description: `${configItems.length} 个可配置项（凭据、代理或连接参数）。`,
          render: 'module',
          module: '/console/cards/config-panel.js',
          configEndpoint: `/api/plugins/${plugin.id}/config`
        });
      }
      if (!cards.length) return;
      const group = {
        id: plugin.id,
        title: plugin.name || plugin.id,
        status: plugin.status || 'unknown',
        enabled: plugin.status === 'started',
        error: plugin.error || plugin.consoleCardError || '',
        cards: []
      };
      cards.forEach((card, cardIndex) => {
        const id = `plugin:${plugin.id}:${card.id || cardIndex}`;
        const ownedCard = card.owner === 'plugin';
        const entry = {
          id,
          kind: 'plugin',
          owner: 'plugin',
          pluginId: plugin.id,
          pluginName: plugin.name || plugin.id,
          pluginStatus: plugin.status || 'unknown',
          enabled: plugin.status === 'started',
          title: card.title || card.id || plugin.id,
          description: card.description || '',
          endpoint: card.endpoint || '',
          order: 1000 + pluginIndex * 100 + cardIndex,
          render: ownedCard ? (card.render || 'module') : (declarative ? 'declarative' : 'legacy'),
          ...(ownedCard ? {
            ...(card.data ? { data: card.data } : {}),
            ...(card.sections ? { sections: card.sections } : {}),
            ...(card.poll ? { poll: card.poll } : {}),
            ...(card.module ? { module: card.module } : {}),
            ...(card.panel ? { panel: card.panel } : {}),
            ...(card.configEndpoint ? { configEndpoint: card.configEndpoint } : {})
          } : (declarative ? {
            contractVersion: declarative.contractVersion || 'v1',
            ...(declarative.data ? { data: declarative.data } : {}),
            ...(declarative.sections ? { sections: declarative.sections } : {}),
            ...(declarative.poll ? { poll: declarative.poll } : {}),
            ...(declarative.panel ? { panel: declarative.panel } : {})
          } : {}))
        };
        group.cards.push(entry);
      });
      pluginGroups.push(group);
    });
    // 控制台自己的连接配置（SnowLuma / 控制台令牌）不属于任何插件，单独成组。
    pluginGroups.push({
      id: 'console-tools',
      title: '控制台工具',
      status: 'builtin',
      enabled: true,
      builtin: true,
      error: '',
      cards: [{
        id: 'console-tools:credentials',
        kind: 'plugin',
        owner: 'plugin',
        pluginId: 'console-tools',
        pluginName: '控制台工具',
        pluginStatus: 'builtin',
        enabled: true,
        title: '核心连接配置',
        description: 'SnowLuma accessToken 与控制台访问令牌；插件凭据已移到各自插件卡。',
        order: 9000,
        render: 'module',
        module: '/console/cards/config-panel.js',
        configEndpoint: '/api/socialV2/credentials'
      }]
    });
    return {
      ok: true,
      contractVersion: 'v2',
      core: { title: '基础功能', cards: coreCards },
      plugins: { title: '插件功能', groups: pluginGroups },
      groups: CONSOLE_GROUPS,
      pluginList: list.map((plugin) => ({
        id: plugin.id,
        name: plugin.name || plugin.id,
        version: plugin.version || '',
        status: plugin.status || 'unknown',
        error: plugin.error || '',
        cardCount: Array.isArray(plugin.console?.cards) ? plugin.console.cards.length : 0
      }))
    };
  }

  /** GET /api/console/plugin-guide */
  function pluginGuide() {
    return {
      ok: true,
      contractVersion: CONSOLE_CONTRACT_VERSION,
      cardContract: {
        kinds: ['declarative', 'iframe'],
        fields: ['text', 'input', 'number', 'switch', 'select', 'textarea', 'table', 'list', 'progress', 'custom-note', 'actions'],
        security: [
          '插件只能提交 JSON 元数据，不能提交 HTML/JS 片段',
          '动作路径必须位于 /api/plugins/<id>/ 下',
          'iframe panel 必须 sandbox="allow-scripts"（不带 allow-same-origin）',
          '插件缺席时卡片不占位，控制台不报错'
        ]
      },
      configItemContract: {
        fields: ['key', 'label', 'group', 'kind', 'restart', 'doc', 'options'],
        kinds: ['secret', 'text', 'switch', 'number', 'select', 'textarea'],
        endpoint: 'GET/POST /api/plugins/<id>/config',
        security: [
          'secret 项必须声明 secrets 权限',
          'GET 默认只回脱敏预览，reveal=1&key= 才回单条明文',
          'set(value) 由插件自己校验和保存；错误原样反馈',
          '凭据文件必须列进 manifest.secrets 白名单'
        ]
      },
      permissions: PLUGIN_PERMISSIONS,
      permissionModes: PLUGIN_PERMISSION_MODES,
      example: {
        file: 'plugins/<id>/console.card.json',
        json: {
          id: '<id>',
          kind: 'plugin',
          pluginId: '<id>',
          title: '插件卡片标题',
          order: 110,
          data: [{ source: '/api/plugins/<id>/card', as: 'st' }],
          sections: [
            { type: 'text', label: '状态', bind: 'st.enabled', map: { true: '已启用', false: '未启用' } },
            { type: 'switch', label: '启用', bind: 'st.enabled' }
          ]
        }
      },
      plugins: plugins().map((plugin) => ({
        id: plugin.id,
        name: plugin.name || plugin.id,
        version: plugin.version || '',
        status: plugin.status || 'unknown',
        error: plugin.error || plugin.consoleCardError || '',
        cardCount: plugin.consoleCard ? 1 : (Array.isArray(plugin.console?.cards) ? plugin.console.cards.length : 0),
        hasDeclarativeCard: !!plugin.consoleCard,
        tools: Array.isArray(plugin.tools) ? plugin.tools.length : undefined
      }))
    };
  }

  /** GET /api/console/panel/token-report：iframe 面板 HTML。 */
  function tokenReportPanel() {
    try {
      return { ok: true, html: fs.readFileSync(path.join(root, 'public', 'console', 'panels', 'token-report.html')) };
    } catch {
      return { ok: false, status: 404 };
    }
  }

  /** GET /api/socialV2/tool-flags */
  function toolFlags() {
    const tools = cfg.socialV2?.tools ?? {};
    const groups = groupedToolFlags((flag) => tools[flag] !== false);
    const names = typeof toolNamesOf === 'function' ? toolNamesOf() : [];
    return {
      ok: true,
      total: TOOL_FLAGS.length,
      toolCount: Array.isArray(names) ? names.length : 0,
      enabledCount: TOOL_FLAGS.filter((x) => x.fixed !== true && tools[x.flag] !== false).length,
      groups
    };
  }

  /** GET /api/plugins/<id>/config：读取插件注册的配置项（默认脱敏）。 */
  async function pluginConfig(pluginId, { reveal = false, only = '' } = {}) {
    const items = pluginHost?.getContext?.(pluginId)?.console?.configItems;
    if (!items) return { ok: false, status: 404, error: '插件能力不可用' };
    const selected = only ? items.filter((item) => item.key === only) : items;
    if (reveal && !only) return { ok: false, status: 400, error: 'reveal 必须指定单条 key' };
    const out = [];
    for (const item of selected) {
      let value = '';
      let error = '';
      try {
        const got = await item.get();
        value = got == null ? '' : String(got);
      } catch (e) {
        error = String(e?.message ?? e);
      }
      const secret = item.kind === 'secret';
      out.push({
        key: item.key,
        label: item.label,
        group: item.group || '配置',
        kind: item.kind,
        restart: item.restart === true,
        doc: item.doc || '',
        ...(Array.isArray(item.options) ? { options: item.options } : {}),
        configured: !!value,
        value: secret ? ((reveal && only) ? value : '') : value,
        preview: secret && value ? maskValue(value) : '',
        ...(error ? { error } : {})
      });
    }
    return { ok: true, pluginId, items: out };
  }

  return { about, pluginList, adminPlugins, manifest, pluginGuide, tokenReportPanel, toolFlags, pluginConfig };
}
