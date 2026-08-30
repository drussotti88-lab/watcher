@echo off
REM Undoes "4 - Start automatically". Leaves everything else alone.
cd /d "%~dp0"
set "ENTRY=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Pokemon Watcher.bat"
title Stop starting automatically

if not exist "%ENTRY%" goto none

del "%ENTRY%"
echo.
echo   Removed. The Watcher will not start on its own any more.
echo.
echo   If it is running right now it keeps running - use
echo   "3 - Stop watching" to stop it.
echo.
pause
exit /b 0

:none
echo.
echo   It was not set to start automatically. Nothing to undo.
echo.
pause
exit /b 0
