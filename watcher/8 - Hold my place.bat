@echo off
REM Double-click at about 7:55pm on a Wednesday.
REM
REM Opens the BUY profile (the signed-in one) on the item below, joins Walmart's
REM line if there is one, and then waits without refreshing. Refreshing is the
REM one reliable way to throw away a place you already hold.
REM
REM It will not sign you in, will not answer a bot check, and will not click a
REM control nobody has verified. When it hands back, it hands back a Chrome
REM window you can finish in - the place in line survives that.
cd /d "%~dp0"
title Holding my place

REM The Pitch Black Booster Bundle - the item that dropped on 2 Sep 2026.
REM Change the number to hold a place for something else.
set ITEM=20243261734
set MINUTES=60

node --experimental-strip-types scripts/hold-my-place.ts %ITEM% %MINUTES%

echo.
pause
