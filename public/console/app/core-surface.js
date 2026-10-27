// 基础功能摘要卡 surface（C6 P2）。
//
// 只负责 19 张 owner=core 的摘要卡；整页详情与 FLIP 动画由 detail-surface 统一提供，
// 插件卡复用同一套详情行为。
import { mountDetailSurface, openDetail, closeDetail } from './detail-surface.js';

export function mountCoreSurface(registry) {
  const pool = document.getElementById('detailPool');
  const grid = document.getElementById('summaryGrid');
  const DETAIL_POOL = pool;
  const SUMMARY_GRID = grid;
  if (!pool || !grid) return;
  if (window.__CORE_SURFACE_MOUNTED__) return;
  window.__CORE_SURFACE_MOUNTED__ = true;

  mountDetailSurface();
  grid.textContent = '';
  let index = 0;
  for (const card of registry.coreCards) {
    let section = pool.querySelector(card.legacy || '');
    if (!section) {
      section = document.createElement('section');
      section.className = `card ${card.cardClass || ''}`.trim();
      section.id = `sec-${card.id}`;
      section.dataset.sec = card.id;
      const h2 = document.createElement('h2');
      const no = document.createElement('span');
      no.className = 'sec-no';
      no.textContent = card.id;
      h2.append(no, document.createTextNode(card.title || ''));
      const mount = document.createElement('div');
      mount.className = 'declarative-card';
      mount.setAttribute('data-card-mount', card.id);
      section.append(h2, mount);
      pool.appendChild(section);
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'summary-card glass';
    btn.dataset.card = card.id;
    btn.dataset.group = 'core';
    btn.style.setProperty('--i', String(index++));
    btn.setAttribute('aria-controls', 'detailPage');
    btn.setAttribute('aria-expanded', 'false');

    const badge = document.createElement('span');
    badge.className = 'sc-no';
    badge.textContent = card.id;
    const title = document.createElement('span');
    title.className = 'sc-title';
    title.textContent = card.title;
    title.title = card.title;
    const summary = document.createElement('span');
    summary.className = 'sc-summary';
    summary.id = `summary-${card.id}`;
    summary.textContent = '…';
    const dot = document.createElement('span');
    dot.className = 'sc-dot';
    dot.hidden = true;
    dot.setAttribute('aria-hidden', 'true');
    const main = document.createElement('span');
    main.className = 'sc-main';
    main.append(badge, title);
    btn.append(main, summary, dot);
    btn.addEventListener('click', () => { openCoreCard(card.id, btn); });
    grid.appendChild(btn);
  }

  function openCoreCard(id, trigger) {
    const card = registry.coreCards.find((c) => c.id === id);
    const section = card ? pool.querySelector(card.legacy || '') : null;
    if (!section) return false;
    return openDetail({
      section,
      trigger,
      title: card.title || '',
      no: card.id || '',
      returnHost: pool,
      inert: [SUMMARY_GRID, DETAIL_POOL]
    });
  }

  function closeCoreCard() { return closeDetail(); }

  window.__openCoreCard = openCoreCard;
  window.__closeCoreCard = closeCoreCard;
  window.__closeDetail = closeDetail;

  pool.hidden = true;
  window.initSummaryGloss?.();
  window.applyConsoleGroup?.('core');
  window.refreshSummaries?.();
}
