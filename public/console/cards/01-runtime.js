// 01 运行模式（C2 模块卡）。
//
// 四个模式按钮 + 封闭 Agent 预设下拉。保留 #modeRow / #closedPreset 这两个 id，
// 因为 legacy 的摘要统计（refreshSummaries）仍在读 #modeRow button.active。
import { api as defaultApi } from '../core/api.js';

const MODES = [
  { id: 'chat', label: '聊天模式' },
  { id: 'closed-agent', label: '封闭 Agent' },
  { id: 'reserved', label: '一代仿真模式' },
  { id: 'reserved2', label: '二代仿真模式' }
];

export async function mount(container, ctx = {}) {
  const api = ctx.api || defaultApi;
  container.textContent = '';
  let currentMode = '';

  const modeRow = document.createElement('div');
  modeRow.className = 'mode-row';
  modeRow.id = 'modeRow';
  const buttons = new Map();
  for (const mode of MODES) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.dataset.mode = mode.id;
    btn.textContent = mode.label;
    btn.addEventListener('click', () => { void setMode(mode.id); });
    buttons.set(mode.id, btn);
    modeRow.appendChild(btn);
  }

  const row = document.createElement('div');
  row.className = 'row';
  row.style.marginTop = '12px';
  const label = document.createElement('label');
  label.style.cssText = 'flex:1;margin:0';
  label.textContent = '封闭 Agent 使用的 DSH 预设';
  const select = document.createElement('select');
  select.id = 'closedPreset';
  select.style.maxWidth = '260px';
  row.append(label, select);

  const hint = document.createElement('div');
  hint.className = 'meta';
  hint.textContent = '二代仿真模式（reserved2）骨架已接入；完整“一切皆工具”链路开发中。';

  container.append(modeRow, row, hint);

  async function setMode(mode) {
    try {
      const r = await api('/api/mode', 'POST', {
        mode,
        closedAgentPreset: select.value || 'router-standard'
      });
      if (!r?.ok) throw new Error(r?.error || '切换失败');
      await refresh();
    } catch (error) {
      window.alert(error?.message || String(error));
    }
  }

  function renderPresets(presets, current) {
    const list = Array.isArray(presets) ? presets : [];
    select.textContent = '';
    for (const preset of list) {
      const option = document.createElement('option');
      option.value = preset.id;
      option.textContent = preset.id + (preset.trust && preset.trust !== 'system' ? `（${preset.trust}）` : '');
      select.appendChild(option);
    }
    if (!list.length) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = '（没有可用预设）';
      select.appendChild(option);
    }
    if (current && !list.some((p) => p.id === current)) {
      const option = document.createElement('option');
      option.value = current;
      option.textContent = current;
      select.appendChild(option);
    }
    select.value = current || list[0]?.id || '';
  }

  async function refresh() {
    try {
      const [st, presets] = await Promise.all([api('/api/status'), api('/api/presets')]);
      currentMode = st?.mode || '';
      for (const [id, btn] of buttons) btn.classList.toggle('active', id === currentMode);
      renderPresets(presets?.presets, st?.closedAgentPreset);
    } catch {
      /* 读取失败时保留上一次状态 */
    }
  }

  select.addEventListener('change', () => { if (currentMode) void setMode(currentMode); });
  await refresh();
  setInterval(() => { if (document.visibilityState !== 'hidden') void refresh(); }, 5000);
}
