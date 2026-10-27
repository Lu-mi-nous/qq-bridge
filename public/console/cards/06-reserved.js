// 06 一代仿真模式（reserved，C2 模块卡）。
//
// 表单字段多但都是普通 number/checkbox/text；逻辑与 legacy 的
// loadSocialForm / saveSocialConfig / refreshSocialStatus 对齐。
import { api as defaultApi } from '../core/api.js';

const TEMPLATE = `
<div class="meta" id="socialStatus">加载中…</div>
<div class="row" style="margin-top:10px">
  <label style="flex:1">普通消息触发概率（观望期）</label><input type="number" id="sTrigger" step="0.05" min="0" max="1" style="width:80px">
</div>
<div class="row"><label style="flex:1">活跃检测间隔（秒）</label>
  <input type="number" id="sCheckMin" min="5" style="width:70px"> ~
  <input type="number" id="sCheckMax" min="5" style="width:70px"></div>
<div class="row"><label style="flex:1">活跃回复延迟（秒）</label>
  <input type="number" id="sActiveDelayMin" min="0" style="width:70px"> ~
  <input type="number" id="sActiveDelayMax" min="0" style="width:70px"></div>
<div class="divider"></div>
<div class="meta" style="margin-bottom:6px">群聊活跃超时主动退出</div>
<div class="row"><label style="flex:1">启用</label><input type="checkbox" id="sActiveDurationEnabled" style="width:auto"></div>
<div class="row"><label style="flex:1">活跃最长持续时间（分）</label>
  <input type="number" id="sActiveDurationMin" min="1" style="width:70px"> ~
  <input type="number" id="sActiveDurationMax" min="1" style="width:70px"></div>
<div class="meta">从进入群聊活跃那一刻起随机取一个时长；到点后即使群里还在聊，也会提示 AI 说一句收尾话并回到观望。私聊不自动退场。</div>
<div class="row"><label style="flex:1">冷场窗口（分）</label><input type="number" id="sIdleWindow" min="1" style="width:80px"></div>
<div class="row"><label style="flex:1">冷场试探概率</label><input type="number" id="sIdleRetry" step="0.05" min="0" max="1" style="width:80px"></div>
<div class="row"><label style="flex:1">试探等待窗口（分）</label><input type="number" id="sIdleWait" min="1" style="width:80px"></div>
<div class="row"><label style="flex:1">普通消息沉默概率</label><input type="number" id="sSkipProb" step="0.05" min="0" max="1" style="width:80px"></div>
<div class="row"><label style="flex:1">抬杠时退让概率</label><input type="number" id="sSurrenderProb" step="0.05" min="0" max="1" style="width:80px"></div>
<div class="row"><label style="flex:1">附带上下文条数</label><input type="number" id="sContextWindow" min="1" max="100" style="width:80px"></div>
<div class="row"><label style="flex:1">单条消息长度上限（字）</label><input type="number" id="sMaxChars" min="1" style="width:80px"></div>
<div class="divider"></div>
<div class="meta" style="margin-bottom:6px">分条发送（按空格分句）</div>
<div class="meta" style="margin-bottom:8px">AI 用空格表示“分成下一条消息”；中英文/数字之间的空格也会被当成分条信号，不想分条就不要加空格、用标点连接。单条只做安全长度上限，不再限制条数。</div>
<div class="row"><label style="flex:1">启用分条发送</label><input type="checkbox" id="sBurstEnabled" style="width:auto"></div>
<div class="row"><label style="flex:1">条间间隔（毫秒）</label>
  <input type="number" id="sBurstIntervalMin" min="0" style="width:70px"> ~
  <input type="number" id="sBurstIntervalMax" min="0" style="width:70px"></div>
<div class="row"><label style="flex:1">长间隔概率</label><input type="number" id="sLongGapProb" step="0.05" min="0" max="1" style="width:80px"></div>
<div class="row"><label style="flex:1">长间隔范围（毫秒）</label>
  <input type="number" id="sLongGapMin" min="0" style="width:70px"> ~
  <input type="number" id="sLongGapMax" min="0" style="width:70px"></div>
<label>必回关键词（逗号分隔）</label>
<input type="text" id="sKeywords" placeholder="deepseek, 在吗">
<div class="divider"></div>
<div class="meta" style="margin-bottom:6px">主动开话题（观望期第三种触发）</div>
<div class="row"><label style="flex:1">启用主动开话题</label><input type="checkbox" id="sProactiveEnabled" style="width:auto"></div>
<div class="row"><label style="flex:1">群安静多久判定（分）</label><input type="number" id="sProactiveIdle" min="1" style="width:80px"></div>
<div class="row"><label style="flex:1">判定间隔（分）</label>
  <input type="number" id="sProactiveCheckMin" min="1" style="width:70px"> ~
  <input type="number" id="sProactiveCheckMax" min="1" style="width:70px"></div>
<div class="row"><label style="flex:1">判定成功概率</label><input type="number" id="sProactiveProb" step="0.05" min="0" max="1" style="width:80px"></div>
<div class="row" style="margin-top:10px">
  <button id="socialSave">保存社交配置</button>
  <button id="socialFlush">立刻投喂摘要</button>
  <span class="meta" id="socialMsg"></span>
</div>
<div class="row" style="margin-top:10px">
  <select id="sStateKey" style="flex:1"><option value="">选择会话</option></select>
  <button id="sStateActive" class="small">设为活跃</button>
  <button id="sStateIdle" class="small">设为观望</button>
</div>
<div class="meta">一代仿真模式状态机：观望期按“明确点名 / 小概率”触发进入活跃；活跃期每 10~20 秒批量查看新消息并回应；群聊活跃超过随机上限会主动提示 AI 收尾退场；冷场后大概率回观望、小概率让 AI 试探一句。可手动强制切换状态。</div>
`;

