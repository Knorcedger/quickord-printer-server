@echo off
cd /d "%~dp0"
setlocal

:: Use the actual Windows Service name (matches printerServerService.xml <id>)
set SERVICE_NAME=printerServer

:: Check if the service is already installed
sc query "%SERVICE_NAME%" >nul 2>&1
if %errorlevel%==0 (
    echo Service is already installed.
    pause
    exit /b
)

:: Try to install the service
echo Installing service...
printerServerService.exe install

:: Wait a moment for Windows to register the service
timeout /t 2 >nul

:: Check if installation was successful
sc query "%SERVICE_NAME%" >nul 2>&1
if %errorlevel%==0 (
    echo Service installed successfully.
    pause
    exit /b 0
)

:: If we get here, installation failed
echo Failed to install service.
pause
exit /b 1