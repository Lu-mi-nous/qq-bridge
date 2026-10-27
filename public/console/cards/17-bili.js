// 17 B 站自己刷视频（C5 真模块卡）。
//
// 从 legacy 的 refreshBiliStatus 迁出：状态/上次观看/额度/声音内容/口味/推荐目的地/最近看过。
import { api as defaultApi } from '../core/api.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));
const fmtSec = (sec) => {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}分${s % 60}秒` : `${s}秒`;
};
const fmtAbs = (ms) => {
  if (!ms) return '—';
  const d = new Date(Number(ms));
  const p = (x) => String(x).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const PHASE = { 'fetching-list': '正在取热门列表', picking: '正在挑视频', downloading: '正在下载片段', delivering: '正在把画面交给 AI', done: '看完了' };

export async function mount(container, ctx = {}) {
  const api = ctx.api || defaultApi;
  container.textContent = '';
  const status = document.createElement('div'); status.className = 'meta'; status.id = 'biliStatusLine'; status.textContent = '加载中…';
  const now = document.createElement('div'); now.id = 'biliNow'; now.style.margin = '8px 0';
  const budget = document.createElement('div'); budget.className = 'meta'; budget.id = 'biliBudget';
  const audio = document.createElement('div'); audio.id = 'biliAudio'; audio.style.marginTop = '10px';
  const taste = document.createElement('div'); taste.className = 'meta'; taste.id = 'biliTaste'; taste.style.marginTop = '6px';
  const activity = document.createElement('div'); activity.id = 'biliActivity'; activity.style.marginTop = '8px';
  const recent = document.createElement('div'); recent.id = 'biliRecent'; recent.style.marginTop = '8px';
  const row = document.createElement('div'); row.className = 'row'; row.style.marginTop = '8px';
  const browse = document.createElement('button'); browse.type = 'button'; browse.className = 'small'; browse.id = 'biliBrowseNow'; browse.textContent = '现在刷一条';
  const pause = document.createElement('button'); pause.type = 'button'; pause.className = 'small'; pause.id = 'biliPause'; pause.textContent = '暂停自主刷';
  const msg = document.createElement('span'); msg.className = 'meta'; msg.id = 'biliBrowseMsg';
  row.append(browse, pause, msg);
  const hint = document.createElement('div'); hint.className = 'meta'; hint.id = 'biliHint';
  hint.textContent = '潜水时随机刷热门视频；喜欢多看、不喜欢划走；每天上限 2 小时（按实际观看秒数）。暂停只停"自己刷"，群友发的链接照看不误。';
  container.append(status, now, budget, audio, taste, activity, recent, row, hint);

  async function refresh() {
    try {
      const s = await api('/api/socialV2/bili-status');
      if (!s?.ok) { status.textContent = '未启用'; return; }
      const sb = s.selfBrowsing || {};
      const pausedNow = s.enabled !== false && sb.enabled === false;
      pause.textContent = pausedNow ? '恢复自主刷' : '暂停自主刷';
      pause.disabled = s.enabled === false;
      pause.title = pausedNow ? '点击恢复：会重新开始按 5~10 分钟间隔随机刷' : '点击暂停：停掉"自己刷"，群友发的链接仍会观看';

      if (s.enabled === false) status.innerHTML = '<span class="pill">已关闭</span> socialV2.bili.enabled=false';
      else if (sb.enabled === false) status.innerHTML = '<span class="pill r">⏸ 自主刷已暂停</span> 群友发链接时仍会观看';
      else if (sb.browsing?.active) {
        const v = sb.browsing.video;
        const phase = PHASE[sb.browsing.phase] || sb.browsing.phase || '进行中';
        status.innerHTML = `<span class="pill r">▶ 正在刷</span> ${esc(phase)}`
          + (v ? `：《${esc(String(v.title || '').slice(0, 30))}》` : '')
          + ` <span class="meta">（已持续 ${fmtSec(sb.browsing.elapsedSec)}）</span>`;
      } else {
        const next = Number(sb.nextInSec) > 0 ? `下次约 ${fmtSec(sb.nextInSec)} 后` : '等待调度';
        status.innerHTML = `<span class="pill g">空闲</span> ${esc(next)}`
          + (sb.lastBrowseAt ? `　上次 ${esc(fmtAbs(sb.lastBrowseAt))}` : '');
      }

      const last = sb.lastVideo;
      if (last) {
        const okMark = last.ok === false ? '<span class="pill r">失败</span>' : '';
        now.innerHTML = `<div class="meta">上次观看 ${okMark}`
          + `<b>${esc(String(last.title || last.bvid || '').slice(0, 40))}</b>`
          + `${last.owner ? `　${esc(last.owner)}` : ''}`
          + `${last.category ? `　<span class="pill">${esc(last.category)}</span>` : ''}`
          + `${last.seconds ? `　看了 ${last.seconds}s / ${last.frames} 帧` : ''}`
          + `${last.key ? `　→ ${esc(last.key)}` : ''}</div>`
          + (last.error ? `<div class="meta">失败原因：${esc(String(last.error).slice(0, 100))}</div>` : '');
      } else {
        now.innerHTML = '<div class="meta">还没有刷过（或刚重启，记录在内存里）</div>';
      }

      const used = Number(sb.usedSec) || 0;
      const max = Number(sb.dailyBudgetSec) || 0;
      const remain = Number(sb.remainingSec) || 0;
      const pct = max > 0 ? Math.min(100, Math.round((used / max) * 100)) : 0;
      const bars = '█'.repeat(Math.round(pct / 5)) + '░'.repeat(20 - Math.round(pct / 5));
      budget.innerHTML = `今日额度：<code>${esc(bars)}</code> ${pct}%　已看 ${esc(fmtSec(used))} / 上限 ${esc(fmtSec(max))}`
        + `　剩余 ${esc(fmtSec(remain))}　今天刷了 ${Number(sb.videosToday) || 0} 条`;

      const au = sb.audio || {};
      const asrStateText = {
        ready: '<span class="pill g">已就绪</span>', starting: '<span class="pill">加载中…</span>',
        idle: '<span class="pill">待加载</span>', failed: '<span class="pill" style="background:#8a3a3a;color:#fff">不可用</span>',
        disabled: '<span class="pill">已关闭</span>'
      }[au.asrState] || '<span class="pill">未知</span>';
      const subText = au.subtitleAvailable ? '<span class="pill g">可用</span>（登录态）' : `<span class="pill">不可用</span> <span class="meta">${esc(au.subtitleReason || '')}</span>`;
      const modelText = au.asrModel ? `<code>${esc(au.asrModel)}</code>${au.asrModelKind === 'dir' ? ' <span class="meta">（复用本地模型）</span>' : ''}` : '<span class="meta">未配置</span>';
      const loadText = au.asrLoadSec != null ? `加载 ${esc(String(au.asrLoadSec))}s` : '';
      const errText = au.asrError ? `<div class="meta" style="margin-top:4px">原因：${esc(au.asrError)}</div>` : '';
      const retryText = au.asrRetryInSec > 0 ? `<span class="meta">（${Math.ceil(au.asrRetryInSec / 60)} 分钟后自动重试）</span>` : '';
      audio.innerHTML = `<div class="tk-sub">声音内容</div><div class="meta">B 站字幕：${subText}</div>`
        + `<div class="meta">本地语音识别：${asrStateText} ${modelText}`
        + `${au.asrThreads ? `<span class="meta">· ${esc(String(au.asrThreads))} 线程</span>` : ''}`
        + `${loadText ? `<span class="meta">· ${loadText}</span>` : ''}${retryText}</div>`
        + `<div class="meta" style="margin-top:4px">${esc(au.summary || '')}</div>${errText}`
        + `<div class="meta" style="margin-top:4px;opacity:.75">模型只收文字和图片（无音频/视频输入位），所以"听见"的方式是把音轨转成文字：有字幕用字幕，没字幕才用本地语音识别补（约 12~15 秒）。</div>`;

      const tasteData = s.taste || {};
      const tags = (tasteData.totalTags || []).map((t) => `${esc(t.name)}×${t.count}`).join('、');
      const cats = (tasteData.categories || []).map((c) => `${esc(c.name)}×${c.count}`).join('、');
      taste.innerHTML = tasteData.total
        ? `口味（喜欢 ${tasteData.liked}/${tasteData.total}）：${tags || '标签不足'}${cats ? `　分区：${cats}` : ''}`
        : '口味：还没有记录';

      const share = s.share || {};
      const groups = Array.isArray(share.groups) ? share.groups : [];
      const eligible = groups.filter((g) => g.shareEligible);
      if (share.preferActiveGroups === false) {
        activity.innerHTML = '<div class="meta">推荐目的地：<span class="pill">未启用活跃群优先</span> 使用旧的「最久没动静」策略</div>';
      } else if (!groups.length) {
        activity.innerHTML = '<div class="meta">推荐目的地：暂无群会话</div>';
      } else {
        const rows = groups.slice(0, 6).map((g) => `${g.shareEligible ? '<span class="pill g">可推荐</span>' : '<span class="pill">太冷</span>'} ${esc(g.key)}　近 ${esc(String(share.activeWindowHours || 24))}h <b>${esc(String(g.activity))}</b> 条`).join('<br>');
        activity.innerHTML = `<div class="meta">推荐目的地（近 ${esc(String(share.activeWindowHours || 24))} 小时发言 ≥${esc(String(share.minActivityForShare || 1))} 条的群才推荐）　<b>${eligible.length}</b>/${groups.length} 个群可用</div><div class="meta">${rows}</div>`;
      }

      const list = Array.isArray(s.recent) ? s.recent : [];
      recent.innerHTML = list.length
        ? '<div class="meta" style="margin-bottom:4px">最近看过：</div>' + list.map((v) => {
            const like = v.liked === true ? '<span class="pill g">喜欢</span>' : v.liked === false ? '<span class="pill">不喜欢</span>' : '<span class="pill">未评</span>';
            return `<div class="meta" style="margin:2px 0">${like} <b>${esc(String(v.title || v.bvid).slice(0, 34))}</b>`
              + `${v.owner ? `　${esc(String(v.owner).slice(0, 12))}` : ''}${v.category ? `　${esc(v.category)}` : ''}`
              + `${v.interest != null ? `　兴趣 ${v.interest}` : ''}${v.source === 'shared' ? '　<span class="pill b">群友发的</span>' : ''}`
              + `　<span class="meta">${esc(fmtAbs(v.lastSeenAt))}</span></div>`;
          }).join('')
        : '';
    } catch (error) {
      status.textContent = '状态读取失败：' + (error?.message || error);
    }
  }

  browse.addEventListener('click', async () => {
    browse.disabled = true;
    msg.textContent = '正在刷，稍等（约 5~10 秒）…';
    try {
      const r = await api('/api/socialV2/bili-browse-now', 'POST', {});
      if (r?.ok) {
        const v = r.video || {};
        msg.textContent = `刷完了：《${String(v.title || '').slice(0, 28)}》${v.category ? `（${v.category}）` : ''}　看了 ${r.seconds}s / ${r.frames} 帧${r.manualWhilePaused ? '（暂停中，本次为手动触发）' : ''}`;
      } else msg.textContent = `没刷：${r?.error || r?.reason || '未知原因'}`;
    } catch (error) {
      msg.textContent = '失败：' + (error?.message || error);
    } finally {
      browse.disabled = false;
    }
    await refresh();
    setTimeout(() => { msg.textContent = ''; }, 12000);
  });

  pause.addEventListener('click', async () => {
    const willPause = pause.textContent !== '恢复自主刷';
    pause.disabled = true;
    msg.textContent = willPause ? '正在暂停…' : '正在恢复…';
    try {
      const r = await api('/api/socialV2/bili-pause', 'POST', { paused: willPause });
      if (r?.ok) msg.textContent = r.paused
        ? (r.browsing?.active ? '已暂停：当前这条会看完，之后不再自动刷' : '已暂停自主刷')
        : '已恢复自主刷（5~10 分钟后开始）';
      else msg.textContent = `失败：${r?.error || '未知原因'}`;
    } catch (error) {
      msg.textContent = '失败：' + (error?.message || error);
    } finally {
      pause.disabled = false;
    }
    await refresh();
    setTimeout(() => { msg.textContent = ''; }, 12000);
  });

  await refresh();
  setInterval(() => { if (!document.hidden) void refresh(); }, 5000);
}