export async function mount(container, ctx = {}) {
  const api = ctx.api || defaultApi;
  container.innerHTML = TEMPLATE;
  const $ = (id) => document.getElementById(id);

  async function loadForm() {
    try {
      const s = await api('/api/social');
      const c = s.config;
      $('sTrigger').value = c.triggerProbability;
      $('sCheckMin').value = Math.round((c.activeCheckMinMs || 0) / 1000);
      $('sCheckMax').value = Math.round((c.activeCheckMaxMs || 0) / 1000);
      $('sActiveDelayMin').value = Math.round((c.activeReplyDelayMinMs || 0) / 1000);
      $('sActiveDelayMax').value = Math.round((c.activeReplyDelayMaxMs || 0) / 1000);
      $('sActiveDurationEnabled').checked = c.activeDurationEnabled !== false;
      $('sActiveDurationMin').value = Math.round((c.activeDurationMinMs || 0) / 60000);
      $('sActiveDurationMax').value = Math.round((c.activeDurationMaxMs || 0) / 60000);
      $('sIdleWindow').value = Math.round((c.idleWindowMs || 0) / 60000);
      $('sIdleRetry').value = c.idleRetryProbability;
      $('sIdleWait').value = Math.round((c.idleRetryWaitMs || 0) / 60000);
      $('sSkipProb').value = c.skipProbability ?? 0.15;
      $('sSurrenderProb').value = c.surrenderProbability ?? 0.08;
      $('sContextWindow').value = c.contextWindow;
      $('sMaxChars').value = c.maxReplyChars ?? 500;
      $('sBurstEnabled').checked = c.burstEnabled !== false;
      $('sBurstIntervalMin').value = c.burstIntervalMinMs ?? 1000;
      $('sBurstIntervalMax').value = c.burstIntervalMaxMs ?? 3000;
      $('sLongGapProb').value = c.longGapProbability ?? 0.1;
      $('sLongGapMin').value = c.longGapMinMs ?? 2500;
      $('sLongGapMax').value = c.longGapMaxMs ?? 5000;
      $('sKeywords').value = (c.mustReplyKeywords || []).join(', ');
      $('sProactiveEnabled').checked = c.proactiveEnabled !== false;
      $('sProactiveIdle').value = Math.round((c.proactiveIdleThresholdMs || 0) / 60000);
      $('sProactiveCheckMin').value = Math.round((c.proactiveCheckMinMs || 0) / 60000);
      $('sProactiveCheckMax').value = Math.round((c.proactiveCheckMaxMs || 0) / 60000);
      $('sProactiveProb').value = c.proactiveProbability;
    } catch { /* 保留上次值 */ }
  }

  async function refreshStatus() {
    try {
      const s = await api('/api/social');
      const buff = Object.entries(s.pendingSummaries || {}).map(([k, n]) => k + ':' + n).join('  ') || '无';
      const phaseLabel = { idle: '观望', active: '活跃', probing: '试探', exiting: '退场中' };
      const phaseClass = { idle: 'pill g', active: 'pill b', probing: 'pill r', exiting: 'pill' };
      const entries = Object.entries(s.states || {});
      const sel = $('sStateKey');
      const prev = sel.value;
      sel.textContent = '';
      const first = document.createElement('option');
      first.value = '';
      first.textContent = '选择会话';
      sel.appendChild(first);
      for (const [k] of entries) {
        const opt = document.createElement('option');
        opt.value = k;
        opt.textContent = k;
        sel.appendChild(opt);
      }
      if (prev && [...sel.options].some((o) => o.value === prev)) sel.value = prev;
      let html = '摘要缓冲: ' + buff + '<br>状态:';
      if (!entries.length) html += ' 暂无（发过消息的群会显示状态）';
      for (const [k, v] of entries) html += ` <span class="${phaseClass[v.phase] || 'pill'}">${k} · ${phaseLabel[v.phase] || v.phase}</span>`;
      $('socialStatus').innerHTML = html;
    } catch { /* ignore */ }
  }

  async function save() {
    const n = (id) => Number($(id).value);
    const r = await api('/api/social', 'POST', {
      triggerProbability: Math.min(1, Math.max(0, n('sTrigger'))),
      activeCheckMinMs: Math.max(5, n('sCheckMin')) * 1000,
      activeCheckMaxMs: Math.max(5, n('sCheckMax')) * 1000,
      activeReplyDelayMinMs: Math.max(0, n('sActiveDelayMin')) * 1000,
      activeReplyDelayMaxMs: Math.max(0, n('sActiveDelayMax')) * 1000,
      activeDurationEnabled: $('sActiveDurationEnabled').checked,
      activeDurationMinMs: Math.max(1, n('sActiveDurationMin')) * 60000,
      activeDurationMaxMs: Math.max(1, n('sActiveDurationMax')) * 60000,
      idleWindowMs: Math.max(1, n('sIdleWindow')) * 60000,
      idleRetryProbability: Math.min(1, Math.max(0, n('sIdleRetry'))),
      idleRetryWaitMs: Math.max(1, n('sIdleWait')) * 60000,
      skipProbability: Math.min(1, Math.max(0, n('sSkipProb'))),
      surrenderProbability: Math.min(1, Math.max(0, n('sSurrenderProb'))),
      contextWindow: Math.min(100, Math.max(1, n('sContextWindow'))),
      maxReplyChars: Math.max(1, n('sMaxChars')),
      burstEnabled: $('sBurstEnabled').checked,
      burstIntervalMinMs: Math.max(0, n('sBurstIntervalMin')),
      burstIntervalMaxMs: Math.max(0, n('sBurstIntervalMax')),
      longGapProbability: Math.min(1, Math.max(0, n('sLongGapProb'))),
      longGapMinMs: Math.max(0, n('sLongGapMin')),
      longGapMaxMs: Math.max(0, n('sLongGapMax')),
      mustReplyKeywords: $('sKeywords').value.split(/[,，]/).map((x) => x.trim()).filter(Boolean),
      proactiveEnabled: $('sProactiveEnabled').checked,
      proactiveIdleThresholdMs: Math.max(1, n('sProactiveIdle')) * 60000,
      proactiveCheckMinMs: Math.max(1, n('sProactiveCheckMin')) * 60000,
      proactiveCheckMaxMs: Math.max(1, n('sProactiveCheckMax')) * 60000,
      proactiveProbability: Math.min(1, Math.max(0, n('sProactiveProb')))
    });
    $('socialMsg').textContent = r.ok ? '✅ 已保存' : ('❌ ' + (r.error || '失败'));
    $('socialMsg').className = r.ok ? 'meta ok' : 'meta err';
    if (r.ok) { await loadForm(); await refreshStatus(); }
  }

  async function flush() {
    try {
      const r = await api('/api/social/flush', 'POST', {});
      $('socialMsg').textContent = r.ok ? '✅ 已触发摘要投喂' : ('❌ ' + (r.error || '失败'));
      $('socialMsg').className = r.ok ? 'meta ok' : 'meta err';
    } catch (error) {
      $('socialMsg').textContent = '❌ ' + (error?.message || error);
      $('socialMsg').className = 'meta err';
    }
  }

  async function setPhase(phase) {
    const key = $('sStateKey').value;
    if (!key) { window.alert('请先选择会话'); return; }
    try {
      const r = await api('/api/social/state', 'POST', { key, phase });
      $('socialMsg').textContent = r.ok ? ('✅ 已设为' + (phase === 'active' ? '活跃' : '观望')) : ('❌ ' + (r.error || '失败'));
      $('socialMsg').className = r.ok ? 'meta ok' : 'meta err';
      await refreshStatus();
    } catch (error) {
      $('socialMsg').textContent = '❌ ' + (error?.message || error);
      $('socialMsg').className = 'meta err';
    }
  }

  $('socialSave').addEventListener('click', () => { void save(); });
  $('socialFlush').addEventListener('click', () => { void flush(); });
  $('sStateActive').addEventListener('click', () => { void setPhase('active'); });
  $('sStateIdle').addEventListener('click', () => { void setPhase('idle'); });

  await loadForm();
  await refreshStatus();
  setInterval(() => { if (!document.hidden) void refreshStatus(); }, 3000);
}
