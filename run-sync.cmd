@echo off
REM RunHub MY - daily sync wrapper for Windows Task Scheduler.
REM Task: RunHub-DailySync. Exit code 0 = at least one portal succeeded.
REM
REM The run is silent: status and per-portal errors are written to Postgres
REM (sync_runs / sync_portal_runs). Check them with:
REM   curl http://127.0.0.1:3300/api/sync/runs?limit=5
REM Only stdout/stderr from a crash is kept, because that never reaches the DB.
cd /d "%~dp0"
if not exist "logs" mkdir "logs"
node sync.mjs --quiet 1>>"logs\sync.log" 2>&1
exit /b %ERRORLEVEL%
