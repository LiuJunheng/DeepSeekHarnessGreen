@echo off
setlocal
rem ============================================================
rem  DeepSeek Harness green desktop shell (WebView2 standalone)
rem  Opens the DSH WebUI inside an embedded WebView2 window --
rem  a real desktop app look that does NOT depend on the user's
rem  installed browser (Edge/Chrome) at all.
rem
rem  Usage: double-click this file (or a desktop shortcut made to it).
rem
rem  On first run it ensures the portable python has pywebview
rem  (WebView2 backend) installed, then launches desktop-shell.py
rem  with pythonw.exe (no console) so it looks like a native app.
rem  If WebView2 runtime is missing, desktop-shell.py falls back
rem  to the system default browser automatically.
rem ============================================================

cd /d "%~dp0"

set "PYTHON_EXE=%~dp0runtime\python\python\python.exe"
set "PYTHONW_EXE=%~dp0runtime\python\python\pythonw.exe"
set "SHELL_SCRIPT=%~dp0desktop-shell.py"
set "WEBVIEW_PKG=%~dp0runtime\python\python\Lib\site-packages\webview"

if not exist "%PYTHON_EXE%" (
    echo [ERROR] Portable python not found. Please download a full green package.
    pause
    exit /b 1
)

rem ---- 1. ensure pywebview (WebView2 backend) is installed on first run ----
if not exist "%WEBVIEW_PKG%" (
    echo First run: installing the WebView2 desktop-shell dependency. Please wait...
    "%PYTHON_EXE%" -m pip install pywebview pythonnet --index-url https://mirrors.aliyun.com/pypi/simple/ --no-warn-script-location
    if errorlevel 1 (
        echo [ERROR] Dependency install failed. Falling back to the system default browser.
        start "" "http://127.0.0.1:3080"
        endlocal
        exit /b 1
    )
)

rem ---- 2. launch the WebView2 shell with a hidden console ----
if exist "%PYTHONW_EXE%" (
    start "" "%PYTHONW_EXE%" "%SHELL_SCRIPT%"
) else (
    start "" "%PYTHON_EXE%" "%SHELL_SCRIPT%"
)

endlocal
exit /b 0