function ensureDevLogModal() {
  if (document.getElementById('devLogOverlay')) return;
  document.body.insertAdjacentHTML('beforeend', "  <!-- ============ 开发日志弹窗（关于页「说明」卡按钮） ============ -->\n  <div class=\"modal-overlay\" id=\"devLogOverlay\">\n    <div class=\"modal dev-log-modal\" role=\"dialog\" aria-modal=\"true\" aria-labelledby=\"devLogTitle\">\n      <div class=\"row\" style=\"justify-content:space-between;align-items:center;margin:0\">\n        <h3 id=\"devLogTitle\" style=\"margin:0\">开发日志</h3>\n        <button class=\"small\" id=\"devLogClose\" type=\"button\" title=\"关闭（Esc）\" aria-label=\"关闭\">✕</button>\n      </div>\n      <div class=\"meta\" id=\"devLogStatus\" style=\"margin-top:6px\">加载中…</div>\n      <div id=\"devLogList\" class=\"dev-log-list\"></div>\n      <div class=\"row\" style=\"margin-top:10px\">\n        <button id=\"devLogRefresh\" class=\"small\">刷新</button>\n        <button id=\"devLogMore\" class=\"small\" hidden>显示全部</button>\n        <span class=\"meta\" id=\"devLogMsg\"></span>\n      </div>\n    </div>\n  </div>\n\n  <!-- ============ 黑话确认/编辑弹窗（body 级浮层） ============\n       必须在 #detailPool 之外：池子会 display:none，留在里面就永远打不开。\n       z-index 1000 > 整页详情的 900，所以叠在整页之上。 -->\n  <div class=\"modal-overlay\" id=\"slangModalOverlay\">\n    <div class=\"modal\">\n      <h3 id=\"slangModalTitle\">确认黑话</h3>\n      <div class=\"meta\" id=\"slangModalContent\" style=\"margin-bottom:6px\"></div>\n      <label>含义 *</label>\n      <input type=\"text\" id=\"slangModalMeaning\" placeholder=\"必须填写，确认后才会注入 AI 上下文\">\n      <label>用法（可选）</label>\n      <input type=\"text\" id=\"slangModalUsage\" placeholder=\"使用场景 / 语气\">\n      <label>示例（可选）</label>\n      <input type=\"text\" id=\"slangModalExample\" placeholder=\"自然短句示例\">\n      <label>风险/慎用说明（可选）</label>\n      <input type=\"text\" id=\"slangModalRisk\" placeholder=\"敏感 / 慎用风险\">\n      <label>参考来源（可选，每行一个 URL）</label>\n      <textarea id=\"slangModalSources\" rows=\"3\" placeholder=\"https://...\"></textarea>\n      <div class=\"row\">\n        <button id=\"slangModalDirectConfirm\" class=\"small\">直接确认（转正）</button>\n        <button id=\"slangModalSendResearch\" class=\"small\">送 DSH 深度研究</button>\n        <button id=\"slangModalCancel\" class=\"small\">取消</button>\n      </div>\n    </div>\n  </div>\n\n");
}
ensureDevLogModal();

