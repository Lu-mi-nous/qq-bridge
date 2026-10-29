// R4.7-2：一代社交状态 / 开发日志读模型。
//
// GET /api/social 与 /api/dev-log 原先从 21 项依赖里拼响应。
// 阶段切换/配置保存/flush/后台提醒在 `src/console/commands/social-v1.js`。

let devLogCache = { mtimeMs: 0, size: 0, data: null };

export function createSocialV1ReadModel({
  ROOT,
  cfg = {},
  social = {},
  socialV2 = { conversations: new Map() },
  state = {},
  contextDisplayName,
  fs,
  path,
  parseChangelogMarkdown,
  sanitizeDevLogText
} = {}) {
  /** GET /api/social：阶段与待摘要统计。 */
  function socialState() {
    const stats = {};
    for (const [k, e] of social.pendingSummaries.entries()) stats[k] = e.items.length;
    const states = {};
    const keys = new Set([...social.states.keys(), ...social.recentMessages.keys()]);
    for (const k of keys) {
      const st = social.states.get(k);
      states[k] = { phase: st?.phase ?? 'idle' };
    }
    return { config: cfg.social, pendingSummaries: stats, states };
  }

  /** GET /api/dev-log：读取 README 更新日志，按 mtime/size 缓存并脱敏。 */
  function devLog() {
    try {
      const file = path.join(ROOT, 'README.md');
      const st = fs.statSync(file);
      if (!devLogCache.data || devLogCache.mtimeMs !== st.mtimeMs || devLogCache.size !== st.size) {
        const markdown = fs.readFileSync(file, 'utf8');
        devLogCache = {
          mtimeMs: st.mtimeMs,
          size: st.size,
          data: parseChangelogMarkdown(markdown)
        };
      }
      const redactions = [];
      const ids = new Set();
      if (cfg.ownerQQ) ids.add(String(cfg.ownerQQ));
      for (const key of socialV2.conversations.keys()) {
        const name = contextDisplayName(key);
        const m = /^(group|private):(\d+)$/.exec(key);
        if (m) ids.add(m[2]);
        if (!name) continue;
        redactions.push({ name, replacement: key.startsWith('private:') ? '某用户' : '某群' });
      }
      for (const key of Object.keys(state.sessions || {})) {
        const m = /^(group|private):(\d+)$/.exec(key);
        if (m) ids.add(m[2]);
      }
      const sanitize = (text) => sanitizeDevLogText(text, { names: redactions, ids: [...ids] });
      const data = devLogCache.data;
      return {
        ok: true,
        updatedAt: st.mtimeMs,
        sanitized: true,
        entries: data.entries,
        sections: (data.sections || []).map((sec) => ({
          title: sanitize(sec.title),
          entries: (sec.entries || []).map((e) => ({
            title: sanitize(e.title),
            body: sanitize(e.body),
            date: e.date || ''
          }))
        }))
      };
    } catch (error) {
      return { ok: false, status: 500, error: `读取开发日志失败：${error?.message ?? error}` };
    }
  }

  return { socialState, devLog };
}
