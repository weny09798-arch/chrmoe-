@echo off
cd /d "%~dp0"
TraditionalImageTool.exe
if errorlevel 1 pause
