// R4.7-2：Token 读模型（面向控制台 UI）。
//
// 为什么单独一层：`05-token` 原先从 20 项平铺依赖里自己拼响应——日/模型/会话三种口径、
// 缓存命中率、按日审阅的过滤都在路由里。新增一个数字就要再拉一个 getter，路由逐渐变成
// "知道所有实现细节"的组装点。这里只负责「读哪份缓存 + 怎么派生」，不发送、不写盘、
// 不触发全量扫描；刷新/渲染/发送在 `src/console/commands/token.js`。
//
// 动态值（live.tokenUsage / live.turnMetrics / state.sessions）每次调用现读，
// 不能在创建时快照——控制台是长寿命进程，快照会让报表停在启动那一刻。

const ZERO = Object.freeze({ input: 0, output: 0, cacheRead: 0, reasoning: 0, calls: 0 });

/** 空缓存态：字段与完整响应保持一致，前端不需要分支判断。 */
export function emptyUsage() {
  return { days: {}, models: {}, dayModels: {}, turns: 0, calls: 0 };
}

/**
 * 计费口径派生：DSH 的 input 是未命中缓存输入，cacheRead 是命中缓存输入，
 * provider 的 prompt_tokens 才是两者之和。控制台必须把三者都摆出来，
 * 否则「输入 129M」会被误读成总消耗（实际总输入是 4B 量级）。
 */
export function deriveUsage(v) {
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
}

export function sumModelUsage(obj) {
  const out = { input: 0, output: 0, cacheRead: 0, reasoning: 0, calls: 0 };
  for (const v of Object.values(obj || {})) {
    out.input += Number(v?.input) || 0;
    out.output += Number(v?.output) || 0;
    out.cacheRead += Number(v?.cacheRead) || 0;
    out.reasoning += Number(v?.reasoning) || 0;
    out.calls += Number(v?.calls) || 0;
  }
  return out;
}

function shanghaiDay(date) {
  return new Date(date).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
}

export function createTokenReadModel({
  live = {},
  state = {},
  loadTokenUsage,
  contextDisplayName,
  buildSessionUsageRows,
  now = () => new Date()
} = {}) {
  const rawUsage = () => live.tokenUsage || (typeof loadTokenUsage === 'function' ? loadTokenUsage() : null);
  const turnMetrics = (opts) => (typeof live.turnMetrics === 'function' ? live.turnMetrics(opts) : null);

  /**
   * GET /api/socialV2/token-usage 的完整视图。
   *
   * 只读缓存（state/token-usage.json），**不在请求里现算**——全量扫一遍要 13~15 秒，
   * 放在 HTTP 请求里会卡住控制台。需要立刻重算走命令层的 refresh。
   *
   * @returns {{ok:true, body:object}|{ok:false, status:number, error:string}}
   */
  function usageView(rawDate) {
    const dateParam = String(rawDate ?? '').trim();
    const wantAll = !dateParam || dateParam === 'all';
    const wantDate = wantAll ? '' : (/^\d{4}-\d{2}-\d{2}$/.test(dateParam) ? dateParam : '');
    if (!wantAll && !wantDate) {
      return { ok: false, status: 400, error: 'date 应为 YYYY-MM-DD 或 all' };
    }

    const data = rawUsage();
    if (!data) {
      // 还没算过：返回空态 + 提示（前端会显示"正在统计"）
      return { ok: true, status: 200, body: { ok: true, ready: false, ...emptyUsage(), turnMetrics: turnMetrics() } };
    }

    const today = shanghaiDay(now());
    const dayKeys = Object.keys(data.days || {}).sort().reverse();
    const tot = { ...ZERO };
    for (const v of Object.values(data.days || {})) {
      tot.input += Number(v?.input) || 0;
      tot.output += Number(v?.output) || 0;
      tot.cacheRead += Number(v?.cacheRead) || 0;
      tot.reasoning += Number(v?.reasoning) || 0;
      tot.calls += Number(v?.calls) || 0;
    }

    // 按日审阅（2026-10-21 用户要求）：`?date=YYYY-MM-DD` 时，
    // `models` 换成**那一天**的模型明细；不传或传 `all` 则是全时段汇总。
    // 服务端过滤而不是前端自己挑：dayModels 是日×模型的联合分布，
    // 全量下发给前端在日期多了以后会明显变大（30 天 × 6 模型），
    // 而且前端拿到的数字必须和后端口径一致，放一处算就不会漂。
    const modelSource = wantAll ? (data.models || {}) : (data.dayModels?.[wantDate] || {});
    const sessionUsage = typeof buildSessionUsageRows === 'function'
      ? buildSessionUsageRows({
        usage: data,
        currentSessions: state.sessions || {},
        displayName: contextDisplayName,
        today,
        // 按日审阅对会话表生效：选某天时只看那天，选「总计」看全时段。
        scopeDay: wantAll ? '' : wantDate
      })
      : { scopeDay: wantAll ? 'all' : wantDate, rows: [], unowned: [] };

    return {
      ok: true,
      status: 200,
      body: {
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
        modelScopeUsage: deriveUsage(wantAll ? sumModelUsage(data.models) : sumModelUsage(modelSource)),
        todayUsage: deriveUsage(data.days?.[today] || { input: 0, output: 0, cacheRead: 0, calls: 0 }),
        total: deriveUsage(tot),
        turns: data.turns || 0,
        calls: data.calls || 0,
        files: data.files || 0,
        // 按日：最近 30 天，新的在前
        days: dayKeys.slice(0, 30).map((d) => ({ date: d, ...deriveUsage(data.days[d]) })),
        // 按模型：当前所选日期（或全时段）的明细，按输入量排序
        models: Object.entries(modelSource)
          .map(([model, v]) => ({ model, ...deriveUsage(v) }))
          .sort((a, b) => b.input - a.input),
        // T5：按回合的 Token 效率指标（KPI 见 docs/refactor-t5-acceptance.md）。
        // 与上方 token-usage 口径分开：这里按「回合」统计，不做全量转录扫描。
        turnMetrics: turnMetrics(wantAll ? undefined : { day: wantDate })
      }
    };
  }

  return { rawUsage, turnMetrics, usageView };
}
