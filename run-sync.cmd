@echo off
REM RunHub MY - daily sync wrapper for Windows Task Scheduler.
REM Task: RunHub-DailySync. Exit code 0 = at least one portal succeeded.
cd /d "%~dp0"
if not exist "logs" mkdir "logs"
node sync.mjs >> "logs\sync.log" 2>&1
exit /b %ERRORLEVEL%
