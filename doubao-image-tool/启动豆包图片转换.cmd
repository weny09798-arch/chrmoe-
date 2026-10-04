@echo off
cd /d "%~dp0"
if exist "DoubaoImageTool.exe" (
  "DoubaoImageTool.exe"
) else (
  python run.py
)
if errorlevel 1 pause
