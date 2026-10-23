# start-all.ps1 — 一键启动 QQ 机器人全套服务并打开两个控制台
#   1) SnowLuma（QQ 接入端，WebUI :5099）
#   2) OneBot（挂在 QQ 账号上，HTTP :3000 / WS :3001）
#   3) DSH（DeepSeek Harness，AI 大脑 :3080）
#   4) qq-bridge 桥接（控制台 :3100）
#   5) 浏览器打开 SnowLuma WebUI 和桥接控制台
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File start-all.ps1
#       加 -WaitQrSeconds 600 可延长等待扫码登录的时间（默认 300 秒）

param(
  [int]$WaitQrSeconds = 300
)

$ErrorActionPreference = 'Continue'

# ── 路径配置（换目录只改这里）─────────────────────────────────────────────
$SnowLumaDir  = if ($env:SNOWLUMA_DIR) { $env:SNOWLUMA_DIR } else { Join-Path $env:USERPROFILE 'SnowLuma' }
$SnowLumaExe  = Join-Path $SnowLumaDir 'node.exe'
$SnowLumaMain = Join-Path $SnowLumaDir 'index.mjs'
$BridgeDir    = Split-Path -Parent $PSScriptRoot
$NodeExe      = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $NodeExe) { $NodeExe = Join-Path $env:ProgramFiles 'nodejs\node.exe' }
# DSH 由全局 npm 安装，用 .cmd 启动器（内部会挑 node）而不是硬编码 bin.js 路径
$DshCmd       = Join-Path $env:APPDATA 'npm\dsh.cmd'
$DshWorkDir   = $env:USERPROFILE

$SnowLumaPort = 5099
$OneBotHttpPort = 3000
$OneBotWsPort   = 3001
$BridgePort     = 3100
$DshPort        = 3080
$ModelPort      = 7863   # 本地模型网关（config.json 里 dsh.provider=local 时用）

function Write-Head($text) {
  Write-Host ''
  Write-Host "==== $text ====" -ForegroundColor Cyan
}
function Write-Ok($text)   { Write-Host "  [OK]   $text" -ForegroundColor Green }
function Write-Warn2($text){ Write-Host "  [警告] $text" -ForegroundColor Yellow }
function Write-Err2($text) { Write-Host "  [失败] $text" -ForegroundColor Red }
function Write-Info($text) { Write-Host "  $text" -ForegroundColor Gray }

function Test-Port([int]$Port, [int]$TimeoutMs = 800) {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $iar = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
    if ($iar.AsyncWaitHandle.WaitOne($TimeoutMs, $false) -and $client.Connected) { return $true }
    return $false
  } catch { return $false } finally { $client.Close() }
}

function Wait-Port([int]$Port, [int]$MaxSeconds, [string]$Label) {
  for ($i = 0; $i -lt $MaxSeconds; $i++) {
    if (Test-Port $Port) { return $true }
    if ($i % 10 -eq 9) { Write-Info "$Label 还在启动…（已等 $($i + 1)s）" }
    Start-Sleep -Seconds 1
  }
  return (Test-Port $Port)
}

