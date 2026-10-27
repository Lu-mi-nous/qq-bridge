// 控制台卡片注册表（C1）。
//
// 输入：GET /api/console/manifest 的 JSON（核心卡 + 插件卡）。
// 职责：校验、去重、排序、按来源分组（基础功能平铺 / 插件功能按插件分组）。
// 纯函数，可在 Node 里直接测试；不碰 DOM。

export const CONTRACT_VERSION = 'v1';

const GROUPS = [
  { id: 'all', title: '全部功能' },
  { id: 'core', title: '基础功能' },
  { id: 'plugins', title: '插件功能' },
  { id: 'about', title: '关于' }
];

// manifest 拉取失败时的最小回退：只保证试点声明式卡片仍有内容。
// 核心卡的旧 section 仍由 legacy 渲染，因此这里不需要完整 24 卡清单。
const FALLBACK_CARDS = [
  {
    id: '10',
    kind: 'core',
    title: '静默开关',
    group: 'community',
    order: 100,
    legacy: '#sec-10',
    render: 'declarative',
    data: [{ source: '/api/status', as: 'st' }],
    sections: [
      { type: 'custom-note', text: '静默时群友消息不投递 agent，仅管理员可对话。' },
      { type: 'text', label: '当前状态', bind: 'st.roleMode', map: { silent: '静默中（只回管理员）', active: '正常回复' }, fallback: '—' },
      { type: 'actions', items: [
        { label: '开启静默', method: 'POST', path: '/api/role-mode', body: { mode: 'silent' }, tone: 'danger' },
        { label: '恢复正常', method: 'POST', path: '/api/role-mode', body: { mode: 'active' } }
      ] }
    ],
    poll: { ms: 5000, sources: ['st'] }
  },
  {
    id: '11',
    kind: 'core',
    title: '安全拦截通知',
    group: 'community',
    order: 110,
    legacy: '#sec-11',
    render: 'declarative',
    data: [{ source: '/api/security', as: 'sec' }],
    sections: [
      { type: 'switch', label: '拦截时在群里发提示', bind: 'sec.security.interceptNotify', default: true },
      { type: 'actions', items: [{ label: '保存安全设置', method: 'POST', path: '/api/security', body: { interceptNotify: '$sec.security.interceptNotify' } }] }
    ],
    poll: { ms: 15000, sources: ['sec'] }
  },
  {
    id: '13',
    kind: 'core',
    title: '加好友 / 入群请求',
    group: 'community',
    order: 130,
    legacy: '#sec-13',
    render: 'declarative',
    data: [{ source: '/api/socialV2/join-requests', as: 'jr' }],
    sections: [
      { type: 'text', bind: 'jr', format: 'joinStatus', fallback: '加载中…' },
      { type: 'list', bind: 'jr.pending', template: 'joinRequest' },
      { type: 'custom-note', text: '有人加好友或拉 bot 进群时，桥接会私聊管理员并等裁决：/yes 编号 同意、/no 编号 拒绝、/pending 查看。默认不自动同意，超时（默认 5 分钟）自动拒绝。' }
    ],
    poll: { ms: 5000, sources: ['jr'] }
  }
];

function compareCards(a, b) {
  const ao = Number(a.order);
  const bo = Number(b.order);
  if (Number.isFinite(ao) && Number.isFinite(bo) && ao !== bo) return ao - bo;
  if (Number.isFinite(ao) !== Number.isFinite(bo)) return Number.isFinite(ao) ? -1 : 1;
  return String(a.id).localeCompare(String(b.id), 'zh-CN', { numeric: true });
}

/** 校验 manifest 结构；重复 id 直接报错（宁可整页回退，也不静默覆盖）。 */
export function validateManifest(raw) {
  if (!raw || raw.ok !== true) throw new Error('manifest 无效：ok !== true');
  const seen = new Set();
  const checkCard = (card, owner) => {
    if (!card || typeof card.id !== 'string' || !card.id) throw new Error('manifest 无效：卡片缺少 id');
    if (typeof card.title !== 'string' || !card.title) throw new Error(`manifest 无效：卡片 ${card.id} 缺少 title`);
    if (owner === 'plugin' && !card.pluginId) throw new Error(`manifest 无效：插件卡片 ${card.id} 缺少 pluginId`);
    if (seen.has(card.id)) throw new Error(`manifest 无效：重复卡片 id ${card.id}`);
    seen.add(card.id);
  };
  const isV2 = !!raw.core || !!(raw.plugins && !Array.isArray(raw.plugins));
  if (isV2) {
    const core = raw.core?.cards;
    const groups = raw.plugins?.groups;
    if (!Array.isArray(core)) throw new Error('manifest 无效：core.cards 不是数组');
    if (!Array.isArray(groups)) throw new Error('manifest 无效：plugins.groups 不是数组');
    for (const card of core) checkCard(card, 'core');
    for (const group of groups) {
      if (!group || !group.id) throw new Error('manifest 无效：插件组缺少 id');
      for (const card of Array.isArray(group.cards) ? group.cards : []) checkCard(card, 'plugin');
    }
    return raw;
  }
  // v1 兼容：旧版混排 cards。
  if (!Array.isArray(raw.cards)) throw new Error('manifest 无效：cards 不是数组');
  for (const card of raw.cards) {
    if (card.kind !== 'core' && card.kind !== 'plugin') throw new Error(`manifest 无效：卡片 ${card.id} 的 kind 非法`);
    checkCard(card, card.kind);
  }
  return raw;
}

