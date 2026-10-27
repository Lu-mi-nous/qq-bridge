// 15 取图额度卡片（C2 模块卡）。
//
// 三类上限分开显示：反查额度（唯一真的会用完）、拉取冷却（补货间隔）、
// 图库容量（满了淘汰旧图）。混在一起会把「没开图源」误判成「额度用完」。
import { api as defaultApi } from '../core/api.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));

function fmtSec(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}分${s % 60}秒` : `${s}秒`;
}

function fmtAbs(ms) {
  if (!ms) return '—';
  const d = new Date(Number(ms));
  const p = (x) => String(x).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const bars = (pct) => {
  const filled = Math.round(Math.max(0, Math.min(100, pct)) / 5);
  return '█'.repeat(filled) + '░'.repeat(20 - filled);
};

export async function mount(container, ctx = {}) {
  const api = ctx.api || defaultApi;
  container.textContent = '';
  const status = document.createElement('div');
  status.className = 'meta';
  status.textContent = '加载中…';
  const reverse = document.createElement('div');
  reverse.style.marginTop = '8px';
  const fetchLine = document.createElement('div');
  fetchLine.className = 'meta';
  fetchLine.style.marginTop = '6px';
  const libLine = document.createElement('div');
  libLine.className = 'meta';
  libLine.style.marginTop = '6px';
  const sources = document.createElement('div');
  sources.className = 'meta';
  sources.style.marginTop = '6px';
  const hint = document.createElement('div');
  hint.className = 'meta';
  hint.innerHTML = '三类上限互相独立：<b>SauceNAO 反查</b>是唯一会「当天用完」的上游免费额度；'
    + '<b>拉取冷却</b>只是两次补货之间的最小间隔；<b>图库容量</b>满了会淘汰旧图，不影响继续取图。';
  container.append(status, reverse, fetchLine, libLine, sources, hint);

  function clearDetails() {
    reverse.textContent = '';
    fetchLine.textContent = '';
    libLine.textContent = '';
    sources.textContent = '';
  }

  function setSummary(text) {
    window.__CONSOLE_CARD_STATE__ = window.__CONSOLE_CARD_STATE__ || {};
    window.__CONSOLE_CARD_STATE__['plugin:images'] = { statusText: text };
  }

  async function refresh() {
    try {
      const s = await api('/api/socialV2/image-quota');
      if (!s?.ok) { status.textContent = '读取失败'; return; }
      if (s.enabled === false) {
        status.innerHTML = '<span class="pill">图库已关闭</span> socialV2.images.enabled=false（取图相关功能不可用）';
        setSummary('图库已关闭');
        clearDetails();
        return;
      }

      const rs = s.reverseSearch || {};
      const fetchCfg = s.fetch || {};
      const lib = s.library || {};
      const send = s.send || {};

      let summaryText;
      if (!rs.hasKey) {
        status.innerHTML = '<span class="pill">反查未配置</span> 没配 SauceNAO API key，反查功能不可用';
        summaryText = '反查未配置';
      } else if (Number(rs.remainingToday) <= 0) {
        status.innerHTML = '<span class="pill r">反查额度已用完</span> 今天无法再反查，明天自动重置';
        summaryText = '反查额度已用完';
      } else {
        status.innerHTML = `<span class="pill g">反查剩余 ${Number(rs.remainingToday)} / ${Number(rs.dailyMax)} 次</span> 今日免费额度`;
        summaryText = `反查剩余 ${Number(rs.remainingToday)} / ${Number(rs.dailyMax)} 次`;
      }
      setSummary(summaryText);

      // ① 反查额度详情
      if (rs.hasKey) {
        const used = Number(rs.usedToday) || 0;
        const max = Number(rs.dailyMax) || 0;
        const pct = max > 0 ? Math.round((used / max) * 100) : 0;
        let html = `SauceNAO 反查：<code>${esc(bars(pct))}</code> ${pct}%`
          + `　已用 ${esc(String(used))} / ${esc(String(max))} 次　剩余 <b>${esc(String(rs.remainingToday))}</b> 次`;
        const wUsed = Number(rs.windowUsed) || 0;
        const wMax = Number(rs.windowMax) || 0;
        if (wUsed > 0) {
          html += `<br><span class="meta">短时窗口：${esc(String(wUsed))} / ${esc(String(wMax))} 次`
            + (Number(rs.windowResetMs) > 0
              ? `　已满，${esc(fmtSec(Number(rs.windowResetMs) / 1000))}后可再用`
              : '　当前可用') + '</span>';
        }
        const cached = Number(rs.cached) || 0;
        if (cached > 0) html += `<br><span class="meta">缓存 ${esc(String(cached))} 张（同一张图不重复消耗额度）</span>`;
        reverse.innerHTML = html;
      } else {
        reverse.innerHTML = '<span class="meta">未配置 imageReverseSearch.apiKey，反查不可用（其余取图功能不受影响）</span>';
      }

      // ② 拉取冷却
      const cdMs = Number(fetchCfg.cooldownMs) || 0;
      fetchLine.innerHTML = fetchCfg.fetching
        ? '<span class="pill r">正在拉取</span> 有补货任务进行中'
        : fetchCfg.cooling
          ? `<span class="pill">补货冷却中</span> 还需 ${esc(fmtSec(Number(fetchCfg.remainMs) / 1000))}`
            + `（两次补货最短间隔 ${esc(fmtSec(cdMs / 1000))}）`
            + (fetchCfg.lastFetchedAt ? `　上次 ${esc(fmtAbs(fetchCfg.lastFetchedAt))}` : '')
          : `<span class="pill g">可补货</span> 每次最多 ${esc(String(fetchCfg.fetchPerRun))} 张`
            + (cdMs > 0 ? `　最短间隔 ${esc(fmtSec(cdMs / 1000))}` : '');

      // ③ 图库容量
      if (lib && Number(lib.maxFiles) > 0) {
        const libPct = Math.round((Number(lib.total) / Number(lib.maxFiles)) * 100);
        const bySrc = Object.entries(lib.bySource || {})
          .map(([k, v]) => `${esc(k)} ${esc(String(v))}`).join('　');
        libLine.innerHTML = `图库容量：<code>${esc(bars(libPct))}</code> ${libPct}%`
          + `　${esc(String(lib.total))} / ${esc(String(lib.maxFiles))} 张`
          + `　${esc(String(lib.totalMB ?? 0))}MB / ${esc(String(lib.maxTotalMB ?? 0))}MB`
          + `　已发过 ${esc(String(lib.sent ?? 0))} 张`
          + (bySrc ? `<br><span class="meta">来源：${bySrc}</span>` : '')
          + `<br><span class="meta">每会话发送限频：冷却 ${esc(fmtSec((Number(send.cooldownMs) || 0) / 1000))}`
          + `　每小时最多 ${esc(String(send.maxSendPerHour ?? 0))} 张</span>`;
      } else {
        libLine.textContent = '';
      }

      // ④ 图源开关
      const list = Array.isArray(s.sources) ? s.sources : [];
      sources.innerHTML = list.length
        ? '图源：' + list.map((x) => {
            const on = x.enabled ? '<span class="pill g">开</span>' : '<span class="pill">关</span>';
            return `${esc(x.name)} ${on}${x.enabled ? `　上限 ${esc(String(x.limit))} 张/次` : ''}`
              + `${x.enabled && !x.hasProxy && /pixiv|yandere/.test(x.name) ? '　<span class="meta">（无代理，可能连不上）</span>' : ''}`;
          }).join('　')
        : '';
    } catch (error) {
      status.textContent = '额度读取失败：' + (error?.message || error);
      setSummary('读取失败');
    }
  }

  await refresh();
  setInterval(() => { if (document.visibilityState !== 'hidden') void refresh(); }, 15000);
}