function Start-Detached([string]$File, [string]$Arguments, [string]$WorkDir) {
  # 刻意不使用 -RedirectStandardOutput/Error：
  #   1) 一旦重定向，PowerShell 改用「继承句柄」的 CreateProcess，子进程会挂在启动器的
  #      控制台上 —— 关掉启动器窗口就会把服务一起杀掉；
  #   2) 继承来的 stdout 句柄还会让脚本被管道调用时永远不返回。
  # 不重定向时子进程拥有自己的（隐藏）控制台，与启动器彻底脱离，关窗安全。
  # 日志改看：桥接 state\bridge.log（实时滚动）、SnowLuma WebUI 的「运行日志」页。
  Start-Process -FilePath $File -ArgumentList $Arguments -WorkingDirectory $WorkDir `
    -WindowStyle Hidden -PassThru
}

Write-Host 'QQ 机器人 一键启动' -ForegroundColor White
Write-Info "时间：$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"

# ── 1. SnowLuma ───────────────────────────────────────────────────────────
# 只在**需要**时打开 SnowLuma 控制台：它的用途是「登录 QQ 账号 / 看日志」。
# 若 OneBot 已经就绪（说明账号已注入、能收发消息），再弹一个控制台页面纯属打扰，
# 所以那种情况只启动、不开浏览器。判定放在下面 OneBot 段之后统一处理（见 $openSnowLuma）。
Write-Head '1/4 SnowLuma（QQ 接入端）'
if (Test-Port $SnowLumaPort) {
  Write-Ok "已在运行（:$SnowLumaPort）"
} else {
  if (-not (Test-Path $SnowLumaExe))  { Write-Err2 "找不到 $SnowLumaExe"; Read-Host '按回车退出'; exit 1 }
  if (-not (Test-Path $SnowLumaMain)) { Write-Err2 "找不到 $SnowLumaMain"; Read-Host '按回车退出'; exit 1 }
  Write-Info '正在启动 SnowLuma…'
  Start-Detached $SnowLumaExe "`"$SnowLumaMain`"" $SnowLumaDir | Out-Null
  if (Wait-Port $SnowLumaPort 45 'SnowLuma') { Write-Ok "启动成功（:$SnowLumaPort）" }
  else { Write-Err2 '启动超时，请在 SnowLuma WebUI 的「运行日志」页查看原因' }
}

# ── 2. OneBot（需要 QQ 已登录）────────────────────────────────────────────
Write-Head '2/4 OneBot（QQ 账号）'
# 是否要弹 SnowLuma 控制台：默认不弹；**仅当 OneBot 没就绪**（没检测到已加载账号）才弹，
# 因为那时需要人工去页面里扫码登录。
$openSnowLuma = $false
if (Test-Port $OneBotWsPort) {
  Write-Ok "OneBot 已就绪（HTTP :$OneBotHttpPort / WS :$OneBotWsPort）"
  Write-Info '账号已注入，跳过打开 SnowLuma 控制台（需要时手动访问 :5099）'
} else {
  $openSnowLuma = $true
  Write-Warn2 'OneBot 未就绪 —— 通常是因为 QQ 账号还没登录。'
  # **必须在此刻就打开页面**，不能等到第 5 段：
  # 下面要等最多 $WaitQrSeconds 秒扫码，而超时会 `exit 1` 直接结束脚本——
  # 那时第 5 段根本执行不到，页面就永远不会弹出来（用户只能干等）。
  Start-Process "http://127.0.0.1:$SnowLumaPort"
  Write-Info "已打开 SnowLuma 页面（:$SnowLumaPort）：左侧「进程」→ 登录 QQ 账号（需要手机 QQ 扫码）"
  Write-Info "本窗口会等最多 $WaitQrSeconds 秒，登录成功后自动继续…"
  $ok = Wait-Port $OneBotWsPort $WaitQrSeconds 'OneBot'
  if ($ok) { Write-Ok "OneBot 已就绪（HTTP :$OneBotHttpPort / WS :$OneBotWsPort）" }
  else {
    Write-Err2 "等待超时：QQ 仍未登录，桥接无法启动。"
    Write-Info "登录页已打开（:$SnowLumaPort），扫码完成后重新运行本脚本即可（SnowLuma 会保持运行）。"
    Write-Host ''
    Read-Host '按回车退出'
    exit 1
  }
}

