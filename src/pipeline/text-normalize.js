// 消息管线 · 出站消息归一化。
//
// 模型经常把消息传成 JSON 数组字符串（甚至元素里的直引号没转义）。
// 这里把「数组 / JSON 字符串 / 普通文本」统一成 string[]。
// bridge.js 与 mcp-snowluma-safe.js 共用同一份实现，避免两处容错逻辑漂移。

export function normalizeMessagesInput(value) {
  if (Array.isArray(value)) return value.map((m) => String(m ?? '')).filter((s) => s.trim() !== '');
  if (typeof value !== 'string') return [];

  const trimmed = value.trim();
  // 单条 JSON 字符串："\"你好\"" → 你好
  if (trimmed.startsWith('"') && !trimmed.startsWith('["')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === 'string') return [parsed].filter((s) => s.trim() !== '');
      if (Array.isArray(parsed)) return parsed.map((m) => String(m ?? '')).filter((s) => s.trim() !== '');
    } catch {}
  }

  // JSON 数组字符串（含内层直引号未转义的容错）
  //
  // 判据必须包含「有引号」：模型真正会踩的是 `["a","b"]` 这种**元素带引号**的序列化形式，
  // 此时引号一定存在。若不加这个前提，容错分支会把任何以 `[` 开头的正文都当数组字面量：
  //   实测（2026-10-09 用真实端点验证）`[图片]` → `图片`、`[doge]这个梗我熟` → `doge]这个梗我熟`，
  //   前者是桥接自己生成的段标记、后者是群友常用写法，都被静默改坏了。
  if (trimmed.startsWith('[') && /["']/.test(trimmed)) {
    try {
      const parsed = JSON.parse(trimmed);
      // 只有「字符串数组」才算消息列表；`[1]` 这种不应被当成分条内容。
      if (Array.isArray(parsed) && parsed.every((m) => typeof m === 'string')) {
        const out = parsed.map((m) => String(m ?? '')).filter((s) => s.trim() !== '');
        if (out.length) return out;
      }
    } catch {
      const salvaged = splitArrayLiteral(trimmed);
      if (salvaged.length) return salvaged;
    }
  }
  return trimmed ? [trimmed] : [];
}

// 手工切分形如 ["a","b"] 的数组字面量：以「引号 + 逗号 + 引号」为分隔，
// 剥掉首尾的 [ ] 与每个元素两侧的引号。仅供 JSON.parse 失败时兜底。
export function splitArrayLiteral(text) {
  let s = String(text ?? '').trim();
  if (s.startsWith('[')) s = s.slice(1);
  if (s.endsWith(']')) s = s.slice(0, -1);
  return s
    .split(/"?\s*,\s*"?/)
    .map((part) => {
      let t = part.trim();
      if (t.startsWith('"')) t = t.slice(1);
      if (t.endsWith('"')) t = t.slice(0, -1);
      return t.trim();
    })
    .filter((t) => t !== '');
}
