@echo off
setlocal
title DeepSeek Harness Launcher - Stop

cd /d "%~dp0"

rem Prefer bundled portable Python in runtime\python (two possible layouts),
rem then fall back to system Python (py / python / python3)
set "PYTHON_CMD="
if exist "%~dp0runtime\python\python.exe" set "PYTHON_CMD=%~dp0runtime\python\python.exe"
if not defined PYTHON_CMD (if exist "%~dp0runtime\python\python\python.exe" set "PYTHON_CMD=%~dp0runtime\python\python\python.exe")
if not defined PYTHON_CMD (where py >nul 2>nul && set "PYTHON_CMD=py -3")
if not defined PYTHON_CMD (where python >nul 2>nul && set "PYTHON_CMD=python")
if not defined PYTHON_CMD (where python3 >nul 2>nul && set "PYTHON_CMD=python3")

if not defined PYTHON_CMD (
    echo [ERROR] Python is not found on this system.
    pause
    exit /b 1
)

%PYTHON_CMD% launcher.py --stop
echo.
pause
endlocal
