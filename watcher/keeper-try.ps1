$here = 'C:\Users\danru\Pokemon\watcher'
$a = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $here + '\keeper.ps1"')
$t = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5)
try {
  Register-ScheduledTask -TaskName 'keeper' -TaskPath '\Phantom\' -Action $a -Trigger $t -Force | Out-Null
  Write-Host 'SUBFOLDER OK'
} catch {
  Write-Host ('SUBFOLDER FAILED: ' + $_.Exception.Message)
}