/** 分区构建：coreCards 与 pluginGroups 永远不混。 */
export function buildRegistry(raw) {
  const manifest = validateManifest(raw);
  const isV2 = !!manifest.core || !!(manifest.plugins && !Array.isArray(manifest.plugins));
  if (isV2) {
    const coreCards = [...(manifest.core?.cards || [])].sort(compareCards);
    const pluginGroups = (manifest.plugins?.groups || [])
      .map((group) => ({
        id: group.id,
        title: group.title || group.id,
        status: group.status || 'unknown',
        enabled: group.enabled !== false,
        error: group.error || '',
        builtin: group.builtin === true,
        cards: (Array.isArray(group.cards) ? group.cards : []).slice().sort(compareCards)
      }))
      .filter((group) => group.cards.length > 0);
    const pluginCards = pluginGroups.flatMap((group) => group.cards);
    return {
      contractVersion: manifest.contractVersion || CONTRACT_VERSION,
      groups: Array.isArray(manifest.groups) && manifest.groups.length ? manifest.groups : GROUPS,
      cards: [...coreCards, ...pluginCards],
      coreCards,
      pluginCards,
      pluginGroups,
      plugins: Array.isArray(manifest.pluginList) ? manifest.pluginList : (Array.isArray(manifest.plugins) ? manifest.plugins : [])
    };
  }
  // v1 兼容路径
  const cards = [...manifest.cards].sort(compareCards);
  const coreCards = cards.filter((c) => c.kind === 'core');
  const pluginCards = cards.filter((c) => c.kind === 'plugin');
  const byPlugin = new Map();
  for (const card of pluginCards) {
    if (!byPlugin.has(card.pluginId)) byPlugin.set(card.pluginId, []);
    byPlugin.get(card.pluginId).push(card);
  }
  const declared = Array.isArray(manifest.pluginGroups) ? manifest.pluginGroups : [];
  const pluginGroups = declared
    .map((group) => ({
      id: group.id,
      title: group.title || group.id,
      status: group.status || 'unknown',
      enabled: group.enabled !== false,
      error: group.error || '',
      cards: (byPlugin.get(group.id) || []).slice().sort(compareCards)
    }))
    .filter((group) => group.cards.length > 0);
  for (const [id, list] of byPlugin) {
    if (pluginGroups.some((g) => g.id === id)) continue;
    pluginGroups.push({ id, title: list[0].pluginName || id, status: list[0].pluginStatus || 'unknown', enabled: true, error: '', cards: list });
  }
  pluginGroups.sort((a, b) => compareCards(a.cards[0], b.cards[0]));
  return {
    contractVersion: manifest.contractVersion || CONTRACT_VERSION,
    groups: Array.isArray(manifest.groups) && manifest.groups.length ? manifest.groups : GROUPS,
    cards,
    coreCards,
    pluginCards,
    pluginGroups,
    plugins: Array.isArray(manifest.pluginList) ? manifest.pluginList : (Array.isArray(manifest.plugins) ? manifest.plugins : [])
  };
}

/** 侧栏分组过滤：all = 全部；core = 基础；plugins = 全部插件；plugin:<id> = 单个插件。 */
export function cardsForGroup(registry, group) {
  if (group === 'all') return registry.cards;
  if (group === 'core') return registry.coreCards;
  if (group === 'plugins') return registry.pluginCards;
  if (String(group).startsWith('plugin:')) {
    const id = String(group).slice('plugin:'.length);
    return registry.pluginCards.filter((card) => card.pluginId === id);
  }
  return [];
}

/** 拉 manifest；失败返回最小回退（页面仍可用，不阻塞首屏）。 */
export async function loadManifest(fetchImpl = globalThis.fetch) {
  try {
    const res = await fetchImpl('/api/console/manifest', { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = await res.json();
    return { ...buildRegistry(raw), fallback: false };
  } catch (error) {
    const registry = buildRegistry({ ok: true, contractVersion: CONTRACT_VERSION, groups: GROUPS, cards: FALLBACK_CARDS, pluginGroups: [], plugins: [] });
    return { ...registry, fallback: true, error: String(error?.message || error) };
  }
}
