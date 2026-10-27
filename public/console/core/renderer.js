// 声明式卡片渲染器（C1 最小字段集）。
//
// 支持：custom-note / text / number / switch / select / textarea / table /
//       list / progress / actions。卡片描述来自 /api/console/manifest，
//       插件永远不能提交 HTML/JS 片段——这里只认这些字段。
import { api } from './api.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));

export function getPath(obj, path) {
  if (!path) return undefined;
  return String(path).split('.').reduce((cur, key) => (cur == null ? undefined : cur[key]), obj);
}

export function setPath(obj, path, value) {
  const keys = String(path).split('.');
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (cur[keys[i]] == null || typeof cur[keys[i]] !== 'object') cur[keys[i]] = {};
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = value;
  return obj;
}

function resolveBody(body, scope) {
  if (typeof body === 'string') {
    // 纯 "$path" 返回原始值；"prefix-${path}" 做字符串插值（如 kind + ':' + id）。
    if (body.startsWith('$') && !body.includes('${')) return getPath(scope, body.slice(1));
    return body.replace(/\$\{([^}]+)\}/g, (_, path) => {
      const value = getPath(scope, path);
      return value == null ? '' : String(value);
    });
  }
  if (Array.isArray(body)) return body.map((item) => resolveBody(item, scope));
  if (body && typeof body === 'object') {
    const out = {};
    for (const [key, value] of Object.entries(body)) out[key] = resolveBody(value, scope);
    return out;
  }
  return body;
}

export function joinStatusText(jr) {
  if (!jr) return '读取中…';
  if (jr.enabled === false) return '已关闭（收到请求会直接拒绝）';
  if (!jr.ownerConfigured) return '未配置管理员（请求会被自动拒绝）';
  if (jr.autoApprove) return '自动同意（仍会私聊告知）';
  const list = Array.isArray(jr.pending) ? jr.pending : [];
  return list.length ? `待处理 ${list.length} 条（请在私聊里用 /yes 编号 或 /no 编号 处理）` : '无待处理';
}

function formatValue(section, scope) {
  if (section.format === 'joinStatus') return joinStatusText(getPath(scope, section.bind));
  const raw = getPath(scope, section.bind);
  if (section.map && raw != null && Object.prototype.hasOwnProperty.call(section.map, raw)) {
    return section.map[raw];
  }
  if (raw == null || raw === '') return section.fallback ?? '—';
  return String(raw);
}

function joinRequestHtml(item) {
  const isFriend = item.requestType === 'friend';
  const who = item.nickname
    ? `${esc(item.nickname)}（${esc(String(item.userId))}）`
    : esc(String(item.userId));
  const target = isFriend
    ? '加好友'
    : `${item.subType === 'add' ? '入群申请' : '群邀请'} → ${item.groupName ? esc(item.groupName) + ' ' : ''}${esc(String(item.groupId))}`;
  const remain = Math.round((Number(item.remainMs) || 0) / 1000);
  return `<div class="dc-list-item">`
    + `<b>#${esc(String(item.n))}</b> ${esc(target)}　${who}`
    + `${item.comment ? `　<span class="dc-muted">「${esc(String(item.comment).slice(0, 40))}」</span>` : ''}`
    + `　<span class="dc-muted">剩 ${esc(String(Math.floor(remain / 60)))}分${esc(String(remain % 60))}秒</span>`
    + `</div>`;
}

function showToast(ctx, text, ok) {
  const el = document.createElement('div');
  el.className = ok ? 'dc-ok' : 'dc-err';
  el.textContent = text;
  ctx.mount.appendChild(el);
  setTimeout(() => { try { el.remove(); } catch {} }, 4000);
}