# ── 3. DSH（AI 大脑）────────────────────────────────────────────────────────
# 桥接只是转发的「手脚」，真正跑 agent 循环、挂载 QQ MCP 工具的是 DSH；
# 它没起来时桥接会每 3 秒重试并提示「系统服务重启中，消息已排队」。
# 必须排在桥接之前：桥接启动后就会去连 :3080，先起 DSH 可少一轮重试。
Write-Head '3/5 DSH（DeepSeek Harness）'
if (Test-Port $DshPort) {
  Write-Ok "已在运行（:$DshPort）"
} else {
  if (-not (Test-Path $DshCmd)) {
    Write-Err2 "找不到 DSH 启动器：$DshCmd"
    Write-Info '请先安装：npm i -g @deepseek-ai/dsh'
    Write-Warn2 '跳过了 DSH —— 桥接会一直重试连接，QQ 消息只入队不处理。'
    Write-Info '装好后重新运行本脚本，或单独执行：dsh web --no-open'
  } else {
    Write-Info '正在启动 DSH…'
    # dsh.cmd 是批处理：交给 cmd 执行才能正确解析，隐藏窗口避免闪黑框。
    Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', "`"$DshCmd`"", 'web', '--no-open' `
      -WorkingDirectory $DshWorkDir -WindowStyle Hidden | Out-Null
    if (Wait-Port $DshPort 60 'DSH') {
      Write-Ok "启动成功（:$DshPort）"
      # 端口就绪后再确认 HTTP 层可用：DSH 起 MCP 子进程还要几秒，
      # 这里只探一次首页，失败不致命（桥接自身有 5 秒探活兜底）。
      try {
        $resp = Invoke-WebRequest -Uri "http://127.0.0.1:$DshPort/" -UseBasicParsing -TimeoutSec 8
        if ($resp.StatusCode -eq 200) { Write-Ok 'HTTP 探活通过' }
      } catch {
        Write-Warn2 "HTTP 探活未通过（$($_.Exception.Message)），桥接会自动重试"
      }
    } else {
      Write-Err2 '启动超时：DSH 未能监听，桥接将无法处理 QQ 消息。'
      Write-Info '可手动排查：新开窗口执行  dsh web --no-open  看报错输出'
    }
  }
}

# DSH 的 provider 配置会被它自己改名成 settings.yaml.imported（2026-10-01、10-08 各一次），
# 而 DSH 不加载 .imported → 每轮投递报 no adapter serves provider "vgw"，QQ 侧表现为不理人。
# 这里在起桥接前自检并自愈：配置没问题时只打印一行，不会改动任何东西。
# 注意要放在整个 DSH 分支之外——DSH 已经在跑但配置是坏的，同样需要修。
if (Test-Port $DshPort) {
  $ensureScript = Join-Path $BridgeDir 'scripts\ensure-dsh-provider.mjs'
  if (Test-Path $ensureScript) {
    & $NodeExe $ensureScript 2>&1 | ForEach-Object { Write-Info $_ }
  }
}

