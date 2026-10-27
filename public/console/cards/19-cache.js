// 19 磁盘缓存卡片（C2 模块卡）。
//
// 为什么用模块而不是声明式：这张卡需要「分组表格 + 按当前盘点清单生成确认文案」，
// 声明式字段表达不了；模块只操作自己容器内的 DOM，不碰其它卡片。
import { api as defaultApi } from '../core/api.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));

function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v >= 1024 ** 3) return (v / 1024 ** 3).toFixed(2) + 'GB';
  if (v >= 1024 ** 2) return (v / 1024 ** 2).toFixed(1) + 'MB';
  if (v >= 1024) return (v / 1024).toFixed(0) + 'KB';
  return v + 'B';
}

export async function mount(container, ctx = {}) {
  const api = ctx.api || defaultApi;
  container.textContent = '';
  let items = [];

  const status = document.createElement('div');
  status.className = 'meta';
  status.textContent = '加载中…';
  const body = document.createElement('div');
  body.className = 'cache-body';
  body.style.marginTop = '10px';
  const row = document.createElement('div');
  row.className = 'row';
  row.style.marginTop = '10px';
  const refreshBtn = document.createElement('button');
  refreshBtn.type = 'button';
  refreshBtn.className = 'small';
  refreshBtn.textContent = '重新盘点';
  const purgeBtn = document.createElement('button');
  purgeBtn.type = 'button';
  purgeBtn.className = 'small danger';
  purgeBtn.textContent = '清理可删项';
  const msg = document.createElement('span');
  msg.className = 'meta';
  row.append(refreshBtn, purgeBtn, msg);

  const hint = document.createElement('div');
  hint.className = 'meta';
  hint.style.marginTop = '8px';
  hint.innerHTML = '<b>只删能重新生成的</b>（标「可清」）：语音/报表/菜单/超分缓存、X 媒体、媒体处理临时文件、截图 Chrome 目录、测试截图与旧备份等。'
    + '<b>不动</b>标着「保留」的项（语音模型、图库、黑话库、会话历史、收藏原图）——那些删了要重新下载或丢数据。';

  container.append(status, body, row, hint);

  function render(r) {
    const s = r.summary || {};
    items = Array.isArray(r.items) ? r.items : [];
    const safeText = `可安全清理 ${fmtBytes(s.safeBytes)}`;
    status.innerHTML = `<span class="pill g">${esc(safeText)}</span>`
      + `　${esc(String(s.safeCount || 0))} 项可清 · 全部相关占用 ${esc(fmtBytes(s.totalBytes))}（含保留项）`;
    window.__CONSOLE_CARD_STATE__ = window.__CONSOLE_CARD_STATE__ || {};
    window.__CONSOLE_CARD_STATE__['15'] = { statusText: safeText };

    const groups = Array.isArray(r.groups) && r.groups.length
      ? r.groups
      : [...new Set(items.map((it) => it.group || 'other'))].map((id) => ({ id, label: '' }));
    body.textContent = '';
    for (const group of groups) {
      const list = items.filter((it) => (group.id ? (it.group || 'other') === group.id : true));
      if (!list.length) continue;
      const wrap = document.createElement('div');
      wrap.className = 'cache-group';
      if (group.label) {
        const title = document.createElement('div');
        title.className = 'cache-group-title';
        title.textContent = group.label;
        wrap.appendChild(title);
      }
      const table = document.createElement('table');
      table.className = 'tk-table';
      const thead = document.createElement('thead');
      const headRow = document.createElement('tr');
      for (const [text, cls] of [['', ''], ['项目', ''], ['占用', 'num'], ['文件数', 'num']]) {
        const th = document.createElement('th');
        if (cls) th.className = cls;
        th.textContent = text;
        headRow.appendChild(th);
      }
      thead.appendChild(headRow);
      table.appendChild(thead);
      const tbody = document.createElement('tbody');
      for (const item of list) {
        const tr = document.createElement('tr');
        const tagCell = document.createElement('td');
        tagCell.style.width = '70px';
        tagCell.innerHTML = item.kind === 'keep'
          ? '<span class="pill">保留</span>'
          : '<span class="pill g">可清</span>';
        const labelCell = document.createElement('td');
        labelCell.textContent = item.label || '';
        if (item.note) {
          const note = document.createElement('div');
          note.className = 'meta';
          note.style.fontSize = '11px';
          note.textContent = item.note;
          labelCell.appendChild(note);
        }
        const sizeCell = document.createElement('td');
        sizeCell.className = 'num';
        sizeCell.textContent = item.bytes > 0 ? fmtBytes(item.bytes) : '0';
        const filesCell = document.createElement('td');
        filesCell.className = 'num meta';
        filesCell.textContent = String(item.files || 0);
        tr.append(tagCell, labelCell, sizeCell, filesCell);
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      wrap.appendChild(table);
      body.appendChild(wrap);
    }
  }

  async function refresh() {
    try {
      const r = await api('/api/socialV2/cache');
      if (!r?.ok) { status.textContent = '读取失败'; return; }
      render(r);
    } catch (error) {
      status.textContent = '读取失败：' + (error?.message || error);
    }
  }

  refreshBtn.addEventListener('click', async () => {
    msg.textContent = '正在盘点…';
    await refresh();
    msg.textContent = '已刷新';
    setTimeout(() => { msg.textContent = ''; }, 4000);
  });

  purgeBtn.addEventListener('click', async () => {
    const safe = items.filter((it) => it.kind === 'safe' && it.bytes > 0);
    const keep = items.filter((it) => it.kind === 'keep' && it.bytes > 0);
    if (!safe.length) { msg.textContent = '没有可清理的项'; return; }
    const willDelete = safe.map((it) => `· ${it.label}（${fmtBytes(it.bytes)}）`).join('\n');
    const wontTouch = keep.length ? keep.map((it) => it.label).join('、') : '无';
    if (!window.confirm(`清理所有「可清」项？\n\n会删：\n${willDelete}\n\n不会动：${wontTouch}。\n\n删掉的内容会在用到时自动重新生成。`)) return;
    purgeBtn.disabled = true;
    msg.textContent = '正在清理…';
    try {
      const r = await api('/api/socialV2/cache-purge', 'POST', {});
      if (!r?.ok) throw new Error(r?.error || '清理失败');
      msg.textContent = `✅ 释放 ${r.freedHuman}（${r.removed} 个文件）`;
      await refresh();
    } catch (error) {
      msg.textContent = '失败：' + (error?.message || error);
    } finally {
      purgeBtn.disabled = false;
      setTimeout(() => { msg.textContent = ''; }, 10000);
    }
  });

  await refresh();
  setInterval(() => { if (document.visibilityState !== 'hidden') void refresh(); }, 60000);
}
