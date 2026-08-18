@echo off
setlocal
title DSH Launcher - Build EXE

rem Build a single-file DSH_Launcher.exe using PyInstaller.
rem PyInstaller is installed locally under runtime\pyinstaller (never touches
rem system Python nor C drive). The final exe is copied to the project root,
rem next to runtime\, so it can find node/dsh/home on first run.

cd /d "%~dp0"

rem 1. Find Python: bundled portable first, then system Python
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
echo [INFO] Using Python: %PYTHON_CMD%

rem 2. Install PyInstaller locally (project-relative, China mirror first)
set "PYINSTALLER_DIR=%~dp0runtime\pyinstaller"
if not exist "%PYINSTALLER_DIR%" (
    echo [INFO] Installing PyInstaller locally under runtime\pyinstaller ...
    "%PYTHON_CMD%" -m pip install --target "%PYINSTALLER_DIR%" -i https://pypi.tuna.tsinghua.edu.cn/simple pyinstaller
    if errorlevel 1 (
        echo [ERROR] Failed to install PyInstaller. Check your network.
        pause
        exit /b 1
    )
)

rem 3. Build single-file windowed exe (no UPX to reduce AV false positives)
rem    --icon: embeds exe icon; --add-data: carries the icon into the onefile bundle
rem    so the GUI/tray icon works when running from the unpacked temp dir
rem    note: --add-data src;dst paths are relative to the spec dir (build\), so
rem    always pass absolute source paths (%~dp0...) here
rem 3b. Bundle the VC runtime DLLs that python310.dll needs. PyInstaller only
rem      auto-collects VCRUNTIME140.dll; VCRUNTIME140_1.dll and
rem      VCRUNTIME140_threads.dll are skipped, and on machines without the
rem      system VC runtime the onefile bootloader fails with
rem      "Failed to load Python DLL ... cannot find the specified module".
rem      Add all three explicitly so they are unpacked next to python310.dll.
rem      Both DSH_Launcher.exe and DSH_Update.exe embed python, so both need
rem      these DLLs (otherwise the standalone updater crashes the same way).
set "VC_BINARIES="
if exist "%~dp0runtime\python\python\vcruntime140.dll" set "VC_BINARIES=%VC_BINARIES% --add-binary "%~dp0runtime\python\python\vcruntime140.dll;.""
if exist "%~dp0runtime\python\python\vcruntime140_1.dll" set "VC_BINARIES=%VC_BINARIES% --add-binary "%~dp0runtime\python\python\vcruntime140_1.dll;.""
if exist "%~dp0runtime\python\python\vcruntime140_threads.dll" set "VC_BINARIES=%VC_BINARIES% --add-binary "%~dp0runtime\python\python\vcruntime140_threads.dll;.""
set "PYTHONPATH=%PYINSTALLER_DIR%;%PYTHONPATH%"
echo [INFO] Building DSH_Launcher.exe ...
"%PYTHON_CMD%" -m PyInstaller --onefile --windowed --noupx --name DSH_Launcher --icon "%~dp0DSH_Launcher.ico" --add-data "%~dp0DSH_Launcher.ico;."%VC_BINARIES% --distpath dist --workpath build --specpath build "%~dp0launcher.py"
if errorlevel 1 (
    echo [ERROR] Build failed. See messages above.
    pause
    exit /b 1
)

rem 3c. Build the standalone updater DSH_Update.exe (from update_agent.py).
rem      This is the process that actually performs the overlay install AFTER the
rem      main launcher exits, so it can replace a locked DSH_Launcher.exe. It ships
rem      with the green zip and self-replaces itself during updates. It also embeds
rem      python, so it needs the same VC binaries as above (already in %VC_BINARIES%).
echo [INFO] Building DSH_Update.exe ...
"%PYTHON_CMD%" -m PyInstaller --onefile --windowed --noupx --name DSH_Update --icon "%~dp0DSH_Launcher.ico" --add-data "%~dp0DSH_Launcher.ico;."%VC_BINARIES% --distpath dist --workpath build --specpath build "%~dp0update_agent.py"
if errorlevel 1 (
    echo [ERROR] DSH_Update build failed. See messages above.
    pause
    exit /b 1
)

rem 4. Copy exe to project root (next to runtime\)
copy /Y "dist\DSH_Launcher.exe" "DSH_Launcher.exe" >nul
copy /Y "dist\DSH_Update.exe" "DSH_Update.exe" >nul
if exist "DSH_Launcher.exe" (
    echo.
    echo [OK] Build finished: DSH_Launcher.exe and DSH_Update.exe in project root.
    echo     Double-click it, or move it alongside the runtime folder.
) else (
    echo [ERROR] Copy exe failed.
)
pause
endlocal
