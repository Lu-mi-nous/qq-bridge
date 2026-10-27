// 24 上下文与记忆（C5 真模块卡，逻辑自 legacy-runtime 迁入）。
import { api as defaultApi } from '../core/api.js';


function ensureCtxMemModal() {
  if (document.getElementById('ctxMemOverlay')) return;
  document.body.insertAdjacentHTML('beforeend', "  <div class=\"modal-overlay\" id=\"ctxMemOverlay\">\n    <div class=\"modal ctx-mem-modal\" role=\"dialog\" aria-modal=\"true\" aria-labelledby=\"ctxMemTitle\">\n      <div class=\"row\" style=\"justify-content:space-between;align-items:center;margin:0\">\n        <h3 id=\"ctxMemTitle\" style=\"margin:0\">长期记忆</h3>\n        <button class=\"small\" id=\"ctxMemClose\" type=\"button\" title=\"关闭（Esc）\" aria-label=\"关闭\">✕</button>\n      </div>\n      <div class=\"ctx-mem-body\" id=\"ctxMemBody\">加载中…</div>\n      <div class=\"row\" style=\"margin-top:12px\">\n        <button class=\"small\" id=\"ctxMemRebuild\">从 episode 重建</button>\n        <span class=\"meta\" id=\"ctxMemMsg\"></span>\n      </div>\n    </div>\n  </div>\n\n");
}

function cacheBytes(n) {
  const v = Number(n) || 0;
  if (v >= 1024 ** 3) return (v / 1024 ** 3).toFixed(2) + 'GB';
  if (v >= 1024 ** 2) return (v / 1024 ** 2).toFixed(1) + 'MB';
  if (v >= 1024) return (v / 1024).toFixed(0) + 'KB';
  return v + 'B';
}
function tkNum(n) {
  const v = Number(n) || 0;
  if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(2) + 'K';
  return String(Math.round(v));
}
const tkFull = (n) => (Number(n) || 0).toLocaleString('en-US');
const tkAgo = (ms) => {
  const t = Number(ms) || 0;
  if (!t) return '从未';
  const d = Math.max(0, Date.now() - t);
  if (d < 60000) return '刚刚';
  if (d < 3600000) return `${Math.round(d / 60000)} 分钟前`;
  if (d < 86400000) return `${Math.round(d / 3600000)} 小时前`;
  return `${Math.round(d / 86400000)} 天前`;
};
function renderBacklogTrend(history, totals) {
  const arr = Array.isArray(history) ? history.slice(-48) : [];
  if (!arr.length) return '<span class="meta">积压趋势：暂无历史（每 5 分钟记录一次）</span>';
  const max = Math.max(1, ...arr.map((x) => Number(x.pending) || 0));
  const bars = arr.map((x) => {
    const v = Number(x.pending) || 0;
    const h = Math.max(2, Math.round((v / max) * 22));
    return `<span class="ctx-trend-bar" style="height:${h}px" title="${esc(x.time || '')} · 待总结 ${v}"></span>`;
  }).join('');
  return `<div class="meta">积压趋势（近 ${arr.length} 次，最高 ${max} 条）：</div><div class="ctx-trend-bars">${bars}</div>`;
}

