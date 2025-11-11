@echo off
setlocal
set SERVICE=printerServerService.exe
set PORT=7810

:: Check if port is actively LISTENING (ignore TIME_WAIT)
echo Checking if port %PORT% is available...
netstat -ano | findstr ":%PORT%" | findstr "LISTENING" >nul 2>&1
if %errorlevel%==0 (
    echo Port %PORT% is already in use! Service will not start.
    pause
    exit /b
)

:: Try to start the service
echo Starting service...
%SERVICE% start

:: Wait a moment for service to start
timeout /t 2 >nul

:: Verify service started by checking if it's now listening on the port
netstat -ano | findstr ":%PORT%" | findstr "LISTENING" >nul 2>&1
if %errorlevel%==0 (
    echo Service started successfully on port %PORT%.
) else (
    echo Failed to start service. Check if the service is installed.
)

pause