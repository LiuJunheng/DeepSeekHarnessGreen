@echo off
setlocal
title DeepSeek Harness Launcher

rem Change to the directory where this script resides
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
    echo.
    echo Please install Python 3 first:
    echo   1. Open https://www.python.org/downloads/
    echo   2. Download the latest Python 3 installer
    echo   3. During install, check "Add Python to PATH"
    echo.
    echo Then double-click start.bat again.
    echo.
    pause
    exit /b 1
)

rem Prefer pythonw.exe (GUI subsystem, no console) when available (bundled python).
rem Running the GUI with plain python.exe keeps THIS console attached to the
rem launcher process: if the user closes that console, Windows kills the whole
rem launcher (including the tray icon), but the dsh server (a separate node
rem subprocess) keeps running orphaned. pythonw detaches the GUI from any
rem console, so there is no console window to accidentally close, and this
rem bat returns immediately after launching the GUI.
set "PYTHONW_CMD="
if exist "%~dp0runtime\python\pythonw.exe" set "PYTHONW_CMD=%~dp0runtime\python\pythonw.exe"
if not defined PYTHONW_CMD (if exist "%~dp0runtime\python\python\pythonw.exe" set "PYTHONW_CMD=%~dp0runtime\python\python\pythonw.exe")
if defined PYTHONW_CMD (
    rem Launch GUI detached, then let this console window close on its own.
    start "" "%PYTHONW_CMD%" launcher.py
    exit /b 0
)

rem Fallback: no pythonw available (e.g. system python). A console window will
rem show; closing it terminates the launcher. Prefer pythonw as described above.
echo [INFO] Using Python: %PYTHON_CMD%
%PYTHON_CMD% launcher.py
if errorlevel 1 (
    echo.
    echo [ERROR] Launcher exited with an error. See messages above.
    pause
)
endlocal