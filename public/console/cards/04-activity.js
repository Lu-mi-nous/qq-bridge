// 04 活动日志（实时消息状态，C2 模块卡）。
//
// 1 秒轮询；保留滚动位置，只有原本已在底部时才自动跟随新消息。
import { api as defaultApi } from '../core/api.js';

const STATUS_CLASSES = new Set(['pending', 'processing', 'replied', 'unread', 'read', 'sent', 'voice-sent']);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));

function fmtTime(ms) {
  const t = Number(ms) || 0;
  if (!t) return '—';
  const d = new Date(t);
  const now = new Date();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (d.toDateString() === now.toDateString()) return hm;
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${hm}`;
}

export async function mount(container, ctx = {}) {
  const api = ctx.api || defaultApi;
  container.textContent = '';
  const line = document.createElement('div');
  line.className = 'meta';
  line.textContent = '实时状态加载中…';
  const feed = document.createElement('div');
  feed.className = 'msg-feed';
  feed.textContent = '（空）';
  container.append(line, feed);
  let busy = false;

  function render(data) {
    const rows = Array.isArray(data?.rows) ? data.rows : [];
    const c = data?.counts || {};
    const pending = (Number(c.pending) || 0) + (Number(c.processing) || 0);
    const sent = (Number(c.sent) || 0) + (Number(c['voice-sent']) || 0);
    line.textContent = `待回复 ${pending} · 处理中 ${Number(c.processing) || 0} · 未读 ${Number(c.unread) || 0}`
      + ` · 已回复 ${Number(c.replied) || 0} · 已发送 ${sent}`
      + (Number(c['voice-sent']) ? `（语音 ${Number(c['voice-sent'])}）` : '');
    window.__CONSOLE_CARD_STATE__ = window.__CONSOLE_CARD_STATE__ || {};
    window.__CONSOLE_CARD_STATE__['04'] = {
      statusText: pending ? `待回复 ${pending} · 已发送 ${sent}` : (sent ? `已发送 ${sent}` : '暂无活动')
    };

    const atBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 30;
    const prevTop = feed.scrollTop;
    if (!rows.length) {
      feed.innerHTML = '<div class="msg-empty">暂无消息活动</div>';
      return;
    }
    feed.innerHTML = rows.map((r) => {
      const voice = !!r.isVoice;
      const rawText = String(r.text || '');
      const body = voice
        ? `<span class="msg-voice">语音</span>${esc(rawText.replace(/^\[语音\]\s*/, '') || '（语音转文字中）')}`
        : esc(rawText || '（无文本）');
      const cls = STATUS_CLASSES.has(String(r.status)) ? String(r.status) : 'read';
      return `<div class="msg-row" title="${esc(rawText)}">
        <span class="msg-time">${fmtTime(r.time)}</span>
        <div class="msg-main">
          <div class="msg-top"><span class="msg-session">${esc(r.session || r.sessionKey || '')}</span><span class="msg-sender">${esc(r.sender || '')}</span></div>
          <div class="msg-text">${body}</div>
        </div>
        <span class="msg-pill ${cls}">${esc(r.label || '')}</span>
      </div>`;
    }).join('');
    feed.scrollTop = atBottom ? feed.scrollHeight : prevTop;
  }

  async function refresh() {
    if (busy) return;
    busy = true;
    try {
      const r = await api(`/api/socialV2/activity-feed?limit=120&t=${Date.now()}`);
      if (!r?.ok) throw new Error(r?.error || '读取失败');
      render(r);
    } catch (error) {
      line.textContent = `实时状态读取失败：${error?.message ?? error}`;
    } finally {
      busy = false;
    }
  }

  await refresh();
  setInterval(() => { if (!document.hidden) void refresh(); }, 1000);
}