export async function mount(container, ctx = {}) {
  ensureCtxMemModal();
  const api = ctx.api || defaultApi;
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
  container.innerHTML = "      <div class=\"meta\" id=\"ctxStatusLine\">加载中…</div>\n      <div id=\"ctxBacklogTrend\" class=\"ctx-trend\"></div>\n      <div class=\"row\" id=\"ctxSearchRow\" style=\"margin-top:10px;gap:8px;flex-wrap:wrap\">\n        <select id=\"ctxSearchKey\" style=\"min-width:200px\" aria-label=\"选择要检索的会话\"></select>\n        <input type=\"text\" id=\"ctxSearchInput\" placeholder=\"搜索历史消息 / 情节…\" style=\"flex:1;min-width:220px\">\n        <button id=\"ctxSearchBtn\" class=\"small\">搜索</button>\n        <button id=\"ctxRebuildIndex\" class=\"small\" title=\"清空该会话的检索索引缓存，下次搜索/唤醒时重建\">重建索引</button>\n        <span class=\"meta\" id=\"ctxSearchMsg\"></span>\n      </div>\n      <div id=\"ctxSearchResults\" class=\"ctx-search-results\"></div>\n      <div id=\"ctxBody\" style=\"margin-top:10px\">加载中…</div>\n      <!-- P2 跨会话人物记忆：默认开启；只共享同一 QQ 号的稳定偏好，不共享聊天内容。 -->\n      <details id=\"ctxSharedPanel\" class=\"ctx-shared\">\n        <summary>跨会话人物记忆 <span class=\"meta\" id=\"ctxSharedStats\">加载中…</span></summary>\n        <div class=\"row\" style=\"margin-top:8px;gap:12px;flex-wrap:wrap;align-items:center\">\n          <label style=\"margin:0;flex:none\"><input type=\"checkbox\" id=\"ctxSharedEnabled\"> 启用</label>\n          <label style=\"margin:0;flex:none\"><input type=\"checkbox\" id=\"ctxSharedProfiles\"> 共享偏好</label>\n          <label style=\"margin:0;flex:none\"><input type=\"checkbox\" id=\"ctxSharedPrivate\"> 私聊仅本人</label>\n          <label style=\"margin:0;flex:none\">注入上限 <input type=\"number\" id=\"ctxSharedMaxChars\" min=\"50\" max=\"1000\" style=\"width:86px\"></label>\n          <button id=\"ctxSharedSave\" class=\"small\">保存</button>\n          <button id=\"ctxSharedClear\" class=\"small danger\">清空全部</button>\n          <span class=\"meta\" id=\"ctxSharedMsg\"></span>\n        </div>\n        <div class=\"meta\" style=\"margin-top:6px\">\n          只共享同一个 QQ 号的稳定偏好（喜欢/讨厌/在玩/职业等），不共享聊天原文、episode、群名或群内事件；\n          只有此人当前出现在会话里时才会注入。私聊只处理对方本人。\n        </div>\n        <div id=\"ctxSharedList\" style=\"margin-top:8px\">展开后加载…</div>\n      </details>\n      <!-- G1 记忆断层提醒：重启/长间隔后给模型补一段“中间断过”的背景。 -->\n      <details id=\"ctxGapPanel\" class=\"ctx-shared\">\n        <summary>记忆断层提醒 <span class=\"meta\" id=\"ctxGapStats\">加载中…</span></summary>\n        <div class=\"row\" style=\"margin-top:8px;gap:12px;flex-wrap:wrap;align-items:center\">\n          <label style=\"margin:0;flex:none\"><input type=\"checkbox\" id=\"ctxGapEnabled\"> 启用</label>\n          <label style=\"margin:0;flex:none\">断层阈值（分钟） <input type=\"number\" id=\"ctxGapMinutes\" min=\"1\" max=\"10080\" style=\"width:100px\"></label>\n          <label style=\"margin:0;flex:none\">长间隔（小时） <input type=\"number\" id=\"ctxGapLongHours\" min=\"1\" max=\"720\" style=\"width:90px\"></label>\n          <button id=\"ctxGapSave\" class=\"small\">保存</button>\n          <span class=\"meta\" id=\"ctxGapMsg\"></span>\n        </div>\n        <div class=\"meta\" style=\"margin-top:6px\">\n          程序关闭/重启超过阈值后，下一次唤醒会补一句「中间断过」的背景；首次启动和正常连续对话不会提示。\n        </div>\n      </details>\n      <div class=\"row\" style=\"margin-top:10px\">\n        <button id=\"ctxRefresh\" class=\"small\">刷新</button>\n        <span class=\"meta\" id=\"ctxMsg\"></span>\n      </div>\n      <div class=\"meta ctx-note\">\n        Phase 2：每条消息按序写入 <b>messages.jsonl</b>（补 recentMessages 100 条之外的突发段）；\n        每累计 40 条或空闲 20 分钟且有 15 条以上，把最早一批 60 条压成 <b>情节记忆</b>。\n        每条 episode 的 人物/稳定事实/线索 会继续合并进 <b>长期记忆</b>；唤醒时按 1,500 字符预算注入。\n        「总结」立即生成一条；「清空」只删情节/压缩/长期记忆，消息日志保留；点「长期」查看人物/事实/线索详情。\n      </div>\n      <div class=\"declarative-card\" data-card-mount=\"19\"></div>";

async function refreshContextStatus() {
  const line = document.getElementById('ctxStatusLine');
  const body = document.getElementById('ctxBody');
  if (!line || !body) return false;
  // 30 秒轮询会重建表格。先记住滚动位置，重建后恢复。
  const prevScroll = body.querySelector('.ctx-scroll');
  const prevTop = prevScroll ? prevScroll.scrollTop : 0;
  const prevLeft = prevScroll ? prevScroll.scrollLeft : 0;
  try {
    const r = await api(`/api/socialV2/context-status?t=${Date.now()}`);
    if (!r?.ok) throw new Error(r?.error || '读取失败');
    const rows = Array.isArray(r.rows) ? r.rows : [];
    const groupRows = rows.filter((x) => String(x.key || '').startsWith('group:') && x.inGroupList !== false);
    const staleRows = rows.filter((x) => String(x.key || '').startsWith('group:') && x.inGroupList === false);
    const privateRows = rows.filter((x) => String(x.key || '').startsWith('private:'));
    const t = r.totals || {};
    line.textContent = r.enabled === false
      ? '未启用（socialV2.contextMemory.enabled=false）'
      : `当前群会话 ${groupRows.length} · 已离群会话 ${staleRows.length} · 私聊会话 ${privateRows.length} ｜ 会话文件 ${cacheBytes(t.sessionBytes)} · ${t.episodes || 0} 条情节 · ${t.compactions || 0} 条压缩摘要 · 长期 ${t.people || 0} 人 / ${t.facts || 0} 事实 / ${t.openThreads || 0} 线索 · 日志 ${cacheBytes(t.journalBytes)} · 今日 Token ${tkNum(t.tokenToday || 0)}（累计） · 共享人物 ${Number(r.sharedMemory?.people) || 0} / 偏好 ${Number(r.sharedMemory?.traits) || 0} · 熔断 ${Number(r.tokenFuse?.fused) || 0} · 24h 覆盖 ${t.coveragePct ?? '—'}% · 召回 ${t.recallCalls || 0} 次/命中 ${t.recallHitRate || 0}%`;
    const searchKey = document.getElementById('ctxSearchKey');
    if (searchKey) {
      const current = searchKey.value;
      const choices = rows.filter((x) => /^(group|private):\d+$/.test(String(x.key || '')));
      searchKey.innerHTML = choices.length
        ? choices.map((x) => `<option value="${esc(x.key)}">${esc(x.displayName || x.key)}</option>`).join('')
        : '<option value="">无会话</option>';
      if (choices.some((x) => String(x.key) === current)) searchKey.value = current;
    }
    const trend = document.getElementById('ctxBacklogTrend');
    if (trend) trend.innerHTML = renderBacklogTrend(r.backlogHistory, t);
    if (!rows.length) {
      body.innerHTML = '<div class="meta">还没有会话。</div>';
      return true;
    }

    const rowCell = (x, stale) => {
      const key = String(x.key || '');
      const keyLabel = key.replace(/^group:/, '群 ').replace(/^private:/, '私聊 ');
      const display = String(x.displayName || '').trim();
      const short = display || keyLabel;
      const epTitle = String(x.lastEpisodeSummary || '').trim();
      const err = String(x.lastEpisodeError || '').trim();
      const epCell = x.episodes ? `<span title="${esc(epTitle)}">${x.episodes}</span>` : '—';
      const compCell = x.compactions ? `<span title="最近 ${x.lastCompactionAt ? tkAgo(x.lastCompactionAt) : '未知'}">${x.compactions}</span>` : '—';
      const mem = `提示 ${Number(x.lastPromptChars) || 0} / 记忆 ${Number(x.lastMemoryChars) || 0}`;
      const pendingN = Number(x.pendingMessages) || 0;
      const backlogLevel = String(x.backlogLevel || 'ok');
      const pendingCell = `<span class="ctx-backlog ${esc(backlogLevel)}" title="待总结 ${pendingN} 条（告警 ${Number(x.backlogWarnMessages) || 200} / 严重 ${Number(x.backlogCriticalMessages) || 800}）">${pendingN}</span>`;
      const cov = x.coverage || {};
      const recallRate = Number(x.recallCalls) ? `${Number(x.recallHitRate) || 0}%` : '—';
      const retCell = `<span title="24h 覆盖 ${Number(cov.coveragePct) || 0}%（${Number(cov.indexed24h) || 0}/${Number(cov.messages24h) || 0}）；召回 ${Number(x.recallCalls) || 0} 次，命中 ${recallRate}，平均 ${Number(x.recallAvgMs) || 0}ms；最近 ${Number(x.lastRecallMs) || 0}ms / ${Number(x.lastRecallHits) || 0} 条">${Number(cov.coveragePct) || 0}% / ${Number(x.recallCalls) ? `${Number(x.lastRecallMs) || 0}ms` : '—'}</span>`;
      const lt = x.longTerm || {};
      const ltPeople = Number(lt.people) || 0;
      const ltFacts = Number(lt.facts) || 0;
      const ltThreads = Number(lt.openThreads ?? lt.threads) || 0;
      const journalCell = Number(x.journalBytes) ? cacheBytes(x.journalBytes) : '—';
      const tokenCell = Number(x.tokenToday)
        ? `<span title="今日总输入（含缓存，累计该会话所有轮换前后 sessionId + 情节摘要器）：${esc(tkFull(x.tokenToday))}">${esc(tkNum(x.tokenToday))}</span>`
        : '—';
      const ltCell = (ltPeople || ltFacts || ltThreads)
        ? `<button class="small ctx-mem-btn" data-ctx-mem="${esc(key)}" data-ctx-name="${esc(display || keyLabel)}" title="查看长期记忆（人物/事实/未结线索）">${ltPeople}/${ltFacts}/${ltThreads}</button>`
        : '—';
      const delBtn = stale ? `<button class="small danger" data-ctx-delete="${esc(key)}" title="删除该失效群的全部本地会话状态">删除会话</button>` : '';
      return `<tr>
        <td title="${esc(display || keyLabel)}"><b>${esc(short)}</b>${display ? `<div class="meta">${esc(keyLabel)}</div>` : ''}${err ? `<div class="meta" style="color:var(--err)">${esc(err.slice(0, 40))}</div>` : ''}</td>
        <td class="num">${cacheBytes(x.sessionBytes)}</td>
        <td class="num">${compCell}</td>
        <td class="num">${epCell}</td>
        <td class="num">${pendingCell}</td>
        <td class="num" title="${esc(mem)}">${Number(x.lastPromptChars) || 0} / ${Number(x.lastMemoryChars) || 0}</td>
        <td class="num">${retCell}</td>
        <td class="num" title="完整消息日志（messages.jsonl）大小">${journalCell}</td>
        <td class="num">${tokenCell}</td>
        <td class="num">${ltCell}</td>
        <td><span class="ctx-actions"><button class="small" data-ctx-sum="${esc(key)}">总结</button><button class="small" data-ctx-catchup="${esc(key)}" title="连续生成 episode 直到积压下降">追赶</button><button class="small danger" data-ctx-clear="${esc(key)}">清空</button>${delBtn}</span></td>
      </tr>`;
    };
    const tableOf = (list, stale) => `<table class="tk-table ctx-table">
      <thead><tr>
        <th scope="col">会话</th><th scope="col" class="num">DSH 会话</th><th scope="col" class="num">压缩</th>
        <th scope="col" class="num">情节</th><th scope="col" class="num">待总结</th>
        <th scope="col" class="num">提示 / 记忆</th>
        <th scope="col" class="num" title="最近24小时消息进入检索索引的比例 / 最近一次召回耗时">覆盖 / 召回</th>
        <th scope="col" class="num" title="完整消息日志（messages.jsonl）大小">日志</th>
        <th scope="col" class="num" title="今日总输入（含缓存，累计该会话轮换前后全部 sessionId + 情节摘要器）">今日 Token</th>
        <th scope="col" class="num" title="长期记忆：人物 / 事实 / 未结线索">长期（人物/事实/未结线索）</th>
        <th scope="col">操作</th>
      </tr></thead><tbody>${list.map((x) => rowCell(x, stale)).join('')}</tbody></table>`;
    body.innerHTML = `<div class="scroll-area ctx-scroll" tabindex="0" aria-label="上下文会话列表">
      <div class="ctx-section-title">当前群聊会话（${groupRows.length}）</div>
      ${groupRows.length ? tableOf(groupRows, false) : '<div class="meta">无</div>'}
      ${staleRows.length ? `<div class="ctx-section-title danger">已不在当前群列表的群聊会话（${staleRows.length}）<span class="meta">这些会话可清理，清理后不会影响当前在群会话</span></div>${tableOf(staleRows, true)}` : ''}
      <div class="ctx-section-title">私聊（${privateRows.length}）</div>
      ${privateRows.length ? tableOf(privateRows, false) : '<div class="meta">无</div>'}
    </div>`;
    const nextScroll = body.querySelector('.ctx-scroll');
    if (nextScroll) { nextScroll.scrollTop = prevTop; nextScroll.scrollLeft = prevLeft; }
    const sm = r.sharedMemory || {};
    const smStats = document.getElementById('ctxSharedStats');
    if (smStats) {
      smStats.textContent = smStats.textContent.startsWith('共享人物')
        ? smStats.textContent
        : `共享人物 ${Number(sm.people) || 0} · 偏好 ${Number(sm.traits) || 0} 条 · ${sm.enabled ? '已开启' : '已关闭'}`;
    }
    if (document.getElementById('ctxSharedPanel')?.open && !CTX_SHARED_LOADED) void loadSharedMemoryPanel();
    return true;
  } catch (error) {
    line.textContent = `读取失败：${error?.message ?? error}`;
    return false;
  }
}

// ── P2 跨会话人物记忆（24 卡子面板）──
let CTX_SHARED_LOADED = false;
function renderSharedPeople(rows) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return '<div class="meta">暂无共享人物；新生成的情节记忆会开始积累（历史不回填）。</div>';
  return `<table class="tk-table">
    <thead><tr><th>人物</th><th>共享偏好</th><th class="num">最后出现</th><th>操作</th></tr></thead>
    <tbody>${list.map((p) => {
      const names = Object.values(p.names || {}).filter(Boolean);
      const name = names[0] || `QQ ${p.id}`;
      const alias = names.length > 1 ? `（${names.length} 个称呼）` : '';
      const traits = (Array.isArray(p.traits) ? p.traits : [])
        .map((t) => `${t.predicate} ${t.object}`).join('；') || '—';
      const when = p.lastSeenAt ? new Date(p.lastSeenAt).toLocaleString('zh-CN', { hour12: false }) : '—';
      return `<tr>
        <td><b>${esc(name)}</b>${alias ? `<span class="meta">${esc(alias)}</span>` : ''}<div class="meta">QQ ${esc(p.id)}</div></td>
        <td title="${esc(traits)}">${esc(traits)}</td>
        <td class="num">${esc(when)}</td>
        <td><button class="small danger" data-shared-forget="${esc(p.id)}">忘记此人</button></td>
      </tr>`;
    }).join('')}</tbody></table>`;
}
async function loadSharedMemoryPanel(force = false) {
  const listEl = document.getElementById('ctxSharedList');
  const msg = document.getElementById('ctxSharedMsg');
  if (!listEl) return;
  if (CTX_SHARED_LOADED && !force) return;
  if (msg) msg.textContent = '加载中…';
  try {
    const r = await api('/api/socialV2/shared-memory?limit=200');
    if (!r?.ok) throw new Error(r?.error || '读取失败');
    const c = r.config || {};
    document.getElementById('ctxSharedEnabled').checked = c.enabled !== false;
    document.getElementById('ctxSharedProfiles').checked = c.shareProfiles !== false;
    document.getElementById('ctxSharedPrivate').checked = c.includePrivate !== false;
    document.getElementById('ctxSharedMaxChars').value = Number(c.maxPromptChars) || 300;
    const s = r.stats || {};
    const stats = document.getElementById('ctxSharedStats');
    if (stats) stats.textContent = `共享人物 ${Number(s.people) || 0} · 偏好 ${Number(s.traits) || 0} 条 · ${s.enabled ? '已开启' : '已关闭'}`;
    listEl.innerHTML = renderSharedPeople(r.rows);
    CTX_SHARED_LOADED = true;
    if (msg) msg.textContent = '';
  } catch (error) {
    listEl.innerHTML = `<div class="meta" style="color:var(--err)">读取失败：${esc(error?.message ?? error)}</div>`;
    if (msg) msg.textContent = '';
  }
}
async function saveSharedMemoryConfig() {
  const msg = document.getElementById('ctxSharedMsg');
  if (msg) msg.textContent = '保存中…';
  try {
    const r = await api('/api/socialV2/shared-memory-config', 'POST', {
      enabled: document.getElementById('ctxSharedEnabled').checked,
      shareProfiles: document.getElementById('ctxSharedProfiles').checked,
      includePrivate: document.getElementById('ctxSharedPrivate').checked,
      maxPromptChars: Number(document.getElementById('ctxSharedMaxChars').value) || 300
    });
    if (!r?.ok) throw new Error(r?.error || '保存失败');
    if (msg) msg.textContent = '已保存';
    CTX_SHARED_LOADED = false;
    await loadSharedMemoryPanel(true);
  } catch (error) {
    if (msg) msg.textContent = `保存失败：${error?.message ?? error}`;
  }
}
document.getElementById('ctxSharedPanel')?.addEventListener('toggle', (e) => {
  if (e.target.open) void loadSharedMemoryPanel();
});
document.getElementById('ctxSharedSave')?.addEventListener('click', () => void saveSharedMemoryConfig());
document.getElementById('ctxSharedClear')?.addEventListener('click', async () => {
  if (!confirm('确定清空全部跨会话人物记忆？此操作不可撤销。')) return;
  const msg = document.getElementById('ctxSharedMsg');
  try {
    const r = await api('/api/socialV2/shared-memory-clear', 'POST', {});
    if (!r?.ok) throw new Error(r?.error || '清空失败');
    if (msg) msg.textContent = '已清空';
    CTX_SHARED_LOADED = false;
    await loadSharedMemoryPanel(true);
  } catch (error) { if (msg) msg.textContent = `清空失败：${error?.message ?? error}`; }
});
document.getElementById('ctxSharedList')?.addEventListener('click', async (e) => {
  const btn = e.target.closest?.('[data-shared-forget]');
  if (!btn) return;
  const id = btn.getAttribute('data-shared-forget');
  if (!id || !confirm(`忘记 QQ ${id} 的跨会话资料？`)) return;
  const msg = document.getElementById('ctxSharedMsg');
  try {
    const r = await api('/api/socialV2/shared-memory-forget', 'POST', { id });
    if (!r?.ok) throw new Error(r?.error || '删除失败');
    if (msg) msg.textContent = '已忘记';
    CTX_SHARED_LOADED = false;
    await loadSharedMemoryPanel(true);
  } catch (error) { if (msg) msg.textContent = `删除失败：${error?.message ?? error}`; }
});