# ── 4. 桥接 ───────────────────────────────────────────────────────────────
Write-Head '4/5 qq-bridge 桥接'
if (Test-Port $BridgePort) {
  Write-Ok "已在运行（:$BridgePort）"
} else {
  if (-not (Test-Path (Join-Path $BridgeDir 'src\bridge.js'))) { Write-Err2 "找不到 $BridgeDir\src\bridge.js"; Read-Host '按回车退出'; exit 1 }
  # 清理上次异常退出的残留锁
  Get-ChildItem (Join-Path $BridgeDir 'state') -Filter '*.lock' -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
  Write-Info '正在启动桥接…'
  Start-Detached $NodeExe "`"$(Join-Path $BridgeDir 'src\bridge.js')`"" $BridgeDir | Out-Null
  if (Wait-Port $BridgePort 45 '桥接') {
    Write-Ok "启动成功（:$BridgePort）"
    Start-Sleep -Seconds 3
    $log = Get-Content (Join-Path $BridgeDir 'state\bridge.log') -Encoding UTF8 -Tail 8 -ErrorAction SilentlyContinue
    if ($log) { Write-Info '桥接日志：'; $log | ForEach-Object { Write-Info "    $_" } }
  } else {
    Write-Err2 '启动超时，最近日志：'
    Get-Content (Join-Path $BridgeDir 'state\bridge.log') -Encoding UTF8 -Tail 8 -ErrorAction SilentlyContinue | ForEach-Object { Write-Info "    $_" }
  }
}

# ── 5. 打开控制台 ─────────────────────────────────────────────────────────
Write-Head '5/5 打开控制台'
# SnowLuma 控制台只在「没检测到已加载账号」时需要（人工扫码），而且那一步已经在
# 第 2 段就提前打开了（见那里的注释：超时会 exit，等不到这一行）。
# 所以这里只**报告状态**，不再重复开一次页面——避免多弹一个重复标签页。
if ($openSnowLuma) {
  Write-Ok "SnowLuma WebUI  -> http://127.0.0.1:$SnowLumaPort（已在前一步打开）"
} else {
  Write-Info "SnowLuma WebUI  -> http://127.0.0.1:$SnowLumaPort（未打开：账号已注入，需要时手动访问）"
}

# 桥接控制台：鉴权可关闭（config.consoleAuth=false），那就直接开干净 URL，不带 token 参数。
$needToken = $true
try {
  $cfg0 = Get-Content (Join-Path $BridgeDir 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($cfg0.consoleAuth -eq $false) { $needToken = $false }
} catch {}
$token = ''
$tokenFile = Join-Path $BridgeDir 'state\console-token'
if (Test-Path $tokenFile) { $token = (Get-Content $tokenFile -Raw).Trim() }
if (-not $needToken) {
  Start-Process "http://127.0.0.1:$BridgePort"
  Write-Ok "桥接控制台      -> http://127.0.0.1:$BridgePort  （已关闭令牌鉴权，无需登录）"
} elseif ($token) {
  Start-Process "http://127.0.0.1:$BridgePort/?token=$token"
  Write-Ok "桥接控制台      -> http://127.0.0.1:$BridgePort  （已带令牌自动登录）"
  Write-Info "控制台令牌：$token"
} else {
  Start-Process "http://127.0.0.1:$BridgePort"
  Write-Warn2 "未读到 state\console-token，控制台需要手动输入令牌"
}

# ── 状态汇总 ──────────────────────────────────────────────────────────────
Write-Head '运行状态'
$rows = @(
  @{ Name = "SnowLuma (:5099)";   Port = $SnowLumaPort },
  @{ Name = "OneBot HTTP (:3000)"; Port = $OneBotHttpPort },
  @{ Name = "OneBot WS (:3001)";   Port = $OneBotWsPort },
  @{ Name = "桥接 (:3100)";        Port = $BridgePort },
  @{ Name = "DSH (:3080)";         Port = $DshPort }
)
foreach ($r in $rows) {
  if (Test-Port $r.Port) { Write-Ok "$($r.Name) 运行中" } else { Write-Warn2 "$($r.Name) 未运行" }
}
if (-not (Test-Port $DshPort)) { Write-Warn2 'DSH 未运行：桥接连不上 AI，QQ 消息只入队不处理（可重跑本脚本或执行 dsh web --no-open）' }
if (-not (Test-Port $ModelPort)) { Write-Warn2 "本地模型网关 (:$ModelPort) 未运行：QQ 会话会调用失败（config.json 用的是 local provider）" }

# 当前模型 / 模式 / 角色
try {
  $cfg = Get-Content (Join-Path $BridgeDir 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  Write-Info "模型：$($cfg.dsh.provider) / $($cfg.dsh.model)"
} catch { Write-Warn2 '读取 config.json 失败' }
$modeFile = Join-Path $BridgeDir 'state\mode.json'
if (Test-Path $modeFile) {
  try { $m = Get-Content $modeFile -Raw -Encoding UTF8 | ConvertFrom-Json; Write-Info "模式：$($m.mode)" } catch {}
}
$roleFile = Join-Path $BridgeDir 'state\current-role.json'
if (Test-Path $roleFile) {
  try { $r2 = Get-Content $roleFile -Raw -Encoding UTF8 | ConvertFrom-Json; Write-Info "角色：$($r2.role)" } catch {}
}

Write-Host ''
Write-Host '全部就绪。服务已与窗口脱离，可以放心关掉这个窗口。' -ForegroundColor Green
Write-Host '停止服务：双击桌面「停止QQ机器人.bat」' -ForegroundColor Gray
Write-Host '桥接日志：state\bridge.log    SnowLuma 日志：WebUI 的「运行日志」页' -ForegroundColor DarkGray
