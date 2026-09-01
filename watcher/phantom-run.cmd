@echo off
REM Launcher with no spaces in its path, so Task Scheduler can hold it.
REM
REM Phantom kept dying silently with its supervisor: no crash line, no exit
REM line, the whole process tree gone at once. Everything was being launched
REM from a remote session, and the tree was dying with it. Task Scheduler owns
REM this instead - its parent is a service, not anybody's terminal.
cd /d "%~dp0"
call "2 - Start watching.bat"
