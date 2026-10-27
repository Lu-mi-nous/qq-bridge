// 通用配置卡（凭据 / 连接 / 插件配置项）。
//
// 数据来自核心 `/api/socialV2/credentials` 或插件 `/api/plugins/<id>/config`：
//   { ok, items: [{ key,label,group,kind,restart,doc,configured,value,preview }] }
// 插件自己注册 get/set；本模块只负责通用 UI、脱敏与提交。
import { api as defaultApi } from '../core/api.js';

let credDocTimer = null;
let credDocBound = false;

function ensureCredDocModal() {
  if (!document.getElementById('credDocOverlay')) {
    document.body.insertAdjacentHTML('beforeend', "  <!-- ============ 配置项说明弹窗 ============ -->\n  <div class=\"doc-overlay\" id=\"credDocOverlay\">\n    <div class=\"doc-modal\" role=\"dialog\" aria-modal=\"true\" aria-labelledby=\"credDocTitle\">\n      <div class=\"doc-head\">\n        <b id=\"credDocTitle\">说明</b>\n        <button class=\"doc-close\" id=\"credDocClose\" title=\"关闭（Esc）\">✕</button>\n      </div>\n      <div class=\"doc-body\" id=\"credDocBody\"></div>\n    </div>\n  </div>\n");
  }
  if (credDocBound) return;
  credDocBound = true;
  document.getElementById('credDocClose')?.addEventListener('click', closeCredDoc);
  document.getElementById('credDocOverlay')?.addEventListener('click', (e) => {
    if (e.target?.id === 'credDocOverlay') closeCredDoc();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeCredDoc();
  });
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function renderMd(t) {
  return esc(String(t ?? ''));
}

function closeCredDoc() {
  const overlay = document.getElementById('credDocOverlay');
  if (!overlay) return;
  overlay.classList.remove('open');
  clearTimeout(credDocTimer);
  credDocTimer = setTimeout(() => {
    const body = document.getElementById('credDocBody');
    if (body && !overlay.classList.contains('open')) body.innerHTML = '';
  }, 220);
}

function openCredDoc(item) {
  const overlay = document.getElementById('credDocOverlay');
  const body = document.getElementById('credDocBody');
  const title = document.getElementById('credDocTitle');
  if (!overlay || !body) return;
  title.textContent = item.label || '说明';
  body.innerHTML = renderMd(item.doc || '（这项没有说明文档）');
  body.scrollTop = 0;
  clearTimeout(credDocTimer);
  overlay.classList.add('open');
  setTimeout(() => document.getElementById('credDocClose')?.focus(), 60);
}

function fieldRowHtml(item) {
  const configured = item.configured
    ? '<span class="cred-tag ok">已配置</span>'
    : '<span class="cred-tag">未配置</span>';
  const restart = item.restart
    ? '<span class="cred-tag warn" title="保存后需点「重启桥接」才生效">需重启</span>'
    : '<span class="cred-tag" title="保存后立即生效">即时生效</span>';
  const kind = String(item.kind || 'text');
  const secret = kind === 'secret';
  const preview = String(item.preview || '');
  const value = secret ? preview : String(item.value ?? '');
  const ph = item.configured ? '输入新值（留空表示不修改）' : '未配置，点击填写';
  const common = `data-cred="${esc(item.key)}" data-configured="${item.configured ? '1' : '0'}" data-preview="${esc(preview)}"`;
  let control = '';
  if (kind === 'switch') {
    const on = String(item.value ?? '') === 'true' || item.value === true;
    control = `<input type="checkbox" ${common} ${on ? 'checked' : ''} style="width:auto">`;
  } else if (kind === 'select') {
    const opts = (item.options || []).map((o) => `<option value="${esc(o.value)}" ${String(o.value) === String(item.value) ? 'selected' : ''}>${esc(o.label ?? o.value)}</option>`).join('');
    control = `<select ${common}>${opts || '<option value="">（无可选项）</option>'}</select>`;
  } else if (kind === 'textarea') {
    control = `<textarea rows="3" ${common}>${esc(item.value ?? '')}</textarea>`;
  } else {
    const type = kind === 'number' ? 'number' : 'text';
    control = `<input type="${type}"
      class="${item.configured && secret ? 'masked' : ''}"
      ${common}
      placeholder="${esc(ph)}"
      autocomplete="off" spellcheck="false"
      value="${esc(value)}">`;
  }
  return `
    <div class="cred-row" data-key="${esc(item.key)}">
      <div class="cred-label">
        <span>${esc(item.label)}</span>
        <span class="meta">${configured} ${restart}</span>
      </div>
      <div class="cred-input-wrap${secret ? ' has-eye' : ''}">
        ${control}
        ${secret ? `<button class="cred-eye" data-eye="${esc(item.key)}" title="显示/隐藏">👁</button>` : ''}
      </div>
      ${item.doc ? `<button class="cred-guide" data-doc="${esc(item.key)}" title="查看这项怎么配">?</button>` : ''}
    </div>`;
}

export async function mount(container, ctx = {}) {
  const api = ctx.api || defaultApi;
  const endpoint = String(ctx.card?.configEndpoint || '').trim();
  ensureCredDocModal();
  if (!endpoint) {
    container.textContent = '配置端点缺失';
    return;
  }

  const items = [];
  const edited = new Map(); // key -> 用户输入的新值（DOM 重建不丢）

  container.innerHTML = `
    <div class="meta cred-status">加载中…</div>
    <div class="cred-body" style="margin-top:10px"></div>
    <div class="row" style="margin-top:10px">
      <button class="small cred-save" type="button">保存改动</button>
      <button class="small cred-restart" type="button">重启桥接</button>
      <span class="meta cred-msg"></span>
    </div>
    <div class="meta cred-hint">
      这些值只在本机控制台与桥接之间流转，默认全部打码，点右侧<span class="cred-eye-inline">👁</span>才显示明文。
      标着 <b>需重启</b> 的项保存后要按「重启桥接」才生效；其余保存即生效。
      每项右侧的 <b>?</b> 打开说明。
    </div>`;

  const statusEl = container.querySelector('.cred-status');
  const bodyEl = container.querySelector('.cred-body');
  const msgEl = container.querySelector('.cred-msg');
  const saveBtn = container.querySelector('.cred-save');
  const restartBtn = container.querySelector('.cred-restart');

  function setMsg(text) { if (msgEl) msgEl.textContent = text || ''; }

  async function load() {
    try {
      const r = await api(endpoint);
      if (!r?.ok) throw new Error(r?.error || '读取失败');
      items.length = 0;
      items.push(...(Array.isArray(r.items) ? r.items : []));
      const groups = new Map();
      for (const item of items) {
        if (!groups.has(item.group)) groups.set(item.group, []);
        groups.get(item.group).push(item);
      }
      bodyEl.innerHTML = [...groups.entries()].map(([group, list]) => `
        <div class="cred-group">
          <div class="cred-group-title">${esc(group)}</div>
          ${list.map(fieldRowHtml).join('')}
        </div>`).join('') || '<div class="meta">没有可配置项</div>';
      const ready = items.filter((x) => x.configured).length;
      if (statusEl) {
        statusEl.innerHTML = `<span class="pill g">${ready} / ${items.length} 已配置</span>`
          + ' 明文不会下发到页面，点 <b>👁</b> 才临时读取';
      }
      bindRows();
    } catch (e) {
      if (statusEl) statusEl.textContent = '读取失败：' + (e?.message || e);
    }
  }

  function bindRows() {
    bodyEl.querySelectorAll('[data-doc]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const it = items.find((x) => x.key === btn.dataset.doc);
        if (it) openCredDoc(it);
      });
    });
    bodyEl.querySelectorAll('[data-eye]').forEach((btn) => {
      btn.addEventListener('click', () => { void toggleReveal(btn.dataset.eye); });
    });
    bodyEl.querySelectorAll('[data-cred]').forEach((input) => {
      const pending = edited.get(input.dataset.cred);
      if (pending !== undefined) {
        if (input.type === 'checkbox') input.checked = pending === true || pending === 'true';
        else input.value = pending;
        input.dataset.edited = '1';
        input.classList.remove('masked');
      }
      const read = () => input.type === 'checkbox' ? String(input.checked) : input.value;
      const event = input.tagName === 'SELECT' ? 'change' : 'input';
      input.addEventListener(event, () => {
        edited.set(input.dataset.cred, read());
        input.dataset.edited = '1';
        input.classList.remove('masked');
      });
    });
  }

  async function toggleReveal(key) {
    const row = bodyEl.querySelector(`.cred-row[data-key="${key}"]`);
    if (!row) return;
    const input = row.querySelector(`[data-cred="${key}"]`);
    const btn = row.querySelector(`[data-eye="${key}"]`);
    if (!input) return;
    if (!input.classList.contains('masked')) {
      input.value = input.dataset.preview || '';
      input.classList.add('masked');
      if (btn) btn.textContent = '👁';
      return;
    }
    if (btn) btn.textContent = '…';
    let plain = '';
    try {
      const sep = endpoint.includes('?') ? '&' : '?';
      const r = await api(`${endpoint}${sep}reveal=1&key=${encodeURIComponent(key)}`);
      const it = r?.items?.[0];
      if (r?.ok && it) plain = it.value || '';
    } catch {}
    if (btn) btn.textContent = '👁';
    if (input.dataset.edited === '1') {
      input.classList.remove('masked');
      return;
    }
    if (plain) {
      input.value = plain;
      input.classList.remove('masked');
      input.focus();
      try { input.setSelectionRange(plain.length, plain.length); } catch {}
    }
  }

  saveBtn?.addEventListener('click', async () => {
    if (!edited.size) { setMsg('没有改动'); setTimeout(() => setMsg(''), 4000); return; }
    if (saveBtn) saveBtn.disabled = true;
    let okCount = 0;
    const okKeys = [];
    const failures = [];
    let needRestart = false;
    for (const [key, pendingValue] of edited) {
      const item = items.find((x) => x.key === key);
      if (!item) continue;
      let value = pendingValue;
      if (value === undefined) {
        const input = bodyEl.querySelector(`[data-cred="${key}"]`);
        if (!input || input.dataset.edited !== '1') continue;
        value = input.type === 'checkbox' ? String(input.checked) : input.value;
      }
      try {
        const r = await api(endpoint, 'POST', { key, value });
        if (r?.ok) {
          okCount += 1;
          okKeys.push(key);
          if (r.restart) needRestart = true;
        } else {
          failures.push(`${key}: ${r?.error || '未知错误'}`);
        }
      } catch (e) {
        failures.push(`${key}: ${e?.message || e}`);
      }
    }
    if (saveBtn) saveBtn.disabled = false;
    setMsg(failures.length
      ? `保存 ${okCount} 项，失败 ${failures.length} 项：${failures.join('；')}`
      : `已保存 ${okCount} 项${needRestart ? '，其中部分需重启桥接才生效' : '（已生效）'}`);
    for (const key of okKeys) edited.delete(key);
    await load();
    setTimeout(() => setMsg(''), 12000);
  });

  restartBtn?.addEventListener('click', async () => {
    if (!confirm('确定重启桥接？当前进行中的对话会被中断（若由守护脚本启动，约 5 秒后自动恢复）。')) return;
    if (restartBtn) restartBtn.disabled = true;
    setMsg('正在重启…');
    try {
      const r = await api('/api/restart', 'POST', {});
      setMsg(r?.message || '正在重启…');
      let back = false;
      for (let i = 0; i < 60; i++) {
        await new Promise((res) => setTimeout(res, 1000));
        try {
          const st = await api(endpoint);
          if (st?.ok) { back = true; break; }
        } catch {}
        setMsg(`正在重启…（${i + 1}s）`);
      }
      setMsg(back ? '✅ 桥接已恢复' : '⚠️ 桥接 60 秒内未恢复，请检查 state/bridge.log');
      if (back) await load();
    } catch (e) {
      setMsg('重启命令发送失败：' + (e?.message || e));
    } finally {
      if (restartBtn) restartBtn.disabled = false;
    }
  });

  await load();
}
