# Phantom keeper - the watchdog that is not inside the thing it watches.
#
# WHY THIS EXISTS
#
# "2 - Start watching.bat" already restarts Phantom when it exits, and that
# supervisor works. It has one blind spot, and it is the one that keeps
# happening: the supervisor is a loop INSIDE the console window. When the whole
# window goes - closed by hand, killed on sleep or resume, taken down with a
# session - the supervisor goes with it, and there is nothing left running to
# notice.
#
# Measured 2 Sep 2026: the log stops mid-pass at 5:28:07 PM with no error, no
# exit line and no restart line. Thirty-five minutes later there was no node
# process for Phantom and no cmd process for the supervisor. Nothing had
# crashed. The tree had simply gone.
#
# So this runs from Task Scheduler, which is a Windows service and outside that
# tree entirely. Every few minutes it asks two questions and acts on them:
#
#   1. Was Phantom asked to be off?   -> then leave it off. The stop button
#      means what it says, and a keeper that fights it is worse than none.
#   2. Has it written anything lately? -> if not, it is dead or hung, and
#      either way the cure is the same: kill what is left and start it again.
#
# It never starts a second Phantom on top of a healthy one: fresh output is
# proof of life, and a hung process is killed before the new one starts.

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here

$logDir  = Join-Path $here 'logs'
$console = Join-Path $logDir 'console-run.log'
$stopped = Join-Path $logDir '.stopped'
$keepLog = Join-Path $logDir 'keeper.log'

# How long Phantom may be silent before it counts as gone. It writes a pass
# line roughly every ninety seconds, so six minutes is four missed passes -
# long enough that a slow retailer or a long backoff is never mistaken for
# death, short enough that a drop is not missed by much.
$staleMinutes = 6

if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }

function Note([string]$text) {
  $line = '{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $text
  Add-Content -Path $keepLog -Value $line
}

# 1. Asked to be off? Then off is correct, and this has no opinion about it.
if (Test-Path $stopped) { exit 0 }

# 2. Proof of life. The console log is appended every pass, so its age is the
#    honest measure - more honest than a process existing, because the failure
#    this project actually keeps hitting is a process that is alive and stuck.
$silentFor = $null
if (Test-Path $console) {
  $silentFor = (New-TimeSpan -Start (Get-Item $console).LastWriteTime -End (Get-Date)).TotalMinutes
}

if ($silentFor -ne $null -and $silentFor -lt $staleMinutes) { exit 0 }

$why = if ($silentFor -eq $null) { 'no console log at all' }
       else { 'silent for {0:N0} minutes' -f $silentFor }

# 3. Kill whatever is left of it. A hung Phantom still holds the Chrome profile
#    lock, and a new one would fail to launch with "that profile is already
#    open" - which is how a watchdog turns one dead Phantom into two.
$mine = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine -like "*$here*" }
foreach ($p in $mine) {
  Note ("killing stuck node {0}" -f $p.ProcessId)
  Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
}
# The stale lock file names a process that is gone. Phantom clears this itself
# on a clean exit; a killed one cannot.
$running = Join-Path $logDir '.running'
if (Test-Path $running) { Remove-Item $running -Force -ErrorAction SilentlyContinue }

# 4. Start it, in its own window, the same way a person would.
Note ("restarting - {0}" -f $why)
Start-Process -FilePath (Join-Path $here '2 - Start watching.bat') -WorkingDirectory $here
exit 0
