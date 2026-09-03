$dir = 'C:\Users\danru\Pokemon\watcher'
Set-Location $dir
$log = Join-Path $dir 'logs\console-run.log'
$before = (Get-Content $log).Count

# Use the project's own stop, not a hand-made flag file. `npm run stop` is what
# the supervisor is actually listening for; a file I invent is not.
Write-Output "running npm run stop ..."
& cmd /c 'npm run stop' 2>&1 | Select-Object -Last 4

$stopped = $false
for ($i = 0; $i -lt 25; $i++) {
  Start-Sleep -Seconds 2
  $t = Get-Content $log -Tail 8
  if ($t -match 'stop file seen|exited with code') { $stopped = $true; break }
}
Write-Output ("clean stop seen: {0}" -f $stopped)
Start-Sleep -Seconds 3
Write-Output "starting ..."
& cmd /c 'start "" /min cmd /c "2 - Start watching.bat"'
$started = $false
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Seconds 2
  $now = Get-Content $log
  if ($now.Count -gt $before) {
    $new = $now[$before..($now.Count - 1)]
    if ($new -match 'Watching via') { $started = $true; break }
  }
}
Write-Output ("new startup banner seen: {0}" -f $started)