// ── G1 记忆断层提醒 ──
async function loadGapPanel() {
  const stats = document.getElementById('ctxGapStats');
  const msg = document.getElementById('ctxGapMsg');
  try {
    const r = await api('/api/socialV2/config');
    if (!r?.ok) throw new Error(r?.error || '读取失败');
    const c = r.config?.gapNotice || {};
    document.getElementById('ctxGapEnabled').checked = c.enabled === true;
    document.getElementById('ctxGapMinutes').value = Number(c.gapMinutes) || 30;
    document.getElementById('ctxGapLongHours').value = Number(c.longGapHours) || 6;
    if (stats) stats.textContent = `${c.enabled === true ? '已开启' : '已关闭'} · 阈值 ${Number(c.gapMinutes) || 30} 分钟 / 长间隔 ${Number(c.longGapHours) || 6} 小时`;
    if (msg) msg.textContent = '';
  } catch (error) {
    if (stats) stats.textContent = '读取失败';
    if (msg) msg.textContent = `读取失败：${error?.message ?? error}`;
  }
}
async function saveGapPanel() {
  const msg = document.getElementById('ctxGapMsg');
  if (msg) msg.textContent = '保存中…';
  try {
    const r = await api('/api/socialV2/config', 'POST', {
      gapNotice: {
        enabled: document.getElementById('ctxGapEnabled').checked,
        gapMinutes: Number(document.getElementById('ctxGapMinutes').value) || 30,
        longGapHours: Number(document.getElementById('ctxGapLongHours').value) || 6
      }
    });
    if (!r?.ok) throw new Error(r?.error || '保存失败');
    if (msg) msg.textContent = '已保存';
    await loadGapPanel();
  } catch (error) {
    if (msg) msg.textContent = `保存失败：${error?.message ?? error}`;
  }
}
document.getElementById('ctxGapPanel')?.addEventListener('toggle', (e) => {
  if (e.target.open) void loadGapPanel();
});
document.getElementById('ctxGapSave')?.addEventListener('click', () => void saveGapPanel());

