$ErrorActionPreference = 'Stop'
Set-Location C:\Users\danru\Pokemon\hub
npm run bundle 2>&1 | Select-String 'index.js'
Set-Location ..
git add hub/src/generated/phantom-zip.ts hub/api/index.js
git commit -q -m "Repack: the download is the zip with START HERE.html in it`n`nSession: phantom`n`nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>`nClaude-Session: https://claude.ai/code/session_01M8hLnVi4c5cKKPrBQQQ4xZ"
git push -q origin main 2>$null
git log --oneline -1
git status -sb | Select-Object -First 1
