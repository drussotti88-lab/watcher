$log = Get-ChildItem 'C:\Users\danru\Pokemon\watcher\logs' -Filter 'activity-*.ndjson' |
  Sort-Object LastWriteTime | Select-Object -Last 1
$lines = Get-Content $log.FullName
Write-Output "== mission 11 lines, last 3 =="
$lines | Where-Object { $_ -match '"missionId":11,' } | Select-Object -Last 3
Write-Output "== tail =="
$lines | Select-Object -Last 3
