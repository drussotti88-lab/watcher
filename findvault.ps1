$roots = @('C:\Users\danru\Pokemon', 'C:\Users\danru\Desktop', 'C:\Users\danru\Documents', 'C:\Users\danru\Downloads')
foreach ($r in $roots) {
  if (-not (Test-Path $r)) { continue }
  Get-ChildItem $r -Recurse -Depth 5 -Filter 'PlanCards.js' -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -notmatch 'node_modules|\.next' } |
    ForEach-Object { Write-Output ("{0}  {1}" -f $_.LastWriteTime, $_.FullName) }
}
