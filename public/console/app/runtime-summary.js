// 摘要卡文案刷新（C6 runtime 拆分）。
function summaryTextOf(id, max = 42) {
  const el = document.getElementById(id);
  const t = (el?.textContent || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}
// 已删除 summaryCountOf()：它数的是"子节点个数"，而列表都包在容器里（详情见 refreshSummaries
// 里 02/03 的注释）。数量类摘要一律直接数真实行（`.sess-row` / `table tr`）。
function setSummary(no, text, opts = {}) {
  const el = document.getElementById(`summary-${no}`);
  if (!el) return;
  el.textContent = text || '—';
  const card = el.closest('.summary-card');
  if (!card) return;
  const dot = card.querySelector('.sc-dot');
  if (dot) dot.hidden = !opts.attention;
  card.classList.toggle('sc-attention', !!opts.attention);
}
function countList(value) {
  return String(value || '').split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean).length;
}

function refreshSummaries() {
  // 01 运行模式
  const mode = document.querySelector('#modeRow button.active')?.textContent?.trim() || '';
  const roleMode = summaryTextOf('roleModeText', 8);
  setSummary('01', [mode, roleMode && `· ${roleMode}`].filter(Boolean).join(' '));

  // 02 会话映射
  // ⚠️ 不能数「子节点个数」：列表被包在一个 `.sess-list` 里，子节点永远只有 1 个，
  // 于是不管有多少会话都显示「1 个会话」（实测踩到）。数真正的行。
  const sessions = document.querySelectorAll('#sessionList .sess-row').length;
  setSummary('02', sessions ? `${sessions} 个会话` : '暂无会话');

  // 03 挂起审批（模块卡把数量/状态写入 __CONSOLE_CARD_STATE__）
  const pendingState = window.__CONSOLE_CARD_STATE__?.['03'];
  const pending = Number(pendingState?.count) || 0;
  setSummary('03', pendingState?.statusText || '没有待处理项', { attention: pending > 0 });

  // 04 活动日志（模块卡把状态写入 __CONSOLE_CARD_STATE__）
  setSummary('04', window.__CONSOLE_CARD_STATE__?.['04']?.statusText || '暂无活动');

  // 05 人格：默认角色 + 单独配置的群数
  const role = summaryTextOf('roleText', 16);
  const roleAssign = summaryTextOf('roleAssignSummary', 40);
  setSummary('05', roleAssign || (role ? `${role} ｜ ${roleMode || '正常'}` : '未设置角色'));

  // 06 一代仿真：`#socialStatus` 是"摘要缓冲/状态"那行，做摘要不好读；
  // 改用卡内三个最关键的参数值（它们就是这个模式的可调项）。
  {
    const trig = document.getElementById('sTrigger')?.value;
    const cmin = document.getElementById('sCheckMin')?.value;
    const cmax = document.getElementById('sCheckMax')?.value;
    setSummary('06', trig
      ? `触发概率 ${trig} · 活跃检测 ${cmin}~${cmax}s`
      : (summaryTextOf('socialStatus', 40) || '状态未知'));
  }

  // 07 二代仿真：把新增的等待硬上限直接放到悬停摘要里，便于一眼确认参数是否生效。
  const v2On = document.getElementById('v2Enabled')?.checked;
  const v2Act = summaryTextOf('v2ActivityStatus', 8);
  const v2WaitCnt = document.getElementById('v2WaitTurnMaxCount')?.value || '2';
  const v2WaitSec = document.getElementById('v2WaitTurnMaxSec')?.value || '120';
  setSummary('07', `${v2On ? '已启用' : '未启用'}${v2Act ? ` · ${v2Act}` : ''} ｜ 等待≤${v2WaitCnt}次/${v2WaitSec}s`);

  // 08 MCP 工具
  const toolSummary = summaryTextOf('tool09Summary', 52);
  setSummary('08', toolSummary || '工具清单');

  // 09 白名单（模块卡把完整名单写入 __WL_STATE__）
  const wl = window.__WL_STATE__ || { allowGroups: [], allowPrivate: [], ownerQQ: '', privateMode: 'list' };
  const groups = wl.allowGroups.length;
  const privates = wl.allowPrivate.length;
  const pmode = document.getElementById('wlPrivateMode')?.value || wl.privateMode;
  const pmodeLabel = pmode === 'friends' ? '好友放行' : pmode === 'all' ? '全放开' : '白名单';
  // 正常态只放三组短信息，刚好一行；没有管理员是异常态，才追加提示并亮红点。
  const ownerHint = wl.ownerQQ ? '' : ' · 无管理员';
  setSummary('09', `群 ${groups} · 私聊 ${privates} ｜ ${pmodeLabel}${ownerHint}`,
    { attention: !wl.ownerQQ });

  // 10 静默
  const silent = roleMode === '静默';
  setSummary('10', silent ? '静默中（只回管理员）' : '正常回复', { attention: silent });

  // 11 安全拦截（声明式卡片把状态写入 __CONSOLE_CARD_STATE__）
  const notify = window.__CONSOLE_CARD_STATE__?.['11']?.interceptNotify;
  setSummary('11', notify === undefined ? '—' : (notify ? '拦截时群内提示：开' : '拦截时群内提示：关'));

  // 12 访问令牌（声明式卡片把状态写入 __CONSOLE_CARD_STATE__）
  const auth = window.__CONSOLE_CARD_STATE__?.['12']?.statusText;
  setSummary('12', auth || '—');

  // 13 加好友 / 入群（声明式卡片把状态写入 __CONSOLE_CARD_STATE__）
  const join = window.__CONSOLE_CARD_STATE__?.['13']?.statusText || '';
  const joinPending = /[1-9]/.test(join) && /待/.test(join);
  setSummary('13', join || '暂无待裁决', { attention: joinPending });

  // 14 Token 用量
  setSummary('14', summaryTextOf('tokenToday', 40) || '暂无数据');

  // 15 磁盘缓存（模块卡把状态写入 __CONSOLE_CARD_STATE__）
  setSummary('15', window.__CONSOLE_CARD_STATE__?.['15']?.statusText || '—');

  // 16~18 是操作类卡片，给固定说明（没有实时状态可摘）
  setSummary('16', '向指定会话发一条测试消息');
  setSummary('17', '重启桥接 · 清空 WebSocket 连接');
  setSummary('18', '向 DSH 投递后台提醒（不进群）');
  // 19 上下文与记忆：状态行由 refreshContextStatus 写入
  setSummary('19', summaryTextOf('ctxStatusLine', 40) || '—');
}
