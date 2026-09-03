@echo off
REM Phantom updates itself every few hours while it is running, so you should
REM not normally need this. Use it when you have been asked to update now.
REM
REM Stop Phantom first with "3 - Stop watching", run this, then start it again
REM with "2 - Start watching".
cd /d "%~dp0"
title Update Phantom

call npm run update

echo.
pause
