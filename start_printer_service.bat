@echo off
cd /d "%~dp0"
setlocal
set SERVICE=printerServerService.exe
set SERVICE_NAME=printerServer
set PORT=7810

:: Fail with the real reason instead of cmd's "is not recognized" further down.
if not exist "%SERVICE%" (
    echo %SERVICE% is missing from this folder - the install is incomplete.
    echo Run force_autoupdate.bat to re-download a full build, then run this again.
    pause
    exit /b 1
)

:: Kill any stale printerServer.exe processes first
echo Cleaning up stale processes...
taskkill /IM printerServer.exe /F >nul 2>&1

:: Also kill any process on the port. netstat's state column is localized, so a
:: listener is matched by its wildcard foreign address, not by "LISTENING".
for /f "tokens=2,3,5" %%a in ('netstat -ano -p TCP ^| findstr /R /C:":%PORT% "') do (
    if "%%b"=="0.0.0.0:0" taskkill /pid %%c /f >nul 2>&1
    if "%%b"=="[::]:0" taskkill /pid %%c /f >nul 2>&1
)

:: Wait for cleanup
timeout /t 2 >nul

:: Check if the port is actively held (ignore TIME_WAIT)
echo Checking if port %PORT% is available...
call :portinuse
if defined PORT_IN_USE (
    echo Port %PORT% is still in use! Service will not start.
    pause
    exit /b
)

:: Try to start the service
echo Starting service...
%SERVICE% start

:: Wait a moment for service to start
timeout /t 3 >nul

:: Verify service started by checking if it's now listening on the port
call :portinuse
if defined PORT_IN_USE (
    echo Service started successfully on port %PORT%.
) else (
    echo Failed to start service. Check if the service is installed.
)

pause
exit /b

:: Sets PORT_IN_USE when something holds %PORT%. A listener is identified by its
:: wildcard foreign address because the state column is localized.
:portinuse
set "PORT_IN_USE="
for /f "tokens=2,3" %%a in ('netstat -ano -p TCP ^| findstr /R /C:":%PORT% "') do (
    if "%%b"=="0.0.0.0:0" set "PORT_IN_USE=1"
    if "%%b"=="[::]:0" set "PORT_IN_USE=1"
)
exit /b
