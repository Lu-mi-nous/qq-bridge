// 配置 schema 与校验。
//
// 设计目标（R1）：
//   1. 配置默认值只有一处来源（config-defaults.js），模板由它生成，避免"模板缺段"。
//   2. 启动时校验类型与未知键：类型错误直接拒绝启动并给出路径；未知键只告警。
//   3. 不改变 loadConfig 现有的合并语义——校验是叠加的，不是替换。
//
// 动态键（按群号等生成的 map）允许任意键，不做未知键告警。
import { z } from 'zod';
import { CONFIG_DEFAULTS } from './config-defaults.js';

const DYNAMIC_MAP_PATHS = new Set(['socialV2.tokenFuse.overrides']);

// 少数字段的默认值是 null（表示"未设置"），但合法输入类型更多，不能按 null 判型。
const TYPE_FLEX = {
  ownerQQ: ['number', 'string', 'null'],
};

const isPlainObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

function buildNode(value, path) {
  if (path === 'ownerQQ') return z.union([z.number(), z.string(), z.null()]);
  if (Array.isArray(value)) return z.array(z.any());
  if (isPlainObject(value)) {
    if (DYNAMIC_MAP_PATHS.has(path)) {
      return z.record(
        z.string(),
        z.object({
          warnTokens: z.number().optional(),
          fuseTokens: z.number().optional(),
          fuseUncachedTokens: z.number().optional(),
        }).passthrough()
      );
    }
    const shape = {};
    for (const [k, v] of Object.entries(value)) {
      shape[k] = buildNode(v, path ? `${path}.${k}` : k);
    }
    return z.object(shape).passthrough();
  }
  if (typeof value === 'boolean') return z.boolean();
  if (typeof value === 'number') return z.number();
  if (typeof value === 'string') return z.string();
  return z.any();
}

export const CONFIG_SCHEMA = buildNode(CONFIG_DEFAULTS, '');

/** 把对象摊平成叶子路径：{ 'socialV2.images.enabled': true } */
export function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj ?? {})) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (isPlainObject(v)) flatten(v, p, out);
    else out[p] = v;
  }
  return out;
}

const isDynamicPath = (p) => {
  for (const base of DYNAMIC_MAP_PATHS) {
    if (p === base || p.startsWith(base + '.')) return true;
  }
  return false;
};

const typeName = (v) => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v);

/**
 * 校验用户配置（原始文件内容，不含代码默认值）。
 * @returns {{ errors: Array, warnings: Array, missing: string[], unknown: string[] }}
 *   errors   —— 类型不匹配，调用方应拒绝启动
 *   warnings —— 未知键，仅告警（可能是新版本字段或拼写错误）
 *   missing  —— 未配置、将使用默认值的字段路径
 */
export function validateConfig(raw) {
  const defaults = flatten(CONFIG_DEFAULTS);
  const actual = flatten(raw);
  const errors = [];
  const unknown = [];
  const missing = [];

  for (const [p, v] of Object.entries(actual)) {
    if (isDynamicPath(p)) continue;
    if (!(p in defaults)) { unknown.push(p); continue; }
    const expected = typeName(defaults[p]);
    const got = typeName(v);
    const allowed = TYPE_FLEX[p] ?? [expected];
    if (!allowed.includes(got)) errors.push({ path: p, expected: allowed.join(' | '), got });
  }

  for (const p of Object.keys(defaults)) {
    if (isDynamicPath(p)) continue;
    if (!(p in actual)) missing.push(p);
  }

  // zod 再做一次结构校验（覆盖嵌套对象/动态 map 的形态）
  const merged = deepMerge(structuredClone(CONFIG_DEFAULTS), raw ?? {});
  const parsed = CONFIG_SCHEMA.safeParse(merged);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const pathStr = issue.path.join('.');
      if (!errors.some((e) => e.path === pathStr)) {
        errors.push({ path: pathStr || '(root)', expected: issue.code, got: issue.message });
      }
    }
  }

  return { errors, warnings: unknown, missing, unknown };
}

export function deepMerge(target, source) {
  for (const [k, v] of Object.entries(source ?? {})) {
    if (isPlainObject(v) && isPlainObject(target[k])) deepMerge(target[k], v);
    else target[k] = v;
  }
  return target;
}

/** 启动摘要：只挑运维最关心的开关，避免刷屏。 */
export function configSummary(cfg) {
  const sv = cfg.socialV2 ?? {};
  const tools = sv.tools ?? {};
  return {
    dsh: `${cfg.dsh?.provider ?? '?'} / ${cfg.dsh?.model ?? '?'}`,
    consolePort: cfg.consolePort,
    images: sv.images?.enabled === true,
    tts: sv.tts?.enabled === true,
    bili: sv.bili?.enabled !== false,
    upscale: sv.upscale?.enabled === true,
    toolsOn: Object.values(tools).filter((v) => v === true).length,
    toolsTotal: Object.keys(tools).length,
  };
}
