// R4.7-3：记忆追加 / 编辑 / 删除 / 清空命令。
//
// 原先在路由里直接改 socialV2 会话的记忆数组与 memberImpressions。
// 这里保留全部校验（category、target、oldContent、__proto__ 防护）与脱敏规则。

export function createMemoryCommands({
  getSocialV2State,
  appendMemoryV2,
  formatMemoryV2,
  saveSocialV2State,
  redactKnownTokensOnly
} = {}) {
  const CATEGORIES = ['activeTopic', 'pendingThought', 'memberImpression'];
  const badTarget = (name) => ['__proto__', 'constructor', 'prototype'].includes(name);

  /** POST /api/socialV2/memory-append */
  function append(body = {}) {
    const key = String(body.key ?? '').trim();
    const category = String(body.category ?? '').trim();
    const content = String(body.content ?? '').trim();
    const extra = body.extra && typeof body.extra === 'object' ? body.extra : {};
    if (!key || !category || !content) return { ok: false, status: 400, error: 'key/category/content 不能为空' };
    if (!CATEGORIES.includes(category)) return { ok: false, status: 400, error: 'category 必须是 activeTopic / pendingThought / memberImpression' };
    if (category === 'memberImpression' && !String(extra.target || '').trim()) {
      return { ok: false, status: 400, error: 'memberImpression 需要 extra.target 指定群友名字' };
    }
    const st = getSocialV2State(key);
    appendMemoryV2(st, category, content, extra);
    return { ok: true, key, category, content, memory: formatMemoryV2(st) };
  }

  /** POST /api/socialV2/memory-update */
  function update(body = {}) {
    const key = String(body.key ?? '').trim();
    const category = String(body.category ?? '').trim();
    const oldContent = String(body.oldContent ?? '').trim();
    const target = redactKnownTokensOnly(String(body.target ?? '').trim());
    const newContent = body.newContent !== undefined && body.newContent !== null ? redactKnownTokensOnly(String(body.newContent).trim()) : undefined;
    const newExtra = body.newExtra && typeof body.newExtra === 'object' && !Array.isArray(body.newExtra) ? body.newExtra : {};
    const redactExtra = (v) => redactKnownTokensOnly(String(v ?? '')).trim();
    const cleanNewExtra = {
      ...newExtra,
      pendingQuestion: newExtra.pendingQuestion !== undefined ? redactExtra(newExtra.pendingQuestion) : undefined,
      participants: Array.isArray(newExtra.participants) ? newExtra.participants.map((p) => redactExtra(p)) : undefined,
      motivation: newExtra.motivation !== undefined ? redactExtra(newExtra.motivation) : undefined,
      target: newExtra.target !== undefined ? redactExtra(newExtra.target) : undefined
    };
    if (!key || !category) return { ok: false, status: 400, error: 'key/category 不能为空' };
    if (!CATEGORIES.includes(category)) return { ok: false, status: 400, error: 'category 必须是 activeTopic / pendingThought / memberImpression' };
    if (category === 'memberImpression' && !target) return { ok: false, status: 400, error: 'memberImpression 需要 target 指定原群友名字' };
    if (category !== 'memberImpression' && !oldContent) return { ok: false, status: 400, error: '该类别需要 oldContent 指定要编辑的记忆内容' };
    const st = getSocialV2State(key);
    if (category === 'activeTopic' && Array.isArray(st.activeTopics)) {
      const idx = st.activeTopics.findIndex((t) => String(t?.text ?? '') === oldContent);
      if (idx < 0) return { ok: false, status: 404, error: '找不到要编辑的 activeTopic' };
      if (newContent !== undefined) st.activeTopics[idx].text = newContent.slice(0, 200);
      if (cleanNewExtra.pendingQuestion !== undefined) st.activeTopics[idx].pendingQuestion = String(cleanNewExtra.pendingQuestion).slice(0, 200);
      if (Array.isArray(cleanNewExtra.participants)) st.activeTopics[idx].participants = cleanNewExtra.participants.map(String).slice(0, 10);
    } else if (category === 'pendingThought' && Array.isArray(st.pendingThoughts)) {
      const idx = st.pendingThoughts.findIndex((t) => String(t?.text ?? '') === oldContent);
      if (idx < 0) return { ok: false, status: 404, error: '找不到要编辑的 pendingThought' };
      if (newContent !== undefined) st.pendingThoughts[idx].text = newContent.slice(0, 200);
      if (cleanNewExtra.motivation !== undefined) st.pendingThoughts[idx].motivation = String(cleanNewExtra.motivation).slice(0, 50);
      if (cleanNewExtra.expiresAtMs !== undefined) st.pendingThoughts[idx].expiresAt = Date.now() + Math.max(0, Number(cleanNewExtra.expiresAtMs) || 0);
    } else if (category === 'memberImpression' && st.memberImpressions && typeof st.memberImpressions === 'object') {
      const oldTarget = target;
      if (badTarget(oldTarget)) return { ok: false, status: 400, error: '非法的群友名字' };
      const im = st.memberImpressions[oldTarget] || {};
      const newTarget = String(cleanNewExtra.target || oldTarget).trim();
      if (!newTarget || badTarget(newTarget)) return { ok: false, status: 400, error: '非法的群友名字' };
      if (newContent !== undefined) {
        im.traits = newContent.split(/[,，、]/).map((s) => s.trim()).filter(Boolean).slice(0, 20);
      }
      if (cleanNewExtra.interactionCount !== undefined) im.interactionCount = Math.max(0, Number(cleanNewExtra.interactionCount) || 0);
      if (newTarget !== oldTarget) delete st.memberImpressions[oldTarget];
      st.memberImpressions[newTarget] = im;
    }
    saveSocialV2State?.();
    return { ok: true, key, category, memory: formatMemoryV2(st) };
  }

  /** POST /api/socialV2/memory-remove */
  function remove(body = {}) {
    const key = String(body.key ?? '').trim();
    const category = String(body.category ?? '').trim();
    const content = String(body.content ?? '').trim();
    const target = String(body.target ?? '').trim();
    if (!key || !category) return { ok: false, status: 400, error: 'key/category 不能为空' };
    if (!CATEGORIES.includes(category)) return { ok: false, status: 400, error: 'category 必须是 activeTopic / pendingThought / memberImpression' };
    if (category === 'memberImpression' && !target) return { ok: false, status: 400, error: 'memberImpression 需要 target 指定群友名字' };
    if (category === 'memberImpression' && badTarget(target)) return { ok: false, status: 400, error: '非法的群友名字' };
    if (category !== 'memberImpression' && !content) return { ok: false, status: 400, error: '该类别需要 content 指定要删除的记忆内容' };
    const st = getSocialV2State(key);
    if (category === 'activeTopic' && Array.isArray(st.activeTopics)) {
      st.activeTopics = st.activeTopics.filter((t) => String(t?.text ?? '') !== content);
    } else if (category === 'pendingThought' && Array.isArray(st.pendingThoughts)) {
      st.pendingThoughts = st.pendingThoughts.filter((t) => String(t?.text ?? '') !== content);
    } else if (category === 'memberImpression' && st.memberImpressions && typeof st.memberImpressions === 'object') {
      delete st.memberImpressions[target];
    }
    saveSocialV2State?.();
    return { ok: true, key, category, memory: formatMemoryV2(st) };
  }

  /** POST /api/socialV2/memory-clear */
  function clear(body = {}) {
    const key = String(body.key ?? '').trim();
    const category = String(body.category ?? '').trim();
    if (!key) return { ok: false, status: 400, error: 'key 不能为空' };
    if (category && !CATEGORIES.includes(category)) return { ok: false, status: 400, error: 'category 必须是 activeTopic / pendingThought / memberImpression' };
    const st = getSocialV2State(key);
    if (!category || category === 'activeTopic') st.activeTopics = [];
    if (!category || category === 'pendingThought') st.pendingThoughts = [];
    if (!category || category === 'memberImpression') st.memberImpressions = {};
    saveSocialV2State?.();
    return { ok: true, key, category: category || 'all', memory: formatMemoryV2(st) };
  }

  return { append, update, remove, clear };
}
