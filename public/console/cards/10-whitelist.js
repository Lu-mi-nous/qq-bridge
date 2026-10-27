// 10 白名单 / 管理员（C5 真模块卡）。
import { api as defaultApi } from '../core/api.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));

const FIELDS = {
  allowGroups: { id: 'wlGroups', label: '允许的群号', unit: '群号', list: true },
  allowPrivate: { id: 'wlPrivate', label: '允许的私聊 QQ', unit: 'QQ 号', list: true },
  ownerQQ: { id: 'ownerQQ', label: '管理员 QQ', unit: 'QQ 号', list: false },
  denyGroups: { id: 'dnGroups', label: '拒绝的群号', unit: '群号', list: true },
  denyPrivate: { id: 'dnPrivate', label: '拒绝的私聊 QQ', unit: 'QQ 号', list: true }
};

const TEMPLATE = `
<label>私聊准入策略</label>
<div class="row">
  <select id="wlPrivateMode" style="flex:1">
    <option value="friends">好友自动放行（推荐）— 是你的 QQ 好友就能私聊，非好友仍需白名单</option>
    <option value="all">纯黑名单 — 除黑名单外任何私聊都收（群里陌生人也能私聊，慎用）</option>
    <option value="list">白名单 — 只有下面列出的 QQ 能私聊（旧行为）</option>
  </select>
</div>
<div class="meta" id="wlPrivateModeHint">好友自动放行：不用再手动加好友到名单；非好友（群内临时会话）仍需命中下面的白名单。</div>
<div class="meta" style="margin-top:10px">下面的名单用下拉菜单管理：选中一项后可删除；点「＋ 添加」输入新号码，改动会立即保存。</div>
<label>允许的群号</label>
<div class="wl-edit-row"><select id="wlGroups" aria-label="允许的群号"></select><button class="small" type="button" data-wl-add="allowGroups">＋ 添加</button><button class="small danger" type="button" data-wl-del="allowGroups">删除</button></div>
<label>允许的私聊 QQ</label>
<div class="wl-edit-row"><select id="wlPrivate" aria-label="允许的私聊 QQ"></select><button class="small" type="button" data-wl-add="allowPrivate">＋ 添加</button><button class="small danger" type="button" data-wl-del="allowPrivate">删除</button></div>
<div class="meta" id="wlPrivateHint">「好友自动放行」模式下这里只需填**非好友**（比如临时会话来源）；好友无需列出。</div>
<label>管理员 QQ（ownerQQ，最高权限）</label>
<div class="wl-edit-row"><select id="ownerQQ" aria-label="管理员 QQ"></select><button class="small" type="button" data-wl-add="ownerQQ">＋ 添加</button><button class="small danger" type="button" data-wl-del="ownerQQ">删除</button></div>
<div class="meta">管理员是唯一可执行管理命令/审批/closed-agent 的 QQ；可留空清除（清除后无管理员，fail-closed）。</div>
<label>拒绝的群号（黑名单）</label>
<div class="wl-edit-row"><select id="dnGroups" aria-label="拒绝的群号"></select><button class="small" type="button" data-wl-add="denyGroups">＋ 添加</button><button class="small danger" type="button" data-wl-del="denyGroups">删除</button></div>
<label>拒绝的私聊 QQ（黑名单）</label>
<div class="wl-edit-row"><select id="dnPrivate" aria-label="拒绝的私聊 QQ"></select><button class="small" type="button" data-wl-add="denyPrivate">＋ 添加</button><button class="small danger" type="button" data-wl-del="denyPrivate">删除</button></div>
<div class="meta">黑名单优先级最高：即使在白名单里、或是你的好友，命中黑名单也一律拒绝。</div>
<div class="row" style="margin-top:10px"><button id="wlSave">保存白名单</button><span class="meta">保存后立即生效并写入 config.json</span><span class="meta" id="wlMsg"></span></div>
`;

