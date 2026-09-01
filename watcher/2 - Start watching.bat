@echo off
REM Double-click to start watching. Leave the window open.
cd /d "%~dp0"
title Phantom - leave this open

echo.
echo   Starting. A Chrome window will open and stay open - that is the point.
echo   It is signed out on purpose and never touches an account with a card.
echo.
echo   Leave BOTH windows alone. To stop properly, use "3 - Stop watching".
echo.

REM ── The supervisor ────────────────────────────────────────────────────────
REM
REM Phantom died twice on 1 Sep 2026 and stayed dead for 35 and 60 minutes,
REM because nothing was watching the watcher. A drop does not wait for somebody
REM to notice a closed window.
REM
REM So: if it exits and nobody asked it to, start it again. "Nobody asked" is
REM the stop file - "3 - Stop watching" writes it, Phantom deletes it on the way
REM out, and this checks for the marker Phantom leaves behind instead. Simplest
REM version that cannot fight the stop button: the stop path exits code 0 and
REM writes logs\.stopped; every other way out is a crash and gets restarted.
REM
REM Output goes to logs\console-run.log so a crash leaves a stack behind rather
REM than scrolling off the top of a minimised window.

:loop
if exist "logs\.stopped" del "logs\.stopped"
call npm run watch >> logs\console-run.log 2>&1
if exist "logs\.stopped" goto done

echo.
echo   Phantom stopped on its own - restarting in 10 seconds.
echo   (Ctrl+C twice to stop it properly.)
echo.
echo   --- supervisor: restarting at %TIME% --- >> logs\console-run.log
timeout /t 10 /nobreak >nul
goto loop

:done
echo.
echo   Phantom has stopped.
echo.
pause
