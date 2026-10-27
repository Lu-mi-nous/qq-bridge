// 05 人格（角色扮演，C5 真模块卡，逻辑自 legacy-runtime 迁入）。
import { api as defaultApi } from '../core/api.js';

export async function mount(container, ctx = {}) {
  const api = ctx.api || defaultApi;
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
  const renderMd = (t) => esc(String(t ?? ''));
  container.innerHTML = "      <div class=\"meta\" style=\"margin-bottom:10px\">每个群可以单独选择人格；未单独设置的群跟随默认人格。群名来自机器人当前所在群列表；不在列表中的群只显示群号（可能已退群/被踢，或不在当前账号）。</div>\n\n      <div class=\"role-seg role-seg-main\" id=\"roleMainSeg\">\n        <div class=\"role-seg-inner\">\n          <div class=\"role-toolbar\">\n            <label style=\"margin:0\">默认人格</label>\n            <select id=\"roleDefaultSelect\"><option value=\"\">加载中…</option></select>\n            <span class=\"meta\">状态：<span id=\"roleModeText\">-</span></span>\n            <span class=\"meta\" id=\"roleAssignSummary\"></span>\n            <span class=\"meta\" style=\"display:none\" id=\"roleText\">-</span>\n          </div>\n          <div class=\"role-layout\">\n            <div class=\"role-groups-col\">\n              <div class=\"row\" style=\"margin-bottom:8px\">\n                <input id=\"roleGroupFilter\" placeholder=\"筛选群号/群名\" style=\"flex:1\">\n                <button id=\"roleRefresh\" class=\"small\">刷新</button>\n              </div>\n              <div id=\"roleGroupList\" class=\"role-group-list\">加载中…</div>\n            </div>\n            <div class=\"role-side-col\">\n              <div class=\"meta\">人格库（点击预览，标题栏「编辑」可直接改；用上方下拉设置默认，用群列表下拉设置单群）</div>\n              <div id=\"roleList\" class=\"role-tags\">加载中…</div>\n              <div class=\"md-panel\" id=\"rolePreviewPanel\">\n                <div class=\"md-panel-hd\">\n                  <span class=\"meta\" id=\"rolePreviewMeta\">人格卡内容</span>\n                  <button id=\"roleEditBtn\" class=\"small role-edit-btn\" hidden>编辑</button>\n                </div>\n                <div id=\"rolePreviewBody\" class=\"md-body\"><span class=\"meta\">选择角色后显示内容</span></div>\n                <div id=\"roleEditor\" class=\"role-editor\" hidden>\n                  <textarea id=\"roleEditorText\" class=\"role-edit-area\" spellcheck=\"false\" placeholder=\"角色设定（Markdown）\"></textarea>\n                  <div class=\"role-edit-actions\">\n                    <button id=\"roleEditSave\" class=\"small\">保存</button>\n                    <button id=\"roleEditCancel\" class=\"small\">取消</button>\n                    <span class=\"role-edit-msg\" id=\"roleEditMsg\"></span>\n                  </div>\n                </div>\n              </div>\n            </div>\n          </div>\n        </div>\n      </div>\n\n      <!-- 段二：新建表单（默认收起，高度 0） -->\n      <div class=\"role-seg role-seg-create\" id=\"roleCreateSeg\">\n        <div class=\"role-seg-inner\">\n          <div class=\"meta\" style=\"margin-bottom:6px\">新建人格（创建后可在角色库里预览，再分配给群）</div>\n          <label>角色名</label>\n          <input type=\"text\" id=\"newRoleName\" placeholder=\"如：猫娘\">\n          <label>角色设定（Markdown）</label>\n          <textarea id=\"newRoleContent\" placeholder=\"- 性格：…&#10;- 说话风格：…&#10;- 背景设定：…\"></textarea>\n          <div class=\"row\" style=\"margin-top:8px\">\n            <button id=\"roleCreate\">创建人格</button>\n            <button id=\"roleCreateCancel\" class=\"small\">取消</button>\n            <span class=\"meta\" id=\"roleCreateMsg\"></span>\n          </div>\n        </div>\n      </div>\n\n      <!-- 底部固定操作条：切换两段 -->\n      <div class=\"role-foot\">\n        <button id=\"roleToggleCreate\" class=\"small\">＋ 新建人格</button>\n      </div>\n      <div class=\"declarative-card\" data-card-mount=\"05\"></div>";

let roleAssignments = { defaultRole: null, mode: 'active', roles: [], conversations: [] };
let rolePreviewKey = '';
let rolePreviewName = '';
let roleAssignmentsBusy = false;
// 05 人格卡编辑（2026-10-23 用户要求「人格卡不能直接在控制台修改」）
let roleEditing = false;
let roleEditDirty = false;
let roleEditName = '';
const ROLE_HINT_LIMIT = 12000;

function roleLabelOf(item) {
  return item?.name ? String(item.name) : `群 ${item?.id || ''}`;
}

function renderRoleTags(roles, defaultRole) {
  const box = document.getElementById('roleList');
  if (!box) return;
  box.innerHTML = '';
  if (!roles.length) { box.innerHTML = '<span class="meta">暂无角色，可在下方新建</span>'; return; }
  for (const name of roles) {
    const tag = document.createElement('span');
    tag.className = 'tag' + (name === rolePreviewName ? ' active' : '');
    tag.textContent = name;
    tag.title = '点击预览，标题栏「编辑」可直接改；用上方默认人格下拉设置默认，用群列表下拉设置单群';
    tag.addEventListener('click', () => {
      if (name === rolePreviewName) return;
      if (!confirmDiscardRoleEdit()) return;
      if (roleEditing) exitRoleEdit();
      rolePreviewKey = '';
      loadRolePreview(name);
    });
    box.appendChild(tag);
  }
}

function renderRoleGroups() {
  const box = document.getElementById('roleGroupList');
  if (!box) return;
  const q = String(document.getElementById('roleGroupFilter')?.value || '').trim().toLowerCase();
  // 人格卡只显示机器人当前所在群；已离群会话在 24 号卡单独清理。
  const all = (Array.isArray(roleAssignments.conversations) ? roleAssignments.conversations : []).filter((x) => x.inGroupList !== false);
  const list = q ? all.filter((x) => `${x.key} ${x.name || ''}`.toLowerCase().includes(q)) : all;
  if (!list.length) { box.innerHTML = '<div class="role-group-empty">没有匹配的群</div>'; return; }
  const roles = Array.isArray(roleAssignments.roles) ? roleAssignments.roles : [];
  const defaultRole = roleAssignments.defaultRole || '';
  box.innerHTML = list.map((x) => {
    const selected = x.overrideRole || '';
    const opts = [`<option value="">跟随默认（${esc(defaultRole || '无')}）</option>`]
      .concat(roles.map((r) => `<option value="${esc(r)}"${r === selected ? ' selected' : ''}>${esc(r)}</option>`));
    if (selected && !roles.includes(selected)) {
      opts.push(`<option value="${esc(selected)}" selected>${esc(selected)}（角色已删除）</option>`);
    }
    return `<div class="role-group-row${x.key === rolePreviewKey ? ' active' : ''}" data-key="${esc(x.key)}">`
      + `<div class="role-group-main"><div class="role-group-name">${esc(roleLabelOf(x))}</div>`
      + `<div class="role-group-key">${esc(x.key)}${x.inGroupList === false ? ' · 未在当前群列表' : (x.overrideRole ? ' · 单独设置' : ' · 跟随默认')}</div></div>`
      + `<span class="tag${x.overrideRole ? ' active' : ''}">${esc(x.effectiveRole || '无角色')}</span>`
      + `<select class="role-group-select" data-key="${esc(x.key)}">${opts.join('')}</select>`
      + `</div>`;
  }).join('');
}

async function refreshRoles(force = false) {
  // 用户正在操作群列表/默认下拉时不要重建 DOM，避免把选择框冲掉；手动刷新和变更后传 force。
  if (!force && (document.activeElement?.closest?.('#roleGroupList') || document.activeElement?.id === 'roleDefaultSelect')) return;
  if (roleAssignmentsBusy) return;
  roleAssignmentsBusy = true;
  try {
    const r = await api('/api/role-assignments');
    if (!r?.ok) throw new Error(r?.error || '读取失败');
    roleAssignments = r;
    const defaultSel = document.getElementById('roleDefaultSelect');
    const roleText = document.getElementById('roleText');
    const modeText = document.getElementById('roleModeText');
    if (roleText) roleText.textContent = r.defaultRole || '无';
    if (modeText) modeText.textContent = r.mode === 'silent' ? '静默' : '正常';
    if (defaultSel && document.activeElement !== defaultSel) {
      const roles = Array.isArray(r.roles) ? r.roles : [];
      defaultSel.innerHTML = '<option value="">无角色（闲聊）</option>'
        + roles.map((name) => `<option value="${esc(name)}">${esc(name)}</option>`).join('');
      if (r.defaultRole && !roles.includes(r.defaultRole)) {
        defaultSel.innerHTML += `<option value="${esc(r.defaultRole)}">${esc(r.defaultRole)}（角色已删除）</option>`;
      }
      defaultSel.value = r.defaultRole || '';
    }
    renderRoleTags(Array.isArray(r.roles) ? r.roles : [], r.defaultRole || '');
    renderRoleGroups();
    const visibleGroups = (r.conversations || []).filter((x) => x.inGroupList !== false);
    const overrides = visibleGroups.filter((x) => x.overrideRole).length;
    const summary = `共 ${visibleGroups.length} 个群 · ${overrides} 个单独设置`;
    const sumEl = document.getElementById('roleAssignSummary');
    if (sumEl) sumEl.textContent = summary;
    setSummary('05', `默认 ${r.defaultRole || '无'} · ${overrides} 群单独设置`);
    if (!rolePreviewKey) {
      // 保留用户点选的人格标签：否则 15 秒自动刷新会把预览/编辑对象弹回默认人格。
      await loadRolePreview(rolePreviewName || r.defaultRole || '');
    } else {
      const item = (r.conversations || []).find((x) => x.key === rolePreviewKey);
      if (item) await loadRolePreview(item.effectiveRole || '');
    }
  } catch (e) {
    const box = document.getElementById('roleGroupList');
    if (box) box.textContent = '加载失败：' + String(e?.message || e);
  } finally {
    roleAssignmentsBusy = false;
  }
}

// 当前角色卡内容预览（Markdown → HTML 渲染，展示在 05 卡片右侧）。
async function loadRolePreview(name) {
  const box = document.getElementById('rolePreviewBody');
  const meta = document.getElementById('rolePreviewMeta');
  const editBtn = document.getElementById('roleEditBtn');
  if (!box || !meta) return;
  // 编辑中不要被 15 秒自动刷新覆盖掉用户正在改的内容
  if (roleEditing) return;
  if (!name) {
    rolePreviewName = '';
    if (editBtn) editBtn.hidden = true;
    meta.textContent = '人格卡内容';
    box.innerHTML = '<span class="meta">当前没有生效的人格（闲聊模式）。选择角色后这里会显示它的内容。</span>';
    renderRoleTags(roleAssignments.roles || [], roleAssignments.defaultRole || '');
    return;
  }
  rolePreviewName = name;
  meta.textContent = `${name} · 读取中…`;
  box.innerHTML = '<span class="meta">读取中…</span>';
  try {
    const r = await api(`/api/role-content?name=${encodeURIComponent(name)}`);
    if (rolePreviewName !== name) return;
    if (!r.ok) {
      meta.textContent = name;
      if (editBtn) editBtn.hidden = true;
      box.innerHTML = `<span class="meta">读取失败：${esc(r.error || '未知')}</span>`;
    } else {
      box.innerHTML = renderMd(r.content);
      const kb = (r.bytes / 1024).toFixed(1);
      meta.textContent = `${name} · ${r.content.split('\n').length} 行 · ${kb}KB`;
      if (editBtn) editBtn.hidden = false;
    }
  } catch (e) {
    if (rolePreviewName !== name) return;
    meta.textContent = name;
    box.innerHTML = `<span class="meta">读取失败：${esc(String(e?.message || e))}</span>`;
  }
  renderRoleTags(roleAssignments.roles || [], roleAssignments.defaultRole || '');
}

// ── 05 人格卡编辑 ───────────────────────────────────────────────────────
// 只改正文，不改文件名；保存后写 roles/<name>.md 并立即热更新（按 mtime 失效）。
function roleEditDirtyNow() { return roleEditing && roleEditDirty; }
function confirmDiscardRoleEdit() {
  return !roleEditDirtyNow() || confirm('人格卡还有未保存的修改，确定放弃？');
}
function setRoleEditMsg(text, kind = '') {
  const msg = document.getElementById('roleEditMsg');
  if (!msg) return;
  msg.textContent = text || '';
  msg.classList.toggle('warn', kind === 'warn');
  msg.classList.toggle('ok', kind === 'ok');
}
function updateRoleEditMeta() {
  const ta = document.getElementById('roleEditorText');
  const msg = document.getElementById('roleEditMsg');
  if (!ta || !msg) return;
  const chars = ta.value.length;
  const lines = ta.value.split('\n').length;
  let text = `${chars} 字 · ${lines} 行 · Ctrl+Enter 保存 · Esc 取消`;
  const over = chars > ROLE_HINT_LIMIT;
  if (over) text += ` · 超过 ${ROLE_HINT_LIMIT} 字会被截断，末尾不会进提示词`;
  msg.textContent = text;
  msg.classList.toggle('warn', over);
  msg.classList.remove('ok');
}
function setRoleEditMode(on) {
  roleEditing = !!on;
  const ed = document.getElementById('roleEditor');
  const body = document.getElementById('rolePreviewBody');
  const btn = document.getElementById('roleEditBtn');
  if (ed) ed.hidden = !on;
  if (body) body.hidden = !!on;
  if (btn) btn.hidden = !!on || !rolePreviewName;
}
async function startRoleEdit() {
  if (!rolePreviewName) return;
  if (!confirmDiscardRoleEdit()) return;
  const name = rolePreviewName;
  try {
    const r = await api(`/api/role-content?name=${encodeURIComponent(name)}`);
    if (!r.ok) { alert(r.error || '读取失败'); return; }
    roleEditName = name;
    const ta = document.getElementById('roleEditorText');
    if (!ta) return;
    ta.value = r.content || '';
    roleEditDirty = false;
    setRoleEditMode(true);
    updateRoleEditMeta();
    ta.focus();
    ta.setSelectionRange(0, 0);
    ta.scrollTop = 0;
  } catch (e) {
    alert('读取失败：' + String(e?.message || e));
  }
}
function exitRoleEdit() {
  roleEditing = false;
  roleEditDirty = false;
  roleEditName = '';
  setRoleEditMode(false);
}
function cancelRoleEdit() {
  if (!confirmDiscardRoleEdit()) return;
  exitRoleEdit();
}
async function saveRoleEdit() {
  if (!roleEditing) return;
  const ta = document.getElementById('roleEditorText');
  const name = roleEditName || rolePreviewName;
  if (!ta || !name) return;
  const content = ta.value;
  if (!content.trim()) { setRoleEditMsg('内容不能为空', 'warn'); return; }
  const btn = document.getElementById('roleEditSave');
  if (btn) btn.disabled = true;
  setRoleEditMsg('保存中…');
  try {
    const r = await api('/api/role-content', 'POST', { name, content });
    if (!r.ok) { setRoleEditMsg(r.error || '保存失败', 'warn'); return; }
    exitRoleEdit();
    await loadRolePreview(name);
    const meta = document.getElementById('rolePreviewMeta');
    if (meta) meta.textContent = `${name} · 已保存（${(r.bytes / 1024).toFixed(1)}KB，下一轮对话生效）`;
  } catch (e) {
    setRoleEditMsg('保存失败：' + String(e?.message || e), 'warn');
  } finally {
    if (btn) btn.disabled = false;
  }
}
// ── 白名单 / 管理员：下拉菜单 + 右侧添加/删除 ─────────────────────────
// 五个名单（允许群/允许私聊/管理员/拒绝群/拒绝私聊）都用单选下拉框展示；
// 右侧按钮直接增删并立即写回 /api/whitelist。私聊策略仍是上面的独立下拉框。
const WL_FIELDS = {
  allowGroups: { id: 'wlGroups', label: '允许的群号', unit: '群号', list: true },
  allowPrivate: { id: 'wlPrivate', label: '允许的私聊 QQ', unit: 'QQ 号', list: true },
  ownerQQ: { id: 'ownerQQ', label: '管理员 QQ', unit: 'QQ 号', list: false },
  denyGroups: { id: 'dnGroups', label: '拒绝的群号', unit: '群号', list: true },
  denyPrivate: { id: 'dnPrivate', label: '拒绝的私聊 QQ', unit: 'QQ 号', list: true }
};
let wlState = {
  allowGroups: [], allowPrivate: [], ownerQQ: '',
  denyGroups: [], denyPrivate: [], privateMode: 'friends'
};
let wlNames = { groups: {}, privates: {} };

function setWlMsg(text, ok) {
  const msg = document.getElementById('wlMsg');
  if (!msg) return;
  msg.textContent = text || '';
  msg.className = ok ? 'meta ok' : 'meta err';
}

function renderWlSelect(key) {
  const f = WL_FIELDS[key];
  const sel = document.getElementById(f.id);
  if (!sel) return;
  const values = f.list ? (wlState[key] || []) : (wlState.ownerQQ ? [wlState.ownerQQ] : []);
  const isGroupList = key === 'allowGroups' || key === 'denyGroups';
  const nameMap = isGroupList ? wlNames.groups : wlNames.privates;
  const labelOf = (v) => {
    const name = nameMap[String(v)];
    if (name) return `${v}（${name}）`;
    return isGroupList ? `${v}（未在当前群列表）` : `${v}（未知昵称）`;
  };
  const prev = sel.value;
  sel.innerHTML = values.length
    ? values.map((v) => `<option value="${esc(String(v))}">${esc(labelOf(v))}</option>`).join('')
    : '<option value="">— 暂无 —</option>';
  if (prev && values.some((v) => String(v) === prev)) sel.value = prev;
}

function renderWlAll() {
  Object.keys(WL_FIELDS).forEach(renderWlSelect);
}

async function refreshWhitelist() {
  try {
    const w = await api('/api/whitelist');
    wlNames = {
      groups: w.groupNames && typeof w.groupNames === 'object' ? w.groupNames : {},
      privates: w.privateNames && typeof w.privateNames === 'object' ? w.privateNames : {}
    };
    wlState = {
      allowGroups: (w.allow?.groups || []).map(Number).filter(Number.isFinite),
      allowPrivate: (w.allow?.private || []).map(Number).filter(Number.isFinite),
      ownerQQ: w.ownerQQ != null ? String(w.ownerQQ) : '',
      denyGroups: (w.deny?.groups || []).map(Number).filter(Number.isFinite),
      denyPrivate: (w.deny?.private || []).map(Number).filter(Number.isFinite),
      privateMode: w.privateMode || 'list'
    };
    renderWlAll();
    const pm = wlState.privateMode;
    document.getElementById('wlPrivateMode').value = pm;
    updatePrivateModeHint(pm, w.friendCount);
    // 白名单是异步加载的；加载完成后立即重算 10 号摘要，避免悬停一直停留在初始 0/0。
    refreshSummaries();
  } catch {}
}

function wlPayload(mode) {
  return {
    allow: {
      private: wlState.allowPrivate,
      groups: wlState.allowGroups,
      privateMode: mode
    },
    deny: { private: wlState.denyPrivate, groups: wlState.denyGroups },
    ownerQQ: wlState.ownerQQ
  };
}

async function persistWl(mode, okText) {
  const r = await api('/api/whitelist', 'POST', wlPayload(mode));
  if (!r.ok) {
    setWlMsg(`保存失败：${r.error || '未知原因'}`, false);
    await refreshWhitelist();   // 回滚到后端真实状态
    return false;
  }
  setWlMsg(okText, true);
  const pendingMode = document.getElementById('wlPrivateMode')?.value;
  if (pendingMode && pendingMode !== mode) {
    setWlMsg(`${okText}；私聊策略有未保存改动，请点「保存白名单」`, true);
  }
  refresh();                    // 刷新顶部状态/摘要
  return true;
}

async function addWlItem(key) {
  const f = WL_FIELDS[key];
  if (!f) return;
  const raw = prompt(`${f.list ? '添加' : '设置'}${f.label}（${f.unit}）：`, f.list ? '' : wlState.ownerQQ);
  if (raw == null) return;
  const value = raw.trim();
  if (!/^\d{5,12}$/.test(value)) {
    alert('请输入 5~12 位数字的群号 / QQ 号');
    return;
  }
  const n = Number(value);
  if (f.list) {
    if (wlState[key].some((x) => Number(x) === n)) {
      alert('这个号码已经在列表里了');
      return;
    }
    wlState[key].push(n);
  } else {
    if (wlState.ownerQQ === value) {
      alert('这已经是当前管理员');
      return;
    }
    if (wlState.ownerQQ && !confirm(`把管理员从 ${wlState.ownerQQ} 改为 ${value}？`)) return;
    wlState.ownerQQ = value;
  }
  renderWlSelect(key);
  const sel = document.getElementById(f.id);
  if (sel) sel.value = String(value);
  await persistWl(wlState.privateMode, `已添加 ${value} 并保存`);
}

async function delWlItem(key) {
  const f = WL_FIELDS[key];
  if (!f) return;
  if (!f.list) {
    if (!wlState.ownerQQ) { alert('当前没有配置管理员'); return; }
    if (!confirm(`清除管理员 ${wlState.ownerQQ}？清除后将没有人能执行管理命令。`)) return;
    const old = wlState.ownerQQ;
    wlState.ownerQQ = '';
    renderWlSelect(key);
    await persistWl(wlState.privateMode, `已清除管理员 ${old}`);
    return;
  }
  const sel = document.getElementById(f.id);
  const value = sel?.value || '';
  if (!value) { alert('列表为空，没有可删除的项'); return; }
  if (!confirm(`从「${f.label}」中删除 ${value}？`)) return;
  wlState[key] = wlState[key].filter((x) => String(x) !== String(value));
  renderWlSelect(key);
  await persistWl(wlState.privateMode, `已删除 ${value} 并保存`);
}

document.querySelectorAll('[data-wl-add]').forEach((btn) => {
  btn.addEventListener('click', () => { void addWlItem(btn.dataset.wlAdd); });
});
document.querySelectorAll('[data-wl-del]').forEach((btn) => {
  btn.addEventListener('click', () => { void delWlItem(btn.dataset.wlDel); });
});

// 策略说明随选择变化：把「这条策略到底会发生什么」讲清楚，避免误选。
function updatePrivateModeHint(mode, friendCount) {
  const n = (typeof friendCount === 'number') ? `（当前识别到 ${friendCount} 位好友）` : '';
  const text = mode === 'friends'
    ? `好友自动放行${n}：是你的 QQ 好友就能私聊，**不需要手动加到下面**；非好友（群内临时会话）仍需命中白名单。`
    : mode === 'all'
      ? '纯黑名单：除黑名单外任何私聊都收。⚠️ 群里的陌生人也能通过临时会话私聊机器人，仅在完全信任的场景使用。'
      : '白名单：只有下面列出的 QQ 能私聊，其余一律拒绝（旧行为）。';
  document.getElementById('wlPrivateModeHint').textContent = text;
}

document.getElementById('wlPrivateMode')?.addEventListener('change', (e) => {
  updatePrivateModeHint(e.target.value, null);
});


async function refreshSessions() {
  try {
    const s = await api('/api/sessions');
    const box = document.getElementById('sessionList');
    // 02 已迁到模块卡（renderer shell 负责），旧容器不存在时直接跳过。
    if (!box) return;
    // 每行两块：上面是会话信息（key/类型/DSH 会话 id），下面是操作按钮。
    // 按钮**不放进表格列**：卡片变窄后最后一列被挤到横滚区之外、只露一小条，
    // 点不到也不好认（实测「查看消息」变成「查看消」）。改成分行排布，窄卡里也清晰。
    let html = '<div class="sess-list">';
    for (const x of s.sessions) {
      const isP = x.key.startsWith('private:');
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
    box.querySelectorAll('[data-view-key]').forEach(btn => btn.addEventListener('click', () => showMessages(btn.dataset.viewKey)));
    box.querySelectorAll('[data-reset-key]').forEach(btn => btn.addEventListener('click', async () => {
      if (!confirm('确定清除该会话的上下文？下次消息将开新会话。')) return;
      const r = await api('/api/session/reset', 'POST', { key: btn.dataset.resetKey });
      alert(r.ok ? '✅ 已清除上下文' : ('❌ ' + (r.error || '失败')));
      refreshSessions();
    }));
  } catch {}
}

// 查看某个会话的最近消息（含机器人自己发的）。
// 为什么需要：QQ 不会把机器人与**别人**的私聊显示给你（会话按账号隔离），
// 群里也看不到私聊内容。所以桥接侧的这份记录是唯一能回看的地方。
let currentViewKey = '';
async function showMessages(key) {
  currentViewKey = key;
  const card = document.getElementById('msgViewerCard');
  // 展开动画：这个卡片收起时是 display:none（彻底退出网格，见 CSS 注释），
  // 直接删类会让它"啪"地出现，没有 0fr→1fr 过渡。
  // 所以分两步：先恢复布局并**强制一次 reflow**，让浏览器先认下收起态，
  // 下一帧再放开过渡。这是 display 切换后仍要过渡的标准做法。
  card.style.transition = 'none';
  card.classList.remove('card-hidden');
  void card.offsetHeight;              // 强制 reflow：此刻仍是收起态
  card.style.transition = '';          // 交还给 CSS 的过渡定义
  // 改版后 02b 是 02 全页视图里的二级视图：把它从详情池搬进当前整页。
  // （节点是移动不是重建，里面的 msgViewerBody 等引用照常有效）
  if (DETAIL_PAGE.body && card.parentElement !== DETAIL_PAGE.body) {
    DETAIL_PAGE.body.appendChild(card);
  }
  document.getElementById('msgViewerTitle').textContent = key;
  await loadMessages();
  card.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function loadMessages() {
  const key = currentViewKey;
  if (!key) return;
  const limit = Number(document.getElementById('msgViewerLimit').value) || 30;
  const box = document.getElementById('msgViewerBody');
  box.innerHTML = '<span class="meta">加载中…</span>';
  try {
    // 优先用 recent（含机器人自己发的）；它需要 agent 会话，群/私聊都支持。
    const r = await api(`/api/socialV2/recent?key=${encodeURIComponent(key)}&limit=${limit}`);
    const list = r.messages || [];
    if (!list.length) { box.innerHTML = '<span class="meta">该会话还没有记录</span>'; return; }
    let html = '<div class="msglist">';
    for (const m of list) {
      const mine = !!m.isSelf;
      const who = mine ? '机器人' : (m.sender || m.userId || '对方');
      const t = m.time ? new Date(m.time).toLocaleString('zh-CN') : '';
      const media = m.hasMedia ? ' <span class="pill g">含图</span>' : '';
      const fwd = m.hasForward ? ' <span class="pill g">含转发</span>' : '';
      html += `<div class="msgrow ${mine ? 'mine' : 'theirs'}">`
        + `<div class="msgmeta">${esc(who)} · ${esc(t)}${media}${fwd}${m.seq != null ? ' · seq=' + m.seq : ''}</div>`
        + `<div class="msgtext">${esc(m.text || m.plain || '')}</div></div>`;
    }
    box.innerHTML = html + '</div>';
  } catch (e) {
    box.innerHTML = `<span class="meta">读取失败：${esc(String(e?.message || e))}</span>`;
  }
}

async function refreshPending() {
  try {
    const p = await api('/api/pending');
    const box = document.getElementById('pendingList');
    // 03 已迁到模块卡（renderer shell 负责），旧容器不存在时直接跳过。
    if (!box) return;
    if (!p.pending.length) {
      // 空态别只丢一行字：这张卡与 02/04 同高（网格 stretch 对齐到邻居），
      // 只写"无挂起请求"会留一大片空白。给个说明性的空态，空间才算有用。
      box.innerHTML = '<div class="empty-state">'
        + '<div class="empty-ico">✓</div>'
        + '<div class="empty-t">当前没有挂起的审批或提问</div>'
        + '<div class="empty-d">当 AI 需要你确认某件事（例如删除操作、越权请求）时，'
        + '会在这里排队等你处理；平时这里是空的。</div>'
        + '</div>';
      return;
    }
    let html = '<table><tr><th>会话</th><th>类型</th><th>详情</th></tr>';
    for (const x of p.pending) {
      const kind = x.kind === 'approval' ? '<span class="pill r">审批</span>' : '<span class="pill b">提问</span>';
      let detail = '';
      if (x.kind === 'approval') detail = `${esc(x.toolName)}${x.reason ? '：' + esc(x.reason) : ''}`;
      else if (x.questions) detail = x.questions.map(q => esc(q.question)).join(' / ');
      html += `<tr><td>${esc(x.key)}</td><td>${kind}</td><td>${detail}</td></tr>`;
    }
    box.innerHTML = html + '</table>';
  } catch {}
}

document.querySelectorAll('#modeRow button').forEach(b => b.addEventListener('click', async () => {
  if (b.disabled) return;
  await saveMode(b.dataset.mode);
}));
document.getElementById('closedPreset')?.addEventListener('change', async () => {
  // 01 已迁到模块卡（renderer shell 负责），旧下拉不存在时跳过。
  // 切换预设立即保存（若当前是 closed-agent 则即时生效，否则供下次切换使用）
  const active = document.querySelector('#modeRow button.active');
  const mode = active ? active.dataset.mode : 'chat';
  await saveMode(mode);
});
document.getElementById('roleDefaultSelect')?.addEventListener('change', async () => {
  const sel = document.getElementById('roleDefaultSelect');
  if (roleEditing) { alert('请先保存或取消人格卡编辑'); await refreshRoles(true); return; }
  const r = await api('/api/role', 'POST', { role: sel.value || null });
  if (!r.ok) { alert(r.error || '设置失败'); await refreshRoles(true); return; }
  await refreshRoles(true);
});
document.getElementById('roleRefresh')?.addEventListener('click', () => refreshRoles(true));
document.getElementById('roleGroupFilter')?.addEventListener('input', () => renderRoleGroups());
document.getElementById('roleEditBtn')?.addEventListener('click', startRoleEdit);
document.getElementById('roleEditSave')?.addEventListener('click', saveRoleEdit);
document.getElementById('roleEditCancel')?.addEventListener('click', cancelRoleEdit);
// 详情页「返回」在编辑中也要先确认，否则未保存内容会直接丢
document.getElementById('detailBack')?.addEventListener('click', (e) => {
  if (!roleEditing) return;
  if (!confirmDiscardRoleEdit()) { e.preventDefault(); e.stopImmediatePropagation(); return; }
  exitRoleEdit();
}, true);
document.getElementById('roleEditorText')?.addEventListener('input', () => { roleEditDirty = true; updateRoleEditMeta(); });
document.getElementById('roleEditorText')?.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelRoleEdit(); return; }
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveRoleEdit(); return; }
  if (e.key === 'Tab') {
    e.preventDefault();
    const ta = e.currentTarget;
    const start = ta.selectionStart, end = ta.selectionEnd;
    ta.setRangeText('\t', start, end, 'end');
    roleEditDirty = true;
    updateRoleEditMeta();
  }
});
document.getElementById('roleGroupList')?.addEventListener('click', (e) => {
  const row = e.target.closest('.role-group-row');
  if (!row || e.target.closest('select')) return;
  if (!confirmDiscardRoleEdit()) return;
  if (roleEditing) exitRoleEdit();
  rolePreviewKey = row.dataset.key;
  const item = (roleAssignments.conversations || []).find((x) => x.key === rolePreviewKey);
  renderRoleGroups();
  loadRolePreview(item?.effectiveRole || roleAssignments.defaultRole || '');
});
document.getElementById('roleGroupList')?.addEventListener('change', async (e) => {
  const sel = e.target.closest('select.role-group-select');
  if (!sel) return;
  if (roleEditing) { alert('请先保存或取消人格卡编辑'); await refreshRoles(true); return; }
  const key = sel.dataset.key;
  const role = sel.value || null;
  const r = await api('/api/role', 'POST', { key, role });
  if (!r.ok) { alert(r.error || '设置失败'); await refreshRoles(true); return; }
  rolePreviewKey = key;
  await refreshRoles(true);
});
// ── 05 人格卡片：两段互斥切换（当前角色 ↔ 新建表单）──────────────────────
//
// 用户反馈（2026-10-21）：点「新建人格」时元素会溢出卡片。
// 根因是那张卡是**固定高度**（.card-h），而新建表单比「当前角色 + 预览」更高，
// 用 <details> 直接展开就会把内容顶出卡片边界、盖到下一张上。
//
// 现在改成：一次只展开一段，另一段高度收到 0（带过渡动画）。
// 用 grid-template-rows: 0fr ↔ 1fr 做动画——它能对"内容自然高度"过渡，
// 不用事先量像素，内容变多也不会被截断。
let rolePanel = 'main'; // 'main' | 'create'

