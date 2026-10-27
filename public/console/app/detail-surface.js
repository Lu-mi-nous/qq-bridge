// 通用整页详情（基础卡 / 插件卡共用）。
//
// 负责一个 detailPage 骨架、FLIP ghost 展开/收起、Esc/返回按钮与 inert 恢复。
// 调用方只传 section、触发卡与返回容器；section 是“移动”不是重建，
// 所以卡片模块里已有的 getElementById/事件绑定/轮询不会因为打开详情而失效。

function ensureDetailPage() {
  if (document.getElementById('detailPage')) return;
  document.body.insertAdjacentHTML('beforeend', "  <section class=\"detail-page\" id=\"detailPage\" hidden aria-labelledby=\"detailPageTitle\">\n    <div class=\"detail-shell\">\n      <div class=\"detail-bar\">\n        <button class=\"detail-back\" id=\"detailBack\" type=\"button\" title=\"返回功能列表（Esc）\">\n          <span class=\"arrow\" aria-hidden=\"true\">←</span><span>返回</span>\n        </button>\n        <div class=\"detail-heading\">\n          <span class=\"sec-no\" id=\"detailPageNo\"></span>\n          <h2 id=\"detailPageTitle\">详情</h2>\n        </div>\n        <span class=\"detail-hint\">Esc 返回</span>\n      </div>\n      <div class=\"detail-page-body\" id=\"detailPageBody\"></div>\n    </div>\n  </section>");
}

let refs = null;
let bound = false;
let openSection = null;
let openTrigger = null;
let openReturnHost = null;
let openInert = [];
let openOnClose = null;
let detailTimer = 0;
let detailGhost = null;
let closing = false;

function getRefs() {
  ensureDetailPage();
  if (!refs) {
    refs = {
      page: document.getElementById('detailPage'),
      body: document.getElementById('detailPageBody'),
      title: document.getElementById('detailPageTitle'),
      no: document.getElementById('detailPageNo')
    };
  }
  return refs;
}

const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
const clearGhost = () => {
  if (detailGhost) { detailGhost.remove(); detailGhost = null; }
};
const setInert = (on) => {
  for (const el of openInert) {
    if (!el) continue;
    if (on) el.setAttribute('inert', '');
    else el.removeAttribute('inert');
  }
};

function finishClose() {
  const section = openSection;
  const restore = openTrigger;
  const host = openReturnHost;
  const onClose = openOnClose;
  if (section) section.style.visibility = '';
  if (section && host) host.appendChild(section);
  openSection = null;
  openTrigger = null;
  openReturnHost = null;
  openOnClose = null;
  if (refs?.page) {
    refs.page.hidden = true;
    refs.page.classList.remove('manual-exit', 'manual-enter', 'open');
  }
  setInert(false);
  openInert = [];
  document.dispatchEvent(new CustomEvent('detailpagechange', { detail: { open: false } }));
  if (restore) {
    restore.style.visibility = '';
    restore.setAttribute('aria-expanded', 'false');
    if (typeof restore.focus === 'function') setTimeout(() => restore.focus({ preventScroll: true }), 0);
  }
  if (typeof onClose === 'function') onClose();
  closing = false;
}

function mount() {
  const r = getRefs();
  if (!bound) {
    bound = true;
    document.getElementById('detailBack')?.addEventListener('click', () => closeDetail());
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !r.page?.hidden) { e.preventDefault(); closeDetail(); }
    });
  }
}

/**
 * 打开整页详情。
 * @param {object} opts
 * @param {HTMLElement} opts.section 要移动进详情页的 section
 * @param {HTMLElement} [opts.trigger] 摘要卡（用于 FLIP 与焦点恢复）
 * @param {string} [opts.title] 顶栏标题
 * @param {string} [opts.no] 顶栏序号/标签
 * @param {HTMLElement} [opts.returnHost] 关闭时 section 回到哪里
 * @param {HTMLElement[]} [opts.inert] 打开期间需要 inert 的容器
 * @param {Function} [opts.onClose] 关闭后的回调
 * @param {'core'|'plugin'} [opts.kind] 供路由判断返回目标
 */
