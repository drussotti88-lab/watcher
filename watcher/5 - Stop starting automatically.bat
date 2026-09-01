@echo off
REM Undoes "4 - Start automatically". Leaves everything else alone.
cd /d "%~dp0"
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "ENTRY=%STARTUP%\Phantom.bat"
REM The entry was called "Pokemon Watcher.bat" before the rename. Remove that
REM too, so a machine set up under the old name is not left starting a ghost.
set "LEGACY=%STARTUP%\Pokemon Watcher.bat"
if exist "%LEGACY%" del "%LEGACY%"
title Stop starting automatically

if not exist "%ENTRY%" goto none

del "%ENTRY%"
echo.
echo   Removed. Phantom will not start on its own any more.
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
