// 16 Token 用量（C5 真模块卡，逻辑自 legacy-runtime 迁入）。
import { api as defaultApi } from '../core/api.js';

export async function mount(container, ctx = {}) {
  const api = ctx.api || defaultApi;
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
  container.innerHTML = "      <div id=\"tokenStatus\" class=\"meta\">加载中…</div>\n      <div id=\"tokenToday\" style=\"margin-top:10px\"></div>\n      <div id=\"tokenTotal\" class=\"meta\" style=\"margin-top:6px\"></div>\n      <!-- 按日审阅（2026-10-21 用户要求）：选「总计」看全时段汇总，\n           选某一天则下方「按模型」只显示那一天的模型调用量。 -->\n      <div class=\"row\" style=\"margin-top:10px;align-items:center\">\n        <label style=\"margin:0;flex:none\">按日审阅</label>\n        <select id=\"tokenDayPick\" style=\"width:auto;min-width:150px\">\n          <option value=\"all\">总计（全时段）</option>\n        </select>\n        <span class=\"meta\" id=\"tokenDayPickHint\"></span>\n      </div>\n      <div id=\"tokenDays\" style=\"margin-top:10px\"></div>\n      <div id=\"tokenModels\" style=\"margin-top:10px\"></div>\n      <!-- 按会话（2026-10-25 用户要求）：当前 = 映射里的当前 DSH 会话；\n           累计 = 该 QQ 会话名下所有历史 sessionId + 情节摘要器，轮换不清零。 -->\n      <div id=\"tokenSessions\" style=\"margin-top:10px\"></div>\n      <!-- 会话级 Token 熔断（二期 F3）：默认关闭；开启后达到阈值的会话停止自动唤醒/B站自主刷。 -->\n      <details id=\"tokenFusePanel\" class=\"ctx-shared\">\n        <summary>会话级 Token 熔断 <span class=\"meta\" id=\"tokenFuseStats\">加载中…</span></summary>\n        <div class=\"row\" style=\"margin-top:8px;gap:10px;flex-wrap:wrap;align-items:center\">\n          <label style=\"margin:0;flex:none\"><input type=\"checkbox\" id=\"tokenFuseEnabled\"> 启用</label>\n          <span class=\"meta\" style=\"flex:none\">全局默认（只影响未自定义的会话）：</span>\n          <label class=\"fuse-global\" style=\"margin:0;flex:none\">提醒 <input type=\"number\" id=\"tokenFuseWarn\" min=\"0\" step=\"any\"><select id=\"tokenFuseWarnUnit\" aria-label=\"全局提醒阈值单位\"></select></label>\n          <label class=\"fuse-global\" style=\"margin:0;flex:none\">熔断 <input type=\"number\" id=\"tokenFuseFuse\" min=\"0\" step=\"any\"><select id=\"tokenFuseFuseUnit\" aria-label=\"全局熔断阈值单位\"></select></label>\n          <label class=\"fuse-global\" style=\"margin:0;flex:none\">未缓存 <input type=\"number\" id=\"tokenFuseUncached\" min=\"0\" step=\"any\"><select id=\"tokenFuseUncachedUnit\" aria-label=\"全局未缓存阈值单位\"></select></label>\n          <button id=\"tokenFuseSave\" class=\"small\">保存全局</button>\n          <span class=\"meta\" id=\"tokenFuseMsg\"></span>\n        </div>\n        <div class=\"meta\" style=\"margin-top:6px\">\n          按自然日（上海时区）累计「总输入（含缓存）」；熔断后只停该会话的自动唤醒和 B 站自主刷，\n          管理员私聊与控制台手动操作不受影响。下方表格可逐会话覆盖全局阈值（K/M/B 单位）。\n        </div>\n        <div id=\"tokenFuseList\" style=\"margin-top:8px\">展开后加载…</div>\n      </details>\n      <div class=\"row\" style=\"margin-top:10px\">\n        <button id=\"tokenRefresh\" class=\"small\">重新统计</button>\n        <button id=\"tokenReport\" class=\"small\">生成报表图</button>\n        <span class=\"meta\" id=\"tokenMsg\"></span>\n      </div>\n      <div id=\"tokenReportPreview\" style=\"margin-top:10px\"></div>\n      <iframe class=\"console-panel\" data-panel-src=\"/api/console/panel/token-report\"\n        sandbox=\"allow-scripts\" loading=\"lazy\" title=\"Token 报表预览\"\n        style=\"width:100%;height:520px;border:0;border-radius:10px;margin-top:10px\"></iframe>\n      <div class=\"meta\" id=\"tokenHint\">\n        数据来自 DSH 会话转录（本地文件解析，不调用任何 API）。<b>口径是 DSH 会话，不是网关积分/账单</b>；\n        网关 credit 请到模型网关面板查看。总输入 = 未缓存输入 + 缓存读（provider 的 prompt_tokens），\n        输出是 completion_tokens。\n        <b>每日更新</b>：跨天自动重算，平时每 6 小时刷新一次；也可点「重新统计」手动刷新。\n        统计已按 (turn, step, 用量) 去重——同一份 usage 在流式增量与最终汇总里各出现一次，\n        直接累加会翻倍。\n      </div>\n";

function tkAgo(ms) {
  const t = Number(ms) || 0;
  if (!t) return '从未';
  const d = Math.max(0, Date.now() - t);
  if (d < 60 * 1000) return '刚刚';
  if (d < 3600 * 1000) return `${Math.round(d / 60000)} 分钟前`;
  if (d < 24 * 3600 * 1000) return `${Math.round(d / 3600000)} 小时前`;
  return `${Math.round(d / 86400000)} 天前`;
}

function tkNum(n) {
  const v = Number(n) || 0;
  if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  return String(v);
}
function tkFull(n) { return (Number(n) || 0).toLocaleString('en-US'); }

// 「按日审阅」当前选中的日期：'all' = 全时段总计，否则 YYYY-MM-DD。
// 放在模块级而不是从 <select> 现读：刷新时 select 会被重建，保留选择才不会每次跳回"总计"。
// 记住选择的理由——用户切到某天在看模型明细时，60 秒自动刷新不该把他的选择冲掉。
let TK_SELECTED_DAY = 'all';
// 16 卡「按会话」默认只看前 10 个，展开状态跨 60 秒刷新保留。
let TK_SHOW_ALL_SESSIONS = false;

async function refreshTokenUsage() {
  const statusEl = document.getElementById('tokenStatus');
  if (!statusEl) return;
  try {
    const q = TK_SELECTED_DAY && TK_SELECTED_DAY !== 'all'
      ? `?date=${encodeURIComponent(TK_SELECTED_DAY)}`
      : '';
    const r = await api('/api/socialV2/token-usage' + q);
    if (!r?.ok) {
      // 选中的日期在重新统计后消失了（比如跨天、或那天被清理）：退回总计并重取一次，
      // 否则用户会卡在一个永远查不到数据的选项上。
      if (r?.error && TK_SELECTED_DAY !== 'all') { TK_SELECTED_DAY = 'all'; return refreshTokenUsage(); }
      statusEl.textContent = '读取失败';
      return;
    }
    if (!r.ready) {
      statusEl.innerHTML = '<span class="pill">尚未统计</span> 桥接启动约 30 秒后会自动算一次，也可点下面的「重新统计」';
      for (const id of ['tokenToday', 'tokenTotal', 'tokenDays', 'tokenModels', 'tokenSessions', 'tokenDayPickHint']) {
        const el = document.getElementById(id); if (el) el.innerHTML = '';
      }
      return;
    }

    const t = r.todayUsage || {};
    const tot = r.total || {};
    statusEl.innerHTML = `<span class="pill g">更新于 ${esc(tkAgo(r.updatedAt))}</span>`
      + `　覆盖 ${esc(String(r.files || 0))} 个会话文件　累计 ${esc(tkFull(r.calls))} 次模型调用 / ${esc(tkFull(r.turns))} 回合`;

    // 今日四项
    const cell = (label, value, sub) => `<div class="tk-metric">
        <div class="tk-v">${esc(value)}</div>
        <div class="tk-l">${esc(label)}${sub ? `　<span class="meta">${esc(sub)}</span>` : ''}</div>
      </div>`;
    const totalInput = Number(t.totalInput) || ((Number(t.input) || 0) + (Number(t.cacheRead) || 0));
    const cacheHitRate = Number.isFinite(t.cacheHitRate)
      ? t.cacheHitRate
      : (totalInput > 0 ? Math.round((Number(t.cacheRead) || 0) / totalInput * 1000) / 10 : 0);
    document.getElementById('tokenToday').innerHTML = `
      <div class="tk-sub">今日（${esc(r.today)}）</div>
      <div class="tk-today">
        ${cell('总输入（含缓存）', tkNum(totalInput), `${tkFull(totalInput)} · 缓存命中 ${cacheHitRate}%`)}
        ${cell('其中未缓存', tkNum(t.input), tkFull(t.input))}
        ${cell('输出 tokens', tkNum(t.output), tkFull(t.output))}
        ${cell('模型调用', tkNum(t.calls), `${tkFull(t.calls)} 次`)}
      </div>
      <div class="meta" style="margin-top:6px">口径：总输入 = 未缓存输入 + 缓存读；缓存读是命中缓存的上下文，按每次请求累计。</div>`;

    // 累计
    const totTotalInput = Number(tot.totalInput) || ((Number(tot.input) || 0) + (Number(tot.cacheRead) || 0));
    const totHitRate = Number.isFinite(tot.cacheHitRate)
      ? tot.cacheHitRate
      : (totTotalInput > 0 ? Math.round((Number(tot.cacheRead) || 0) / totTotalInput * 1000) / 10 : 0);
    document.getElementById('tokenTotal').innerHTML =
      `累计：总输入 <b>${esc(tkNum(totTotalInput))}</b>（未缓存 <b>${esc(tkNum(tot.input))}</b>`
      + ` / 缓存读 <b>${esc(tkNum(tot.cacheRead))}</b> / 命中率 <b>${esc(String(totHitRate))}%</b>）`
      + `　输出 <b>${esc(tkNum(tot.output))}</b>`
      + (tot.reasoning ? `　其中推理 <b>${esc(tkNum(tot.reasoning))}</b>` : '');

    // 按日（最近 14 天，条形对比）
    const days = Array.isArray(r.days) ? r.days.slice(0, 14) : [];
    const dayTotalInput = (d) => Number(d.totalInput) || ((Number(d.input) || 0) + (Number(d.cacheRead) || 0));
    const maxIn = Math.max(1, ...days.map(dayTotalInput));
    document.getElementById('tokenDays').innerHTML = days.length ? `
      <div class="tk-sub">按日（最近 ${days.length} 天，条形长度＝总输入量）</div>
      <table class="tk-table">
        <thead><tr><th>日期</th><th></th><th class="num">总输入</th><th class="num">未缓存</th><th class="num">缓存读</th><th class="num">输出</th><th class="num">调用</th></tr></thead>
        <tbody>${days.map((d) => {
          const w = Math.round((dayTotalInput(d) / maxIn) * 90);
          return `<tr>
            <td>${esc(d.date)}</td>
            <td><span class="tk-bar" style="width:${w}px"></span></td>
            <td class="num">${esc(tkNum(dayTotalInput(d)))}</td>
            <td class="num">${esc(tkNum(d.input))}</td>
            <td class="num">${esc(tkNum(d.cacheRead))}</td>
            <td class="num">${esc(tkNum(d.output))}</td>
            <td class="num">${esc(tkFull(d.calls))}</td>
          </tr>`;
        }).join('')}</tbody>
      </table>` : '';

    // ── 按日审阅下拉（默认「总计」）──
    // 选项用**全部可用天数**（API 给 30 天），而不是上面表格只显示 14 天——
    // 审阅的价值就在于能回看更早的日期，只给 14 项等于把半个月挡在外面。
    const pickEl = document.getElementById('tokenDayPick');
    if (pickEl) {
      const allDays = Array.isArray(r.days) ? r.days : [];
      const wanted = TK_SELECTED_DAY;
      pickEl.innerHTML = '<option value="all">总计（全时段）</option>'
        + allDays.map((d) => `<option value="${esc(d.date)}">${esc(d.date)}</option>`).join('');
      // 选中的那天若已不在列表里（跨天/清理），退回总计
      const stillThere = wanted === 'all' || allDays.some((d) => d.date === wanted);
      if (!stillThere) TK_SELECTED_DAY = 'all';
      pickEl.value = TK_SELECTED_DAY;
      if (!pickEl.dataset.bound) {
        pickEl.dataset.bound = '1';
        pickEl.addEventListener('change', () => {
          TK_SELECTED_DAY = pickEl.value || 'all';
          void refreshTokenUsage();
        });
      }
    }
    // 当前口径提示：让"按模型"这块的数字属于哪一天一目了然
    const hintEl = document.getElementById('tokenDayPickHint');
    if (hintEl) {
      if (r.modelScope && r.modelScope !== 'all') {
        const dayRow = (Array.isArray(r.days) ? r.days : []).find((d) => d.date === r.modelScope);
        const d = dayRow || {};
        hintEl.innerHTML = `按模型显示 <b>${esc(r.modelScope)}</b> 当天：`
          + `总输入 ${esc(tkNum(dayTotalInput(d)))}（未缓存 ${esc(tkNum(d.input || 0))} / 缓存读 ${esc(tkNum(d.cacheRead || 0))}）`
          + ` / 输出 ${esc(tkNum(d.output || 0))} / 调用 ${esc(tkFull(d.calls || 0))} 次`;
      } else {
        // 注意措辞：这里所有模型合计是**全部天**的累计（API 最多给 30 天），
        // 而上面的表格只显示最近 14 天。写成"14 天合起来"会让人把两个口径搞混
        // （实测 全时段=42,139 次 vs 最近 14 天=23,754 次，差了近一倍）。
        hintEl.textContent = '按模型显示全时段累计（所有已统计的天）';
      }
    }

    // ── 按模型（随所选日期变化）──
    const models = Array.isArray(r.models) ? r.models : [];
    const scopeLabel = r.modelScope && r.modelScope !== 'all'
      ? `按模型 · ${r.modelScope}`
      : '按模型 · 全时段';
    const scopeUsage = r.modelScopeUsage || null;
    const modelHead = scopeUsage
      ? `<div class="meta" style="margin-top:2px">合计 总输入 ${esc(tkNum(scopeUsage.totalInput || scopeUsage.input + scopeUsage.cacheRead))}`
        + `（未缓存 ${esc(tkNum(scopeUsage.input))} / 缓存读 ${esc(tkNum(scopeUsage.cacheRead))}）`
        + ` / 输出 ${esc(tkNum(scopeUsage.output))}`
        + ` / 调用 ${esc(tkFull(scopeUsage.calls))} 次</div>`
      : '';
    document.getElementById('tokenModels').innerHTML = models.length ? `
      <div class="tk-sub">${esc(scopeLabel)}</div>
      ${modelHead}
      <table class="tk-table">
        <thead><tr><th>模型</th><th class="num">总输入</th><th class="num">未缓存</th><th class="num">缓存读</th><th class="num">输出</th><th class="num">调用</th></tr></thead>
        <tbody>${models.map((m) => `<tr>
          <td>${esc(m.model)}</td>
          <td class="num">${esc(tkNum(m.totalInput || (Number(m.input) || 0) + (Number(m.cacheRead) || 0)))}</td>
          <td class="num">${esc(tkNum(m.input))}</td>
          <td class="num">${esc(tkNum(m.cacheRead))}</td>
          <td class="num">${esc(tkNum(m.output))}</td>
          <td class="num">${esc(tkFull(m.calls))}</td>
        </tr>`).join('')}</tbody>
      </table>` : `
      <div class="tk-sub">${esc(scopeLabel)}</div>
      <div class="meta">这一天没有任何模型调用记录。</div>`;

    // ── 按会话（当前 / 累计两个口径）──
    // 当前 = 映射里的当前 DSH 会话；累计 = 该 QQ 会话名下所有历史 sessionId
    // + 情节摘要器。轮换后旧会话的消耗在累计里继续存在。
    const sessEl = document.getElementById('tokenSessions');
    // 按日审阅对按会话表生效：选某天时只显示那天的数字（当天无消耗的会话不占行）。
    const sessionScope = String(r.sessionScope || 'all');
    const isDayScope = sessionScope !== 'all';
    const allSess = (Array.isArray(r.sessions) ? r.sessions : []).filter((s) =>
      !isDayScope || (Number(s.cumulative?.totalInput) || 0) > 0 || (Number(s.summarizer?.calls) || 0) > 0);
    const unowned = (Array.isArray(r.unownedSessions) ? r.unownedSessions : []).filter((s) =>
      !isDayScope || (Number(s.totalInput) || 0) > 0);
    if (sessEl) {
      if (!allSess.length && !unowned.length) {
        sessEl.innerHTML = `<div class="tk-sub">按会话${isDayScope ? ` · ${esc(sessionScope)}` : ''}</div>`
          + `<div class="meta">${isDayScope ? '这一天没有会话级调用记录。' : '暂无会话级数据（点「重新统计」生成）'}</div>`;
      } else {
        const shown = TK_SHOW_ALL_SESSIONS ? allSess : allSess.slice(0, 10);
        const summText = (s) => (Number(s?.calls) > 0)
          ? `${tkNum((Number(s.input) || 0) + (Number(s.cacheRead) || 0) + (Number(s.output) || 0))} / ${tkFull(s.calls)} 次`
          : '—';
        const currentHead = isDayScope ? '当前会话当日' : '当前会话总输入';
        const cumulativeHead = isDayScope ? '累计当日' : '累计总输入';
        const sessTable = (list, withCurrent) => `<table class="tk-table">
          <thead><tr><th>会话</th><th class="num">${currentHead}</th><th class="num">${cumulativeHead}</th><th class="num">未缓存</th><th class="num">缓存读</th><th class="num">输出</th><th class="num">调用</th><th class="num">摘要器</th></tr></thead>
          <tbody>${list.map((s) => `<tr>
            <td title="${esc(s.key || '')}">${esc(s.displayName || s.key || '')}${Number(s.sessionCount) > 1 ? ` <span class="meta">（${Number(s.sessionCount)} 个会话）</span>` : ''}</td>
            <td class="num">${withCurrent && s.currentSessionId ? esc(tkNum(s.current?.totalInput || 0)) : '—'}</td>
            <td class="num">${esc(tkNum(s.cumulative?.totalInput || 0))}</td>
            <td class="num">${esc(tkNum(s.cumulative?.input || 0))}</td>
            <td class="num">${esc(tkNum(s.cumulative?.cacheRead || 0))}</td>
            <td class="num">${esc(tkNum(s.cumulative?.output || 0))}</td>
            <td class="num">${esc(tkFull(s.cumulative?.calls || 0))}</td>
            <td class="num">${esc(summText(s.summarizer))}</td>
          </tr>`).join('')}</tbody></table>`;
        const more = allSess.length > 10
          ? `<button id="tokenSessionToggle" class="small" style="margin-top:6px">${TK_SHOW_ALL_SESSIONS ? '收起' : `展开全部（${allSess.length}）`}</button>`
          : '';
        const unTotal = unowned.reduce((a, s) => a + (Number(s.totalInput) || 0), 0);
        const unBlock = unowned.length ? `<details style="margin-top:8px">
          <summary class="meta">内部 / 历史无主会话 ${unowned.length} 个，合计 ${esc(tkNum(unTotal))}${isDayScope ? `（${esc(sessionScope)}）` : ''}（无 QQ 归属，多为黑话学习或已删除会话）</summary>
          <table class="tk-table" style="margin-top:6px">
            <thead><tr><th>sessionId</th><th class="num">总输入</th><th class="num">调用</th></tr></thead>
            <tbody>${unowned.slice(0, 50).map((s) => `<tr><td><code>${esc(s.sessionId)}</code></td><td class="num">${esc(tkNum(s.totalInput))}</td><td class="num">${esc(tkFull(s.calls))}</td></tr>`).join('')}</tbody>
          </table></details>` : '';
        const title = isDayScope
          ? `按会话 · ${esc(sessionScope)} 当天（含摘要器）`
          : '按会话（累计含轮换前旧会话与情节摘要器）';
        sessEl.innerHTML = `<div class="tk-sub">${title}</div>
          ${allSess.length ? sessTable(shown, true) : '<div class="meta">这一天没有已归属会话的调用记录</div>'}${more}${unBlock}`;
        document.getElementById('tokenSessionToggle')?.addEventListener('click', () => {
          TK_SHOW_ALL_SESSIONS = !TK_SHOW_ALL_SESSIONS;
          void refreshTokenUsage();
        });
      }
    }
  } catch (e) {
    statusEl.textContent = '读取失败：' + (e?.message || e);
  }
}

// ── 会话级 Token 熔断（二期 F3）──
let TOKEN_FUSE_LOADED = false;
function splitTokenUnit(n) {
  const v = Math.max(0, Number(n) || 0);
  if (v >= 1e9) return { value: Math.round((v / 1e9) * 100) / 100, unit: '1e9' };
  if (v >= 1e6) return { value: Math.round((v / 1e6) * 100) / 100, unit: '1e6' };
  return { value: Math.round((v / 1e3) * 100) / 100, unit: '1e3' };
}
function tokenUnitOptions(selected) {
  return [['1e3', 'K'], ['1e6', 'M'], ['1e9', 'B']]
    .map(([v, label]) => `<option value="${v}"${String(selected) === v ? ' selected' : ''}>${label}</option>`).join('');
}
function setGlobalThreshold(inputId, unitId, value) {
  const p = splitTokenUnit(value);
  const input = document.getElementById(inputId);
  const unit = document.getElementById(unitId);
  if (input) input.value = p.value;
  if (unit) unit.innerHTML = tokenUnitOptions(p.unit);
}
function tokenThresholdCell(kind, key, name, value) {
  const p = splitTokenUnit(value);
  const attr = `data-fuse-${kind}`;
  return `<td class="num"><span class="fuse-threshold"><input type="number" min="0" step="any" ${attr}="${esc(key)}" value="${p.value}" aria-label="${esc(name)} ${kind} 阈值"><select ${attr}-unit="${esc(key)}" aria-label="${esc(name)} ${kind} 单位">${tokenUnitOptions(p.unit)}</select></span></td>`;
}
function renderTokenFuseRows(rows) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return '<div class="meta">暂无会话（启用后才会开始累计）。</div>';
  return `<table class="tk-table">
    <thead><tr><th>会话</th><th class="num">今日总输入</th><th class="num">未缓存</th><th class="num">调用</th><th>状态</th><th class="num">提醒阈值</th><th class="num">熔断阈值</th><th class="num">未缓存阈值</th><th>操作</th></tr></thead>
    <tbody>${list.map((x) => {
      const stateText = x.state === 'fused' ? '已熔断' : x.state === 'warn' ? '提醒' : '正常';
      const pill = x.state === 'fused' ? 'r' : x.state === 'warn' ? 'b' : 'g';
      const name = x.displayName || x.key;
      const overrideTag = x.overridden ? '<span class="pill b" style="margin-left:6px">自定义</span>' : '';
      return `<tr>
        <td title="${esc(x.key)}"><b>${esc(name)}</b>${overrideTag}<div class="meta">${esc(x.key)}</div></td>
        <td class="num">${esc(tkNum(x.totalInput))}</td>
        <td class="num">${esc(tkNum(x.uncached))}</td>
        <td class="num">${esc(tkFull(x.calls))}</td>
        <td><span class="pill ${pill}">${esc(stateText)}</span></td>
        ${tokenThresholdCell('warn', x.key, name, x.warnTokens)}
        ${tokenThresholdCell('fuse', x.key, name, x.fuseTokens)}
        ${tokenThresholdCell('uncached', x.key, name, x.fuseUncachedTokens)}
        <td><span class="ctx-actions"><button class="small" data-token-fuse-save="${esc(x.key)}">保存</button>${x.overridden ? `<button class="small" data-token-fuse-clear="${esc(x.key)}" title="清除该会话自定义，改用全局默认">用全局</button>` : ''}${x.state === 'fused' ? `<button class="small" data-token-fuse-reset="${esc(x.key)}">解除熔断</button>` : ''}</span></td>
      </tr>`;
    }).join('')}</tbody></table>`;
}
function snapshotTokenFuseInputs() {
  const out = {};
  document.querySelectorAll('#tokenFuseList tbody tr').forEach((tr) => {
    if (tr.dataset.fuseDirty !== '1') return;
    const key = tr.querySelector('[data-token-fuse-save]')?.getAttribute('data-token-fuse-save');
    if (!key) return;
    out[key] = {
      warn: tr.querySelector('[data-fuse-warn]')?.value,
      warnUnit: tr.querySelector('[data-fuse-warn-unit]')?.value,
      fuse: tr.querySelector('[data-fuse-fuse]')?.value,
      fuseUnit: tr.querySelector('[data-fuse-fuse-unit]')?.value,
      uncached: tr.querySelector('[data-fuse-uncached]')?.value,
      uncachedUnit: tr.querySelector('[data-fuse-uncached-unit]')?.value
    };
  });
  return out;
}
function restoreTokenFuseInputs(snapshot, skipKey = '') {
  for (const [key, v] of Object.entries(snapshot || {})) {
    if (key === skipKey) continue;
    const set = (sel, value) => { const el = document.querySelector(sel); if (el && value != null) el.value = value; };
    set(`[data-fuse-warn="${key}"]`, v.warn);
    set(`[data-fuse-warn-unit="${key}"]`, v.warnUnit);
    set(`[data-fuse-fuse="${key}"]`, v.fuse);
    set(`[data-fuse-fuse-unit="${key}"]`, v.fuseUnit);
    set(`[data-fuse-uncached="${key}"]`, v.uncached);
    set(`[data-fuse-uncached-unit="${key}"]`, v.uncachedUnit);
  }
}
async function loadTokenFusePanel(force = false, opts = {}) {
  if (TOKEN_FUSE_LOADED && !force) return;
  const listEl = document.getElementById('tokenFuseList');
  const msg = document.getElementById('tokenFuseMsg');
  if (!listEl) return;
  // 保存/解除只重载该行时，不能把其它行尚未保存的编辑冲掉。
  const snapshot = opts.preserveEdits === false ? null : snapshotTokenFuseInputs();
  if (msg) msg.textContent = '加载中…';
  try {
    const r = await api('/api/socialV2/token-fuse');
    if (!r?.ok) throw new Error(r?.error || '读取失败');
    const c = r.config || {};
    document.getElementById('tokenFuseEnabled').checked = c.enabled === true;
    setGlobalThreshold('tokenFuseWarn', 'tokenFuseWarnUnit', c.warnTokens);
    setGlobalThreshold('tokenFuseFuse', 'tokenFuseFuseUnit', c.fuseTokens);
    setGlobalThreshold('tokenFuseUncached', 'tokenFuseUncachedUnit', c.fuseUncachedTokens);
    const stats = document.getElementById('tokenFuseStats');
    if (stats) stats.textContent = `${c.enabled ? '已启用' : '已关闭'} · ${r.day || '—'} · 熔断 ${Number(r.fused) || 0} / 提醒 ${Number(r.warn) || 0}`;
    listEl.innerHTML = renderTokenFuseRows(r.keys);
    if (snapshot) restoreTokenFuseInputs(snapshot, opts.skipKey || '');
    TOKEN_FUSE_LOADED = true;
    if (msg) msg.textContent = '';
  } catch (error) {
    listEl.innerHTML = `<div class="meta" style="color:var(--err)">读取失败：${esc(error?.message ?? error)}</div>`;
    if (msg) msg.textContent = '';
  }
}
async function saveTokenFuseConfig() {
  const msg = document.getElementById('tokenFuseMsg');
  if (msg) msg.textContent = '保存中…';
  try {
    const readGlobal = (id, unitId) => {
      const value = Number(document.getElementById(id)?.value) || 0;
      const unit = Number(document.getElementById(unitId)?.value) || 1e3;
      return Math.round(value * unit);
    };
    const r = await api('/api/socialV2/token-fuse-config', 'POST', {
      enabled: document.getElementById('tokenFuseEnabled').checked,
      warnTokens: readGlobal('tokenFuseWarn', 'tokenFuseWarnUnit'),
      fuseTokens: readGlobal('tokenFuseFuse', 'tokenFuseFuseUnit'),
      fuseUncachedTokens: readGlobal('tokenFuseUncached', 'tokenFuseUncachedUnit')
    });
    if (!r?.ok) throw new Error(r?.error || '保存失败');
    if (msg) msg.textContent = '全局设置已保存';
    TOKEN_FUSE_LOADED = false;
    await loadTokenFusePanel(true);
  } catch (error) {
    if (msg) msg.textContent = `保存失败：${error?.message ?? error}`;
  }
}
document.getElementById('tokenFusePanel')?.addEventListener('toggle', (e) => {
  if (e.target.open) void loadTokenFusePanel();
});
document.getElementById('tokenFuseSave')?.addEventListener('click', () => void saveTokenFuseConfig());
// 标记正在编辑的行：保存别的行/全局设置时，只恢复这些未保存的编辑，不冲掉新全局默认。
document.getElementById('tokenFuseList')?.addEventListener('input', (e) => {
  const tr = e.target.closest?.('tr');
  if (tr) tr.dataset.fuseDirty = '1';
});
document.getElementById('tokenFuseList')?.addEventListener('click', async (e) => {
  const msg = document.getElementById('tokenFuseMsg');
  const saveBtn = e.target.closest?.('[data-token-fuse-save]');
  const clearBtn = e.target.closest?.('[data-token-fuse-clear]');
  const resetBtn = e.target.closest?.('[data-token-fuse-reset]');
  const key = saveBtn?.getAttribute('data-token-fuse-save')
    || clearBtn?.getAttribute('data-token-fuse-clear')
    || resetBtn?.getAttribute('data-token-fuse-reset');
  if (!key) return;
  try {
    if (saveBtn) {
      const read = (kind) => {
        const value = Number(document.querySelector(`[data-fuse-${kind}="${key}"]`)?.value) || 0;
        const unit = Number(document.querySelector(`[data-fuse-${kind}-unit="${key}"]`)?.value) || 1;
        return Math.round(value * unit);
      };
      const r = await api('/api/socialV2/token-fuse-override', 'POST', {
        key, warnTokens: read('warn'), fuseTokens: read('fuse'), fuseUncachedTokens: read('uncached')
      });
      if (!r?.ok) throw new Error(r?.error || '保存失败');
      if (msg) msg.textContent = '已保存该会话阈值';
    } else if (clearBtn) {
      const r = await api('/api/socialV2/token-fuse-override', 'POST', { key, clear: true });
      if (!r?.ok) throw new Error(r?.error || '恢复失败');
      if (msg) msg.textContent = '已改用全局默认';
    } else if (resetBtn) {
      if (!confirm(`解除 ${key} 的 Token 熔断？当日计数会归零。`)) return;
      const r = await api('/api/socialV2/token-fuse-reset', 'POST', { key });
      if (!r?.ok) throw new Error(r?.error || '解除失败');
      if (msg) msg.textContent = '已解除';
    }
    TOKEN_FUSE_LOADED = false;
    // 只让被操作的那一行回读服务端；其它行保留用户尚未保存的编辑。
    await loadTokenFusePanel(true, { skipKey: key });
  } catch (error) { if (msg) msg.textContent = `操作失败：${error?.message ?? error}`; }
});

