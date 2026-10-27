// 09 DSH 侧 MCP 工具清单（C5 真模块卡）。
//
// 数据来自 /api/socialV2/tool-flags；只读展示，开关统一在 07 卡修改。
import { api as defaultApi } from '../core/api.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));

const EXTRA_GROUPS = [
  {
    group: 'Web Search MCP（只读）',
    fixedExtra: true,
    items: [
      { tools: ['web_search'], desc: '联网搜索：天气/新闻/事实/价格/梗；天气走实时数据，其它多引擎回退', state: 'fixed' },
      { tools: ['web_fetch'], desc: '抓取网页正文：SSRF 防护、GBK/GB2312、非 2xx/验证页报错、境外站点代理回退', state: 'fixed' },
      { tools: ['web_view_image'], desc: '按图片 URL 取图给模型看（单张 ≤2.5MB，一次最多 3 张）', state: 'fixed' }
    ]
  },
  {
    group: 'Host MCP（本机进程）',
    fixedExtra: true,
    items: [
      { tools: ['snowluma_status'], desc: '查看 SnowLuma 是否在线（只读）', state: 'fixed' },
      { tools: ['start_snowluma'], desc: '启动 SnowLuma；默认禁用，需 snowluma.allowProcessControl=true', state: 'off' },
      { tools: ['stop_snowluma'], desc: '停止 SnowLuma；默认禁用，需 snowluma.allowProcessControl=true', state: 'off' }
    ]
  }
];

export async function mount(container, ctx = {}) {
  const api = ctx.api || defaultApi;
  container.textContent = '';
  const summary = document.createElement('div'); summary.className = 'meta'; summary.id = 'tool09Summary'; summary.textContent = '加载中…';
  const note = document.createElement('div'); note.className = 'meta'; note.style.marginTop = '4px';
  note.innerHTML = '清单来自 <code>src/tool-flags.js</code>；开关统一在 07「工具开关」页修改，修改 MCP 源码/挂载后需重启 DSH。';
  const row = document.createElement('div'); row.className = 'row'; row.style.marginTop = '10px';
  const search = document.createElement('input'); search.id = 'tool09Search'; search.placeholder = '搜索工具名 / 说明'; search.style.flex = '1';
  const refreshBtn = document.createElement('button'); refreshBtn.type = 'button'; refreshBtn.className = 'small'; refreshBtn.id = 'tool09Refresh'; refreshBtn.textContent = '刷新';
  const openBtn = document.createElement('button'); openBtn.type = 'button'; openBtn.className = 'small'; openBtn.id = 'tool09OpenFlags'; openBtn.textContent = '打开 07 工具开关';
  row.append(search, refreshBtn, openBtn);
  const groupsBox = document.createElement('div'); groupsBox.id = 'tool09Groups'; groupsBox.className = 'tool09-groups'; groupsBox.textContent = '加载中…';
  container.append(summary, note, row, groupsBox);

  let data = null;

  function render() {
    const q = String(search.value || '').trim().toLowerCase();
    const groups = [...(data?.groups || []), ...EXTRA_GROUPS];
    const html = groups.map((g) => {
      const items = (g.items || []).filter((it) => !q || `${g.group} ${(it.tools || []).join(' ')} ${it.desc || ''}`.toLowerCase().includes(q));
      if (!items.length) return '';
      const toolCount = items.reduce((n, it) => n + (it.tools?.length || 0), 0);
      const rows = items.map((it) => {
        const state = g.fixedExtra ? it.state : (it.fixed ? 'fixed' : (it.enabled ? 'on' : 'off'));
        const label = state === 'fixed' ? '固定' : (state === 'on' ? '开' : '关');
        const tools = (it.tools || []).map((t) => `<code>${esc(t)}</code>`).join('<br>');
        return `<div class="tool09-item"><div class="tool09-name">${tools}</div><div class="tool09-desc">${esc(it.desc || '')}</div><div class="tool09-state ${state}">${label}</div></div>`;
      }).join('');
      return `<div class="tool09-group"><div class="tool09-group-hd"><span>${esc(g.group)}</span><span class="meta">${toolCount} 个工具 / ${items.length} 项</span></div>${rows}</div>`;
    }).join('');
    groupsBox.innerHTML = html || '<div class="tool09-empty">没有匹配的工具</div>';
  }

  async function refresh() {
    try {
      const r = await api('/api/socialV2/tool-flags');
      if (!r?.ok) throw new Error(r?.error || '读取失败');
      data = r;
      summary.textContent = `QQ MCP：${r.toolCount} 个工具 / ${r.total} 个开关项（${r.enabledCount} 个开启） · Web Search MCP：3 个只读工具 · Host MCP：3 个（进程控制默认关闭）`;
      render();
    } catch (error) {
      groupsBox.innerHTML = `<div class="tool09-empty">读取工具清单失败：${esc(error?.message || error)}</div>`;
    }
  }

  search.addEventListener('input', render);
  refreshBtn.addEventListener('click', () => { void refresh(); });
  openBtn.addEventListener('click', () => {
    const card = document.getElementById('summary-07')?.closest('.summary-card');
    if (card) card.click();
  });
  await refresh();
}
