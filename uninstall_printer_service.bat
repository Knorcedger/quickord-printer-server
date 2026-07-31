@echo off
cd /d "%~dp0"
setlocal enabledelayedexpansion

:: Use the actual Windows Service name (matches printerServerService.xml <id>)
set SERVICE_NAME=printerServer
set SERVICE_EXE=printerServerService.exe
set PORT=7810

:: sc stop/delete need elevation; double-clicking does not give it.
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo Requesting administrator privileges...
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

:: Check if port is in use and try to stop service
echo Checking if port %PORT% is in use...
netstat -ano | findstr ":%PORT%" | findstr "LISTENING" >nul 2>&1
if %errorlevel%==0 (
    echo Port %PORT% is in use. Stopping service...
    sc stop "%SERVICE_NAME%" >nul 2>&1
    timeout /t 3 >nul
)

:: WinSW can only uninstall while its own binary is there. If the exe was lost
:: (an update that dropped it), drop the registration through the SCM instead -
:: otherwise the entry can neither be removed nor reinstalled over.
if exist "%SERVICE_EXE%" (
    echo Uninstalling service...
    %SERVICE_EXE% uninstall
) else (
    echo %SERVICE_EXE% is missing; removing the service registration directly...
    sc delete "%SERVICE_NAME%"
)

echo.
echo Done. Check the output above for status.
pause