function renderRecallItem(r) {
  const when = r?.time ? new Date(r.time).toLocaleString('zh-CN', { hour12: false }) : '';
  const kind = r?.kind === 'episode' ? '情节' : '消息';
  const seq = r?.seq ? ` · seq ${r.seq}` : '';
  return `<div class="ctx-search-item"><div class="meta">${esc(when)} · ${kind}${seq} · ${esc(r?.sender || '')} · 相关度 ${Number(r?.score) || 0}</div><div>${esc(r?.text || '')}</div></div>`;
}

async function ctxSearch() {
  const key = String(document.getElementById('ctxSearchKey')?.value || '');
  const query = String(document.getElementById('ctxSearchInput')?.value || '').trim();
  const out = document.getElementById('ctxSearchResults');
  const msg = document.getElementById('ctxSearchMsg');
  if (!out || !key) return;
  if (msg) msg.textContent = '搜索中…';
  out.innerHTML = '';
  try {
    const r = await api(`/api/socialV2/recall?key=${encodeURIComponent(key)}&q=${encodeURIComponent(query)}&limit=20`);
    if (!r?.ok) throw new Error(r?.error || '搜索失败');
    const results = Array.isArray(r.results) ? r.results : [];
    if (!results.length) {
      out.innerHTML = '<div class="meta">没有命中。可以换关键词，或点「重建索引」。</div>';
      if (msg) msg.textContent = `0 条 / 索引 ${Number(r.index?.documents) || 0} 条`;
      return;
    }
    out.innerHTML = results.map(renderRecallItem).join('');
    if (msg) msg.textContent = `命中 ${r.count || results.length} 条 / 索引 ${Number(r.index?.documents) || 0} 条`;
  } catch (error) {
    out.innerHTML = `<div class="meta" style="color:var(--err)">搜索失败：${esc(error?.message ?? error)}</div>`;
    if (msg) msg.textContent = '';
  }
}

