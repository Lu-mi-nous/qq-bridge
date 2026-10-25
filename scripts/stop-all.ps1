# stop-all.ps1 — 停止 QQ 机器人
#   默认只停桥接（保留 SnowLuma 的 QQ 登录状态，下次启动不用重新扫码）
#   加 -IncludeSnowLuma 才会连 SnowLuma 一起停（下次启动需要手机 QQ 重新扫码登录）
#   加 -IncludeDsh 才会连 DSH 和它的 MCP 子进程一起停（释放内存，下次启动需重新加载 agent preset）
# 两个开关互相独立，可单独用也可同时用；都不加时 DSH 保持运行。
#
# 识别方式（2026-10-23 修：以前只匹配命令行里的绝对路径，
#   `node src/bridge.js` 这种相对路径启动的桥接会漏掉，脚本报「本来就没在运行」）：
#   1) 监听端口（config.json 的 consolePort，默认 3100）——最可靠；
#   2) state\bridge.lock 里记的 PID（桥接自己写的）；
#   3) 命令行绝对路径（兼容正/反斜杠）。
param(
  [switch]$IncludeSnowLuma,
  [switch]$IncludeDsh
)

$BridgeDir     = Split-Path -Parent $PSScriptRoot
$BridgePort    = 3100
$SnowLumaPort  = 5099
$OneBotWsPort  = 3001
$DshPort       = 3080

# 端口可能被改过：以 config.json 为准
try {
  $cfgPath = Join-Path $BridgeDir 'config.json'
  if (Test-Path $cfgPath) {
    $cfg = Get-Content $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($cfg.consolePort) { $BridgePort = [int]$cfg.consolePort }
  }
} catch {}

# 命令行匹配（用正则而非 -like：-like 里 `\` 是字面量，正斜杠路径匹配不到）
$BridgeCmdRe   = '(?i)qq-bridge-main[\\/]+src[\\/]+bridge\.js'
$BridgeRelRe   = '(?i)(^|\s)src[\\/]+bridge\.js(\s|$)'
$SnowLumaCmdRe = '(?i)SnowLuma[\\/]+index\.mjs'
$DshCmdRe      = '(?i)@deepseek-ai[\\/]+dsh[\\/].*bin\.js'
$McpAbsRe      = '(?i)qq-bridge-main[\\/]+src[\\/]+mcp-'
$McpRelRe      = '(?i)(^|\s)src[\\/]+mcp-'

function Write-Ok($t)    { Write-Host "  [已停止] $t" -ForegroundColor Green }
function Write-Fail($t)  { Write-Host "  [失败]   $t" -ForegroundColor Red }
function Write-Info($t)  { Write-Host "  $t" -ForegroundColor Gray }
function Write-Warn2($t) { Write-Host "  [提示]   $t" -ForegroundColor Yellow }

# 取端口监听者的 PID。Get-NetTCPConnection 在某些精简系统/旧系统上没有，退回 netstat。
function Get-PortOwnerPids([int]$Port) {
  $found = @()
  try {
    $conns = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction Stop
    foreach ($c in $conns) { if ($c.OwningProcess) { $found += [int]$c.OwningProcess } }
  } catch {
    try {
      $lines = netstat -ano -p TCP 2>$null | Select-String -Pattern 'LISTENING'
      foreach ($l in $lines) {
        if ($l.Line -match "[:.]$Port\s" -and $l.Line -match '\s(\d+)\s*$') {
          $found += [int]$matches[1]
        }
      }
    } catch {}
  }
  return @($found | Sort-Object -Unique)
}

# 进程是否真的没了（Stop-Process 对受保护/已退出进程可能静默失败）
function Test-Alive([int]$ProcId) {
  return [bool](Get-Process -Id $ProcId -ErrorAction SilentlyContinue)
}

# 相对路径启动时，用进程加载的模块确认它属于本项目（避免误杀别的项目的 src/bridge.js）
function Test-InBridgeDir([int]$ProcId) {
  try {
    $p = Get-Process -Id $ProcId -ErrorAction Stop
    return [bool]($p.Modules | Where-Object { $_.FileName -match '(?i)qq-bridge-main' } | Select-Object -First 1)
  } catch { return $false }
}

function Stop-Pid([int]$ProcId, [string]$Label) {
  if (-not (Test-Alive $ProcId)) { return $false }
  try {
    Stop-Process -Id $ProcId -Force -ErrorAction Stop
    # 给进程一点退出时间；确认真的没了再报成功
    for ($i = 0; $i -lt 20; $i++) {
      if (-not (Test-Alive $ProcId)) { break }
      Start-Sleep -Milliseconds 100
    }
    if (Test-Alive $ProcId) {
      Write-Fail "$Label (PID $ProcId) 仍在运行（可能需要管理员权限）"
      return $false
    }
    Write-Ok "$Label (PID $ProcId)"
    return $true
  } catch {
    if (-not (Test-Alive $ProcId)) { Write-Ok "$Label (PID $ProcId)"; return $true }
    Write-Fail "$Label (PID $ProcId)：$($_.Exception.Message)"
    return $false
  }
}

Write-Host 'QQ 机器人 停止' -ForegroundColor White

$procs = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue)

# ── 先盘点桥接：端口 → 锁文件 → 命令行 ──────────────────────────────────
$bridgePids = @()
foreach ($id in (Get-PortOwnerPids $BridgePort)) {
  if ($id -gt 0) { $bridgePids += $id }
}

