// 传输侧注入的具名桥接服务：不向插件提供任意 URL/请求方法入口。
// agentApi 继续承担原有桥接认证与 HTTP 错误处理。
export function createSlangMcpServices(agentApi) {
  return {
    query({ key, token, q }) {
      const query = q ? `&q=${encodeURIComponent(String(q))}` : '';
      return agentApi(`/api/socialV2/slang/query?key=${encodeURIComponent(key)}${query}`, {
        headers: { 'x-agent-token': token }
      });
    },
    submit({ key, token, content, context }) {
      return agentApi('/api/socialV2/slang/submit', {
        method: 'POST',
        body: JSON.stringify({ key, content, context: context || '' }),
        headers: { 'x-agent-token': token }
      });
    }
  };
}

export function createMediaMcpServices(agentApi) {
  const imageReport = (endpoint, timeoutMs, { key, token, refresh }) => {
    const query = new URLSearchParams({ key });
    if (refresh) query.set('refresh', '1');
    return agentApi(`${endpoint}?${query}`, { headers: { 'x-agent-token': token }, timeoutMs });
  };
  return {
    featureMenu: payload => imageReport('/api/socialV2/send-feature-menu', 120000, payload),
    tokenReport: ({ fresh, ...payload }) => imageReport('/api/socialV2/token-report', 180000, { ...payload, refresh: fresh }),
    githubShot: ({ key, token, url }) => agentApi('/api/socialV2/github-shot', {
      method: 'POST', body: JSON.stringify({ key, url }),
      headers: { 'x-agent-token': token }, timeoutMs: 180000
    })
  };
}

export function createImagesMcpServices(agentApi) {
  const post = (endpoint, payload, timeoutMs) => agentApi(endpoint, {
    method: 'POST', body: JSON.stringify(payload), headers: { 'x-agent-token': payload.token },
    ...(timeoutMs ? { timeoutMs } : {})
  });
  return {
    preflight({ key, token, tags, sources }) {
      const q = new URLSearchParams({ key });
      if (tags) q.set('tags', String(tags));
      if (sources) q.set('sources', String(sources));
      return agentApi(`/api/socialV2/image-preflight?${q}`, { headers: { 'x-agent-token': token }, timeoutMs: 20000 });
    },
    archive: ({ key, token, id }) => post('/api/socialV2/archive-image', { key, ...(id ? { id } : {}) }, 120000),
    source({ key, token, id }) {
      const q = new URLSearchParams({ key });
      if (id) q.set('id', String(id));
      return agentApi(`/api/socialV2/image-source?${q}`, { headers: { 'x-agent-token': token }, timeoutMs: 20000 });
    },
    reverseSearch({ key, token, messageId, id }) {
      const q = new URLSearchParams({ key });
      if (messageId) q.set('messageId', String(messageId));
      if (id) q.set('id', String(id));
      return agentApi(`/api/socialV2/reverse-search?${q}`, { headers: { 'x-agent-token': token }, timeoutMs: 90000 });
    },
    reject: ({ key, token, id, reason }) => post('/api/socialV2/reject-image', { key, ...(id ? { id } : {}), ...(reason ? { reason } : {}) }, 20000),
    send: ({ key, token, tags, sources, mode, replyToMessageId }) =>
      post('/api/socialV2/send-image', { key, tags: tags ?? [], sources, mode, replyToMessageId }, 180000),
    refresh: ({ key, token }) => post('/api/socialV2/refresh-image-lib', { key }, 180000)
  };
}

