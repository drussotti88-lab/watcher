@echo off
REM Double-click to stop the Watcher cleanly.
REM
REM Closing the other window instead kills it mid-pass: the last of its log is
REM lost and Chrome comes back next time complaining it did not shut down
REM correctly.
cd /d "%~dp0"
title Stopping the Watcher

call npm run stop

echo.
echo   It finishes the check it is on, closes Chrome and sends what it has -
echo   usually within a minute. The other window will close itself.
echo.
pause