$lockFile = Join-Path $BridgeDir 'state\bridge.lock'
if (Test-Path $lockFile) {
  $lockPid = 0
  try {
    $raw = (Get-Content $lockFile -Raw -ErrorAction Stop).Trim()
    if ([int]::TryParse($raw, [ref]$lockPid) -and $lockPid -gt 0 -and (Test-Alive $lockPid)) {
      $bridgePids += $lockPid
    }
  } catch {}
}

foreach ($p in $procs) {
  $cmd = [string]$p.CommandLine
  if ($cmd -match $BridgeCmdRe) {
    $bridgePids += [int]$p.ProcessId
  } elseif ($cmd -match $BridgeRelRe -and (Test-InBridgeDir ([int]$p.ProcessId))) {
    $bridgePids += [int]$p.ProcessId
  }
}
$bridgePids = @($bridgePids | Sort-Object -Unique)

# ── 先收 DSH 的 MCP 子进程（stdio 子进程，父进程没了会变孤儿）─────────────
$stoppedMcp = 0
$dshPids = @()
if ($IncludeDsh) {
  foreach ($id in (Get-PortOwnerPids $DshPort)) { if ($id -gt 0) { $dshPids += $id } }
  foreach ($p in $procs) {
    if ([string]$p.CommandLine -match $DshCmdRe) { $dshPids += [int]$p.ProcessId }
  }
  $dshPids = @($dshPids | Sort-Object -Unique)

  foreach ($p in $procs) {
    $cmd = [string]$p.CommandLine
    $isMcp = ($cmd -match $McpAbsRe) -or (
      $cmd -match $McpRelRe -and (
        $dshPids -contains [int]$p.ParentProcessId -or (Test-InBridgeDir ([int]$p.ProcessId))
      )
    )
    if ($isMcp) {
      if (Stop-Pid ([int]$p.ProcessId) 'MCP 子进程') { $stoppedMcp++ }
    }
  }
}

# ── 停桥接 ──────────────────────────────────────────────────────────────
$stoppedBridge = $false
foreach ($id in $bridgePids) {
  if (Stop-Pid $id '桥接') { $stoppedBridge = $true }
}
if (-not $stoppedBridge) {
  if ($bridgePids.Count -eq 0) {
    Write-Info '桥接本来就没在运行'
  } else {
    Write-Fail '桥接进程存在但没能停掉'
  }
}

# ── 停 DSH ──────────────────────────────────────────────────────────────
$stoppedDsh = $false
if ($IncludeDsh) {
  foreach ($id in $dshPids) {
    if (Stop-Pid $id 'DSH') { $stoppedDsh = $true }
  }
  if (-not $stoppedDsh) { Write-Info 'DSH 本来就没在运行' }
  if ($stoppedMcp -eq 0) { Write-Info 'MCP 子进程本来就没在运行' }
}

# ── 停 SnowLuma ─────────────────────────────────────────────────────────
$stoppedSnowLuma = $false
if ($IncludeSnowLuma) {
  $snowPids = @()
  foreach ($id in (@(Get-PortOwnerPids $SnowLumaPort) + @(Get-PortOwnerPids $OneBotWsPort))) {
    if ($id -gt 0) { $snowPids += $id }
  }
  foreach ($p in $procs) {
    if ([string]$p.CommandLine -match $SnowLumaCmdRe) { $snowPids += [int]$p.ProcessId }
  }
  $snowPids = @($snowPids | Sort-Object -Unique)
  foreach ($id in $snowPids) {
    if (Stop-Pid $id 'SnowLuma') { $stoppedSnowLuma = $true }
  }
  if (-not $stoppedSnowLuma) { Write-Info 'SnowLuma 本来就没在运行' }
}

Start-Sleep -Milliseconds 300

# 清理桥接残留锁，避免下次启动报「已有实例在运行」
# 只有在确认没有桥接进程存活时才清，避免把正在启动的新实例的锁删掉。
$bridgeStillAlive = $false
foreach ($id in $bridgePids) { if (Test-Alive $id) { $bridgeStillAlive = $true } }
if (-not $bridgeStillAlive) {
  Get-ChildItem (Join-Path $BridgeDir 'state') -Filter '*.lock' -ErrorAction SilentlyContinue |
    Remove-Item -Force -ErrorAction SilentlyContinue
}

Write-Host ''
if ($IncludeSnowLuma) {
  if ($stoppedSnowLuma) {
    Write-Warn2 'SnowLuma 已停止：下次启动需要在 WebUI「进程」里重新扫码登录 QQ。'
  } else {
    Write-Info 'SnowLuma 未运行，无需处理。'
  }
} else {
  Write-Info 'SnowLuma 保持运行（QQ 仍在线，只是不再回复消息），下次启动无需重新扫码。'
  Write-Info '如需连 SnowLuma 一起停：用 -IncludeSnowLuma 参数运行本脚本。'
}
if ($IncludeDsh) {
  if ($stoppedDsh) {
    Write-Warn2 'DSH 已停止：下次启动会重新加载 agent preset 与 MCP（约几秒），期间桥接会重试连接。'
  } else {
    Write-Info 'DSH 未运行，无需处理。'
  }
} else {
  Write-Info 'DSH 与其 MCP 子进程未动（QQ 会话的工具服务仍在，重启桥接即可恢复）。'
  Write-Info '如需连 DSH 一起停：用 -IncludeDsh 参数运行本脚本。'
}
Write-Host ''
