// 控制台路由域：Token 用量与报表（R4）。
//
// 从 console-server.js 原样搬出，只调整了缩进；鉴权 / CSRF / agent 白名单 /
// 暂停隔离仍由 console-server 统一处理，走到这里时请求已通过全部前置校验。
export const id = '05-token';
export const title = 'Token 用量与报表';

/** 本模块负责的路由；console-server 据此分派，不必解析 handler 内部。 */
export const routes = [
  ['GET', '/api/socialV2/token-usage', 'exact'],
  ['POST', '/api/socialV2/token-usage-refresh', 'exact'],
  ['GET', '/api/socialV2/token-report', 'exact'],
  ['GET', '/api/socialV2/token-report-image', 'exact']
];

export async function handle(req, res, url, ctx) {
  const { sendJson, readBody, deps } = ctx;
  const { agentTokenOk, v2SessionAllowed, v2ToolEnabled } = ctx;
  const SECURITY_HEADERS = ctx.securityHeaders;
  const {
    appendActivity,
    buildTokenReport,
    cfg,
    contextDisplayName,
    fs,
    loadTokenUsage,
    log,
    modeAllowed,
    onebotSendImageFile,
    pruneTokenReportCache,
    refreshTokenUsage,
    renderTokenReport,
    shouldBlockSilentReply,
    socialV2,
    state,
    summarizeTokenReport
  } = deps;
  const {
    buildSessionUsageRows
  } = ctx.helpers;

  // Token 用量：控制台读这个拿每日/累计数据。
  //
  // 需求（2026-10-21 用户）：「把 token 记录做成日志，每日更新并且放进控制台」。
  // 这里只读缓存（state/token-usage.json），**不在请求里现算**——
  // 全量扫一遍要 13~15 秒，放在 HTTP 请求里会卡住控制台。
  // 需要立刻重算时用 POST ?refresh=1（后台跑，不阻塞响应）。
  if (req.method === 'GET' && url.pathname === '/api/socialV2/token-usage') {
    const data = deps.live.tokenUsage || loadTokenUsage();
    if (!data) {
      // 还没算过：返回空态 + 提示（前端会显示"正在统计"）
      sendJson({ ok: true, ready: false, days: {}, models: {}, dayModels: {}, turns: 0, calls: 0,
        turnMetrics: typeof deps.live.turnMetrics === 'function' ? deps.live.turnMetrics() : null });
      return;
    }
    // 口径：DSH 的 inputTokens = 未命中缓存的输入，cacheReadTokens = 命中缓存的输入；
    // 真正的 prompt_tokens = input + cacheRead。控制台必须把两者都摆出来，
    // 否则「输入 129M」会被误读成总消耗（实际总输入是 4B 量级）。
    const derive = (v) => {
      const src = (v && typeof v === 'object') ? v : {};
      const input = Number(src.input) || 0;
      const cacheRead = Number(src.cacheRead) || 0;
      const output = Number(src.output) || 0;
      const totalInput = input + cacheRead;
      return {
        ...src,
        totalInput,
        totalTokens: totalInput + output,
        cacheHitRate: totalInput > 0 ? Math.round((cacheRead / totalInput) * 1000) / 10 : 0
      };
    };
    const dayKeys = Object.keys(data.days || {}).sort().reverse();
    const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
    const tot = Object.values(data.days || {}).reduce((a, v) => ({
      input: a.input + v.input, output: a.output + v.output,
      cacheRead: a.cacheRead + v.cacheRead, reasoning: a.reasoning + v.reasoning,
      calls: a.calls + v.calls
    }), { input: 0, output: 0, cacheRead: 0, reasoning: 0, calls: 0 });

    // 按日审阅（2026-10-21 用户要求）：`?date=YYYY-MM-DD` 时，
    // `models` 换成**那一天**的模型明细；不传或传 `all` 则是全时段汇总。
    // 为什么要服务端过滤而不是前端自己挑：dayModels 是日×模型的联合分布，
    // 全量下发给前端在日期多了以后会明显变大（30 天 × 6 模型），
    // 而且前端拿到的数字必须和后端口径一致，放一处算就不会漂。
    const dateParam = String(url.searchParams.get('date') ?? '').trim();
    const wantAll = !dateParam || dateParam === 'all';
    const wantDate = wantAll ? '' : (/^\d{4}-\d{2}-\d{2}$/.test(dateParam) ? dateParam : '');
    if (!wantAll && !wantDate) {
      sendJson({ ok: false, error: 'date 应为 YYYY-MM-DD 或 all' }, 400);
      return;
    }
    const modelSource = wantAll ? (data.models || {}) : (data.dayModels?.[wantDate] || {});
    const sumModels = (obj) => Object.values(obj || {}).reduce((a, v) => ({
      input: a.input + (Number(v.input) || 0),
      output: a.output + (Number(v.output) || 0),
      cacheRead: a.cacheRead + (Number(v.cacheRead) || 0),
      reasoning: a.reasoning + (Number(v.reasoning) || 0),
      calls: a.calls + (Number(v.calls) || 0)
    }), { input: 0, output: 0, cacheRead: 0, reasoning: 0, calls: 0 });

    const sessionUsage = buildSessionUsageRows({
      usage: data,
      currentSessions: state.sessions || {},
      displayName: contextDisplayName,
      today,
      // 按日审阅对会话表生效：选某天时只看那天，选「总计」看全时段。
      scopeDay: wantAll ? '' : wantDate
    });
    sendJson({
      ok: true,
      ready: true,
      updatedAt: data.updatedAt || 0,
      today,
      // 按 QQ 会话：currentSessionId 非空表示该会话有当前 DSH 会话；
      // cumulative 含轮换前旧 sessionId 与情节摘要器，current 只含当前一个。
      // sessionScope：'all' = 全时段；YYYY-MM-DD = 只统计那一天。
      sessionScope: sessionUsage.scopeDay,
      sessions: sessionUsage.rows,
      unownedSessions: sessionUsage.unowned,
      // 当前"按模型"块对应哪一天：'all' = 全时段，否则是 YYYY-MM-DD。
      // 前端用它在标题上写清楚"这是哪天的数"，避免看错口径。
      modelScope: wantAll ? 'all' : wantDate,
      modelScopeUsage: derive(wantAll ? sumModels(data.models) : sumModels(modelSource)),
      todayUsage: derive(data.days?.[today] || { input: 0, output: 0, cacheRead: 0, calls: 0 }),
      total: derive(tot),
      turns: data.turns || 0,
      calls: data.calls || 0,
      files: data.files || 0,
      // 按日：最近 30 天，新的在前
      days: dayKeys.slice(0, 30).map((d) => ({ date: d, ...derive(data.days[d]) })),
      // 按模型：当前所选日期（或全时段）的明细，按输入量排序
      models: Object.entries(modelSource)
        .map(([model, v]) => ({ model, ...derive(v) }))
        .sort((a, b) => b.input - a.input),
      // T5：按回合的 Token 效率指标（KPI 见 docs/refactor-t5-acceptance.md）。
      // 与上方 token-usage 口径分开：这里按「回合」统计，不做全量转录扫描。
      turnMetrics: typeof deps.live.turnMetrics === 'function'
        ? deps.live.turnMetrics({ day: wantAll ? undefined : wantDate })
        : null
    });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/socialV2/token-usage-refresh') {
    // 后台重算，立刻回 202：全量扫描 13~15 秒，不能同步等
    void refreshTokenUsage({ force: url.searchParams.get('force') === '1' }).catch(() => {});
    sendJson({ ok: true, message: '已在后台开始重新统计（约 15 秒）' });
    return;
  }
  // ── Token 用量报表图（2026-10-21 用户要求）──────────────────────────
  //
  // 「让 bot 能够看到 token 消耗日志，能够以图片形式响应群友要求 token 消耗量
  //   相关问题」——所以这个端点是**给模型用的**（MCP 的 qq_token_report 调它），
  // 一次做完「取数 → 渲染 PNG → 发到当前会话」。
  //
  // 为什么由桥接直接发而不是把图 base64 还给模型：模型没有"发送任意图片"的能力
  // （qq_send_image 只认图库里的图），与功能菜单同一个理由。
  //
  // GET，参数：key（会话）、refresh（可选，1=先重算再出图）
  if (req.method === 'GET' && url.pathname === '/api/socialV2/token-report') {
    const key = String(url.searchParams.get('key') ?? '').trim();
    const keyMatch = /^(group|private):(\d+)$/.exec(key);
    if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
    // agent token 必需（与 send-image / send-feature-menu / github-shot 同规则）：
    // 这是个往群里发东西的写操作，不能靠"控制台没设令牌"就放行。
    if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: '发送 Token 报表必须携带 agent token' }, 403); return; }
    if (!agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
    if (!v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
    if (!v2ToolEnabled('tokenReport')) { sendJson({ ok: false, error: '工具未启用：qq_token_report' }, 403); return; }
    if (socialV2.paused) { sendJson({ ok: false, error: 'AI 已暂停，当前不允许发送' }, 403); return; }
    if (deps.ops.isTokenFused?.(key)) { sendJson({ ok: false, error: '会话已触发 Token 熔断，自动发送已停止；请先在控制台解除熔断' }, 403); return; }
    const kind = keyMatch[1];
    const id = Number(keyMatch[2]);
    if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, deps.live.currentMode)) {
      sendJson({ ok: false, error: '当前模式不允许向该会话发送' }, 403);
      return;
    }
    if (shouldBlockSilentReply(key)) { sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403); return; }
    try {
      // refresh=1：先同步重算一次（约 7 秒增量 / 15 秒全量）。
      // 群友明确问"今天用了多少"时值得等一下——拿 6 小时前的旧数回答，
      // 数字可能差出一大截。但不做全量强制重算（force 不传）。
      if (url.searchParams.get('refresh') === '1') {
        await refreshTokenUsage({});
      }
      const usage = deps.live.tokenUsage || loadTokenUsage() || { days: {}, models: {}, turns: 0, calls: 0 };
      const report = buildTokenReport(usage);
      const title = String(url.searchParams.get('title') ?? '').trim().slice(0, 40) || 'Token 用量';
      const r = await renderTokenReport(report, { title, log: (m) => log(m) });
      if (!r.ok) { sendJson({ ok: false, error: r.error }, 500); return; }
      await onebotSendImageFile(key, r.file, { label: 'Token 用量报表' });
      // 顺手清理旧报表缓存（每天都会产生新指纹文件，不清理会攒几千张）
      try { pruneTokenReportCache({ maxFiles: 20, maxAgeDays: 14 }); } catch {}
      log(`[Token报表] 已发送到 ${key}（${Math.round(r.bytes / 1024)}KB${r.cached ? '，缓存' : '，新渲染'}）`);
      appendActivity(`${key} [Token报表] 已发送 Token 用量图`);
      sendJson({
        ok: true,
        key,
        cached: r.cached,
        bytes: r.bytes,
        // 把关键数字一并回给模型：它在群友追问时要能回答，且**必须与图上同源**
        // （否则模型会凭印象再编一个数，和刚发出去的图对不上）。
        summary: summarizeTokenReport(report),
        today: { day: report.today.day, input: report.today.input, output: report.today.output, calls: report.today.calls },
        total: { input: report.all.input, output: report.all.output, calls: report.all.calls },
        stale: report.stale,
        ageText: report.ageText
      });
    } catch (error) {
      log(`Token 报表发送失败：${error?.message ?? error}`);
      sendJson({ ok: false, error: `Token 报表发送失败：${error?.message ?? error}` }, 500);
    }
    return;
  }

  // 控制台预览：渲染 Token 报表并以 PNG 返回（**不发群**）。
  //
  // 与 /api/socialV2/token-report 的区别：那个是给模型用的（渲染 + 发到会话），
  // 这个只给控制台看图。分成两个端点而不是加个 flag，是因为权限模型不同：
  // 发群那条必须带 agent token，预览这条走控制台鉴权（本机 + 同源）。
  if (req.method === 'GET' && url.pathname === '/api/socialV2/token-report-image') {
    try {
      if (url.searchParams.get('refresh') === '1') await refreshTokenUsage({});
      const usage = deps.live.tokenUsage || loadTokenUsage() || { days: {}, models: {}, turns: 0, calls: 0 };
      const report = buildTokenReport(usage);
      const title = String(url.searchParams.get('title') ?? '').trim().slice(0, 40) || 'Token 用量';
      const r = await renderTokenReport(report, { title, force: url.searchParams.get('force') === '1', log: (m) => log(m) });
      if (!r.ok) { sendJson({ ok: false, error: r.error }, 500); return; }
      const buf = fs.readFileSync(r.file);
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'content-type': 'image/png',
        'content-length': String(buf.length),
        // 内容指纹已在文件名里，但浏览器拿不到——用 no-store 保证看到的是新图
        'cache-control': 'no-store'
      });
      res.end(buf);
    } catch (error) {
      sendJson({ ok: false, error: `生成报表失败：${error?.message ?? error}` }, 500);
    }
    return;
  }
}
