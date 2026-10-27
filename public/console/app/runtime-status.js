// 控制台顶部状态刷新（C6 runtime 拆分）。
async function refresh() {
  try {
    const s = await api('/api/status');
    document.querySelectorAll('#modeRow button').forEach(b => b.classList.toggle('active', b.dataset.mode === s.mode));
    const roleTextEl = document.getElementById('roleText');
    if (roleTextEl) roleTextEl.textContent = s.role || '无';
    const roleModeEl = document.getElementById('roleModeText');
    if (roleModeEl) roleModeEl.textContent = s.roleMode === 'silent' ? '静默' : '正常';
    const modeLabel = s.mode === 'reserved' ? '一代仿真模式' : s.mode === 'reserved2' ? '二代仿真模式' : s.mode === 'closed-agent' ? '封闭 Agent' : '聊天模式';
    // 私聊那栏按策略显示：白名单制才列号；好友/全放开则直接说明策略，避免误以为"名单为空=没人能私聊"
    const pm = s.privateMode || 'list';
    const privLabel = pm === 'friends' ? '好友自动放行'
      : pm === 'all' ? '纯黑名单（全放开）'
      : ('私聊白名单: ' + (s.allowPrivate.join(', ') || '无'));
    document.getElementById('statusText').textContent = 'DSH: ' + (s.dshReady ? '在线' : '离线') + ' ｜ 模式: ' + modeLabel + ' ｜ 管理员: ' + (s.ownerQQ || '未设置') + ' ｜ 群白名单: ' + (s.allowGroups.join(', ') || '无') + ' ｜ ' + privLabel;
    // 04 活动日志由 refreshActivityFeed() 独立 1 秒轮询，不在这里重写。
    const presetSel = document.getElementById('closedPreset');
    if (presetSel && document.activeElement !== presetSel) presetSel.value = s.closedAgentPreset || '';
  } catch (e) { const st = document.getElementById('statusText'); if (st) st.textContent = '连接失败: ' + e; }
}

