@echo off
cd /d "%~dp0"
if exist "runtime\node.exe" (
  "runtime\node.exe" src\web-server.js
) else (
  node src\web-server.js
)
pause
