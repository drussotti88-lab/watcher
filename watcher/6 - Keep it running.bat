@echo off
REM Optional, and the one that fixes the failure that keeps happening.
REM
REM File 2 restarts Phantom when it CRASHES. This handles the case file 2
REM cannot: the whole window going away, taking the supervisor with it.
cd /d "%~dp0"
title Keep Phantom running

echo.
echo   ================================================================
echo    KEEP PHANTOM RUNNING
echo   ================================================================
echo.
echo   WHAT THIS DOES
echo     Asks Windows to look every 5 minutes. If Phantom has not
echo     written anything for 6 minutes and you did not press stop,
echo     it starts it again.
echo.
echo   WHY
echo     File 2 already restarts Phantom if it crashes - but that
echo     supervisor is a loop inside the window. When the window
echo     itself goes, the supervisor goes with it and nothing is left
echo     to notice. That is what has been happening.
echo.
echo   WHAT IT DOES NOT DO
echo     - No administrator rights. It runs as you, when you are
echo       logged in, with your permissions.
echo     - It never fights the stop button: if you pressed stop, it
echo       leaves Phantom off.
echo     - It still cannot spend money.
echo.
pause

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0keeper-install.ps1"
pause
