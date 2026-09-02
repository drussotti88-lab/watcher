@echo off
REM Removes the scheduled check added by file 6. Phantom itself is untouched.
cd /d "%~dp0"
title Stop keeping Phantom running
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0keeper-remove.ps1"
echo.
pause
