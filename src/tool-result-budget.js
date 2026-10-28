// T4：工具结果预算（统一裁剪超长文本结果）。
//
// 背景：工具结果会整段进入模型上下文并留在会话历史里。`qq_get_unread_messages` 默认 30 条、
// `qq_list_group_files` 分类全文、`qq_recall_memory` 命中列表都可能一次塞几万字符；
// DSH 侧的 tool-result-pruner 阈值原为 50k，触发太晚。这里在 MCP 出口做**按工具的更严格上限**，
// 与 preset 里的全局 12k 裁剪形成两层。
//
// 只裁剪 `type: 'text'` 的 content；图片/表情内容不动。裁剪保留头尾（尾部常是最新消息/结论），
// 并明确标注截断与翻页提示，避免模型以为结果只有这些。
export const DEFAULT_TOOL_RESULT_BUDGET = 12000;

export const TOOL_RESULT_BUDGETS = Object.freeze({
  qq_get_unread_messages: 6000,
  qq_get_recent_messages: 6000,
  qq_get_message_detail: 4000,
  qq_get_prompt: 12000,
  qq_get_forward_msg: 12000,
  qq_list_group_files: 10000,
  qq_memory_query: 8000,
  qq_recall_memory: 8000,
  qq_bili_memory: 6000,
  qq_list_stickers: 8000,
  qq_social_state: 6000
});

export function capToolResultText(text, maxChars = DEFAULT_TOOL_RESULT_BUDGET) {
  const raw = String(text ?? '');
  const max = Math.max(200, Number(maxChars) || DEFAULT_TOOL_RESULT_BUDGET);
  if (raw.length <= max) return raw;
  const headChars = Math.max(100, Math.floor(max * 0.7));
  const tailChars = Math.max(100, max - headChars);
  const removed = raw.length - headChars - tailChars;
  return `${raw.slice(0, headChars)}\n…（结果超预算：已省略中间 ${removed} 字符，共 ${raw.length} 字符；需要更多请翻页/缩小范围）…\n${raw.slice(-tailChars)}`;
}

export function capToolResult(name, result, { budgets = TOOL_RESULT_BUDGETS, defaultMax = DEFAULT_TOOL_RESULT_BUDGET } = {}) {
  if (!result || !Array.isArray(result.content)) return result;
  const max = Number(budgets?.[name]) > 0 ? Number(budgets[name]) : defaultMax;
  let changed = false;
  const content = result.content.map((part) => {
    if (!part || part.type !== 'text' || typeof part.text !== 'string') return part;
    if (part.text.length <= max) return part;
    changed = true;
    return { ...part, text: capToolResultText(part.text, max) };
  });
  return changed ? { ...result, content } : result;
}

/**
 * 给 server.tool 统一套上结果预算。必须在其他 server.tool 包装器之前应用（包住原始 handler）。
 * 支持两种签名：(name, description, inputSchema, handler) / (name, inputSchema, handler)。
 */
export function bindToolResultBudget(server, opts = {}) {
  const register = server.tool.bind(server);
  server.tool = (name, ...args) => {
    const handlerIndex = typeof args[0] === 'string' ? 2 : 1;
    const handler = args[handlerIndex];
    if (typeof handler === 'function') {
      args[handlerIndex] = async (...callArgs) => capToolResult(name, await handler(...callArgs), opts);
    }
    return register(name, ...args);
  };
  return server;
}
