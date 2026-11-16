@echo off
rem Starts the harness for the folder this harness folder sits in.
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22 or newer is needed: https://nodejs.org
  pause
  exit /b 1
)
node "%~dp0server.js" %*
pause
