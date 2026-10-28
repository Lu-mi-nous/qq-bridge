// T3：角色卡摘要（role digest）。
//
// 背景：角色卡整份注入唤醒提示后，每轮常驻 1 万字符上下（大肥鱼.md 25.8KB ≈ 8.6k 汉字）。
// 计划要求常驻只放 600–1200 字的 digest，完整卡只在角色切换 / 会话初始化 /
// 明确要看细节（qq_get_prompt detail=full）时注入。
//
// 摘要来源优先级：
//   1. `roles/<角色>.digest.md`（人工整理，质量最好；改卡后记得同步）；
//   2. 自动摘要：第一段（通常"你是谁"）+ 其余小节标题与首行，按预算截断。
// 自动摘要只保证"不丢结构"，人设细节仍需人工 digest。
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_DIGEST_CHARS = 1200;

/** 什么时候注入完整角色卡：明确要求 / 角色刚切换 / 会话引导。 */
export function shouldInjectFullRole({ reason = '', changed = false, full = false } = {}) {
  return full === true || changed === true || reason === 'bootstrap';
}

function splitSections(card) {
  const lines = String(card || '').split('\n');
  const sections = [];
  let current = { title: '', body: [] };
  for (const line of lines) {
    if (/^##\s+/.test(line)) {
      if (current.title || current.body.length) sections.push(current);
      current = { title: line.replace(/^##\s+/, '').trim(), body: [] };
      continue;
    }
    if (/^#\s+/.test(line)) continue; // 一级标题（角色卡名）不进摘要
    current.body.push(line);
  }
  if (current.title || current.body.length) sections.push(current);
  return sections.map((s) => ({
    title: s.title,
    body: s.body.join('\n').trim(),
    firstLine: s.body.map((x) => x.trim()).find((x) => x && !x.startsWith('>')) || ''
  }));
}

function trimAtLine(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const at = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf('。'));
  return (at > max * 0.5 ? cut.slice(0, at + 1) : cut).trim();
}

export function buildRoleDigest(card, { maxChars = DEFAULT_DIGEST_CHARS } = {}) {
  const text = String(card || '').trim();
  if (!text) return '';
  if (text.length <= maxChars) return text;
  const sections = splitSections(text);
  if (!sections.length) return trimAtLine(text, maxChars);
  const hint = '（完整角色卡：qq_get_prompt detail=full）';
  const budget = Math.max(200, maxChars - hint.length - 2);
  const parts = [];
  let used = 0;
  // 第一段通常是"你是谁"，给 55% 预算。
  const first = sections[0];
  if (first && first.body) {
    const body = trimAtLine(first.body, Math.floor(budget * 0.55));
    if (body) {
      parts.push(`【${first.title || '角色'}】\n${body}`);
      used += parts.at(-1).length + 2;
    }
  }
  // 其余小节只放标题 + 首行，保证人设结构不丢。
  for (const section of sections.slice(1)) {
    if (!section.title && !section.firstLine) continue;
    const line = `· ${section.title}${section.firstLine ? `：${section.firstLine.replace(/^[-*]\s*/, '').slice(0, 60)}` : ''}`;
    if (used + line.length + 1 > budget) break;
    parts.push(line);
    used += line.length + 1;
  }
  return `${parts.join('\n')}\n${hint}`;
}

/** 读取 `roles/<角色>.digest.md`（人工整理）；不存在返回 null。mtime 缓存。 */
export function createRoleDigestReader({ ROOT, log = () => {} }) {
  const cache = new Map();
  return function readRoleDigest(role) {
    try {
      const file = path.join(ROOT, 'roles', `${role}.digest.md`);
      if (!fs.existsSync(file)) return null;
      const stat = fs.statSync(file);
      const hit = cache.get(role);
      if (hit && hit.mtimeMs === stat.mtimeMs) return hit.text;
      const text = fs.readFileSync(file, 'utf8').trim();
      cache.set(role, { mtimeMs: stat.mtimeMs, text });
      return text || null;
    } catch (error) {
      log(`读取角色摘要失败：${error?.message ?? error}`);
      return null;
    }
  };
}