export async function mount(container, ctx = {}) {
  const api = ctx.api || defaultApi;
  container.innerHTML = TEMPLATE;
  const $ = (id) => document.getElementById(id);
  let state = { allowGroups: [], allowPrivate: [], ownerQQ: '', denyGroups: [], denyPrivate: [], privateMode: 'friends' };
  let names = { groups: {}, privates: {} };

  function setMsg(text, ok) {
    const el = $('wlMsg');
    if (!el) return;
    el.textContent = text || '';
    el.className = ok ? 'meta ok' : 'meta err';
  }

  function renderSelect(key) {
    const f = FIELDS[key];
    const sel = $(f.id);
    if (!sel) return;
    const values = f.list ? (state[key] || []) : (state.ownerQQ ? [state.ownerQQ] : []);
    const isGroup = key === 'allowGroups' || key === 'denyGroups';
    const map = isGroup ? names.groups : names.privates;
    const labelOf = (v) => map[String(v)] ? `${v}（${map[String(v)]}）` : (isGroup ? `${v}（未在当前群列表）` : `${v}（未知昵称）`);
    const prev = sel.value;
    sel.innerHTML = values.length ? values.map((v) => `<option value="${esc(String(v))}">${esc(labelOf(v))}</option>`).join('') : '<option value="">— 暂无 —</option>';
    if (prev && values.some((v) => String(v) === prev)) sel.value = prev;
  }

  function renderAll() { Object.keys(FIELDS).forEach(renderSelect); }

  function updateHint(mode, friendCount) {
    const n = typeof friendCount === 'number' ? `（当前识别到 ${friendCount} 位好友）` : '';
    $('wlPrivateModeHint').textContent = mode === 'friends'
      ? `好友自动放行${n}：是你的 QQ 好友就能私聊，**不需要手动加到下面**；非好友（群内临时会话）仍需命中白名单。`
      : mode === 'all'
        ? '纯黑名单：除黑名单外任何私聊都收。⚠️ 群里的陌生人也能通过临时会话私聊机器人，仅在完全信任的场景使用。'
        : '白名单：只有下面列出的 QQ 能私聊，其余一律拒绝（旧行为）。';
  }

  function publishState() {
    window.__WL_STATE__ = { ...state };
    window.__CONSOLE_CARD_STATE__ = window.__CONSOLE_CARD_STATE__ || {};
    const pmodeLabel = state.privateMode === 'friends' ? '好友放行' : state.privateMode === 'all' ? '全放开' : '白名单';
    window.__CONSOLE_CARD_STATE__['09'] = { statusText: `群 ${state.allowGroups.length} · 私聊 ${state.allowPrivate.length} ｜ ${pmodeLabel}${state.ownerQQ ? '' : ' · 无管理员'}` };
  }

  async function refresh() {
    try {
      const w = await api('/api/whitelist');
      names = {
        groups: w.groupNames && typeof w.groupNames === 'object' ? w.groupNames : {},
        privates: w.privateNames && typeof w.privateNames === 'object' ? w.privateNames : {}
      };
      state = {
        allowGroups: (w.allow?.groups || []).map(Number).filter(Number.isFinite),
        allowPrivate: (w.allow?.private || []).map(Number).filter(Number.isFinite),
        ownerQQ: w.ownerQQ != null ? String(w.ownerQQ) : '',
        denyGroups: (w.deny?.groups || []).map(Number).filter(Number.isFinite),
        denyPrivate: (w.deny?.private || []).map(Number).filter(Number.isFinite),
        privateMode: w.privateMode || 'list'
      };
      renderAll();
      $('wlPrivateMode').value = state.privateMode;
      updateHint(state.privateMode, w.friendCount);
      publishState();
      if (typeof window.refreshSummaries === 'function') window.refreshSummaries();
    } catch { /* ignore */ }
  }

  function payload(mode) {
    return {
      allow: { private: state.allowPrivate, groups: state.allowGroups, privateMode: mode },
      deny: { private: state.denyPrivate, groups: state.denyGroups },
      ownerQQ: state.ownerQQ
    };
  }

  async function persist(mode, okText) {
    try {
      const r = await api('/api/whitelist', 'POST', payload(mode));
      if (!r.ok) { setMsg(`保存失败：${r.error || '未知原因'}`, false); await refresh(); return false; }
      setMsg(okText, true);
      state.privateMode = mode;
      publishState();
      if (typeof window.refresh === 'function') window.refresh();
      if (typeof window.refreshSummaries === 'function') window.refreshSummaries();
      return true;
    } catch (error) {
      setMsg('保存失败：' + (error?.message || error), false);
      return false;
    }
  }

  async function addItem(key) {
    const f = FIELDS[key];
    const raw = window.prompt(`${f.list ? '添加' : '设置'}${f.label}（${f.unit}）：`, f.list ? '' : state.ownerQQ);
    if (raw == null) return;
    const value = raw.trim();
    if (!/^\d{5,12}$/.test(value)) { window.alert('请输入 5~12 位数字的群号 / QQ 号'); return; }
    const n = Number(value);
    if (f.list) {
      if (state[key].some((x) => Number(x) === n)) { window.alert('这个号码已经在列表里了'); return; }
      state[key].push(n);
    } else {
      if (state.ownerQQ === value) { window.alert('这已经是当前管理员'); return; }
      if (state.ownerQQ && !window.confirm(`把管理员从 ${state.ownerQQ} 改为 ${value}？`)) return;
      state.ownerQQ = value;
    }
    renderSelect(key); $(f.id).value = String(value);
    publishState();
    await persist(state.privateMode, `已添加 ${value} 并保存`);
  }

  async function delItem(key) {
    const f = FIELDS[key];
    if (!f.list) {
      if (!state.ownerQQ) { window.alert('当前没有配置管理员'); return; }
      if (!window.confirm(`清除管理员 ${state.ownerQQ}？清除后将没有人能执行管理命令。`)) return;
      const old = state.ownerQQ;
      state.ownerQQ = '';
      renderSelect(key); publishState();
      await persist(state.privateMode, `已清除管理员 ${old}`);
      return;
    }
    const value = $(f.id)?.value || '';
    if (!value) { window.alert('列表为空，没有可删除的项'); return; }
    if (!window.confirm(`从「${f.label}」中删除 ${value}？`)) return;
    state[key] = state[key].filter((x) => String(x) !== String(value));
    renderSelect(key); publishState();
    await persist(state.privateMode, `已删除 ${value} 并保存`);
  }

  document.querySelectorAll('[data-wl-add]').forEach((btn) => btn.addEventListener('click', () => { void addItem(btn.dataset.wlAdd); }));
  document.querySelectorAll('[data-wl-del]').forEach((btn) => btn.addEventListener('click', () => { void delItem(btn.dataset.wlDel); }));
  $('wlPrivateMode').addEventListener('change', (e) => updateHint(e.target.value, null));
  $('wlSave').addEventListener('click', async () => {
    const mode = $('wlPrivateMode').value;
    if (mode === 'all' && !window.confirm('「纯黑名单」会让任何 QQ 都能私聊机器人（包括群里的陌生人通过临时会话）。确定？')) return;
    const label = { list: '白名单', friends: '好友自动放行', all: '纯黑名单' }[mode] || mode;
    await persist(mode, `白名单已保存并生效（私聊策略：${label}）`);
    await refresh();
  });

  await refresh();
}
