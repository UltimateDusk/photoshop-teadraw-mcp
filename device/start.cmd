@echo off
cd /d "%~dp0"
node --use-env-proxy bridge.cjs
pause
