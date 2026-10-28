// T2：工具面（tool surface）计量。
//
// 模型每次请求都会带上全部可见工具的 schema（名字 + 描述 + 参数），这是常驻 Token。
// 这里把「当前暴露了多少工具、占多少字符」算出来并落盘，作为 T2/T3/T5 的回归指标。
//
// 参数 schema 在 MCP SDK 内部是 zod 对象；发给模型前会转成 JSON Schema。
// 计量必须用**转换后**的 JSON Schema（直接用 JSON.stringify(zod) 会把内部结构算进去，
// 实测虚高 40%+）。zod v4 自带 toJSONSchema，SDK 也是用它，属于直接依赖。
// 估算 token 用 3.2 字符/token（中英混排的保守经验值），只用于趋势对比，不是计费口径。
import { toJSONSchema } from 'zod/v4-mini';

const CHARS_PER_TOKEN = 3.2;

function jsonSchemaOf(inputSchema) {
  if (!inputSchema || typeof inputSchema !== 'object') return {};
  // zod v4 对象也有 .type（值为 'object'），必须先识别 zod 再转换；
  // 否则会把内部结构当成 JSON Schema 序列化，体积虚高 40%+。
  const isZod = Boolean(inputSchema._zod || inputSchema._def || typeof inputSchema.safeParse === 'function');
  if (isZod) {
    try {
      return toJSONSchema(inputSchema, { target: 'draft-7', io: 'input' });
    } catch {
      return {};
    }
  }
  // 已经是 JSON Schema（测试夹具/第三方注册可能直接给对象）。
  return inputSchema;
}

export function toolSchemaChars(tool = {}) {
  return JSON.stringify({
    name: String(tool.name || ''),
    description: String(tool.description || ''),
    inputSchema: jsonSchemaOf(tool.inputSchema)
  }).length;
}

export function summarizeToolSurface(tools = []) {
  const rows = (Array.isArray(tools) ? tools : []).map((tool) => ({
    name: String(tool.name || ''),
    chars: toolSchemaChars(tool)
  }));
  rows.sort((a, b) => b.chars - a.chars || a.name.localeCompare(b.name));
  const totalChars = rows.reduce((sum, row) => sum + row.chars, 0);
  return {
    count: rows.length,
    totalChars,
    estimatedTokens: Math.ceil(totalChars / CHARS_PER_TOKEN),
    largest: rows.slice(0, 5),
    tools: rows
  };
}