function applyRolePanel(which, opts = {}) {
  rolePanel = which === 'create' ? 'create' : 'main';
  const mainSeg = document.getElementById('roleMainSeg');
  const createSeg = document.getElementById('roleCreateSeg');
  const toggle = document.getElementById('roleToggleCreate');
  if (!mainSeg || !createSeg) return;
  const isCreate = rolePanel === 'create';
  for (const [seg, on] of [[mainSeg, !isCreate], [createSeg, isCreate]]) {
    seg.classList.toggle('open', on);
    seg.classList.toggle('active', on);
    // 收起的那段设为 inert：避免 Tab 键聚焦到看不见的输入框里
    try { if (on) seg.removeAttribute('inert'); else seg.setAttribute('inert', ''); } catch {}
  }
  if (toggle) toggle.textContent = isCreate ? '← 返回角色列表' : '＋ 新建人格';
  if (isCreate && opts.focus !== false) {
    // 等动画起步再聚焦，否则输入框还没展开就抢焦点会让页面跳动
    setTimeout(() => document.getElementById('newRoleName')?.focus(), 120);
  }
  try { localStorage.setItem('qq-bridge-role-panel', rolePanel); } catch {}
}

document.getElementById('roleToggleCreate')?.addEventListener('click', () => {
  applyRolePanel(rolePanel === 'create' ? 'main' : 'create');
});
document.getElementById('roleCreateCancel')?.addEventListener('click', () => {
  const msg = document.getElementById('roleCreateMsg');
  if (msg) msg.textContent = '';
  applyRolePanel('main');
});

