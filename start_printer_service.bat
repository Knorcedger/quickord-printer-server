@echo off
cd /d "%~dp0"
setlocal
set SERVICE=printerServerService.exe
set SERVICE_NAME=printerServer
set PORT=7810

:: Kill any stale printerServer.exe processes first
echo Cleaning up stale processes...
taskkill /IM printerServer.exe /F >nul 2>&1

:: Also kill any process on the port
for /f "tokens=5" %%a in ('netstat -ano ^| findstr /R /C:":%PORT% " ^| findstr "LISTENING"') do (
    taskkill /pid %%a /f >nul 2>&1
)

:: Wait for cleanup
timeout /t 2 >nul

:: Check if port is actively LISTENING (ignore TIME_WAIT)
echo Checking if port %PORT% is available...
netstat -ano | findstr /R /C:":%PORT% " | findstr "LISTENING" >nul 2>&1
if %errorlevel%==0 (
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
netstat -ano | findstr /R /C:":%PORT% " | findstr "LISTENING" >nul 2>&1
if %errorlevel%==0 (
    echo Service started successfully on port %PORT%.
) else (
    echo Failed to start service. Check if the service is installed.
)

pause
