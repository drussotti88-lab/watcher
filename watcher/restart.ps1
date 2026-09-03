$dir = 'C:\Users\danru\Pokemon\watcher'
Set-Location $dir

Write-Output "=== stopping ==="
& cmd /c "`"$dir\3 - Stop watching.bat`""
Start-Sleep -Seconds 5

# The supervisor is a loop inside the console window, so a stop that leaves a
# node process behind leaves the profile locked and the next start fails.
$stale = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -and $_.CommandLine -like "*$dir*" }
foreach ($p in $stale) {
  Write-Output ("killing leftover node {0}" -f $p.ProcessId)
  Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 2

# A stop writes .stopped, which is exactly what tells the keeper "leave it
# alone". Starting again has to clear it or the watchdog stays stood down.
Remove-Item (Join-Path $dir 'logs\.stopped') -ErrorAction SilentlyContinue
Remove-Item (Join-Path $dir 'logs\.running') -ErrorAction SilentlyContinue

Write-Output "=== starting ==="
Start-Process -FilePath "$dir\2 - Start watching.bat" -WorkingDirectory $dir
Start-Sleep -Seconds 20

Write-Output "=== flags ==="
Get-ChildItem (Join-Path $dir 'logs') -Force -Filter '.*' | ForEach-Object { Write-Output $_.Name }
Write-Output "=== tail ==="
Get-Content (Join-Path $dir 'logs\console-run.log') -Tail 12
