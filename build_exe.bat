@echo off
setlocal EnableDelayedExpansion
title DSH Launcher - Build EXE (100%% Portable)

rem ================================================================
rem  DSH Launcher build script
rem  Policy: NEVER use system Python. If runtime\python\python is
rem  missing or broken, auto-download official CPython installer
rem  (full Lib, tkinter, pip) into project-local dir.
rem  All tooling (Python, PyInstaller, VC DLLs) lives under runtime\.
rem  Nothing touches C:\ or system PATH.
rem ================================================================

cd /d "%~dp0"

rem ---------- 0. Config (edit only these) ----------
set "PY_VERSION=3.10.20"
set "PY_DIR=%~dp0runtime\python"
set "PYTHON_EXE=%PY_DIR%\python\python.exe"
set "PYINSTALLER_DIR=%~dp0runtime\pyinstaller"
set "PIP_MIRROR=-i https://pypi.tuna.tsinghua.edu.cn/simple"
set "PY_INSTALLER=runtime\tmp\python-%PY_VERSION%-amd64.exe"

rem ---------- 1. Locate or repair portable Python ----------
if exist "%PYTHON_EXE%" goto :python_ok

echo [INFO] Portable Python not found at %PYTHON_EXE%
echo [INFO] Auto-downloading Python %PY_VERSION% (official installer) ...

if not exist "runtime\tmp" mkdir "runtime\tmp"

rem Fallback chain: python.org -> Huawei Cloud -> USTC
set "PY_BASE=https://www.python.org/ftp/python/%PY_VERSION%/python-%PY_VERSION%-amd64.exe"
set "PY_MIRROR1=https://mirrors.huaweicloud.com/python/%PY_VERSION%/python-%PY_VERSION%-amd64.exe"
set "PY_MIRROR2=https://mirrors.ustc.edu.cn/python-release/%PY_VERSION%/python-%PY_VERSION%-amd64.exe"

call :try_download "%PY_BASE%" "%PY_INSTALLER%" && goto :install_python
call :try_download "%PY_MIRROR1%" "%PY_INSTALLER%" && goto :install_python
call :try_download "%PY_MIRROR2%" "%PY_INSTALLER%" && goto :install_python

echo [ERROR] All mirrors failed. Cannot download Python %PY_VERSION%.
echo         Check your network or place python-%PY_VERSION%-amd64.exe into runtime\tmp\.
pause
exit /b 1

:install_python
echo [INFO] Installing Python silently into "%PY_DIR%\python" ...
"%PY_INSTALLER%" /quiet InstallAllUsers=0 PrependPath=0 Include_launcher=0 Include_pip=1 Include_test=0 Include_doc=0 Include_ssl=1 Include_tcltk=1 SimpleInstall=1 TargetDir="%PY_DIR%\python"
if errorlevel 1 (
    echo [ERROR] Python installer failed.
    pause
    exit /b 1
)

echo [INFO] Cleaning up installer ...
del /f "%PY_INSTALLER%" >nul 2>&1

if not exist "%PYTHON_EXE%" (
    echo [ERROR] Python installed but %PYTHON_EXE% still missing.
    pause
    exit /b 1
)

echo [OK] Python ready: %PYTHON_EXE%
"%PYTHON_EXE%" --version

:python_ok
echo [INFO] Using portable Python: %PYTHON_EXE%

rem ---------- 2. PyInstaller (auto-install into runtime\pyinstaller) ----------
if exist "%PYINSTALLER_DIR%\PyInstaller\__init__.py" goto :pyinstaller_ok

echo [INFO] Installing PyInstaller into %PYINSTALLER_DIR% (mirror: tsinghua) ...
"%PYTHON_EXE%" -m pip install %PIP_MIRROR% --target "%PYINSTALLER_DIR%" pyinstaller
if errorlevel 1 (
    echo [ERROR] PyInstaller install failed. Check network or pip mirror.
    pause
    exit /b 1
)

:pyinstaller_ok
echo [INFO] PyInstaller ready at %PYINSTALLER_DIR%

