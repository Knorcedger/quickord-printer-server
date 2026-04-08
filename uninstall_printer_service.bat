@echo off
cd /d "%~dp0"
setlocal enabledelayedexpansion

:: Use the actual Windows Service name (matches printerServerService.xml <id>)
set SERVICE_NAME=printerServer
set PORT=7810

:: Check if port is in use and try to stop service
echo Checking if port %PORT% is in use...
netstat -ano | findstr ":%PORT%" | findstr "LISTENING" >nul 2>&1
if %errorlevel%==0 (
    echo Port %PORT% is in use. Stopping service...
    sc stop "%SERVICE_NAME%" >nul 2>&1
    timeout /t 3 >nul
)

:: Always attempt uninstall
echo Uninstalling service...
printerServerService.exe uninstall

echo.
echo Done. Check the output above for status.
pause