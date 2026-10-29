// R4.7-2：配置与凭据读模型。
//
// GET /api/socialV2/credentials 与 GET /api/socialV2/config 原先从 16 项依赖里拼响应。
// 凭据保存与 socialV2 配置归一化在 `src/console/commands/config.js`。

export function createConfigReadModel({
  CREDENTIAL_ITEMS,
  ROOT,
  STATE_DIR,
  cfg = {},
  maskValue,
  path,
  readJsonSafe
} = {}) {
  /** GET /api/socialV2/credentials：默认不下发明文，单条 reveal 才给。 */
  function credentials({ reveal = false, only = '' } = {}) {
    // 读取当前值：config 走点路径，file 走 state 下的 json
    const readValue = (item) => {
      try {
        if (item.where === 'config') {
          const file = readJsonSafe(path.join(ROOT, 'config.json'), null);
          if (!file) return { ok: false, value: '', error: 'config.json 读取失败' };
          let cur = file;
          for (const k of item.path.split('.')) {
            cur = cur?.[k];
            if (cur === undefined) break;
          }
          return { ok: true, value: cur == null ? '' : String(cur) };
        }
        const file = readJsonSafe(path.join(STATE_DIR, item.file), null);
        if (!file) return { ok: true, value: '' }; // 文件不存在 = 未配置，不是错误
        const v = file[item.path];
        return { ok: true, value: v == null ? '' : String(v) };
      } catch (error) {
        return { ok: false, value: '', error: String(error?.message ?? error) };
      }
    };

    const items = (only ? CREDENTIAL_ITEMS.filter((it) => it.key === only) : CREDENTIAL_ITEMS)
      .map((item) => {
        const r = readValue(item);
        const configured = !!r.value;
        return {
          key: item.key,
          label: item.label,
          group: item.group,
          kind: item.kind,
          restart: item.restart === true,
          doc: item.doc,
          // 明文下发规则（2026-10-20 用户要求「连接这部分不要脱敏，直接显示明文」）：
          //   - kind='text'（代理地址等**非秘密**）：直接给明文，不然用户没法确认填得对不对。
          //   - kind='secret'（真正的 key / cookie）：默认只给脱敏预览；点眼睛时
          //     （reveal=1 且指定了 key）才给那一条的明文。
          //   整表 reveal 仍然不允许——那会让所有密钥一次性进浏览器内存。
          value: item.kind === 'text'
            ? (r.ok ? r.value : '')
            : ((reveal && only) ? (r.ok ? r.value : '') : ''),
          configured,
          // 连接类不需要脱敏预览（前端直接显示明文）
          preview: configured && item.kind !== 'text' ? maskValue(r.value) : '',
          ...(r.ok ? {} : { error: r.error })
        };
      });
    return { ok: true, items };
  }

  /** GET /api/socialV2/config */
  function socialConfig() {
    return { ok: true, config: cfg.socialV2 ?? {} };
  }

  return { credentials, socialConfig };
}
