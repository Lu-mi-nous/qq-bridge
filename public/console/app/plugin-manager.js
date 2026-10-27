// 插件管理：卡片式列表 + 苹果式开关（C6）。
//
// 只改 config.plugins.disabled，不尝试运行时热卸载；变更后提示重启桥接。
// 开关是即时预览：点击先把 UI 拨到目标态，再从接口确认；失败时平滑拨回。
import { api as defaultApi } from '../core/api.js';

export async function mountPluginManager(container, { api = defaultApi, showHeader = true, onChange = null } = {}) {
  container.textContent = '';

  const card = document.createElement('section');
  card.className = 'card plugin-group plugin-manager';
  let head = null;
  if (showHeader) {
    head = document.createElement('div');
    head.className = 'plugin-group-head';
    const title = document.createElement('h3');
    title.textContent = '插件管理';
    const hint = document.createElement('span');
    hint.className = 'meta';
    hint.textContent = '开关修改 config.plugins.disabled，重启桥接后生效';
    head.append(title, hint);
  }

  const grid = document.createElement('div');
  grid.className = 'plugin-manager-grid';
  grid.textContent = '读取插件清单…';
  const restartBar = document.createElement('div');
  restartBar.className = 'plugin-manager-restart';
  restartBar.hidden = true;
  const restartMsg = document.createElement('span');
  restartMsg.className = 'meta';
  restartMsg.setAttribute('role', 'status');
  restartMsg.setAttribute('aria-live', 'polite');
  const restartBtn = document.createElement('button');
  restartBtn.type = 'button';
  restartBtn.className = 'danger';
  restartBtn.textContent = '重启桥接';
  restartBar.append(restartMsg, restartBtn);
  if (head) card.appendChild(head);
  card.append(grid, restartBar);
  container.appendChild(card);

  let plugins = [];
  let busyActions = 0;

  const runtimeDisabled = (plugin) => plugin.status === 'disabled';
  const needsRestart = (plugin) => !!plugin.disabled !== runtimeDisabled(plugin);
  const syncBusy = () => { restartBtn.disabled = busyActions > 0; };

  function stateOf(plugin) {
    const waiting = needsRestart(plugin);
    if (plugin.disabled) {
      return { kind: waiting ? 'pending' : 'off', label: waiting ? '已卸载 · 待重启' : '已卸载', detail: '' };
    }
    if (plugin.status === 'failed' || plugin.status === 'invalid') {
      return { kind: 'error', label: '加载失败', detail: plugin.error || '' };
    }
    if (runtimeDisabled(plugin)) {
      return { kind: 'pending', label: '已加载 · 待重启', detail: '' };
    }
    return { kind: 'on', label: '运行中', detail: '' };
  }

  function syncRestartBar() {
    const pending = plugins.filter(needsRestart).length;
    if (pending) {
      restartBar.hidden = false;
      restartMsg.textContent = `${pending} 个插件状态已修改，需重启桥接生效`;
    } else {
      restartBar.hidden = true;
      restartMsg.textContent = '';
    }
  }

  async function restartBridge() {
    if (busyActions > 0) return;
    if (!window.confirm('确定重启桥接？插件状态会在重启后生效，约 3~10 秒恢复。')) return;
    restartBtn.disabled = true;
    restartMsg.textContent = '正在重启…';
    try {
      await api('/api/restart', 'POST', {});
      let back = false;
      for (let i = 0; i < 60; i++) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        try {
          const st = await api('/api/socialV2/config');
          if (st) { back = true; break; }
        } catch { /* 重启中 */ }
        restartMsg.textContent = `正在重启…（${i + 1}s）`;
      }
      restartMsg.textContent = back ? '✅ 桥接已恢复，正在刷新…' : '⚠️ 60 秒内未恢复，请检查 state/bridge.log';
      if (back) setTimeout(() => location.reload(), 500);
    } catch (error) {
      restartMsg.textContent = '重启失败：' + (error?.message || error);
    } finally {
      syncBusy();
    }
  }

  restartBtn.addEventListener('click', () => { void restartBridge(); });

  function iconTone(id) {
    let hash = 0;
    for (const ch of String(id || '')) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
    return String(hash % 5 + 1);
  }

  async function refresh() {
    try {
      const r = await api('/api/console/plugins');
      plugins = Array.isArray(r?.plugins) ? r.plugins : [];
      grid.textContent = '';
      if (!plugins.length) {
        const empty = document.createElement('p');
        empty.className = 'meta plugin-manager-empty';
        empty.textContent = '没有可管理的插件。';
        grid.appendChild(empty);
      }
      plugins.forEach((plugin, index) => {
        const article = document.createElement('article');
        article.className = 'plugin-manage-card';
        article.dataset.pluginId = plugin.id;
        article.style.setProperty('--i', String(index));

        const top = document.createElement('div');
        top.className = 'plugin-manage-card-top';
        const icon = document.createElement('span');
        icon.className = 'plugin-manage-icon';
        icon.dataset.tone = iconTone(plugin.id);
        icon.setAttribute('aria-hidden', 'true');
        icon.textContent = String(plugin.name || plugin.id).trim().charAt(0).toUpperCase();
        const titleWrap = document.createElement('div');
        titleWrap.className = 'plugin-manage-title';
        const name = document.createElement('b');
        name.textContent = plugin.name || plugin.id;
        const sub = document.createElement('span');
        sub.className = 'meta';
        sub.textContent = `${plugin.id} · v${plugin.version || '—'}`;
        titleWrap.append(name, sub);

        const sw = document.createElement('button');
        sw.type = 'button';
        sw.className = 'plugin-manage-switch';
        sw.setAttribute('role', 'switch');
        sw.setAttribute('aria-checked', String(!plugin.disabled));
        sw.setAttribute('aria-label', `${plugin.disabled ? '加载' : '卸载'} ${plugin.name || plugin.id}`);
        const knob = document.createElement('span');
        knob.className = 'plugin-manage-knob';
        sw.appendChild(knob);
        top.append(icon, titleWrap, sw);

        const desc = document.createElement('p');
        desc.className = 'plugin-manage-desc';
        desc.textContent = plugin.description || '';
        if (!desc.textContent) desc.hidden = true;

        const foot = document.createElement('div');
        foot.className = 'plugin-manage-foot';
        const dot = document.createElement('span');
        dot.className = 'plugin-manage-dot';
        dot.setAttribute('aria-hidden', 'true');
        const status = document.createElement('span');
        status.className = 'plugin-manage-status';
        const count = document.createElement('span');
        count.className = 'plugin-manage-count meta';
        count.textContent = `${plugin.cardCount || 0} 个功能卡`;
        const msg = document.createElement('span');
        msg.className = 'plugin-manage-msg meta';
        msg.setAttribute('role', 'status');
        msg.setAttribute('aria-live', 'polite');
        msg.textContent = plugin.error || '';
        foot.append(dot, status, count, msg);

        let busy = false;
        const renderState = () => {
          const state = stateOf(plugin);
          article.dataset.state = state.kind;
          status.textContent = state.label;
          sw.setAttribute('aria-checked', String(!plugin.disabled));
          sw.setAttribute('aria-label', `${plugin.disabled ? '加载' : '卸载'} ${plugin.name || plugin.id}`);
          if (state.detail) msg.textContent = state.detail;
        };

        const toggle = async () => {
          if (busy) return;
          busy = true;
          busyActions += 1;
          syncBusy();
          const wasDisabled = !!plugin.disabled;
          const nextDisabled = !wasDisabled;
          // 先拨动开关，让视觉反馈立即开始；接口失败再拨回。
          plugin.disabled = nextDisabled;
          renderState();
          sw.disabled = true;
          msg.textContent = '保存中…';
          try {
            const res = await api(`/api/console/plugins/${encodeURIComponent(plugin.id)}/${nextDisabled ? 'unload' : 'load'}`, 'POST', {});
            plugin.disabled = typeof res?.disabled === 'boolean' ? res.disabled : nextDisabled;
            msg.textContent = res?.message || '已保存，重启桥接后生效';
            if (typeof onChange === 'function') onChange({ id: plugin.id, disabled: plugin.disabled, status: plugin.status });
          } catch (error) {
            plugin.disabled = wasDisabled;
            msg.textContent = '失败：' + (error?.message || error);
          } finally {
            busy = false;
            busyActions -= 1;
            sw.disabled = false;
            renderState();
            syncBusy();
            syncRestartBar();
          }
        };
        sw.addEventListener('click', () => { void toggle(); });
        article.append(top, desc, foot);
        grid.appendChild(article);
        renderState();
      });
      syncRestartBar();
    } catch (error) {
      grid.textContent = '读取插件清单失败：' + (error?.message || error);
    }
  }

  await refresh();
}
