$dir = 'C:\Users\danru\Pokemon\watcher'
Remove-Item (Join-Path $dir 'logs\.stopped') -ErrorAction SilentlyContinue
Remove-Item (Join-Path $dir 'logs\.running') -ErrorAction SilentlyContinue
Start-Process -FilePath "$dir\2 - Start watching.bat" -WorkingDirectory $dir
Write-Output "launched"
