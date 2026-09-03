@echo off
REM Something looks wrong? Double-click this.
REM
REM It gathers what a person debugging Phantom would look at - the last of the
REM log, your settings with the token blanked out, which Node and Chrome you
REM have, whether Phantom is running - and sends it to whoever runs the app.
REM
REM It does NOT send your token, anything about your card or your accounts, or
REM any page Phantom captured. Those stay on this computer.
REM
REM You can add a sentence about what you saw. Type it when it asks, or just
REM press Enter.
cd /d "%~dp0"
title Send a report

echo.
set /p NOTE=What went wrong (or press Enter):
echo.

call npm run report -- %NOTE%

echo.
pause
