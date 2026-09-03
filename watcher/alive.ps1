$dir = 'C:\Users\danru\Pokemon\watcher'
Write-Output "=== node processes for this folder ==="
$p = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -and $_.CommandLine -like "*$dir*" }
if ($p) { $p | ForEach-Object { Write-Output ("pid {0}  started {1}" -f $_.ProcessId, $_.CreationDate) } }
else { Write-Output "NONE - Phantom is not running" }

Write-Output "=== flag files ==="
Get-ChildItem (Join-Path $dir 'logs') -Force | Where-Object { $_.Name -like '.*' } |
  ForEach-Object { Write-Output $_.Name }

Write-Output "=== last startup line ==="
$s = Select-String -Path (Join-Path $dir 'logs\console-run.log') -Pattern 'watching|startup|Phantom is|starting'
if ($s) { $s | Select-Object -Last 5 | ForEach-Object { Write-Output $_.Line } }

Write-Output "=== tail ==="
Get-Content (Join-Path $dir 'logs\console-run.log') -Tail 8
Write-Output ("now {0}" -f (Get-Date))