async function ctxCatchup(key) {
  const msg = document.getElementById('ctxMsg');
  if (msg) { msg.textContent = '追赶中…'; msg.className = 'meta'; }
  try {
    const r = await api('/api/socialV2/context-catchup', 'POST', { key, max: 8 });
    if (!r?.ok) throw new Error(r?.error || '追赶失败');
    const made = Number(r.made) || 0;
    const rawErr = String(r.last?.error || '');
    const reason = rawErr === 'not-enough' ? '不足一个 episode 的窗口' : rawErr;
    if (msg) {
      msg.textContent = made
        ? `已生成 ${made} 条情节`
        : `没有可追赶的积压${reason ? `（${reason}）` : ''}`;
      msg.className = made ? 'meta ok' : 'meta';
    }
    await refreshContextStatus();
  } catch (error) {
    if (msg) { msg.textContent = `追赶失败：${error?.message ?? error}`; msg.className = 'meta err'; }
  }
}

async function ctxRebuildIndex() {
  const key = String(document.getElementById('ctxSearchKey')?.value || '');
  const msg = document.getElementById('ctxSearchMsg');
  if (!key) return;
  if (msg) msg.textContent = '重建索引中…';
  try {
    const r = await api('/api/socialV2/context-rebuild-index', 'POST', { key });
    if (!r?.ok) throw new Error(r?.error || '重建失败');
    await ctxSearch();
    if (msg) msg.textContent = `索引已重建 · ${msg.textContent || ''}`.trim();
  } catch (error) {
    if (msg) msg.textContent = `重建失败：${error?.message ?? error}`;
  }
}

