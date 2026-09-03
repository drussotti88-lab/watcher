$log = 'C:\Users\danru\Pokemon\watcher\logs\console-run.log'
$tail = Get-Content $log -Tail 500
$names = @{}
foreach ($line in $tail) {
  if ($line -match '^\s*(.+?)\s\((Target|Walmart|Pokemon Center)\):\s*(\S+)') {
    $key = $matches[2] + ' | ' + $matches[1]
    $names[$key] = $matches[3]
  }
}
Write-Output ("distinct missions checked in last 500 lines: {0}" -f $names.Count)
foreach ($k in ($names.Keys | Sort-Object)) { Write-Output ("  {0,-9} {1}" -f $names[$k], $k) }
