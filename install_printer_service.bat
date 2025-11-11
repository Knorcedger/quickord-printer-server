@echo off
setlocal

:: Use the actual Windows Service name (not EXE filename)
set SERVICE_NAME=PrinterServerService

:: Check if the service is already installed
sc query "%SERVICE_NAME%" >nul 2>&1
if %errorlevel%==0 (
    echo Service is already installed.
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
    exit /b 0
)

:: If we get here, installation failed
echo Failed to install service.
exit /b 1