async function ctxDelete(key) {
  if (!window.confirm(`删除 ${key} 的全部本地会话状态？
会删除消息日志、情节/长期记忆、DSH 会话映射和人格覆盖，不可恢复。`)) return;
  const msg = document.getElementById('ctxMsg');
  try {
    const r = await api('/api/socialV2/context-delete', 'POST', { key });
    if (!r?.ok) throw new Error(r?.error || '删除失败');
    if (msg) msg.textContent = `已删除 ${key}`;
  } catch (error) {
    if (msg) msg.textContent = `删除失败：${error?.message ?? error}`;
  }
  await refreshContextStatus();
  await refreshRoles(true);
  refreshSummaries();
  setTimeout(() => { if (msg) msg.textContent = ''; }, 12000);
}
// ── 24 号卡：长期记忆详情弹窗 ───────────────────────────────────────────
const CTX_MEM = {
  overlay: document.getElementById('ctxMemOverlay'),
  body: document.getElementById('ctxMemBody'),
  title: document.getElementById('ctxMemTitle'),
  msg: document.getElementById('ctxMemMsg'),
  key: '',
  trigger: null
};

function ctxMemItem(title, meta, note) {
  return `<div class="ctx-mem-item"><b>${esc(title)}</b>`
    + (meta ? ` <span class="meta">${esc(meta)}</span>` : '')
    + (note ? `<div class="meta">${esc(note)}</div>` : '')
    + '</div>';
}

