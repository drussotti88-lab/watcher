@echo off
title PokeTrack
cd /d "%~dp0"

where py >nul 2>nul
if %errorlevel%==0 (
    py -3 run.py
    goto done
)

where python >nul 2>nul
if %errorlevel%==0 (
    python run.py
    goto done
)

echo.
echo   Python is not installed yet.
echo.
echo   1. Go to  https://www.python.org/downloads/
echo   2. Download Python for Windows and run the installer.
echo   3. IMPORTANT: tick "Add python.exe to PATH" on the first screen.
echo   4. Finish the install, then double-click this file again.
echo.
start https://www.python.org/downloads/
pause
goto :eof

:done
echo.
echo PokeTrack has stopped.
pause
