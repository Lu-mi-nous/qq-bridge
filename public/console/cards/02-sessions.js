// 02 会话映射（C2 模块卡）。
//
// 保留 #sessionList / .sess-row，legacy 摘要仍按行数统计会话。
// 「查看消息」复用 legacy 的 02b 二级视图：showMessages(key) 会把 02b 节点
// 搬进当前整页并加载历史消息；02b 本身按计划保留 legacy 适配。
import { api as defaultApi } from '../core/api.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));

export async function mount(container, ctx = {}) {
  const api = ctx.api || defaultApi;
  container.textContent = '';
  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = 'QQ 不会把机器人与别人的私聊显示给你（会话按账号隔离），群里也看不到私聊内容——要回看机器人说过什么，用这里的「查看消息」。';
  const box = document.createElement('div');
  box.id = 'sessionList';
  box.textContent = '加载中…';
  container.append(meta, box);
  let busy = false;

  async function refresh() {
    if (busy) return;
    busy = true;
    try {
      const s = await api('/api/sessions');
      const list = Array.isArray(s?.sessions) ? s.sessions : [];
      if (!list.length) { box.innerHTML = '<span class="meta">暂无会话</span>'; return; }
      let html = '<div class="sess-list">';
      for (const x of list) {
        const isP = String(x.key).startsWith('private:');
        const type = isP ? '<span class="pill b">私聊</span>' : '<span class="pill g">群</span>';
        const ownerTag = x.owner ? ' <span class="pill r">管理员</span>' : '';
        const nameHtml = x.name ? `<span class="sess-name">${esc(x.name)}</span>` : '';
        html += `<div class="sess-row">
          <div class="sess-hd">${nameHtml}<code>${esc(x.key)}</code>${ownerTag} ${type}</div>
          <div class="sess-sid" title="${esc(x.sessionId)}">${x.name ? '会话：' + esc(x.key) + ' · ' : ''}DSH：<code>${esc(x.sessionId)}</code></div>
          <div class="sess-act">
            <button class="small" data-view-key="${esc(x.key)}">查看消息</button>
            <button class="small" data-reset-key="${esc(x.key)}">清除上下文</button>
          </div>
        </div>`;
      }
      box.innerHTML = html + '</div>';
      box.querySelectorAll('[data-view-key]').forEach((btn) => btn.addEventListener('click', () => {
        if (typeof window.showMessages === 'function') void window.showMessages(btn.dataset.viewKey);
      }));
      box.querySelectorAll('[data-reset-key]').forEach((btn) => btn.addEventListener('click', async () => {
        if (!window.confirm('确定清除该会话的上下文？下次消息将开新会话。')) return;
        try {
          const r = await api('/api/session/reset', 'POST', { key: btn.dataset.resetKey });
          window.alert(r?.ok ? '✅ 已清除上下文' : ('❌ ' + (r?.error || '失败')));
          await refresh();
        } catch (error) {
          window.alert('❌ ' + (error?.message || error));
        }
      }));
    } catch {
      box.innerHTML = '<span class="meta">读取失败</span>';
    } finally {
      busy = false;
    }
  }

  await refresh();
  setInterval(() => { if (!document.hidden) void refresh(); }, 5000);
}
