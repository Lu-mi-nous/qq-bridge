// 03 挂起审批 / 提问（C2 模块卡）。
//
// 只读展示：审批/提问由管理员在 QQ 侧处理，控制台不提供远程裁决按钮，
// 避免控制台成为绕过 QQ 身份校验的第二入口。
import { api as defaultApi } from '../core/api.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));

export async function mount(container, ctx = {}) {
  const api = ctx.api || defaultApi;
  container.textContent = '';
  const box = document.createElement('div');
  box.className = 'scroll-area';
  box.textContent = '加载中…';
  container.appendChild(box);

  function renderEmpty() {
    box.innerHTML = '<div class="empty-state">'
      + '<div class="empty-ico">✓</div>'
      + '<div class="empty-t">当前没有挂起的审批或提问</div>'
      + '<div class="empty-d">当 AI 需要你确认某件事（例如删除操作、越权请求）时，'
      + '会在这里排队等你处理；平时这里是空的。</div>'
      + '</div>';
  }

  async function refresh() {
    try {
      const p = await api('/api/pending');
      const list = Array.isArray(p?.pending) ? p.pending : [];
      window.__CONSOLE_CARD_STATE__ = window.__CONSOLE_CARD_STATE__ || {};
      window.__CONSOLE_CARD_STATE__['03'] = {
        count: list.length,
        statusText: list.length ? `待处理 ${list.length} 条` : '没有待处理项'
      };
      if (!list.length) { renderEmpty(); return; }
      let html = '<table><tr><th>会话</th><th>类型</th><th>详情</th></tr>';
      for (const item of list) {
        const kind = item.kind === 'approval'
          ? '<span class="pill r">审批</span>'
          : '<span class="pill b">提问</span>';
        let detail = '';
        if (item.kind === 'approval') detail = `${esc(item.toolName)}${item.reason ? '：' + esc(item.reason) : ''}`;
        else if (Array.isArray(item.questions)) detail = item.questions.map((q) => esc(q.question)).join(' / ');
        html += `<tr><td>${esc(item.key)}</td><td>${kind}</td><td>${detail}</td></tr>`;
      }
      box.innerHTML = html + '</table>';
    } catch {
      box.textContent = '读取失败';
    }
  }

  await refresh();
  setInterval(() => { if (document.visibilityState !== 'hidden') void refresh(); }, 3000);
}
