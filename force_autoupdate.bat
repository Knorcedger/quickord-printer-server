@echo off
cd /d "%~dp0"

REM The update now drives the service manager (sc stop / sc start) instead of
REM leaving a detached process behind, so it needs elevation. Double-clicked by
REM a technician this script is normally NOT elevated, and every sc call would
REM fail with access denied - the update would abort on purpose rather than
REM half-copy the install. Re-launch ourselves elevated instead.
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo Requesting administrator privileges...
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

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

REM An older updater.exe ends by spawning printerServer.exe detached, which
REM leaves the service stopped and an orphan on the port. Clear it and start
REM the service so the machine is left under SCM supervision either way.
taskkill /IM printerServer.exe /F >nul 2>&1
timeout /t 2 >nul
echo Starting service...
sc start "%SERVICE_NAME%"

pause
