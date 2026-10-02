@echo off
rem Launcher only. The prompts live in start.ps1 because cmd mis-parses
rem UTF-8 text inside batch files when the console code page is not UTF-8.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1"
if errorlevel 1 pause