document.getElementById('roleCreate')?.addEventListener('click', async () => {
  const name = document.getElementById('newRoleName').value.trim();
  const content = document.getElementById('newRoleContent').value.trim();
  if (!name) {
    document.getElementById('roleCreateMsg').textContent = '角色名不能为空';
    document.getElementById('roleCreateMsg').className = 'meta err';
    return;
  }
  const r = await api('/api/roles/create', 'POST', { name, content });
  const msg = document.getElementById('roleCreateMsg');
  msg.textContent = r.ok ? '✅ 已创建' : ('❌ ' + (r.error || '失败'));
  msg.className = r.ok ? 'meta ok' : 'meta err';
  if (r.ok) {
    document.getElementById('newRoleName').value = '';
    document.getElementById('newRoleContent').value = '';
    await refreshRoles();
    // 创建成功后自动收回列表视图：新角色已经出现在标签里，留在表单页没意义
    setTimeout(() => applyRolePanel('main'), 350);
  }
});

// 首屏按上次停留的段落恢复（刷新后不会莫名跳到新建表单）
setTimeout(() => {
  try {
    const saved = localStorage.getItem('qq-bridge-role-panel');
    if (saved === 'create') applyRolePanel('create', { focus: false });
    else applyRolePanel('main');
  } catch { applyRolePanel('main'); }
}, 0);

  await refreshRoles();
}
