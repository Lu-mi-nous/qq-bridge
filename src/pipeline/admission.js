// 私聊/群聊准入；好友集合显式传入，名单匹配规则保持单一实现。
export function normalizePrivateMode(value) {
  const s = String(value ?? '').trim().toLowerCase();
  if (s === 'friends' || s === 'friend') return 'friends';
  if (s === 'all') return 'all';
  return 'list';
}


export function allowed(kind, id, cfg) {
  // OneBot 事件里的 id 可能是数字也可能是字符串（int64 序列化差异），统一转字符串比较。
  // 配置字段兼容单数（group/private）与复数（groups/privates）两种写法。
  const s = String(id);
  const denyList = cfg.deny[kind] ?? cfg.deny[kind + 's'] ?? [];
  if (denyList.map(String).includes(s)) return false;
  const allowList = cfg.allow[kind] ?? cfg.allow[kind + 's'] ?? [];
  if (allowList.length > 0) return allowList.map(String).includes(s);
  return cfg.allowAllWhenEmpty;
}

export function privateAllowed(id, cfg, friendIds) {
  const s = String(id);
  const denyList = (Array.isArray(cfg.deny?.private) ? cfg.deny.private : []).map(String);
  if (denyList.includes(s)) return false;
  const mode = cfg.allow?.privateMode ?? 'list';
  if (mode === 'all') return true;
  if (mode === 'friends' && friendIds.has(s)) return true;
  // 'list' 模式、或 'friends' 下非好友（临时会话）：交回白名单
  return allowed('private', id, cfg);
}

export function modeAllowed(key, kind, id, cfg, mode, friendIds) {
  if (mode === 'closed-agent') {
    // 封闭 agent 模式：仅 owner 私聊
    return key === `private:${String(cfg.ownerQQ ?? '')}`;
  }
  // chat / reserved / reserved2（仿真模式，暂同 chat 白名单）
  if (kind === 'private') return privateAllowed(id, cfg, friendIds);
  return allowed(kind, id, cfg);
}
