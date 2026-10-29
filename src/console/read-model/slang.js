// R4.7-2：黑话库读模型。
//
// GET /api/slang 只按 status 过滤内存库并回配置；所有写在 commands/slang.js。

export function createSlangReadModel({ live = {}, cfg = {} } = {}) {
  function list({ status = '' } = {}) {
    const entries = Array.isArray(live.slangEntries) ? live.slangEntries : [];
    const filtered = status ? entries.filter((e) => e.status === status) : entries;
    return { entries: filtered, config: cfg.slang };
  }
  return { list };
}
