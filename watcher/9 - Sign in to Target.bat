@echo off
REM Only needed if your account may BUY. Double-click, and a Chrome window
REM opens on target.com. Sign in to YOUR Target account in that window, with
REM your card already saved on the account. Then close this window (Ctrl+C).
REM
REM Phantom never types a card number and never sees one. It presses the
REM buttons a signed-in person would press, and only for a mission you armed
REM with a price ceiling, under the daily cap in Settings.
REM
REM Target only. Walmart's human check fails in any browser this program
REM opens - for a Walmart drop, use "8 - Hold my place" with your everyday
REM Chrome signed in.
cd /d "%~dp0"
title Sign in to Target

call npm run signin

echo.
pause
