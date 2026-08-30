@echo off
REM Optional. Adds a startup entry so the Watcher runs when you log in.
cd /d "%~dp0"
set "HERE=%CD%"
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "ENTRY=%STARTUP%\Pokemon Watcher.bat"
title Start the Watcher automatically

echo.
echo   ================================================================
echo    START AUTOMATICALLY WHEN YOU LOG IN
echo   ================================================================
echo.
echo   WHAT THIS DOES
echo     Puts one small file in your own Startup folder. Windows runs
echo     whatever is in there when you log in, so the Watcher starts on
echo     its own instead of you double-clicking file 2 every time.
echo.
echo   WHY YOU MIGHT WANT IT
echo     Your app only updates while the Watcher is running. After a
echo     restart it is off until somebody notices. Restocks often land
echo     at three in the morning.
echo.
echo   WHAT IT DOES NOT DO
echo     - No administrator rights. Nothing installed system-wide.
echo     - Nothing hidden: it is one readable file, and this window
echo       will tell you exactly where it is.
echo     - It runs only when YOU log in, as you, with your permissions.
echo     - It still cannot spend money. There is no checkout in this
echo       program at all.
echo.
echo   TO UNDO
echo     Run "5 - Stop starting automatically", or just delete the file.
echo.
echo   The Watcher opens a Chrome window while it runs. That window is
echo   signed out on purpose and stays open. If you would rather decide
echo   for yourself each day, say no here and keep using file 2.
echo.

set "ANSWER="
set /p "ANSWER=  Type yes to turn it on, or press Enter to cancel: "
if /i not "%ANSWER%"=="yes" goto cancelled

(
  echo @echo off
  echo REM Starts the Pokemon Watcher at login.
  echo REM Created by "4 - Start automatically". Delete this file to undo,
  echo REM or run "5 - Stop starting automatically" in the folder below.
  echo cd /d "%HERE%"
  echo call npm run watch
) > "%ENTRY%"

if not exist "%ENTRY%" goto failed

echo.
echo   Done. It will start when you next log in.
echo.
echo   The file is here, and you can open or delete it any time:
echo   %ENTRY%
echo.
echo   It is not running yet - use "2 - Start watching" if you want it
echo   going now without restarting.
echo.
pause
exit /b 0

:cancelled
echo.
echo   Nothing changed. Keep using "2 - Start watching" when you want it.
echo.
pause
exit /b 0

:failed
echo.
echo   Could not write to your Startup folder:
echo   %STARTUP%
echo   Nothing changed.
echo.
pause
exit /b 1
