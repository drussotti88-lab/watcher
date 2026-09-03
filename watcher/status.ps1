$dir = 'C:\Users\danru\Pokemon\watcher'
$log = Join-Path $dir 'logs\console-run.log'
Write-Output "=== tail ==="
Get-Content $log -Tail 16
$f = Get-Item $log
Write-Output ("MTIME {0}" -f $f.LastWriteTime)
Write-Output ("NOW   {0}" -f (Get-Date))
Write-Output "=== flags ==="
$flags = Get-ChildItem (Join-Path $dir 'logs') -Force | Where-Object { $_.Name -like '.*' }
if ($flags) { foreach ($x in $flags) { Write-Output ("FLAG " + $x.Name) } } else { Write-Output "none" }
Write-Output "=== node for this folder ==="
$p = Get-CimInstance Win32_Process -Filter "Name='node.exe'"
$mine = $p | Where-Object { $_.CommandLine -and $_.CommandLine -like "*Pokemon*watcher*" }
if ($mine) { foreach ($x in $mine) { Write-Output ("pid {0} started {1}" -f $x.ProcessId, $x.CreationDate) } }
else { Write-Output "NONE" }
