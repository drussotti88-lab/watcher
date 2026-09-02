Unregister-ScheduledTask -TaskName 'keeper' -TaskPath '\Phantom\' -Confirm:$false -ErrorAction SilentlyContinue
Write-Host '   Removed. Phantom itself is untouched.'