export function createStickersMcpServices(agentApi) {
  const post = (endpoint, payload, timeoutMs) => agentApi(endpoint, {
    method: 'POST', body: JSON.stringify(payload), headers: { 'x-agent-token': payload.token },
    ...(timeoutMs ? { timeoutMs } : {})
  });
  return {
    list({ key, token, query, count, refresh }) {
      const q = new URLSearchParams({ key });
      if (query) q.set('query', String(query));
      if (count != null) q.set('count', String(count));
      if (refresh) q.set('refresh', '1');
      return agentApi(`/api/socialV2/sticker-list?${q}`, { headers: { 'x-agent-token': token } });
    },
    image({ key, token, stickerId }) {
      const q = new URLSearchParams({ key, stickerId: String(stickerId) });
      return agentApi(`/api/socialV2/sticker-image?${q}`, { headers: { 'x-agent-token': token }, timeoutMs: 180000 });
    },
    send: ({ key, token, stickerId, replyToMessageId, atUserId }) =>
      post('/api/socialV2/send-sticker', { key, stickerId: String(stickerId), replyToMessageId, atUserId: atUserId ?? null }, 300000),
    collect: ({ key, token, messageId, remark }) =>
      post('/api/socialV2/collect-sticker', { key, messageId: String(messageId), remark: remark || '' }, 60000),
    note({ key, token, stickerId, note, tags, usage }) {
      const payload = { key, stickerId: String(stickerId) };
      if (note !== undefined && note !== null) payload.note = String(note);
      if (tags !== undefined && tags !== null) payload.tags = Array.isArray(tags) ? tags.map(String) : [];
      if (usage !== undefined && usage !== null) payload.usage = String(usage);
      return post('/api/socialV2/sticker-note', payload);
    },
    remove: ({ key, token, stickerId }) => post('/api/socialV2/sticker-delete', { key, stickerId: String(stickerId) }),
    remark: ({ key, token, stickerId, remark }) =>
      post('/api/socialV2/sticker-remark', { key, stickerId: String(stickerId), remark: String(remark || '') })
  };
}

export function createTtsMcpServices(agentApi) {
  return {
    send({ key, token, text }) {
      return agentApi('/api/socialV2/send-voice', {
        method: 'POST', body: JSON.stringify({ key, text: String(text ?? '') }),
        headers: { 'x-agent-token': token }, timeoutMs: 180000
      });
    }
  };
}

export function createUpscaleMcpServices(agentApi) {
  return {
    messageImage({ key, messageId, token }) {
      const q = new URLSearchParams({ key, messageId: String(messageId), raw: '1' });
      return agentApi(`/api/images/message?${q}`, {
        headers: token ? { 'x-agent-token': token } : {}, timeoutMs: 180000
      });
    },
    publish({ key, token, data }) {
      return agentApi('/api/socialV2/send-upscaled', {
        method: 'POST', headers: token ? { 'x-agent-token': token } : {},
        body: JSON.stringify({ key, token, data }), timeoutMs: 120000
      });
    }
  };
}

export function createXPostsMcpServices(agentApi) {
  return {
    fetch({ key, token, handle, count, date, lastHours }) {
      return agentApi('/api/socialV2/fetch-x-posts', {
        method: 'POST', body: JSON.stringify({ key, handle, count, date, lastHours }),
        headers: { 'x-agent-token': token }, timeoutMs: 180000
      });
    }
  };
}

export function createBiliMcpServices(agentApi) {
  const post = (endpoint, payload, timeoutMs) => agentApi(endpoint, {
    method: 'POST', body: JSON.stringify(payload), headers: { 'x-agent-token': payload.token },
    ...(timeoutMs ? { timeoutMs } : {})
  });
  return {
    record: ({ key, token, bvid, title, owner, category, durationSec, liked, interest, tags, notes, source }) =>
      post('/api/socialV2/bili-record', { key, token, bvid, title, owner, category, durationSec, liked, interest, tags, notes, source }),
    watch: ({ key, token, url, seconds, frames }) => post('/api/socialV2/bili-watch', { key, token, url, seconds, frames }, 180000),
    search: ({ key, token, query, count, order }) => post('/api/socialV2/bili-search', { key, token, query, count, order }, 60000),
    memory({ key, token, limit, likedOnly, q }) {
      const params = new URLSearchParams({ key, limit: String(limit ?? 10) });
      if (likedOnly) params.set('liked', '1');
      if (q) params.set('q', String(q));
      return agentApi(`/api/socialV2/bili-memory?${params}`, { headers: { 'x-agent-token': token } });
    }
  };
}
