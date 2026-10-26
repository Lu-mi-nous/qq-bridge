// Token 用量服务（R3-8）：统计 DSH 转录、摘要器记账与定时刷新。
//
// 只负责 token-usage.json 的聚合/落盘；报表渲染仍在 token-report 模块。
import fs from 'node:fs';
import path from 'node:path';
import { aggregateTokenUsage, dayKey, humanTokens } from './token-usage.js';

export function createTokenService({
  file,
  getConfig = () => ({}),
  sessionHistory,
  state,
  contextMetrics,
  appendActivity = () => {},
  taskService = null,
  readJsonSafe,
  atomicWriteJson,
  aggregateFn = aggregateTokenUsage,
  sessionsRoot = '',
  log = () => {},
  now = Date.now
} = {}) {
  if (!file) throw new Error('createTokenService: file 不能为空');
  if (!sessionHistory) throw new Error('createTokenService: sessionHistory 不能为空');
  if (!state) throw new Error('createTokenService: state 不能为空');
  if (typeof readJsonSafe !== 'function' || typeof atomicWriteJson !== 'function') {
    throw new Error('createTokenService: readJsonSafe/atomicWriteJson 不能为空');
  }

  let tokenUsage = null;
  let busy = false;

  function load() {
    try {
      const raw = readJsonSafe(file, null);
      if (raw && typeof raw === 'object' && raw.days) return raw;
    } catch {}
    return null;
  }

  function recordSummarizerUsage(key, usage = {}) {
    const k = String(key || '');
    if (!/^(group|private):\d+$/.test(k)) return;
    const at = now();
    const day = dayKey(at);
    const input = Number(usage.input) || 0;
    const output = Number(usage.output) || 0;
    const cacheRead = Number(usage.cacheRead) || 0;
    try {
      const disk = load() || {
        updatedAt: at, days: {}, models: {}, dayModels: {}, sessions: {}, summarizer: {}, turns: 0, calls: 0
      };
      if (!disk.summarizer || typeof disk.summarizer !== 'object') disk.summarizer = {};
      const bucket = disk.summarizer[k] || { input: 0, output: 0, cacheRead: 0, calls: 0, days: {} };
      bucket.input += input;
      bucket.output += output;
      bucket.cacheRead += cacheRead;
      bucket.calls += 1;
      if (!bucket.days || typeof bucket.days !== 'object') bucket.days = {};
      const d = bucket.days[day] || { input: 0, output: 0, cacheRead: 0, calls: 0 };
      d.input += input;
      d.output += output;
      d.cacheRead += cacheRead;
      d.calls += 1;
      bucket.days[day] = d;
      disk.summarizer[k] = bucket;
      atomicWriteJson(file, disk);
      if (tokenUsage) tokenUsage.summarizer = disk.summarizer;
      const m = contextMetrics?.get(k) || {};
      m.lastSummaryTokens = input + output;
      m.lastSummaryAt = at;
      contextMetrics?.set(k, m);
      if (usage.hasUsage === false) {
        log(`[Token] 摘要器 ${k} 调用已记账，但网关响应没有 usage 字段（只记次数）`);
      }
    } catch (error) {
      log(`[Token] 摘要器用量记账失败（不影响摘要）：${error?.message ?? error}`);
    }
  }

  async function refresh(opts = {}) {
    if (busy) return tokenUsage;
    busy = true;
    const startedAt = now();
    try {
      const prev = load();
      const home = process.env.USERPROFILE || process.env.HOME || '';
      const rootDir = sessionsRoot || path.join(home, '.dsh', 'sessions');
      const roots = [];
      try {
        for (const name of fs.readdirSync(rootDir)) {
          if (!name.includes('qq-bridge')) continue;
          if (!/-state-agents--$/i.test(name)) continue;
          roots.push(path.join(rootDir, name));
        }
      } catch {}
      if (!roots.length) {
        log('[Token] 未找到 DSH 会话目录，跳过统计');
        return tokenUsage;
      }
      const agg = aggregateFn(roots, {
        cache: opts.force ? {} : (prev?.cache || {}),
        maxFiles: 400,
        sessionKeys: sessionHistory.mapping(),
        currentSessions: state.sessions
      });
      const latest = load();
      const out = {
        updatedAt: now(),
        days: agg.days,
        models: agg.models,
        dayModels: agg.dayModels || {},
        sessions: agg.sessions || {},
        summarizer: latest?.summarizer || prev?.summarizer || {},
        turns: agg.turns,
        calls: agg.calls,
        files: agg.files,
        cache: agg.cache
      };
      atomicWriteJson(file, out);
      tokenUsage = out;
      const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
      const keys = Object.keys(out.days).sort();
      const t = out.days[today] || { input: 0, output: 0, cacheRead: 0, calls: 0 };
      const tot = Object.values(out.days).reduce((a, v) => ({
        input: a.input + v.input, output: a.output + v.output, cacheRead: a.cacheRead + v.cacheRead, calls: a.calls + v.calls
      }), { input: 0, output: 0, cacheRead: 0, calls: 0 });
      const secs = ((now() - startedAt) / 1000).toFixed(1);
      log(`[Token] 统计完成（${secs}s，新解析 ${agg.scanned} 文件 / 复用 ${agg.reused}）`);
      log(`[Token] 今日 ${today}：输入 ${humanTokens(t.input)} / 输出 ${humanTokens(t.output)} / 缓存读 ${humanTokens(t.cacheRead)} / 调用 ${t.calls}`);
      log(`[Token] 累计：输入 ${humanTokens(tot.input)} / 输出 ${humanTokens(tot.output)} / 缓存读 ${humanTokens(tot.cacheRead)} / 调用 ${tot.calls}`);
      appendActivity(`[Token] 今日 输入 ${humanTokens(t.input)} / 输出 ${humanTokens(t.output)} / 调用 ${t.calls}`);
      return out;
    } catch (error) {
      log(`[Token] 统计失败（不影响桥接）：${error?.message || error}`);
      return tokenUsage;
    } finally {
      busy = false;
    }
  }

  function startScheduler() {
    if (!taskService) throw new Error('createTokenService: taskService 不能为空');
    taskService.define('tokenUsageFirst', { kind: 'timeout', delayMs: 30 * 1000, run: () => refresh() });
    taskService.define('tokenUsage', {
      everyMs: 60 * 60 * 1000,
      run: () => {
        const prev = tokenUsage || load();
        const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
        const lastDay = prev?.updatedAt
          ? new Date(prev.updatedAt).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' })
          : '';
        const ageMs = now() - (Number(prev?.updatedAt) || 0);
        if (lastDay !== today || ageMs > 6 * 3600 * 1000) return refresh();
        return undefined;
      }
    });
    taskService.start('tokenUsageFirst');
    taskService.start('tokenUsage');
  }

  return {
    load,
    recordSummarizerUsage,
    refresh,
    startScheduler,
    get: () => tokenUsage,
    set: (value) => { tokenUsage = value || null; }
  };
}
