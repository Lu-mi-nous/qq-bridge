// 控制台路由域：B 站（R4）。
//
// 从 console-server.js 原样搬出，只调整了缩进；鉴权 / CSRF / agent 白名单 /
// 暂停隔离仍由 console-server 统一处理，走到这里时请求已通过全部前置校验。
export const id = '14-bili';
export const title = 'B 站';

/** 本模块负责的路由；console-server 据此分派，不必解析 handler 内部。 */
export const routes = [
  ['POST', '/api/socialV2/bili-record', 'exact'],
  ['GET', '/api/socialV2/bili-memory', 'exact'],
  ['POST', '/api/socialV2/bili-search', 'exact'],
  ['POST', '/api/socialV2/bili-watch', 'exact'],
  ['POST', '/api/socialV2/bili-pause', 'exact'],
  ['POST', '/api/socialV2/bili-browse-now', 'exact'],
  ['GET', '/api/socialV2/join-requests', 'exact'],
  ['POST', '/api/socialV2/tts-say', 'exact'],
  ['POST', '/api/socialV2/tts/pick-path', 'exact'],
  ['GET', '/api/socialV2/cache', 'exact'],
  ['POST', '/api/socialV2/cache-purge', 'exact'],
  ['GET', '/api/socialV2/tts-status', 'exact'],
  ['GET', '/api/socialV2/bili-status', 'exact']
];