function renderCtxMemory(data) {
  const mem = data?.memory || {};
  const lt = data?.longTerm || {};
  const journal = data?.journal || {};
  const people = Object.values(mem.people || {})
    .sort((a, b) => (Number(b.mentions) || 0) - (Number(a.mentions) || 0)
      || (Number(b.lastSeenAt) || 0) - (Number(a.lastSeenAt) || 0));
  const facts = Object.values(mem.facts || {})
    .sort((a, b) => (Number(b.confidence) || 0) - (Number(a.confidence) || 0)
      || (Number(b.lastSeenAt) || 0) - (Number(a.lastSeenAt) || 0));
  const threads = Object.values(mem.threads || {})
    .sort((a, b) => (a.status === 'closed' ? 1 : 0) - (b.status === 'closed' ? 1 : 0)
      || (Number(b.lastSeenAt) || 0) - (Number(a.lastSeenAt) || 0));
  const eps = (Array.isArray(data?.episodes) ? data.episodes : []).slice().reverse();
  const parts = [];
  parts.push(`<div class="ctx-mem-stats">人物 ${Number(lt.people) || 0} · 事实 ${Number(lt.facts) || 0} · 未结线索 ${Number(lt.openThreads) || 0}/${Number(lt.threads) || 0} · 消息日志 ${Number(journal.bytes) ? cacheBytes(journal.bytes) : '—'} · 最近 episode ${lt.updatedAt ? tkAgo(lt.updatedAt) : '—'}</div>`);
  parts.push('<div class="ctx-mem-section"><h4>人物</h4>');
  parts.push(people.length ? people.map((p) => ctxMemItem(
    p.name || p.id || '未知',
    p.name && p.id ? p.id : '',
    `${p.note || '暂无备注'}${p.mentions ? ` · 提及 ${p.mentions} 次` : ''}`
  )).join('') : '<div class="ctx-mem-empty">暂无人物记忆</div>');
  parts.push('</div>');
  parts.push('<div class="ctx-mem-section"><h4>稳定事实</h4>');
  parts.push(facts.length ? facts.map((f) => ctxMemItem(
    `${f.subject || '?'} ${f.predicate || ''} ${f.object || '?'}`,
    `${Math.round((Number(f.confidence) || 0) * 100)}%`,
    f.hits ? `出现 ${f.hits} 次 · 最近 ${tkAgo(f.lastSeenAt)}` : ''
  )).join('') : '<div class="ctx-mem-empty">暂无稳定事实</div>');
  parts.push('</div>');
  parts.push('<div class="ctx-mem-section"><h4>线索</h4>');
  parts.push(threads.length ? threads.map((t) => ctxMemItem(
    t.title || '未命名',
    t.status === 'closed' ? '已结束' : '进行中',
    `${t.nextAction || '（待跟进）'}${t.lastSeenAt ? ` · 最近 ${tkAgo(t.lastSeenAt)}` : ''}`
  )).join('') : '<div class="ctx-mem-empty">暂无线索</div>');
  parts.push('</div>');
  parts.push('<div class="ctx-mem-section"><h4>最近情节</h4>');
  parts.push(eps.length ? eps.map((e) => ctxMemItem(
    e.summary ? e.summary.slice(0, 80) : '（无摘要）',
    `${e.createdAt ? tkAgo(e.createdAt) : ''}${e.messageCount ? ` · ${e.messageCount} 条` : ''}`,
    e.summary && e.summary.length > 80 ? e.summary.slice(80) : ''
  )).join('') : '<div class="ctx-mem-empty">暂无情节摘要</div>');
  parts.push('</div>');
  const audits = (Array.isArray(data?.recallAudit) ? data.recallAudit : []).slice().reverse();
  parts.push('<div class="ctx-mem-section"><h4>最近检索命中</h4>');
  parts.push(audits.length ? audits.map((a) => {
    const when = a.at ? tkAgo(a.at) : '';
    const results = (Array.isArray(a.results) ? a.results : []).map((r) => {
      const kind = r.kind === 'episode' ? '情节' : '消息';
      const seq = r.seq ? ` seq ${r.seq}` : '';
      return `${kind}${seq}：${String(r.text || '').slice(0, 60)}`;
    }).join('；');
    return ctxMemItem(
      `查询：${a.query || '（空）'}`,
      `${when} · 命中 ${Number(a.hits) || 0} 条 · ${Number(a.ms) || 0}ms`,
      results || '无命中'
    );
  }).join('') : '<div class="ctx-mem-empty">暂无检索记录</div>');
  parts.push('</div>');
  CTX_MEM.body.innerHTML = parts.join('');
}

