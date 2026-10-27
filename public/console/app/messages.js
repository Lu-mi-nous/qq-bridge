// 02b 会话消息回看（C6 runtime 拆分）。
function ensureMessageViewer() {
  if (document.getElementById('msgViewerCard')) return;
  const pool = document.getElementById('detailPool');
  if (!pool) return;
  pool.insertAdjacentHTML('beforeend', "    <section data-sec=\"02b\" class=\"card expandable-card card-hidden\" id=\"msgViewerCard\">\n      <div class=\"expandable-inner\">\n      <h2><span class=\"sec-no\">02b</span>会话消息 · <span id=\"msgViewerTitle\"></span></h2>\n      <div class=\"row\">\n        <label style=\"margin:0\">显示条数</label>\n        <select id=\"msgViewerLimit\" style=\"width:auto\">\n          <option value=\"30\">最近 30 条</option>\n          <option value=\"60\">最近 60 条</option>\n          <option value=\"100\">最近 100 条</option>\n        </select>\n        <button class=\"small\" id=\"msgViewerReload\">刷新</button>\n        <button class=\"small\" id=\"msgViewerClose\">关闭</button>\n      </div>\n      <div id=\"msgViewerBody\"><span class=\"meta\">选择会话后显示消息</span></div>\n      </div>\n    </section>\n");
  document.getElementById('msgViewerClose')?.addEventListener('click', () => {
    const card = document.getElementById('msgViewerCard');
    if (!card) return;
    card.classList.add('card-hidden');
    currentViewKey = '';
  });
}

let currentViewKey = '';
async function showMessages(key) {
  ensureMessageViewer();
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
  if (document.getElementById('detailPageBody') && card.parentElement !== document.getElementById('detailPageBody')) {
    document.getElementById('detailPageBody').appendChild(card);
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

