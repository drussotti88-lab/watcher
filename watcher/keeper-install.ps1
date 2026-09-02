# Registers the keeper with Windows Task Scheduler.
#
# Task Scheduler is a SERVICE, which is the whole point: it is outside the
# console window that keeps disappearing and taking the in-window supervisor
# with it. No administrator rights - this is a per-user task that runs as you,
# when you are logged in.
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument (
  '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' +
  (Join-Path $here 'keeper.ps1') + '"')

# At logon, and then every five minutes for as long as the session lasts. The
# repetition is lifted off a one-off trigger because that is the only way the
# scheduler exposes an unbounded interval.
# ── Why there is no logon trigger here ────────────────────────────────────
#
# There was one, and it is what made this fail. Registering a task with an
# AtLogOn trigger returns "Access is denied" without elevation: a logon trigger
# can name any user, so Windows treats creating one as a privileged act.
# Measured on this machine three times - schtasks, root folder, and subfolder -
# and only the version without it registers as an ordinary user.
#
# Nothing is lost. A repeating trigger whose start time is in the past runs at
# the next interval whether or not anybody just logged in, and starting at
# LOGIN is already file 4's job. This one only has to keep checking.
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
             -RepetitionInterval (New-TimeSpan -Minutes 5)

# StartWhenAvailable matters more than it looks: it is what makes the check run
# after a sleep or a resume, which is exactly when the window tends to vanish.
# IgnoreNew means a slow check never stacks up behind itself.
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries `
              -DontStopIfGoingOnBatteries -StartWhenAvailable `
              -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10)

# A SUBFOLDER, not the root. Registering at the root of the task library
# returns "Access is denied" on this machine without elevation - measured
# twice, once with schtasks and once here. A task in its own folder registers
# as an ordinary user, which is the whole point: keeping a watcher alive must
# not require administrator rights.
Register-ScheduledTask -TaskName 'keeper' -TaskPath '\Phantom\' `
  -Action $action -Trigger $trigger -Settings $settings -Force `
  -Description 'Starts Phantom again if it goes quiet and nobody pressed stop.' | Out-Null

Write-Host ''
Write-Host '   Done. Windows will check every 5 minutes.'
Write-Host '   Everything it does is written to logs\keeper.log.'
Write-Host ''
