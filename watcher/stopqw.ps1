# Only the queue watcher. Phantom's own node process must survive this.
$p = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -and $_.CommandLine -like '*queue-watch*' }
if ($p) {
  foreach ($x in $p) {
    Write-Output ("stopping queue-watch pid {0}" -f $x.ProcessId)
    Stop-Process -Id $x.ProcessId -Force -ErrorAction SilentlyContinue
  }
} else { Write-Output "queue-watch was not running" }

Write-Output "=== captures so far ==="
$d = 'C:\Users\danru\Pokemon\watcher\logs\queue'
if (Test-Path $d) {
  Get-ChildItem $d -Directory | ForEach-Object {
    $m = Get-Content (Join-Path $_.FullName 'meta.json') -Raw | ConvertFrom-Json
    Write-Output ("{0}  {1}  [{2}]" -f $_.Name, $m.title, $m.reason)
  }
} else { Write-Output "none" }
