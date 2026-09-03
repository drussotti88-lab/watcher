$log = 'C:\Users\danru\Pokemon\watcher\logs\console-run.log'
$all = Get-Content $log
$idx = $null
for ($i = $all.Count - 1; $i -ge 0; $i--) {
  if ($all[$i] -like '*Watching via*') { $idx = $i; break }
}
if ($idx -ne $null) {
  Write-Output "=== startup block (line $idx onward) ==="
  $end = [Math]::Min($idx + 26, $all.Count - 1)
  $all[($idx - 8)..$end]
} else { Write-Output "no startup banner found" }
Write-Output ("now {0}" -f (Get-Date))
