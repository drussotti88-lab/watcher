@echo off
REM Double-click this once, the first time.
REM
REM It installs what Phantom needs and then asks for the two things your
REM Hub owner gave you. Nothing here touches anything outside this folder.
cd /d "%~dp0"
title Phantom setup

echo.
echo   Installing what Phantom needs. This takes a minute or two.
echo.
call npm install
if errorlevel 1 goto failed

call npm run setup
if errorlevel 1 goto failed

echo.
echo   Done. From now on, use "2 - Start watching".
echo.
pause
exit /b 0

:failed
echo.
echo   That did not finish. The reason is above this line.
echo   If it mentions npm not being recognised, install Node from nodejs.org,
echo   then close this window and try again.
echo.
pause
exit /b 1
