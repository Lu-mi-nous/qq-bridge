# 重启 DSH 及其 MCP 子进程（让工具层加载新的 normalizeMessagesInput）
$ErrorActionPreference = 'Continue'

Write-Host '--- 备份 settings.yaml ---'
$s = Join-Path $env:USERPROFILE '.dsh\settings.yaml'
if (Test-Path $s) {
  $bak = "$s.bak-before-dsh-restart-" + (Get-Date -Format 'HHmmss')
  Copy-Item $s $bak -Force
  Write-Host ("  backed up -> " + (Split-Path $bak -Leaf))
} else {
  Write-Host '  WARN: settings.yaml 不存在'
}

Write-Host '--- 停止 DSH + MCP 子进程 ---'
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
  $_.CommandLine -match 'dsh' -or $_.CommandLine -match 'mcp-snowluma-safe' -or
  $_.CommandLine -match 'mcp-host-server' -or $_.CommandLine -match 'mcp-web-search-safe'
} | ForEach-Object {
  Write-Host ("  kill " + $_.ProcessId)
  Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 4

Write-Host '--- 启动 DSH ---'
$cmd = Join-Path $env:APPDATA 'npm\dsh.cmd'
if (-not (Test-Path $cmd)) { Write-Host "  ERROR: $cmd 不存在"; exit 1 }
Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', "`"$cmd`"", 'web', '--no-open' `
  -WorkingDirectory $env:USERPROFILE -WindowStyle Hidden

$up = $false
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Seconds 2
  $c = New-Object System.Net.Sockets.TcpClient
  try { $c.Connect('127.0.0.1', 3080); $c.Close(); $up = $true; Write-Host ("  :3080 已监听（等了 " + ($i*2) + "s）"); break } catch { $c.Close() }
}
if (-not $up) { Write-Host '  ERROR: :3080 未监听' ; exit 1 }

Write-Host '--- 等待 MCP 子进程 ---'
Start-Sleep -Seconds 14
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
  $_.CommandLine -match 'dsh' -or $_.CommandLine -match 'mcp-snowluma-safe' -or
  $_.CommandLine -match 'mcp-host-server' -or $_.CommandLine -match 'mcp-web-search-safe'
} | ForEach-Object {
  Write-Host ("  pid " + $_.ProcessId + " | " + $_.CreationDate)
}
