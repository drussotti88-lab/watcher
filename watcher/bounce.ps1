$dir = 'C:\Users\danru\Pokemon\watcher'
# Stop by flag, the way the supervisor expects, then wait for it to notice.
New-Item -Path (Join-Path $dir 'logs\.stopped') -ItemType File -Force | Out-Null
Start-Sleep -Seconds 12
$p = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -and $_.CommandLine -like "*$dir*" }
foreach ($x in $p) { Stop-Process -Id $x.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2
Remove-Item (Join-Path $dir 'logs\.stopped') -ErrorAction SilentlyContinue
Remove-Item (Join-Path $dir 'logs\.running') -ErrorAction SilentlyContinue
Start-Process -FilePath "$dir\2 - Start watching.bat" -WorkingDirectory $dir
Write-Output "bounced"