rem ---------- 3. Collect VC runtime DLLs from portable Python ----------
rem python310.dll depends on VCRUNTIME140.dll, VCRUNTIME140_1.dll,
rem VCRUNTIME140_threads.dll. PyInstaller only auto-packs the first one.
rem Explicitly add all three so the onefile exe boots on clean machines.
set "VC_BINARIES="
for %%d in (vcruntime140.dll vcruntime140_1.dll vcruntime140_threads.dll) do (
    if exist "%PY_DIR%\python\%%d" (
        set "VC_BINARIES=!VC_BINARIES! --add-binary "%PY_DIR%\python\%%d;.""
        echo [INFO]   + %%d
    ) else (
        echo [WARN]   %%d not found in portable Python dir
    )
)

set "PYTHONPATH=%PYINSTALLER_DIR%;%PYTHONPATH%"

rem ---------- 4. Build DSH_Launcher.exe ----------
echo.
echo [INFO] Building DSH_Launcher.exe ...
"%PYTHON_EXE%" -m PyInstaller --clean --noconfirm --onefile --windowed --noupx --name DSH_Launcher --icon "%~dp0DSH_Launcher.ico" --add-data "%~dp0DSH_Launcher.ico;."%VC_BINARIES% --distpath dist --workpath build --specpath build "%~dp0launcher.py"
if errorlevel 1 (
    echo [ERROR] DSH_Launcher.exe build failed. See PyInstaller output above.
    pause
    exit /b 1
)

rem ---------- 5. Build DSH_Update.exe ----------
rem Standalone updater that overlays files AFTER main exe exits.
rem It also embeds python, so needs same VC DLLs.
echo.
echo [INFO] Building DSH_Update.exe ...
"%PYTHON_EXE%" -m PyInstaller --clean --noconfirm --onefile --windowed --noupx --name DSH_Update --icon "%~dp0DSH_Launcher.ico" --add-data "%~dp0DSH_Launcher.ico;."%VC_BINARIES% --distpath dist --workpath build --specpath build "%~dp0update_agent.py"
if errorlevel 1 (
    echo [ERROR] DSH_Update.exe build failed. See PyInstaller output above.
    pause
    exit /b 1
)

rem ---------- 6. Copy to project root ----------
echo.
copy /Y "dist\DSH_Launcher.exe" "DSH_Launcher.exe" >nul
copy /Y "dist\DSH_Update.exe" "DSH_Update.exe" >nul

if exist "DSH_Launcher.exe" (
    echo [OK] Build complete!
    echo      DSH_Launcher.exe  = %~dp0DSH_Launcher.exe
    echo      DSH_Update.exe    = %~dp0DSH_Update.exe
    echo      Python            = %PYTHON_EXE%
    echo      PyInstaller       = %PYINSTALLER_DIR%
) else (
    echo [ERROR] Copy to project root failed.
    pause
    exit /b 1
)

pause
endlocal
exit /b 0

rem ================================================================
rem  helper: download $1 into $2. Returns 0 on success, 1 on failure.
rem  Tries: Invoke-WebRequest -> BITS -> curl (PowerShell fallback).
rem ================================================================
:try_download
set "url=%~1"
set "dest=%~2"
echo [INFO] Trying: %url% ...

powershell -NoProfile -Command ^
  "$ProgressPreference='SilentlyContinue'; try { Invoke-WebRequest -Uri '%url%' -OutFile '%dest%' -UseBasicParsing; exit 0 } catch { exit 1 }" 2>nul
if %errorlevel% equ 0 exit /b 0

echo [INFO]   Invoke-WebRequest failed, trying BITS ...
powershell -NoProfile -Command ^
  "$ProgressPreference='SilentlyContinue'; Import-Module BitsTransfer -ErrorAction SilentlyContinue; try { Start-BitsTransfer -Source '%url%' -Destination '%dest%'; exit 0 } catch { exit 1 }" 2>nul
if %errorlevel% equ 0 exit /b 0

echo [INFO]   BITS failed, trying curl ...
curl -fsSL -o "%dest%" "%url%" 2>nul
if %errorlevel% equ 0 exit /b 0

echo [WARN]   Download failed from this mirror.
if exist "%dest%" del /f "%dest%" >nul 2>&1
exit /b 1
