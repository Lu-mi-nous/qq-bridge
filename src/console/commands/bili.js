// R4.7-3：B站 / TTS 试听 / 缓存清理命令。
//
// B站记录/搜索/观看、暂停与手动刷、TTS 试听与原生选路径、缓存清理都在这里；
// 读端点（记忆/状态/入群请求/缓存盘点）在 read-model/bili.js。
// 配置写盘失败不改内存、暂停必须清定时器等约定集中维护。

export function createBiliCommands({
  config = {},
  operations = {},
  sessions = {},
  media = {},
  social = {},
  cache = {}
} = {}) {
  const {
    cfg = {},
    ROOT,
    STATE_DIR,
    DEFAULT_SOVITS_DIR,
    fs,
    path,
    log,
    ttsSpeechParams,
    readJsonSafe,
    atomicWriteJson
  } = config;
  const { live = {}, appendActivity } = operations;
  const { biliInfoCache, socialV2, biliBrowseState } = sessions;
  const {
    searchVideos,
    fetchVideoInfo,
    resolveBiliId,
    watchVideo,
    rememberBiliInfo
  } = media;
  const { scheduleBiliBrowse, runBiliBrowse } = social;
  const { collectCacheItems, purgeCache, humanBytes } = cache;
  const logLine = (message) => { try { log?.(message); } catch { /* 日志失败不影响主流程 */ } };

  // ── 观看记录与记忆 ──────────────────────────────────────────────────
  function record(body = {}) {
    if (!live.biliMem) return { ok: false, status: 400, error: 'B 站功能未启用' };
    // bvid 解析：**优先用"最近看完的那条"**，而不是信模型传的值。
    // 模型记不住 10 位随机 bvid，会瞎编一个；标识由桥接给，模型只负责喜不喜欢。
    let bvid = String(body.bvid ?? '').trim();
    const recent = live.lastBiliWatch?.ok ? String(live.lastBiliWatch.bvid || '').trim() : '';
    if (recent && bvid !== recent) {
      logLine(`[B站] 模型传的 bvid=${bvid || '(空)'} 与刚看完的 ${recent} 不符，改用后者`);
      bvid = recent;
    }
    if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) {
      return { ok: false, status: 400, error: '没有可记录的 bvid（最近没有看完的视频）' };
    }
    // 用缓存补全元信息（简介、标题等模型看不到的字段）
    const cached = biliInfoCache?.get(bvid);
    if (cached) {
      body.desc = body.desc || cached.desc;
      body.title = body.title || cached.title;
      body.owner = body.owner || cached.owner;
      body.category = body.category || cached.category;
      body.durationSec = body.durationSec || cached.durationSec;
      body.biliTags = cached.biliTags || undefined;
    } else {
      logLine(`[B站] 记录 ${bvid}: 元信息缓存未命中（可能重启过），标题/简介可能缺失`);
    }
    const rec = live.biliMem.record({
      bvid,
      title: body.title,
      owner: body.owner,
      category: body.category,
      durationSec: body.durationSec,
      desc: body.desc,
      biliTags: Array.isArray(body.biliTags) ? body.biliTags : undefined,
      subtitle: body.subtitle || undefined,
      tags: Array.isArray(body.tags) ? body.tags : undefined,
      liked: body.liked === true ? true : (body.liked === false ? false : null),
      interest: body.interest,
      watchedFrames: body.watchedFrames,
      watchedSeconds: body.watchedSeconds,
      source: body.source,
      notes: body.notes
    });
    logLine(`[B站] 记录 ${bvid} liked=${rec?.liked} interest=${rec?.interest} tags=${(rec?.tags || []).join('/')}`);
    return { ok: true, video: rec, taste: live.biliMem.taste(5), stats: live.biliMem.stats() };
  }

  // ── 现场搜索 ────────────────────────────────────────────────────────
  async function search(body = {}) {
    if (!cfg.socialV2?.bili?.enabled) return { ok: false, status: 400, error: 'B 站功能未启用' };
    const query = String(body.query ?? '').trim().slice(0, 60);
    if (!query) return { ok: false, status: 400, error: 'query 不能为空' };
    try {
      const count = Math.min(20, Math.max(1, Number(body.count) || 8));
      const order = ['totalrank', 'pubdate', 'click'].includes(body.order) ? body.order : 'totalrank';
      const videos = await searchVideos(query, live.biliAuth, { count, order });
      // 过滤掉已经看过/记录过的（推荐"新的"才有意义）
      const fresh = videos.filter((v) => !live.biliMem?.get(v.bvid));
      return {
        ok: true,
        query,
        engineNote: live.biliAuth.loaded && live.biliAuth.hasSessdata ? '登录态搜索' : '匿名搜索',
        videos: fresh.length ? fresh : videos,
        // 若过滤后为空说明全都看过，明确告知（模型据此换关键词）
        allSeen: fresh.length === 0 && videos.length > 0
      };
    } catch (error) {
      logLine(`[B站] 搜索失败 ${query}：${error?.message ?? error}`);
      return { ok: false, status: 500, error: `搜索失败：${error?.message ?? error}` };
    }
  }

  // ── 手动看一条 ──────────────────────────────────────────────────────
  async function watch(body = {}) {
    if (!cfg.socialV2?.bili?.enabled) return { ok: false, status: 400, error: 'B 站功能未启用' };
    try {
      // 支持 b23.tv 短链：群友分享卡片给的常是短链
      const id = await resolveBiliId(String(body.url ?? body.bvid ?? ''));
      if (!id) return { ok: false, status: 400, error: '识别不出 B 站视频（支持 BV号 / 完整链接 / b23.tv 短链）' };
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
        asr: live.asrEngine,
        asrEnabled: !!live.asrEngine,
        asrTimeoutMs: 120000
      });
      if (!w.ok) return { ok: false, status: 500, error: w.error || '观看失败' };
      rememberBiliInfo(w.info, w.grid);
      // 群友发的链接**不计入**每日"自己刷"额度（那是应要求观看，用户明确区分）
      // 分页拼图：帧多时会被切成多张图，按时间顺序全部返回（模型能一次收多张）
      const sheets = Array.isArray(w.grid.sheets) && w.grid.sheets.length
        ? w.grid.sheets
        : [{ buffer: w.grid.buffer, mimeType: w.grid.mimeType || 'image/png' }];
      return {
        ok: true,
        info: w.info,
        hint: w.hint,
        grid: sheets[0].buffer.toString('base64'),
        mimeType: sheets[0].mimeType || 'image/png',
        images: sheets.map((s) => ({
          data: s.buffer.toString('base64'),
          mimeType: s.mimeType || 'image/png'
        }))
      };
    } catch (error) {
      logLine(`[B站] 观看失败：${error?.message ?? error}`);
      return { ok: false, status: 500, error: `观看失败：${error?.message ?? error}` };
    }
  }

  // ── 暂停 / 恢复「自主刷」────────────────────────────────────────────
  // 语义：只停"它自己想看视频"，**不影响**群友发链接时的 qq_watch_bili。
  // 复用 selfBrowsing.enabled（不新开 paused，避免两个真相源）。
  function setPaused(paused) {
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
      logLine(`[B站] 暂停状态写入失败：${error?.message ?? error}`);
      return { ok: false, status: 500, error: `配置写入失败：${error?.message ?? error}` };
    }
    // 同步内存（cfg.socialV2 是启动时读进来的副本）
    cfg.socialV2 = cfg.socialV2 ?? {};
    cfg.socialV2.bili = cfg.socialV2.bili ?? {};
    cfg.socialV2.bili.selfBrowsing = cfg.socialV2.bili.selfBrowsing ?? {};
    cfg.socialV2.bili.selfBrowsing.enabled = !paused;

    if (paused) {
      // 清掉已排的定时器：否则"暂停"后它还会按原计划再刷一次
      if (live.biliTimer) { clearTimeout(live.biliTimer); live.biliTimer = null; }
      live.biliScheduledAt = 0;
      live.biliNextDelay = 0;
      logLine(`[B站] 自主刷已暂停${live.biliBrowsing ? '（当前这一条会看完，之后不再排期）' : ''}`);
    } else {
      logLine('[B站] 自主刷已恢复');
      scheduleBiliBrowse?.();
    }
    return {
      ok: true,
      paused,
      // 附带实时状态，前端不必再请求一次
      selfBrowsingEnabled: !paused,
      browsing: live.biliBrowsing
        ? { active: true, phase: biliBrowseState?.phase || 'starting' }
        : { active: false }
    };
  }

  // ── 手动触发一次「自己刷」──────────────────────────────────────────
  async function browseNow() {
    if (!live.biliMem) return { ok: false, status: 400, error: 'B 站功能未启用' };
    if (live.biliBrowsing) return { ok: false, status: 409, error: '正在刷，等这次结束' };
    if (live.biliTimer) { clearTimeout(live.biliTimer); live.biliTimer = null; }
    try {
      return await runBiliBrowse({ manual: true });
    } catch (e) {
      logLine(`[B站] 手动刷失败：${e?.message ?? e}`);
      return { ok: false, status: 500, error: String(e?.message ?? e) };
    }
  }

  // ── 控制台试听 ──────────────────────────────────────────────────────
  async function ttsSay(body = {}) {
    if (!live.ttsEngine || !live.ttsEngine.available()) {
      return { ok: false, status: 400, error: '语音合成未启用或不可用（见控制台 17b 卡片）' };
    }
    const text = String(body.text ?? '').trim() || '你好呀，我是达妮娅。';
    try {
      // refId/mood 可选：控制台试听时可以把当前选定的情绪参考也带上
      const r = await live.ttsEngine.speak(text.slice(0, 200), {
        refId: body.refId,
        mood: body.mood,
        params: ttsSpeechParams?.()
      });
      if (!r.ok) return { ok: false, status: 500, error: r.error };
      return { ok: true, buffer: fs.readFileSync(r.file), refId: r.refId || '', refMood: r.refMood || '' };
    } catch (error) {
      return { ok: false, status: 500, error: `合成失败：${error?.message ?? error}` };
    }
  }

  // ── 原生选择文件/文件夹 ─────────────────────────────────────────────
  async function pickPath(body = {}) {
    const kind = body.kind === 'dir' ? 'dir' : 'file';
    if (process.platform !== 'win32') return { ok: false, status: 400, error: '原生文件选择目前只支持 Windows' };
    if (live.pickPathBusy) return { ok: false, status: 429, error: '已经有一个选择窗口打开了，请先处理它' };
    live.pickPathBusy = true;
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
      return { ok: true, path: picked, cancelled: !picked };
    } catch (error) {
      const msg = error?.killed ? '等待选择超时（120 秒）' : (error?.message ?? String(error));
      logLine(`[TTS] 原生路径选择失败：${msg}`);
      return { ok: false, status: 500, error: `打开文件选择框失败：${msg}` };
    } finally {
      live.pickPathBusy = false;
      try { fs.unlinkSync(outFile); } catch { /* 没生成就忽略 */ }
    }
  }

  // ── 缓存清理 ────────────────────────────────────────────────────────
  function purge(body = {}) {
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
        logLine(`[缓存] 清理完成：释放 ${human}（${r.removed} 个文件）`);
        appendActivity?.(`[缓存] 清理释放 ${human}`);
      }
      return {
        ok: true,
        freedBytes: r.freedBytes,
        freedHuman: human,
        removed: r.removed,
        details: r.details,
        dryRun: r.dryRun
      };
    } catch (error) {
      logLine(`[缓存] 清理失败：${error?.message ?? error}`);
      return { ok: false, status: 500, error: `清理失败：${error?.message ?? error}` };
    }
  }

  return { record, search, watch, setPaused, browseNow, ttsSay, pickPath, purge };
}