export async function handle(req, res, url, ctx) {
  const { sendJson, readBody, deps } = ctx;
  const { agentTokenOk, v2SessionAllowed } = ctx;
  const SECURITY_HEADERS = ctx.securityHeaders;
  const {
    CACHE_GROUPS,
    DEFAULT_SOVITS_DIR,
    ROOT,
    STATE_DIR,
    TTS_DEFAULT_PROBABILITY,
    appendActivity,
    atomicWriteJson,
    biliBrowseState,
    biliInfoCache,
    cfg,
    collectCacheItems,
    fetchVideoInfo,
    fs,
    groupActivityScore,
    humanBytes,
    joinQueue,
    log,
    path,
    purgeCache,
    readJsonSafe,
    rememberBiliInfo,
    resolveBiliId,
    runBiliBrowse,
    scheduleBiliBrowse,
    searchVideos,
    socialV2,
    summarizeCache,
    ttsNum,
    ttsSpeechParams,
    watchVideo
  } = deps;

  // ── B 站：观看记录与记忆（全局，跨群共用）────────────────────────────
  //
  // 为什么是全局而不是挂 key：现有 activeTopic/memberImpression 是**群聊上下文**，
  // 本就该按群隔离；而"我喜欢看什么视频"是机器人自己的偏好，与群无关。
  // 在 A 群看过的视频，B 群聊到时也该记得（2026-10-19 用户选定）。
  if (req.method === 'POST' && url.pathname === '/api/socialV2/bili-record') {
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    const token = String(body.token ?? '').trim();
    if (!deps.live.biliMem) { sendJson({ ok: false, error: 'B 站功能未启用' }, 400); return; }
    if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
    if (token && !agentTokenOk(key, token)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
    if (token && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
    // bvid 解析：**优先用"最近看完的那条"**，而不是信模型传的值。
    //
    // 为什么（2026-10-19 实测）：模型记不住 10 位随机 bvid，会**瞎编一个**——
    // 日志里 12:47:12 缓存的是 BV14cnn6REvX，12:47:39 它记录时传的是 BV1qh411c7mR，
    // 于是缓存查不到、记忆里存成两条不同的视频、简介也丢了。
    // 模型只该负责"喜不喜欢"，标识由桥接给。
    let bvid = String(body.bvid ?? '').trim();
    const recent = deps.live.lastBiliWatch?.ok ? String(deps.live.lastBiliWatch.bvid || '').trim() : '';
    if (recent && bvid !== recent) {
      log(`[B站] 模型传的 bvid=${bvid || '(空)'} 与刚看完的 ${recent} 不符，改用后者`);
      bvid = recent;
    }
    if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) {
      sendJson({ ok: false, error: '没有可记录的 bvid（最近没有看完的视频）' }, 400);
      return;
    }
    // 用缓存补全元信息（简介、标题等模型看不到的字段）
    const cached = biliInfoCache.get(bvid);
    if (cached) {
      body.desc = body.desc || cached.desc;
      body.title = body.title || cached.title;
      body.owner = body.owner || cached.owner;
      body.category = body.category || cached.category;
      body.durationSec = body.durationSec || cached.durationSec;
      body.biliTags = cached.biliTags || undefined;
    } else {
      log(`[B站] 记录 ${bvid}: 元信息缓存未命中（可能重启过），标题/简介可能缺失`);
    }
  const rec = deps.live.biliMem.record({
      bvid,
      title: body.title,
      owner: body.owner,
      category: body.category,
      durationSec: body.durationSec,
      // 简介：模型不必自己传，桥接在"自己刷"时会带；工具调用没传就沿用已有的
      desc: body.desc,
      // B 站给的原生标签（简介为空时的主要线索），与模型自己打的 tags 分开存
      biliTags: Array.isArray(body.biliTags) ? body.biliTags : undefined,
      // 字幕片段：桥接看过时缓存，模型不必自己传（它记不住上千字原话）
      subtitle: body.subtitle || undefined,
      tags: Array.isArray(body.tags) ? body.tags : undefined,
      liked: body.liked === true ? true : (body.liked === false ? false : null),
      interest: body.interest,
      watchedFrames: body.watchedFrames,
      watchedSeconds: body.watchedSeconds,
      source: body.source,
      notes: body.notes
    });
    log(`[B站] 记录 ${bvid} liked=${rec?.liked} interest=${rec?.interest} tags=${(rec?.tags || []).join('/')}`);
    sendJson({ ok: true, video: rec, taste: deps.live.biliMem.taste(5), stats: deps.live.biliMem.stats() });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/socialV2/bili-memory') {
    if (!deps.live.biliMem) { sendJson({ ok: false, error: 'B 站功能未启用' }, 400); return; }
    const key = String(url.searchParams.get('key') ?? '').trim();
    const token = String(req.headers['x-agent-token'] ?? '').trim();
    if (token && key && !agentTokenOk(key, token)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
    const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 10));
    const likedOnly = url.searchParams.get('liked') === '1';
    const query = String(url.searchParams.get('q') ?? '').trim();
    let list = deps.live.biliMem.recent(limit, { likedOnly });
    if (query) {
      const q = query.toLowerCase();
      list = list.filter((v) =>
        String(v.title).toLowerCase().includes(q)
        || String(v.owner).toLowerCase().includes(q)
        || (v.tags || []).some((t) => String(t).toLowerCase().includes(q)));
    }
    sendJson({ ok: true, videos: list, taste: deps.live.biliMem.taste(), stats: deps.live.biliMem.stats() });
    return;
  }
  // ── 现场搜索（模型工具 qq_bili_search 用它）──────────────────────────
  //
  // 需求（2026-10-19 用户反馈「为什么没有新增的视频，都是之前说过了的」）：
  // 群友问"推荐点视频"时，模型原来只能翻记忆里的旧视频（因为只有查询工具、
  // 没有搜索工具），还会临时编没有链接的内容。这个端点补上"实时搜索"。
  if (req.method === 'POST' && url.pathname === '/api/socialV2/bili-search') {
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    const token = String(body.token ?? '').trim();
    if (!cfg.socialV2?.bili?.enabled) { sendJson({ ok: false, error: 'B 站功能未启用' }, 400); return; }
    if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
    if (token && !agentTokenOk(key, token)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
    if (token && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
    const query = String(body.query ?? '').trim().slice(0, 60);
    if (!query) { sendJson({ ok: false, error: 'query 不能为空' }, 400); return; }
    try {
      const count = Math.min(20, Math.max(1, Number(body.count) || 8));
      const order = ['totalrank', 'pubdate', 'click'].includes(body.order) ? body.order : 'totalrank';
      const videos = await searchVideos(query, deps.live.biliAuth, { count, order });
      // 过滤掉已经看过/记录过的（推荐"新的"才有意义）
      const fresh = videos.filter((v) => !deps.live.biliMem?.get(v.bvid));
      sendJson({
        ok: true,
        query,
        engineNote: deps.live.biliAuth.loaded && deps.live.biliAuth.hasSessdata ? '登录态搜索' : '匿名搜索',
        videos: fresh.length ? fresh : videos,
        // 若过滤后为空说明全都看过，明确告知（模型据此换关键词）
        allSeen: fresh.length === 0 && videos.length > 0
      });
    } catch (error) {
      log(`[B站] 搜索失败 ${query}：${error?.message ?? error}`);
      sendJson({ ok: false, error: `搜索失败：${error?.message ?? error}` }, 500);
    }
    return;
  }
  // 手动看一条（群友发链接时也可以走这里；模型工具 qq_watch_bili 用它）
  if (req.method === 'POST' && url.pathname === '/api/socialV2/bili-watch') {
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    const token = String(body.token ?? '').trim();
    if (!cfg.socialV2?.bili?.enabled) { sendJson({ ok: false, error: 'B 站功能未启用' }, 400); return; }
    if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
    if (token && !agentTokenOk(key, token)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
    if (token && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
    try {
      // 支持 b23.tv 短链：群友分享卡片给的常是短链
      const id = await resolveBiliId(String(body.url ?? body.bvid ?? ''));
      if (!id) { sendJson({ ok: false, error: '识别不出 B 站视频（支持 BV号 / 完整链接 / b23.tv 短链）' }, 400); return; }
      const info = id.bvid ? await fetchVideoInfo(id.bvid) : await fetchVideoInfo({ aid: id.aid });
      const wc = cfg.socialV2?.bili?.watchShared ?? {};
      const depth = {
        seconds: Math.max(1, Number(body.seconds) || Number(wc.seconds) || 10),
        frames: Math.max(1, Number(body.frames) || Number(wc.frames) || 12)
      };
      const w = await watchVideo(info.bvid, {
        ...depth,
        info,
        // 群友发的视频同样需要"听见"：字幕拿不到时走 ASR
        asr: deps.live.asrEngine,
        asrEnabled: !!deps.live.asrEngine,
        asrTimeoutMs: 120000
      });
      if (!w.ok) { sendJson({ ok: false, error: w.error || '观看失败' }, 500); return; }
      rememberBiliInfo(w.info, w.grid);
      // 群友发的链接**不计入**每日"自己刷"额度（那是应要求观看，用户明确区分）
      // 分页拼图：帧多时会被切成多张图，按时间顺序全部返回（模型能一次收多张）
      const sheets = Array.isArray(w.grid.sheets) && w.grid.sheets.length
        ? w.grid.sheets
        : [{ buffer: w.grid.buffer, mimeType: w.grid.mimeType || 'image/png' }];
      sendJson({
        ok: true,
        info: w.info,
        hint: w.hint,
        grid: sheets[0].buffer.toString('base64'),
        mimeType: sheets[0].mimeType || 'image/png',
        images: sheets.map((s) => ({
          data: s.buffer.toString('base64'),
          mimeType: s.mimeType || 'image/png'
        }))
      });
    } catch (error) {
      log(`[B站] 观看失败：${error?.message ?? error}`);
      sendJson({ ok: false, error: `观看失败：${error?.message ?? error}` }, 500);
    }
    return;
  }
  // ── 暂停 / 恢复「自主刷」（控制台按钮）──────────────────────────────
  //
  // 语义：只停"它自己想看视频"这件事，**不影响**群友发链接时的 qq_watch_bili
  //（那条路走 /bili-watch，只检查 b.enabled）。
  //
  // 为什么直接复用 `selfBrowsing.enabled` 而不是新开一个 paused 字段：
  //   这个字段本来就是"自主刷开关"，`scheduleBiliBrowse` / `runBiliBrowse` 都已检查它。
  //   再开一个 paused 会变成两个真相源——配置里写 enabled:false 而 paused:false 时
  //   到底算不算暂停？迟早对不上。
  //
  // 必须落盘：只改内存的话重启就自己恢复刷视频了，用户会以为按钮没生效。
  if (req.method === 'POST' && url.pathname === '/api/socialV2/bili-pause') {
    const body = await readBody();
    const paused = body.paused === true;
    const configFile = path.join(ROOT, 'config.json');
    // fail-fast：配置损坏时绝不回写，否则可能把整个 config 清成只剩 bili 段
    const file = readJsonSafe(configFile, null, true);
    file.socialV2 = file.socialV2 ?? {};
    file.socialV2.bili = file.socialV2.bili ?? {};
    file.socialV2.bili.selfBrowsing = file.socialV2.bili.selfBrowsing ?? {};
    file.socialV2.bili.selfBrowsing.enabled = !paused;
    try {
      atomicWriteJson(configFile, file);
    } catch (error) {
      // 写盘失败不改内存：否则进程内看似生效、重启即丢，症状比报错更迷惑
      log(`[B站] 暂停状态写入失败：${error?.message ?? error}`);
      sendJson({ ok: false, error: `配置写入失败：${error?.message ?? error}` }, 500);
      return;
    }
    // 同步内存（cfg.socialV2 是启动时读进来的副本）
    cfg.socialV2 = cfg.socialV2 ?? {};
    cfg.socialV2.bili = cfg.socialV2.bili ?? {};
    cfg.socialV2.bili.selfBrowsing = cfg.socialV2.bili.selfBrowsing ?? {};
    cfg.socialV2.bili.selfBrowsing.enabled = !paused;

    if (paused) {
      // 清掉已排的定时器：否则"暂停"后它还会按原计划再刷一次
      if (deps.live.biliTimer) { clearTimeout(deps.live.biliTimer); deps.live.biliTimer = null; }
      deps.live.biliScheduledAt = 0;
      deps.live.biliNextDelay = 0;
      log(`[B站] 自主刷已暂停${deps.live.biliBrowsing ? '（当前这一条会看完，之后不再排期）' : ''}`);
    } else {
      log('[B站] 自主刷已恢复');
      scheduleBiliBrowse();
    }
    sendJson({
      ok: true,
      paused,
      // 附带实时状态，前端不必再请求一次
      selfBrowsingEnabled: !paused,
      browsing: deps.live.biliBrowsing
        ? { active: true, phase: biliBrowseState.phase || 'starting' }
        : { active: false }
    });
    return;
  }

  // 「自己刷」状态：剩余额度、上次时间
  // ── 手动触发一次"自己刷"（控制台按钮 / 调试用）──────────────────────
  // 与自动刷的区别只有两点：跳过"距上次太近"的间隔限制、**等结果再回响应**
  // （自动刷是 fire-and-forget，手动点按钮需要知道"到底刷没刷、刷了什么"）。
  //
  // 为什么必须等结果（2026-10-19 踩的坑）：先前这里先 `sendJson({ok:true})` 再把
  // runBiliBrowse 当异步任务跑，两个问题——
  //   ① 用户在控制台只看到"已触发"，实际被间隔限制拦掉，什么都没发生；
  //   ② promise 的 then 里又调 sendJson，导致 "Cannot write headers after they are sent"。
  if (req.method === 'POST' && url.pathname === '/api/socialV2/bili-browse-now') {
    if (!deps.live.biliMem) { sendJson({ ok: false, error: 'B 站功能未启用' }, 400); return; }
    if (deps.live.biliBrowsing) { sendJson({ ok: false, error: '正在刷，等这次结束' }, 409); return; }
    if (deps.live.biliTimer) { clearTimeout(deps.live.biliTimer); deps.live.biliTimer = null; }
    try {
      const r = await runBiliBrowse({ manual: true });
      sendJson(r);
    } catch (e) {
      log(`[B站] 手动刷失败：${e?.message ?? e}`);
      sendJson({ ok: false, error: String(e?.message ?? e) }, 500);
    }
    return;
  }

  // 加好友/入群邀请的待决列表（控制台可见；也方便管理员在外网侧查）
  if (req.method === 'GET' && url.pathname === '/api/socialV2/join-requests') {
    const jr = cfg.socialV2?.joinRequest ?? {};
    sendJson({
      ok: true,
      enabled: jr.enabled !== false,
      autoApprove: jr.autoApprove === true,
      ttlMs: joinQueue.ttlMs,
      ownerConfigured: !!String(cfg.ownerQQ ?? '').trim(),
      pending: joinQueue.list().map((it) => ({
        n: it.n,
        requestType: it.requestType,
        subType: it.subType,
        userId: it.userId,
        nickname: it.nickname || '',
        groupId: it.groupId,
        groupName: it.groupName || '',
        comment: it.comment || '',
        at: it.at,
        remainMs: Math.max(0, joinQueue.ttlMs - (Date.now() - Number(it.at || 0)))
      }))
    });
    return;
  }

  // 控制台试听：合成一句并**以音频返回**（不发群）。
  // 与 /tts-status 分开：这个是 POST + 可能耗时数秒，不该被轮询碰到。
  if (req.method === 'POST' && url.pathname === '/api/socialV2/tts-say') {
    if (!deps.live.ttsEngine || !deps.live.ttsEngine.available()) {
      sendJson({ ok: false, error: '语音合成未启用或不可用（见控制台 17b 卡片）' }, 400);
      return;
    }
    const body = await readBody();
    const text = String(body.text ?? '').trim() || '你好呀，我是达妮娅。';
    try {
      // refId/mood 可选：控制台试听时可以把当前选定的情绪参考也带上
      const r = await deps.live.ttsEngine.speak(text.slice(0, 200), {
        refId: body.refId,
        mood: body.mood,
        params: ttsSpeechParams()
      });
      if (!r.ok) { sendJson({ ok: false, error: r.error }, 500); return; }
      const buf = fs.readFileSync(r.file);
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'content-type': 'audio/wav',
        'content-length': String(buf.length),
        'cache-control': 'no-store',
        // 诊断用：这次实际用了哪条参考（同源 fetch 可直接读，不需要 CORS）
        'x-tts-ref': String(r.refId || ''),
        'x-tts-mood': String(r.refMood || '')
      });
      res.end(buf);
    } catch (error) {
      sendJson({ ok: false, error: `合成失败：${error?.message ?? error}` }, 500);
    }
    return;
  }
  // 控制台「选择文件/文件夹」：在**运行桥接的这台电脑**上弹原生对话框。
  //
  // 为什么不在页面里用 <input type=file>：浏览器出于安全限制不会把选中文件的
  // 绝对路径交给 JS，而 TTS 引擎要的正是本机绝对路径（权重/引擎目录）。
  // 所以由桥接起一个 PowerShell（-STA 才能弹 WinForms 对话框），选完把路径
  // 写到临时文件（UTF-8 无 BOM），Node 再读回——避免中文路径经过管道被按
  // GBK 解码（这个坑在 TTS 试听上已经踩过一次）。
  // 脚本是固定文本，只通过环境变量传模式/标题，不接受任何拼接执行的内容。
  if (req.method === 'POST' && url.pathname === '/api/socialV2/tts/pick-path') {
    const body = await readBody();
    const kind = body.kind === 'dir' ? 'dir' : 'file';
    if (process.platform !== 'win32') {
      sendJson({ ok: false, error: '原生文件选择目前只支持 Windows' }, 400);
      return;
    }
    if (deps.live.pickPathBusy) {
      sendJson({ ok: false, error: '已经有一个选择窗口打开了，请先处理它' }, 429);
      return;
    }
    deps.live.pickPathBusy = true;
    const outFile = path.join(STATE_DIR, `pick-path-${process.pid}-${Date.now()}.txt`);
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      'Add-Type -AssemblyName System.Drawing',
      '$owner = New-Object System.Windows.Forms.Form',
      '$owner.TopMost = $true',
      '$owner.ShowInTaskbar = $false',
      '$owner.FormBorderStyle = "None"',
      '$owner.StartPosition = "CenterScreen"',
      '$owner.Size = New-Object System.Drawing.Size(1,1)',
      '$owner.Opacity = 0',
      '$owner.Show()',
      'try {',
      '  if ($env:QQB_PICK_KIND -eq "dir") {',
      '    $d = New-Object System.Windows.Forms.FolderBrowserDialog',
      '    $d.Description = $env:QQB_PICK_TITLE',
      '    $d.ShowNewFolderButton = $false',
      '    if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {',
      '      [System.IO.File]::WriteAllText($env:QQB_PICK_OUT, $d.SelectedPath, (New-Object System.Text.UTF8Encoding($false)))',
      '    }',
      '  } else {',
      '    $f = New-Object System.Windows.Forms.OpenFileDialog',
      '    $f.Title = $env:QQB_PICK_TITLE',
      '    $f.Filter = "权重文件 (*.ckpt;*.pth;*.pt;*.safetensors)|*.ckpt;*.pth;*.pt;*.safetensors|所有文件 (*.*)|*.*"',
      '    $f.CheckFileExists = $true',
      '    if ($f.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {',
      '      [System.IO.File]::WriteAllText($env:QQB_PICK_OUT, $f.FileName, (New-Object System.Text.UTF8Encoding($false)))',
      '    }',
      '  }',
      '} finally { $owner.Close() }'
    ].join('\r\n');
    try {
      const { execFile } = await import('node:child_process');
      await new Promise((resolve, reject) => {
        execFile('powershell.exe',
          ['-NoProfile', '-STA', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-Command', script],
          {
            timeout: 120000,
            windowsHide: true,
            maxBuffer: 1024 * 1024,
            env: {
              ...process.env,
              QQB_PICK_KIND: kind,
              QQB_PICK_TITLE: kind === 'dir' ? '选择 GPT-SoVITS 引擎目录' : '选择模型权重文件',
              QQB_PICK_OUT: outFile
            }
          },
          (error) => (error ? reject(error) : resolve())
        );
      });
      let picked = '';
      try {
        picked = fs.readFileSync(outFile, 'utf8').replace(/^\uFEFF/, '').trim();
      } catch { /* 用户取消：没有输出文件 */ }
      sendJson({ ok: true, path: picked, cancelled: !picked });
    } catch (error) {
      const msg = error?.killed ? '等待选择超时（120 秒）' : (error?.message ?? String(error));
      log(`[TTS] 原生路径选择失败：${msg}`);
      sendJson({ ok: false, error: `打开文件选择框失败：${msg}` }, 500);
    } finally {
      deps.live.pickPathBusy = false;
      try { fs.unlinkSync(outFile); } catch { /* 没生成就忽略 */ }
    }
    return;
  }

  // ── 缓存盘点与清理（2026-10-22 用户要求）──────────────────────────
  //
  // 「注意清理 C 盘缓存，并且控制台中给出对应功能卡片」。
  // GET 只盘点（算体积）；POST 才真删，且只删 kind='safe' 的项
  // （语音模型/图库/观看记忆一律不动，见 cache-manager.js 顶部说明）。
  if (req.method === 'GET' && url.pathname === '/api/socialV2/cache') {
    try {
      const items = collectCacheItems({
        root: ROOT,
        ttsDir: cfg.socialV2?.tts?.enabled === true ? (cfg.socialV2.tts.dir || DEFAULT_SOVITS_DIR) : '',
        // 收藏目录可被配置覆盖；不传则用 <项目>/collected
        collectedDir: cfg.socialV2?.images?.archiveDir || ''
      });
      sendJson({ ok: true, items, groups: CACHE_GROUPS, summary: summarizeCache(items) });
    } catch (error) {
      sendJson({ ok: false, error: `盘点失败：${error?.message ?? error}` }, 500);
    }
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/socialV2/cache-purge') {
    const body = await readBody();
    try {
      const items = collectCacheItems({
        root: ROOT,
        ttsDir: cfg.socialV2?.tts?.enabled === true ? (cfg.socialV2.tts.dir || DEFAULT_SOVITS_DIR) : '',
        collectedDir: cfg.socialV2?.images?.archiveDir || ''
      });
      const r = purgeCache(items, {
        keys: Array.isArray(body.keys) ? body.keys.map(String) : [],
        dryRun: body.dryRun === true
      });
      const human = humanBytes(r.freedBytes);
      if (!r.dryRun) {
        log(`[缓存] 清理完成：释放 ${human}（${r.removed} 个文件）`);
        appendActivity(`[缓存] 清理释放 ${human}`);
      }
      sendJson({
        ok: true,
        freedBytes: r.freedBytes,
        freedHuman: human,
        removed: r.removed,
        details: r.details,
        dryRun: r.dryRun
      });
    } catch (error) {
      log(`[缓存] 清理失败：${error?.message ?? error}`);
      sendJson({ ok: false, error: `清理失败：${error?.message ?? error}` }, 500);
    }
    return;
  }
  // 语音合成（TTS）状态：给控制台显示"能不能发语音、什么音色、什么概率"。
  // 与 bili-status 分开成独立端点：TTS 是全局能力，不属于 B 站。
  if (req.method === 'GET' && url.pathname === '/api/socialV2/tts-status') {
    const t = cfg.socialV2?.tts ?? {};
    const st = deps.live.ttsEngine ? deps.live.ttsEngine.status() : null;
    const probe = deps.live.ttsEngine ? deps.live.ttsEngine.probe() : null;
    // 请求级韵律参数：控制台回填/保存用（改完即时生效）
    const speech = ttsSpeechParams();
    sendJson({
      ok: true,
      enabled: t.enabled === true,
      // 可插拔的三种可见状态：未启用 / 已启用但不可用 / 可用
      usable: !!(st && st.available && st.enabled),
      state: st ? st.state : (t.enabled === true ? 'unavailable' : 'disabled'),
      voice: st?.voice || t.voiceName || '达妮娅',
      dir: st?.dir || t.dir || DEFAULT_SOVITS_DIR,
      device: st?.device || t.device || 'cuda',
      // 实际加载的权重/版本：引擎就绪时以引擎回报为准。
      // 之前控制台只显示配置项，出现过「显示爱弥斯、实际跑 dania」的误导。
      gptModel: st?.gptModel || (t.gptModel ? path.basename(String(t.gptModel)) : ''),
      sovitsModel: st?.sovitsModel || (t.sovitsModel ? path.basename(String(t.sovitsModel)) : ''),
      modelVersion: st?.version || '',
      loadSec: st?.loadSec ?? null,
      warmed: st?.warmed ?? null,
      // 只有真正不可用时才回显 error；可用时若还带着"未初始化"这类
      // 初始化期的残留文案，会和"可用"状态自相矛盾（实测 UI 上出现过
      // 「可用」+「原因：未初始化」并列）。
      error: (st && st.available && st.state === 'ready') ? null : (st?.error ?? (t.enabled === true ? '未初始化' : null)),
      retryInSec: st?.retryInMs ? Math.round(st.retryInMs / 1000) : 0,
      probability: Math.max(0, Math.min(1, Number(t.probability ?? TTS_DEFAULT_PROBABILITY))),
      maxPerHour: ttsNum(t.maxPerHour, 3, 0, 60),
      maxChars: ttsNum(t.maxChars, 140, 20, 300),
      refText: probe?.refText ? String(probe.refText).slice(0, 80) : '',
      // ── 音色预设（voices.json）──────────────────────────────────
      // 归档里的音色/权重版本/按情绪分好的参考音频。控制台据此渲染下拉；
      // refs 只回 id/mood/label，不回绝对路径。
      voiceId: st?.voiceId || t.voiceId || '',
      weightsId: st?.weightsId || t.weightsId || '',
      weightsLabel: st?.weightsLabel || '',
      refs: st?.refs || [],
      defaultRefId: st?.defaultRefId || '',
      refMode: st?.refMode || t.refMode || 'auto',
      voices: probe?.voices || [],
      manifestPath: probe?.manifestPath || '',
      manifestError: probe?.manifestError || '',
      // 韵律/响度（请求级，保存即生效）
      speech,
      // ── 可编辑参数（2026-10-22 用户要求「设成可变参数并提供修改按钮」）──
      // 分两类，因为生效时机不同：
      //   ① 即时生效：概率/上限/字数——planTtsV2 与端点每次都现读 cfg；
      //   ② 需重启：dir/模型路径/device/线程——它们在启动时传给引擎并进了闭包。
      // 前端据此把第二类标「需重启」，避免用户改完以为没生效。
      editable: {
        probability: Math.max(0, Math.min(1, Number(t.probability ?? TTS_DEFAULT_PROBABILITY))),
        maxPerHour: ttsNum(t.maxPerHour, 3, 0, 60),
        maxChars: ttsNum(t.maxChars, 140, 20, 300),
        dir: String(t.dir || DEFAULT_SOVITS_DIR),
        gptModel: String(t.gptModel || 'GPT_SoVITS/dania-e15.ckpt'),
        sovitsModel: String(t.sovitsModel || 'GPT_SoVITS/dania_e16_s2192.pth'),
        device: String(t.device || 'cuda'),
        cpuThreads: Math.max(1, Number(t.cpuThreads) || 8),
        voiceName: String(t.voiceName || '达妮娅'),
        voiceId: String(t.voiceId || ''),
        weightsId: String(t.weightsId || ''),
        refMode: String(t.refMode || 'auto'),
        // 韵律/响度：请求级参数，保存后下一次合成即生效
        ...speech
      },
      summary: (() => {
        if (t.enabled !== true) return '未启用：只发文字';
        if (!st || !st.available) return `已启用但不可用：${st?.error || (probe ? '探测失败' : '未初始化')}`;
        if (st.state === 'ready') {
          return `可用（${st.voice}）· ${Math.round(Math.max(0, Math.min(1, Number(t.probability ?? TTS_DEFAULT_PROBABILITY))) * 100)}% 概率发语音`
            + ` · 每小时最多 ${ttsNum(t.maxPerHour, 3, 0, 60)} 条`;
        }
        if (st.state === 'failed') return `已启用但启动失败：${st.error}（稍后自动重试）`;
        return '已启用，等待首次加载（约 10~25 秒，不阻塞文字）';
      })()
    });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/socialV2/bili-status') {
    const b = cfg.socialV2?.bili ?? {};
    const sb = b.selfBrowsing ?? {};
    const today = deps.live.biliMem ? deps.live.biliMem.todayUsage() : { seconds: 0, videos: 0 };
    const budget = Math.max(0, Number(sb.dailyBudgetSec) || 0);
    // 控制台要能看到"此刻是不是在刷"以及"刷到哪一步了"。
    // 这些是进程内的瞬时状态，不落盘：重启后自然归零。
    const now = Date.now();
    const browsing = deps.live.biliBrowsing
      ? {
          active: true,
          phase: biliBrowseState.phase || 'starting',
          since: biliBrowseState.startedAt || now,
          video: biliBrowseState.video || null,
          key: biliBrowseState.key || '',
          elapsedSec: Math.round((now - (biliBrowseState.startedAt || now)) / 1000)
        }
      : { active: false };
    sendJson({
      ok: true,
      enabled: b.enabled !== false,
      selfBrowsing: {
        enabled: sb.enabled !== false,
        // 控制台按钮据此显示"已暂停 / 恢复自主刷"
        paused: sb.enabled === false,
        dailyBudgetSec: budget,
        usedSec: today.seconds,
        remainingSec: Math.max(0, budget - today.seconds),
        videosToday: today.videos,
        lastBrowseAt: deps.live.lastBiliBrowseAt || 0,
        // 下次自己刷还有多久：以**本次调度的起点** + 随机间隔计算。
        // 用 lastBiliBrowseAt 会算错——那个是"上次真的看了"的时间，
        // 而调度可能在它之后才设定（比如跳过某一轮后重新排期）。
        nextInSec: deps.live.biliTimer && deps.live.biliScheduledAt
          ? Math.max(0, Math.round((deps.live.biliScheduledAt + (deps.live.biliNextDelay || 0) - now) / 1000))
          : 0,
        // 当前是否在刷（控制台用这个显示"刷视频中…"）
        browsing,
        // 最近一次刷的结果，方便回看"它刚才看了啥"
        lastVideo: deps.live.lastBiliWatch || null,
        // 分区偏好（让控制台能说明"为什么总刷这类"）
        categoryWeights: sb.categoryWeights || null,
        // 主动搜索：开关、上次搜的关键词、凭据状态（**只报状态，不暴露 cookie**）
        search: {
          enabled: sb.search?.enabled !== false,
          lastKeyword: deps.live.lastBiliSearchKeyword || '',
          auth: deps.live.biliAuth.loaded
            ? { loaded: true, hasLogin: !!deps.live.biliAuth.hasSessdata }
            : { loaded: false, reason: deps.live.biliAuth.reason }
        },
        // 声音内容（听觉）：字幕优先、ASR 兜底（2026-10-21 用户要求）
        audio: (() => {
          const asr = deps.live.asrEngine ? deps.live.asrEngine.status() : null;
          const cfgAsr = b.asr ?? {};
          return {
            // 字幕需要登录态；没登录时 B 站返回空数组（且 code 仍是 0），
            // 所以这里明确告诉控制台"字幕能不能用"
            subtitleAvailable: !!deps.live.biliAuth.hasSessdata,
            subtitleReason: deps.live.biliAuth.hasSessdata ? '' : (deps.live.biliAuth.loaded ? '凭据已加载但无登录态' : '未配置 B 站凭据'),
            asrEnabled: cfgAsr.enabled !== false,
            asrConfigured: !!asr,
            asrState: asr?.state ?? 'disabled',
            asrModel: asr?.model ?? '',
            asrModelPath: asr?.modelPath ?? '',
            asrModelKind: asr?.modelKind ?? '',
            asrThreads: asr?.cpuThreads ?? null,
            asrLoadSec: asr?.loadSec ?? null,
            asrError: asr?.error ?? null,
            asrRetryInSec: asr?.retryInMs ? Math.round(asr.retryInMs / 1000) : 0,
            // 一句话结论，控制台直接显示
            summary: asr?.state === 'ready'
              ? (deps.live.biliAuth.hasSessdata
                ? '字幕优先，字幕缺失时用本地语音识别补'
                : '未登录 B 站：全部走本地语音识别')
              : (asr?.state === 'failed'
                ? `语音识别不可用（${asr.error || '未知原因'}）：只有画面`
                : (asr ? '语音识别待加载（首次用时自动加载，约 8 秒）'
                  : '未启用语音识别：只有画面'))
          };
        })()
      },
      share: {
        enabled: b.share?.enabled !== false,
        minInterest: b.share?.minInterest,
        probability: b.share?.probability,
        lastShareAt: deps.live.lastBiliShareAt || 0,
        nextAllowedInSec: deps.live.lastBiliShareAt
          ? Math.max(0, Math.round((deps.live.lastBiliShareAt + (Number(b.share?.minGapMs) || 6 * 3600 * 1000) - now) / 1000))
          : 0,
        // 推荐目的地策略（2026-10-21 用户要求「更多推荐给活跃的群聊」）
        preferActiveGroups: b.share?.preferActiveGroups !== false,
        activeWindowHours: Math.max(1, Number(b.share?.activeWindowHours) || 24),
        minActivityForShare: Math.max(0, Number(b.share?.minActivityForShare) || 0),
        // 各群活跃度：控制台据此显示"推荐会落到哪些群"
        groups: [...socialV2.conversations.entries()]
          .filter(([k]) => k.startsWith('group:'))
          .map(([k, st]) => {
            const hours = Math.max(1, Number(b.share?.activeWindowHours) || 24);
            const activity = groupActivityScore(st, { hours, now });
            return {
              key: k,
              activity,
              // 是否够格作为推荐目的地
              shareEligible: activity >= Math.max(1, Number(b.share?.minActivityForShare) || 1),
              lastActionAt: Number(st.lastActionAt) || 0
            };
          })
          .sort((x, y) => y.activity - x.activity)
      },
      memory: deps.live.biliMem ? deps.live.biliMem.stats() : null,
      taste: deps.live.biliMem ? deps.live.biliMem.taste(5) : null,
      recent: deps.live.biliMem ? deps.live.biliMem.recent(6).map((v) => ({
        bvid: v.bvid, title: v.title, owner: v.owner, category: v.category,
        liked: v.liked, interest: v.interest, tags: v.tags, lastSeenAt: v.lastSeenAt, source: v.source,
        desc: String(v.desc || '').slice(0, 120)
      })) : []
    });
    return;
  }
}
