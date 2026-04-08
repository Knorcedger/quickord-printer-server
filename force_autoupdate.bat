@echo off
cd /d "%~dp0"
setlocal
set SERVICE_NAME=printerServer
set PORT=7810

REM Force auto-update batch file

REM Stop the service first
echo Stopping service...
sc stop "%SERVICE_NAME%" >nul 2>&1
timeout /t 2 >nul

REM Kill printerServer.exe by name
echo Killing printerServer.exe...
taskkill /IM printerServer.exe /F >nul 2>&1

REM Kill any process on the port
for /f "tokens=5" %%a in ('netstat -ano ^| findstr /R /C:":%PORT% " ^| findstr "LISTENING"') do (
    taskkill /pid %%a /f >nul 2>&1
)

timeout /t 2 >nul

REM Run updater
pushd ..
if exist updater.exe (
    echo Running updater...
    updater.exe
    echo Updater finished
) else (
    echo updater.exe not found in parent folder
)
popd

pause
