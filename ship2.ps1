Copy-Item 'C:\Users\danru\Pokemon\_h2\8 - Hold my place.bat' 'C:\Users\danru\Pokemon\watcher\8 - Hold my place.bat' -Force
Set-Location 'C:\Users\danru\Pokemon'
Remove-Item '.git\index.lock','.git\HEAD.lock','.git\objects\maintenance.lock' -ErrorAction SilentlyContinue
git add -A
git commit -F commitmsg.txt
git push origin main
git log --oneline -1
