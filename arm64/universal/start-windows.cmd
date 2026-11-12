@echo off
cd /d "%~dp0"
py -3 assistant.py
if errorlevel 1 pause
