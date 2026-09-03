$ErrorActionPreference = 'Stop'
Set-Location C:\Users\danru\Pokemon
git add -A
git commit -q -F commitmsg.txt
git push -q origin main 2>$null
git log --oneline -1
Write-Output "=== repacking the zip at this commit, then rebundling ==="
Set-Location watcher
npm run package 2>&1 | Select-String 'zip|sha|launchers'
Set-Location ..\hub
npm run bundle 2>&1 | Select-String 'index.js'
Set-Location ..
git add hub/src/generated/phantom-zip.ts hub/api/index.js
git commit -q -m "Repack: the zip testers download is this commit`n`nnpm run package writes the embedded zip, npm run bundle carries it. Both`nrebuilt so a tester downloading now gets the update path, the report`nbutton and the per-page rest.`n`nSession: phantom`n`nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>`nClaude-Session: https://claude.ai/code/session_01M8hLnVi4c5cKKPrBQQQ4xZ"
git push -q origin main 2>$null
git log --oneline -2
git status -sb | Select-Object -First 1
