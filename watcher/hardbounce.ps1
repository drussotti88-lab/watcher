$dir = 'C:\Users\danru\Pokemon\watcher'
$log = Join-Path $dir 'logs\console-run.log'
$before = (Get-Content $log).Count

# 1. Ask nicely. The supervisor watches for this file and shuts down cleanly.
New-Item -Path (Join-Path $dir 'logs\.stopped') -ItemType File -Force | Out-Null

# 2. Wait for it to actually say so, rather than assuming a sleep was enough.
$stopped = $false
for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Seconds 2
  $tail = Get-Content $log -Tail 6
  if ($tail -match 'stop file seen|exited with code') { $stopped = $true; break }
}
Write-Output ("clean stop seen: {0}" -f $stopped)

# 3. Kill anything left. The supervisor is a loop inside a console window, so a
#    half-dead tree leaves the Chrome profile locked and the next start fails.
$killed = 0
foreach ($p in (Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine -like "*$dir*" })) {
  Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
  $killed++
}
foreach ($p in (Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine -like '*Start watching*' })) {
  Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
  $killed++
}
Write-Output ("processes killed: {0}" -f $killed)
Start-Sleep -Seconds 3

# 4. Clear the flags. .stopped is what tells the keeper to leave it alone, so
#    starting again has to remove it or the watchdog stays stood down.
Remove-Item (Join-Path $dir 'logs\.stopped') -ErrorAction SilentlyContinue
Remove-Item (Join-Path $dir 'logs\.running') -ErrorAction SilentlyContinue

# 5. Start, and prove it started by watching for the banner rather than
#    reporting success because a command returned.
Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', "`"$dir\2 - Start watching.bat`"" `
  -WorkingDirectory $dir -WindowStyle Minimized
$started = $false
for ($i = 0; $i -lt 25; $i++) {
  Start-Sleep -Seconds 2
  $now = Get-Content $log
  if ($now.Count -gt $before -and ($now[$before..($now.Count - 1)] -match 'Watching via')) {
    $started = $true; break
  }
}
Write-Output ("new startup banner seen: {0}" -f $started)
Write-Output "=== everything written since the stop ==="
$after = Get-Content $log
if ($after.Count -gt $before) { $after[$before..($after.Count - 1)] | Select-Object -Last 24 }
Write-Output ("now {0}" -f (Get-Date))
