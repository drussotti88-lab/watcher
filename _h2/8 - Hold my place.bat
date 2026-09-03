@echo off
REM Double-click at about 7:55pm on a Wednesday. Be signed in to Walmart in
REM your NORMAL Chrome first - the one you use every day.
REM
REM This watches the item from a signed-out profile and, the instant the page
REM turns into a queue or the cart button lights up, opens that page in your
REM own browser - once. It does not drive your browser and cannot see it. You
REM take the place in line; it just makes sure you are looking at the right
REM page a second after it changed.
REM
REM Why not the signed-in profile: Walmart's press-and-hold fails in any
REM browser Phantom launches, even with a person holding the button. Yours
REM passes it every day. So yours is the one that goes through the door.
cd /d "%~dp0"
title Hold my place

REM The Pitch Black Booster Bundle - the item that dropped on 2 Sep 2026.
REM Change the number to watch something else.
set ITEM=20243261734
set MINUTES=60

node --experimental-strip-types scripts/hold-my-place.ts %ITEM% %MINUTES%

echo.
pause
