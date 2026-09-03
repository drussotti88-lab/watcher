Set-Location 'C:\Users\danru\Pokemon\watcher'
$out = 'C:\Users\danru\Pokemon\watcher\logs\queue-watch.log'
Start-Process -FilePath 'node' `
  -ArgumentList '--experimental-strip-types','scripts/queue-watch.ts','90' `
  -WorkingDirectory 'C:\Users\danru\Pokemon\watcher' `
  -RedirectStandardOutput $out `
  -RedirectStandardError 'C:\Users\danru\Pokemon\watcher\logs\queue-watch.err' `
  -WindowStyle Minimized
Write-Output "launched, logging to $out"