document.getElementById('tokenRefresh')?.addEventListener('click', async () => {
  const msg = document.getElementById('tokenMsg');
  const btn = document.getElementById('tokenRefresh');
  if (btn) btn.disabled = true;
  if (msg) msg.textContent = '已在后台统计（全量扫描约 15 秒）…';
  try {
    await api('/api/socialV2/token-usage-refresh', 'POST', {});
    // 轮询等结果：updatedAt 变了就算完成
    const before = (await api('/api/socialV2/token-usage'))?.updatedAt || 0;
    for (let i = 0; i < 40; i++) {
      await new Promise((res) => setTimeout(res, 1000));
      const now = await api('/api/socialV2/token-usage');
      if (now?.updatedAt && now.updatedAt !== before) {
        if (msg) msg.textContent = '统计完成';
        break;
      }
      if (i === 39 && msg) msg.textContent = '还在统计，稍后自动刷新';
    }
    await refreshTokenUsage();
  } catch (e) {
    if (msg) msg.textContent = '触发失败：' + (e?.message || e);
  } finally {
    if (btn) btn.disabled = false;
    setTimeout(() => { if (msg) msg.textContent = ''; }, 8000);
  }
});

// 生成报表图（与控制台里看到的表格同一份数据，只是画成图片版）。
// 直接 <img src> 拉同源 PNG：CSP 是 default-src 'self'，允许同源图片；
// 走 URL 而不是 fetch+blob，是因为浏览器能自己流式处理大图、也能右键另存。
document.getElementById('tokenReport')?.addEventListener('click', async () => {
  const msg = document.getElementById('tokenMsg');
  const btn = document.getElementById('tokenReport');
  const box = document.getElementById('tokenReportPreview');
  if (btn) btn.disabled = true;
  if (msg) msg.textContent = '正在渲染（约 3 秒）…';
  try {
    const url = `/api/socialV2/token-report-image?force=1&t=${Date.now()}`;
    // 与 api() 用同一个令牌来源（localStorage['consoleToken']），但不能走 api()——
    // 那个函数总是 .json()，这里是 PNG。所以自己带一次头。
    const tk = localStorage.getItem('consoleToken');
    const res = await fetch(url, { headers: tk ? { 'x-console-token': tk } : {} });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error || `HTTP ${res.status}`);
    }
    const blob = await res.blob();
    const prev = box?.querySelector('img');
    if (prev) URL.revokeObjectURL(prev.dataset.url || '');
    const objUrl = URL.createObjectURL(blob);
    if (box) {
      box.innerHTML = `<div class="meta" style="margin-bottom:6px">报表预览（右键可另存）</div>`
        + `<img alt="Token 用量报表" style="width:100%;border:1px solid #d9e4ec;border-radius:10px">`;
      const img = box.querySelector('img');
      img.src = objUrl;
      img.dataset.url = objUrl;
    }
    if (msg) msg.textContent = `已生成（${Math.round(blob.size / 1024)}KB）`;
  } catch (e) {
    if (msg) msg.textContent = '生成失败：' + (e?.message || e);
  } finally {
    if (btn) btn.disabled = false;
    setTimeout(() => { if (msg) msg.textContent = ''; }, 8000);
  }
});

// ── 09 MCP 工具清单（只读盘点；开关在 07）────────────────────────────────

  await refreshTokenUsage();
  void loadTokenFusePanel();
}