function renderSection(section, ctx) {
  const { scope, card } = ctx;
  const wrap = document.createElement('div');
  wrap.className = 'dc-section';
  switch (section.type) {
    case 'custom-note': {
      const p = document.createElement('p');
      p.className = 'dc-note';
      p.textContent = section.text || '';
      wrap.appendChild(p);
      break;
    }
    case 'text': {
      const row = document.createElement('div');
      row.className = 'dc-row';
      if (section.label) {
        const label = document.createElement('span');
        label.className = 'dc-label';
        label.textContent = section.label;
        row.appendChild(label);
      }
      const value = document.createElement('span');
      value.className = 'dc-value';
      value.textContent = formatValue(section, scope);
      row.appendChild(value);
      wrap.appendChild(row);
      break;
    }
    case 'input': {
      const row = document.createElement('label');
      row.className = 'dc-row';
      if (section.label) {
        const label = document.createElement('span');
        label.className = 'dc-label';
        label.textContent = section.label;
        row.appendChild(label);
      }
      const input = document.createElement('input');
      input.type = section.inputType || 'text';
      input.className = 'dc-input';
      input.placeholder = section.placeholder || '';
      input.autocomplete = section.autocomplete || 'off';
      const current = getPath(scope, section.bind);
      if (current == null && section.default != null) setPath(scope, section.bind, section.default);
      input.value = getPath(scope, section.bind) ?? '';
      input.addEventListener('input', () => setPath(scope, section.bind, input.value));
      row.appendChild(input);
      wrap.appendChild(row);
      break;
    }
    case 'number': {
      const row = document.createElement('label');
      row.className = 'dc-row';
      if (section.label) {
        const label = document.createElement('span');
        label.className = 'dc-label';
        label.textContent = section.label;
        row.appendChild(label);
      }
      const input = document.createElement('input');
      input.type = 'number';
      input.className = 'dc-input';
      input.value = getPath(scope, section.bind) ?? section.default ?? '';
      if (section.min != null) input.min = String(section.min);
      if (section.max != null) input.max = String(section.max);
      input.addEventListener('input', () => setPath(scope, section.bind, input.value === '' ? '' : Number(input.value)));
      row.appendChild(input);
      wrap.appendChild(row);
      break;
    }
    case 'switch': {
      const row = document.createElement('label');
      row.className = 'dc-row dc-switch-row';
      const text = document.createElement('span');
      text.className = 'dc-label';
      text.textContent = section.label || '';
      const input = document.createElement('input');
      input.type = 'checkbox';
      const raw = getPath(scope, section.bind);
      input.checked = raw === undefined ? section.default !== false : raw !== false;
      input.addEventListener('change', () => setPath(scope, section.bind, input.checked));
      row.append(text, input);
      wrap.appendChild(row);
      break;
    }
    case 'select': {
      const row = document.createElement('label');
      row.className = 'dc-row';
      if (section.label) {
        const label = document.createElement('span');
        label.className = 'dc-label';
        label.textContent = section.label;
        row.appendChild(label);
      }
      const select = document.createElement('select');
      select.className = 'dc-input';
      const current = getPath(scope, section.bind);
      if (current == null && section.default != null) setPath(scope, section.bind, section.default);
      for (const opt of section.options || []) {
        const option = document.createElement('option');
        option.value = String(opt.value);
        option.textContent = opt.label ?? String(opt.value);
        if (String(getPath(scope, section.bind)) === String(opt.value)) option.selected = true;
        select.appendChild(option);
      }
      select.addEventListener('change', () => setPath(scope, section.bind, select.value));
      row.appendChild(select);
      wrap.appendChild(row);
      break;
    }
    case 'textarea': {
      const row = document.createElement('label');
      row.className = 'dc-row dc-column';
      if (section.label) {
        const label = document.createElement('span');
        label.className = 'dc-label';
        label.textContent = section.label;
        row.appendChild(label);
      }
      const area = document.createElement('textarea');
      area.className = 'dc-input';
      area.rows = section.rows || 4;
      area.placeholder = section.placeholder || '';
      const current = getPath(scope, section.bind);
      if (current == null && section.default != null) setPath(scope, section.bind, section.default);
      area.value = getPath(scope, section.bind) ?? '';
      area.addEventListener('input', () => setPath(scope, section.bind, area.value));
      row.appendChild(area);
      wrap.appendChild(row);
      break;
    }
    case 'table': {
      const table = document.createElement('table');
      table.className = 'dc-table';
      const thead = document.createElement('thead');
      const headRow = document.createElement('tr');
      for (const col of section.columns || []) {
        const th = document.createElement('th');
        th.textContent = col.title ?? col.key;
        headRow.appendChild(th);
      }
      thead.appendChild(headRow);
      table.appendChild(thead);
      const tbody = document.createElement('tbody');
      const rows = getPath(scope, section.bind);
      for (const item of Array.isArray(rows) ? rows : []) {
        const tr = document.createElement('tr');
        for (const col of section.columns || []) {
          const td = document.createElement('td');
          td.textContent = String(getPath(item, col.key) ?? '');
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      wrap.appendChild(table);
      break;
    }
    case 'list': {
      const list = document.createElement('div');
      list.className = 'dc-list';
      const rows = getPath(scope, section.bind);
      if (Array.isArray(rows) && rows.length) {
        for (const item of rows) {
          const div = document.createElement('div');
          div.innerHTML = section.template === 'joinRequest'
            ? joinRequestHtml(item)
            : `<div class="dc-list-item">${esc(String(item))}</div>`;
          list.appendChild(div);
        }
      } else if (section.empty) {
        const p = document.createElement('p');
        p.className = 'dc-note';
        p.textContent = section.empty;
        list.appendChild(p);
      }
      wrap.appendChild(list);
      break;
    }
    case 'progress': {
      const row = document.createElement('div');
      row.className = 'dc-row dc-column';
      if (section.label) {
        const label = document.createElement('span');
        label.className = 'dc-label';
        label.textContent = section.label;
        row.appendChild(label);
      }
      const bar = document.createElement('progress');
      bar.className = 'dc-progress';
      bar.max = Number(section.max) || 100;
      bar.value = Number(getPath(scope, section.bind)) || 0;
      row.appendChild(bar);
      wrap.appendChild(row);
      break;
    }
    case 'actions': {
      const row = document.createElement('div');
      row.className = 'dc-actions';
      const msg = document.createElement('span');
      msg.className = 'dc-muted';
      for (const item of section.items || []) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = item.tone === 'danger' ? 'danger' : 'small';
        btn.textContent = item.label || '执行';
        btn.addEventListener('click', async () => {
          if (ctx.busy) return;
          if (item.confirm && !window.confirm(item.confirm)) return;
          ctx.busy = true;
          btn.disabled = true;
          msg.textContent = '执行中…';
          try {
            const body = resolveBody(item.body, scope);
            const data = await api(item.path, item.method || 'POST', body);
            if (item.storeConsoleToken && data?.token) localStorage.setItem('consoleToken', data.token);
            if (item.assign && data) {
              for (const [path, from] of Object.entries(item.assign)) setPath(scope, path, getPath(data, from));
            }
            if (item.waitFor) {
              const { path = '', intervalMs = 1000, timeoutMs = 60000 } = item.waitFor;
              const deadline = Date.now() + Number(timeoutMs);
              let ready = false;
              let waited = 0;
              while (Date.now() < deadline) {
                await new Promise((resolve) => setTimeout(resolve, Number(intervalMs)));
                waited += 1;
                try {
                  const state = await api(path);
                  if (state && state.ok !== false) { ready = true; break; }
                } catch { /* 服务重启中，连接失败是预期 */ }
                msg.textContent = `等待服务恢复…（${waited}s）`;
              }
              if (!ready) throw new Error('等待服务恢复超时，请检查 state/bridge.log');
            }
            await ctx.load();
            const successText = item.successTemplate
              ? item.successTemplate.replace(/\$\{([^}]+)\}/g, (_, path) => String(getPath(data, path) ?? ''))
              : (item.success || '✅ 已完成');
            showToast(ctx, successText, true);
            if (item.reloadAfter) setTimeout(() => location.reload(), 800);
          } catch (error) {
            showToast(ctx, `❌ ${error?.message || error}`, false);
          } finally {
            btn.disabled = false;
            ctx.busy = false;
          }
        });
        row.appendChild(btn);
      }
      row.appendChild(msg);
      wrap.appendChild(row);
      break;
    }
    default: {
      const p = document.createElement('p');
      p.className = 'dc-note';
      p.textContent = `未知字段类型：${section.type}`;
      wrap.appendChild(p);
    }
  }
  // 保存卡片级状态给 legacy 摘要用（12/13/14）。
  if (card.id === '12') {
    const v = getPath(scope, 'sec.security.interceptNotify');
    window.__CONSOLE_CARD_STATE__ = window.__CONSOLE_CARD_STATE__ || {};
    window.__CONSOLE_CARD_STATE__['12'] = { interceptNotify: v !== false };
  } else if (card.id === '13') {
    const enabled = getPath(scope, 'ct.authEnabled');
    window.__CONSOLE_CARD_STATE__ = window.__CONSOLE_CARD_STATE__ || {};
    window.__CONSOLE_CARD_STATE__['13'] = {
      statusText: enabled === true ? '令牌鉴权已开启' : enabled === false ? '令牌鉴权已关闭' : '—'
    };
  } else if (card.id === '14') {
    window.__CONSOLE_CARD_STATE__ = window.__CONSOLE_CARD_STATE__ || {};
    window.__CONSOLE_CARD_STATE__['14'] = { statusText: joinStatusText(getPath(scope, 'jr')) };
  }
  return wrap;
}

export function mountDeclarativeCards(cards, options = {}) {
  const mounted = [];
  for (const card of cards || []) {
    if (card.render !== 'declarative') continue;
    const mount = document.querySelector(`[data-card-mount="${card.id}"]`);
    if (!mount) continue;
    const scope = {};
    const ctx = {
      card,
      mount,
      scope,
      busy: false,
      async load() {
        const sources = Array.isArray(card.data) ? card.data : [];
        await Promise.all(sources.map(async (source) => {
          try {
            scope[source.as] = await (options.api || api)(source.source);
          } catch {
            scope[source.as] = null;
          }
        }));
        mount.textContent = '';
        for (const section of card.sections || []) mount.appendChild(renderSection(section, ctx));
      }
    };
    mounted.push(ctx);
    void ctx.load();
    const ms = Number(card.poll?.ms);
    if (Number.isFinite(ms) && ms >= 1000) {
      setInterval(() => {
        if (document.visibilityState === 'hidden') return;
        void ctx.load();
      }, ms);
    }
  }
  return mounted;
}
