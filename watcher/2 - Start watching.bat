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
call npm run watch

echo.
echo   Phantom has stopped.
echo.
pause
