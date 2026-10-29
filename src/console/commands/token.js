// R4.7-3：Token 领域命令（刷新 / 渲染 / 发群）。
//
// 路由只保留鉴权（console token / agent token / 工具开关）与参数解析；
// 「能不能发」（模式、暂停、熔断、静默）和「发出去要做什么」（渲染、发送、清理缓存、
// 写时间线）都在这里。这样新增一个发送前置条件时不用再改路由的依赖清单。
//
// 依赖全部注入，命令本身不 import 桥接实现：同一个模块可以在测试里用替身跑通。

const EMPTY_USAGE = Object.freeze({ days: {}, models: {}, turns: 0, calls: 0 });
const TITLE_MAX = 40;
const DEFAULT_TITLE = 'Token 用量';

export function createTokenCommands({
  live = {},
  cfg = {},
  socialV2 = {},
  ops = {},
  fs,
  loadTokenUsage,
  refreshTokenUsage,
  buildTokenReport,
  renderTokenReport,
  summarizeTokenReport,
  pruneTokenReportCache,
  onebotSendImageFile,
  appendActivity,
  log,
  modeAllowed,
  shouldBlockSilentReply
} = {}) {
  const logLine = (message) => { try { log?.(message); } catch { /* 日志失败不影响主流程 */ } };
  const cleanTitle = (raw) => String(raw ?? '').trim().slice(0, TITLE_MAX) || DEFAULT_TITLE;
  const readUsage = () => live.tokenUsage
    || (typeof loadTokenUsage === 'function' ? loadTokenUsage() : null)
    || EMPTY_USAGE;

  /** 后台重算：全量扫描 13~15 秒，调用方必须 fire-and-forget，不能同步等。 */
  async function refresh({ force = false } = {}) {
    if (typeof refreshTokenUsage !== 'function') throw new Error('Token 统计能力不可用');
    return refreshTokenUsage({ force });
  }

  /**
   * 渲染报表（不发群）。`refresh=true` 时先同步增量重算一次——
   * 群友明确问"今天用了多少"时值得等，拿 6 小时前的旧数回答可能差出一大截；
   * 但不做全量强制重算（force 由调用方显式传）。
   */
  async function renderReport({ title, force = false, refresh: doRefresh = false } = {}) {
    if (typeof buildTokenReport !== 'function' || typeof renderTokenReport !== 'function') {
      return { ok: false, error: 'Token 报表能力不可用' };
    }
    if (doRefresh) await refresh({});
    const report = buildTokenReport(readUsage());
    const r = await renderTokenReport(report, { title: cleanTitle(title), force, log: logLine });
    if (!r?.ok) return { ok: false, error: r?.error || '报表渲染失败' };
    return { ok: true, report, file: r.file, bytes: r.bytes, cached: r.cached };
  }

  /** 控制台预览：渲染成 PNG 字节，不发群。 */
  async function renderImage(options = {}) {
    const r = await renderReport(options);
    if (!r.ok) return r;
    if (!fs?.readFileSync) return { ok: false, error: '报表读取能力不可用' };
    try {
      return { ...r, buffer: fs.readFileSync(r.file) };
    } catch (error) {
      return { ok: false, error: `报表读取失败：${error?.message ?? error}` };
    }
  }

  /**
   * 发 Token 报表到会话。
   *
   * 四道发送闸在命令内：暂停 / 熔断 / 模式准入 / 静默。
   * agent token 与工具开关属于鉴权层，留在路由（与 send-image 等端点同规则）。
   */
  async function sendReport({ key, kind, id, title, refresh: doRefresh = false } = {}) {
    if (socialV2.paused) return { ok: false, status: 403, error: 'AI 已暂停，当前不允许发送' };
    if (ops.isTokenFused?.(key)) {
      return { ok: false, status: 403, error: '会话已触发 Token 熔断，自动发送已停止；请先在控制台解除熔断' };
    }
    if (!Number.isFinite(id) || id <= 0
      || typeof modeAllowed !== 'function'
      || !modeAllowed(key, kind, id, cfg, live.currentMode)) {
      return { ok: false, status: 403, error: '当前模式不允许向该会话发送' };
    }
    if (typeof shouldBlockSilentReply === 'function' && shouldBlockSilentReply(key)) {
      return { ok: false, status: 403, error: '静默模式已开启，当前不允许发送' };
    }
    try {
      const r = await renderReport({ title, refresh: doRefresh });
      if (!r.ok) return { ok: false, status: 500, error: r.error };
      if (typeof onebotSendImageFile !== 'function') {
        return { ok: false, status: 500, error: '图片发送能力不可用' };
      }
      await onebotSendImageFile(key, r.file, { label: 'Token 用量报表' });
      // 顺手清理旧报表缓存（每天都会产生新指纹文件，不清理会攒几千张）
      try { pruneTokenReportCache?.({ maxFiles: 20, maxAgeDays: 14 }); } catch { /* 清理失败不影响发送结果 */ }
      logLine(`[Token报表] 已发送到 ${key}（${Math.round(r.bytes / 1024)}KB${r.cached ? '，缓存' : '，新渲染'}）`);
      appendActivity?.(`${key} [Token报表] 已发送 Token 用量图`);
      const report = r.report;
      return {
        ok: true,
        key,
        cached: r.cached,
        bytes: r.bytes,
        // 把关键数字一并回给模型：它在群友追问时要能回答，且**必须与图上同源**
        // （否则模型会凭印象再编一个数，和刚发出去的图对不上）。
        summary: typeof summarizeTokenReport === 'function' ? summarizeTokenReport(report) : null,
        today: { day: report.today.day, input: report.today.input, output: report.today.output, calls: report.today.calls },
        total: { input: report.all.input, output: report.all.output, calls: report.all.calls },
        stale: report.stale,
        ageText: report.ageText
      };
    } catch (error) {
      logLine(`Token 报表发送失败：${error?.message ?? error}`);
      return { ok: false, status: 500, error: `Token 报表发送失败：${error?.message ?? error}` };
    }
  }

  return { refresh, renderReport, renderImage, sendReport, cleanTitle };
}