// 开发日志弹窗（C6 runtime 拆分）。
// ── 开发日志：解析后的 README 更新日志 ───────────────────────────────
let DEV_LOG_LOADED = false;
let DEV_LOG_SHOW_ALL = false;
const DEV_LOG_PER_SECTION = 12;
async function refreshDevLog(force = false) {
  if (DEV_LOG_LOADED && !force) return;
  const status = document.getElementById('devLogStatus');
  const list = document.getElementById('devLogList');
  const msg = document.getElementById('devLogMsg');
  if (!status || !list) return;
  if (msg) msg.textContent = '加载中…';
  try {
    const r = await api('/api/dev-log');
    if (!r?.ok) throw new Error(r?.error || '读取失败');
    const sections = Array.isArray(r.sections) ? r.sections : [];
    const total = Number(r.entries) || 0;
    let displayed = 0;
    status.textContent = sections.length
      ? `共 ${total} 条记录 · 最近 ${sections[0]?.title || '—'}`
      : '暂无开发日志';
    list.innerHTML = sections.length ? sections.map((sec, i) => {
      const allEntries = Array.isArray(sec.entries) ? sec.entries : [];
      const entries = DEV_LOG_SHOW_ALL ? allEntries : allEntries.slice(0, DEV_LOG_PER_SECTION);
      displayed += entries.length;
      const cards = entries.map((e) => `
        <div class="dev-log-card">
          <button type="button" class="dev-log-card-head" aria-expanded="false">
            <span class="dev-log-card-title">${renderMdInline(e.title)}</span>
            <span class="dev-log-card-meta">${e.date ? `${esc(e.date)} · ` : ''}${esc(sec.title)}</span>
          </button>
          ${e.body ? `<div class="dev-log-card-body"><div class="dev-log-card-inner">${renderMd(e.body)}</div></div>` : ''}
        </div>`).join('');
      return `<details class="dev-log-section"${i === 0 ? ' open' : ''}>
        <summary>${esc(sec.title)} <span class="meta">${allEntries.length} 条</span></summary>
        <div class="dev-log-grid">${cards}</div>
      </details>`;
    }).join('') : '<div class="meta">还没有更新日志。</div>';
    // 展开动画需要具体高度：先量内容 scrollHeight，打开时 max-height 从 0 过渡到该值。
    for (const card of list.querySelectorAll('.dev-log-card')) {
      const inner = card.querySelector('.dev-log-card-inner');
      if (inner) card.style.setProperty('--dev-h', `${Math.ceil(inner.scrollHeight)}px`);
    }
    const more = document.getElementById('devLogMore');
    if (more) {
      more.hidden = displayed >= total;
      more.textContent = `显示全部（${total} 条）`;
    }
    DEV_LOG_LOADED = true;
    if (msg) msg.textContent = '';
  } catch (error) {
    status.textContent = `读取失败：${error?.message ?? error}`;
    if (msg) msg.textContent = '';
  }
}
let devLogTrigger = null;
function openDevLog(trigger) {
  const overlay = document.getElementById('devLogOverlay');
  if (!overlay) return;
  devLogTrigger = trigger || document.activeElement;
  overlay.classList.add('open');
  document.getElementById('devLogClose')?.focus({ preventScroll: true });
  void refreshDevLog();
}
function closeDevLog() {
  const overlay = document.getElementById('devLogOverlay');
  if (!overlay) return;
  overlay.classList.remove('open');
  const restore = devLogTrigger;
  devLogTrigger = null;
  if (restore && typeof restore.focus === 'function') {
    setTimeout(() => restore.focus({ preventScroll: true }), 60);
  }
}
document.getElementById('devLogOpen')?.addEventListener('click', (e) => openDevLog(e.currentTarget));
document.getElementById('devLogClose')?.addEventListener('click', closeDevLog);
document.getElementById('devLogOverlay')?.addEventListener('click', (e) => {
  if (e.target === e.currentTarget) closeDevLog();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.getElementById('devLogOverlay')?.classList.contains('open')) {
    e.preventDefault();
    closeDevLog();
  }
});
function toggleDevLogCard(head) {
  const card = head.closest('.dev-log-card');
  if (!card) return;
  const body = card.querySelector('.dev-log-card-body');
  const open = !card.classList.contains('open');
  head.setAttribute('aria-expanded', String(open));
  if (!body) { card.classList.toggle('open', open); return; }
  const target = card.style.getPropertyValue('--dev-h')
    || `${body.querySelector('.dev-log-card-inner')?.scrollHeight || 400}px`;
  if (reducedMotion()) {
    card.classList.toggle('open', open);
    body.style.maxHeight = open ? target : '0px';
    body.style.opacity = open ? '1' : '0';
    return;
  }
  if (open) {
    body.style.maxHeight = '0px';
    body.style.opacity = '0';
    card.classList.add('open');
    // 先让浏览器记录起始值，再改目标值，max-height 过渡才会真的跑起来。
    void body.offsetHeight;
    setTimeout(() => {
      body.style.maxHeight = target;
      body.style.opacity = '1';
    }, 0);
  } else {
    body.style.maxHeight = `${body.getBoundingClientRect().height}px`;
    body.style.opacity = '1';
    void body.offsetHeight;
    card.classList.remove('open');
    setTimeout(() => {
      body.style.maxHeight = '0px';
      body.style.opacity = '0';
    }, 0);
  }
}
document.getElementById('devLogList')?.addEventListener('click', (e) => {
  const head = e.target.closest?.('.dev-log-card-head');
  if (!head) return;
  toggleDevLogCard(head);
});
document.getElementById('devLogRefresh')?.addEventListener('click', () => void refreshDevLog(true));
document.getElementById('devLogMore')?.addEventListener('click', () => {
  DEV_LOG_SHOW_ALL = true;
  DEV_LOG_LOADED = false;
  void refreshDevLog(true);
});