async function openCtxMemory(key, trigger, displayName = '') {
  if (!CTX_MEM.overlay) return;
  CTX_MEM.key = key;
  CTX_MEM.trigger = trigger || document.activeElement;
  CTX_MEM.title.textContent = `长期记忆 · ${displayName || key.replace(/^group:/, '群 ').replace(/^private:/, '私聊 ')}`;
  CTX_MEM.msg.textContent = '';
  CTX_MEM.body.innerHTML = '<div class="meta">加载中…</div>';
  CTX_MEM.overlay.classList.add('open');
  document.getElementById('ctxMemClose')?.focus({ preventScroll: true });
  try {
    const r = await api(`/api/socialV2/context-memory?key=${encodeURIComponent(key)}`);
    if (!r?.ok) throw new Error(r?.error || '读取失败');
    renderCtxMemory(r);
  } catch (error) {
    CTX_MEM.body.innerHTML = `<div class="ctx-mem-empty">读取失败：${esc(error?.message ?? error)}</div>`;
  }
}

function closeCtxMemory() {
  if (!CTX_MEM.overlay) return;
  CTX_MEM.overlay.classList.remove('open');
  const restore = CTX_MEM.trigger;
  CTX_MEM.trigger = null;
  if (restore && typeof restore.focus === 'function') {
    setTimeout(() => restore.focus({ preventScroll: true }), 60);
  }
}

document.getElementById('ctxMemClose')?.addEventListener('click', closeCtxMemory);
CTX_MEM.overlay?.addEventListener('click', (e) => {
  if (e.target === CTX_MEM.overlay) closeCtxMemory();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && CTX_MEM.overlay?.classList.contains('open')) {
    e.preventDefault();
    closeCtxMemory();
  }
});
document.getElementById('ctxMemRebuild')?.addEventListener('click', async () => {
  if (!CTX_MEM.key) return;
  if (!window.confirm(`从现有 episode 重建 ${CTX_MEM.key} 的长期记忆？会重置人物/事实/线索的计数。`)) return;
  CTX_MEM.msg.textContent = '正在重建…';
  try {
    const r = await api('/api/socialV2/context-rebuild-memory', 'POST', { key: CTX_MEM.key });
    if (!r?.ok) throw new Error(r?.error || '重建失败');
    const full = await api(`/api/socialV2/context-memory?key=${encodeURIComponent(CTX_MEM.key)}`);
    renderCtxMemory(full?.ok ? full : r);
    CTX_MEM.msg.textContent = '已从 episode 重建';
    await refreshContextStatus();
    refreshSummaries();
  } catch (error) {
    CTX_MEM.msg.textContent = `重建失败：${error?.message ?? error}`;
  }
});

document.getElementById('ctxSearchBtn')?.addEventListener('click', () => { void ctxSearch(); });
document.getElementById('ctxSearchInput')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); void ctxSearch(); }
});
document.getElementById('ctxRebuildIndex')?.addEventListener('click', () => { void ctxRebuildIndex(); });

document.getElementById('ctxRefresh')?.addEventListener('click', async () => {
  const btn = document.getElementById('ctxRefresh');
  const msg = document.getElementById('ctxMsg');
  if (!btn || btn.disabled) return;
  const oldText = btn.textContent;
  btn.disabled = true;
  btn.textContent = '刷新中…';
  if (msg) { msg.textContent = '正在读取…'; msg.className = 'meta'; }
  const ok = await refreshContextStatus();
  btn.disabled = false;
  btn.textContent = oldText || '刷新';
  if (msg) {
    if (ok) {
      msg.textContent = `已更新 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`;
      msg.className = 'meta ok';
      setTimeout(() => { if (msg.textContent.startsWith('已更新 ')) msg.textContent = ''; }, 5000);
    } else {
      msg.textContent = '刷新失败，请查看状态行';
      msg.className = 'meta err';
    }
  }
});
document.getElementById('ctxBody')?.addEventListener('click', (e) => {
  const mem = e.target.closest?.('[data-ctx-mem]');
  if (mem) { void openCtxMemory(mem.dataset.ctxMem, mem, mem.dataset.ctxName || ''); return; }
  const sum = e.target.closest?.('[data-ctx-sum]');
  if (sum) { void ctxSummarize(sum.dataset.ctxSum); return; }
  const catchup = e.target.closest?.('[data-ctx-catchup]');
  if (catchup) { void ctxCatchup(catchup.dataset.ctxCatchup); return; }
  const del = e.target.closest?.('[data-ctx-delete]');
  if (del) { void ctxDelete(del.dataset.ctxDelete); return; }
  const clr = e.target.closest?.('[data-ctx-clear]');
  if (clr) void ctxClear(clr.dataset.ctxClear);
});

  await refreshContextStatus();
}