export function openDetail({ section, trigger = null, title = '', no = '', returnHost = null, inert = [], onClose = null, kind = 'core' } = {}) {
  if (!section) return false;
  mount();
  const r = getRefs();
  if (!r.page || !r.body) return false;
  if (openSection === section) return true;
  if (openSection) closeDetail({ immediate: true });

  clearTimeout(detailTimer);
  clearGhost();
  openSection = section;
  openTrigger = trigger || document.activeElement;
  openReturnHost = returnHost || section.parentNode;
  openInert = (Array.isArray(inert) ? inert : []).filter(Boolean);
  openOnClose = onClose;
  if (openTrigger) openTrigger.setAttribute('aria-expanded', 'true');
  if (r.page) r.page.dataset.kind = kind;
  if (r.title) r.title.textContent = title || '';
  if (r.no) r.no.textContent = no || '';
  setInert(true);
  document.dispatchEvent(new CustomEvent('detailpagechange', { detail: { open: true } }));

  const animate = !!(trigger?.classList?.contains('summary-card') && !reducedMotion());
  if (!animate) {
    r.body.appendChild(section);
    r.page.hidden = false;
    r.page.scrollTop = 0;
    return true;
  }

  const rect = trigger.getBoundingClientRect();
  const ghost = document.createElement('div');
  ghost.className = 'detail-ghost';
  ghost.style.left = `${rect.left}px`;
  ghost.style.top = `${rect.top}px`;
  ghost.style.width = `${Math.max(1, rect.width)}px`;
  ghost.style.height = `${Math.max(1, rect.height)}px`;
  const main = trigger.querySelector('.sc-main')?.cloneNode(true);
  if (main) ghost.appendChild(main);
  document.body.appendChild(ghost);
  trigger.style.visibility = 'hidden';

  r.page.classList.add('manual-enter');
  r.page.hidden = false;
  r.body.appendChild(section);
  r.page.scrollTop = 0;
  void r.page.offsetHeight;

  const sectionRect = section.getBoundingClientRect();
  const target = {
    left: Math.max(0, sectionRect.left),
    top: Math.max(0, sectionRect.top),
    width: Math.max(1, Math.min(window.innerWidth, sectionRect.right) - Math.max(0, sectionRect.left)),
    height: Math.max(1, Math.min(window.innerHeight, sectionRect.bottom) - Math.max(0, sectionRect.top))
  };
  const sx = target.width / Math.max(1, rect.width);
  const sy = target.height / Math.max(1, rect.height);
  ghost.style.transform = `translate(${target.left - rect.left}px, ${target.top - rect.top}px) scale(${sx}, ${sy})`;
  ghost.style.borderRadius = `${20 / Math.max(0.01, Math.min(sx, sy))}px`;
  ghost.classList.add('run');
  r.page.classList.add('open');
  detailGhost = ghost;
  detailTimer = setTimeout(() => {
    if (detailGhost === ghost) detailGhost = null;
    ghost.remove();
    trigger.style.visibility = '';
    r.page.classList.remove('manual-enter', 'open');
  }, 760);
  return true;
}

/** 关闭整页详情；immediate=true 时跳过收起动画（用于视图重建）。 */
export function closeDetail({ immediate = false } = {}) {
  mount();
  const r = getRefs();
  if (!openSection || !r.page) return false;
  if (closing) {
    if (!immediate) return false;
    // 视图重建时可能正好处在收起动画中：强制结束，避免旧 section 的定时器
    // 把已清空的节点重新 append 回新池子。
    clearTimeout(detailTimer);
    clearGhost();
    if (openSection) openSection.style.visibility = '';
    finishClose();
    return true;
  }
  closing = true;
  clearTimeout(detailTimer);
  clearGhost();
  const section = openSection;
  const restore = openTrigger;
  const trigger = restore?.classList?.contains('summary-card') ? restore : null;

  if (immediate || !trigger || reducedMotion()) {
    finishClose();
    return true;
  }

  const rawFrom = section.getBoundingClientRect();
  const from = {
    left: Math.max(0, rawFrom.left),
    top: Math.max(0, rawFrom.top),
    width: Math.max(1, Math.min(window.innerWidth, rawFrom.right) - Math.max(0, rawFrom.left)),
    height: Math.max(1, Math.min(window.innerHeight, rawFrom.bottom) - Math.max(0, rawFrom.top))
  };
  const to = trigger.getBoundingClientRect();
  const ghost = document.createElement('div');
  ghost.className = 'detail-ghost';
  ghost.style.left = `${from.left}px`;
  ghost.style.top = `${from.top}px`;
  ghost.style.width = `${from.width}px`;
  ghost.style.height = `${from.height}px`;
  const main = trigger.querySelector('.sc-main')?.cloneNode(true);
  if (main) ghost.appendChild(main);
  document.body.appendChild(ghost);
  section.style.visibility = 'hidden';
  r.page.classList.add('manual-exit');
  void ghost.offsetHeight;
  const sx = Math.max(1, to.width) / Math.max(1, from.width);
  const sy = Math.max(1, to.height) / Math.max(1, from.height);
  ghost.style.transform = `translate(${to.left - from.left}px, ${to.top - from.top}px) scale(${sx}, ${sy})`;
  ghost.style.borderRadius = `${20 / Math.max(0.01, Math.min(sx, sy))}px`;
  ghost.classList.add('run');
  detailGhost = ghost;
  detailTimer = setTimeout(() => {
    if (detailGhost === ghost) detailGhost = null;
    ghost.remove();
    section.style.visibility = '';
    finishClose();
  }, 620);
  return true;
}

export function isDetailOpen() {
  return !!openSection;
}

export function mountDetailSurface() {
  mount();
}
