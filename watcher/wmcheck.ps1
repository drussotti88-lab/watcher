$log = 'C:\Users\danru\Pokemon\watcher\logs\console-run.log'
Write-Output "=== last Walmart lines ==="
$hits = Select-String -Path $log -Pattern 'Walmart' -SimpleMatch
if ($hits) { $hits | Select-Object -Last 10 | ForEach-Object { Write-Output $_.Line } }
else { Write-Output "NONE - Walmart never appears in the run log" }
Write-Output "=== queue / waiting room lines ==="
$q = Select-String -Path $log -Pattern 'QUEUE|waiting room|challenge|blocked'
if ($q) { $q | Select-Object -Last 8 | ForEach-Object { Write-Output $_.Line } } else { Write-Output "NONE" }
Write-Output "=== log size / age ==="
$f = Get-Item $log
Write-Output ("bytes {0}  modified {1}" -f $f.Length, $f.LastWriteTime)
Write-Output ("now {0}" -f (Get-Date))
