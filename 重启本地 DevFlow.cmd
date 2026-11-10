@echo off
node "%~dp0scripts\restart-local-devflow.mjs"
if not errorlevel 1 exit /b 0
pause
exit /b 1
