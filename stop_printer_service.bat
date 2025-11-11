@echo off
setlocal enabledelayedexpansion
set SERVICE=printerServerService.exe
set PORT=7810

:: Stop the service gracefully
echo Stopping service...
%SERVICE% stop

:: Wait a moment for service to stop
timeout /t 2 >nul

:: Kill any process using port 7810 (ignore TIME_WAIT)
set "killed=0"
set "found_process=0"

for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%PORT%" ^| findstr "LISTENING"') do (
    set "found_process=1"
    echo Killing process using port %PORT% with PID %%a
    taskkill /pid %%a /f >nul 2>&1
    if not errorlevel 1 set "killed=1"
)

:: Wait after killing
if "%killed%"=="1" timeout /t 2 >nul

:: Check again if port is still in use by LISTENING process
set "port_still_in_use=0"
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%PORT%" ^| findstr "LISTENING"') do (
    set "port_still_in_use=1"
)

if "%port_still_in_use%"=="1" (
    call :msgbox "Failed to free port %PORT%! Some process may still be using it." "Printer Server Service" 16
) else (
    if "%killed%"=="1" (
        call :msgbox "Service stopped and process on port %PORT% was terminated." "Printer Server Service" 48
    ) else (
        call :msgbox "Service stopped successfully. Port %PORT% is free." "Printer Server Service" 64
    )
)
exit /b

:msgbox
set "msg=%~1"
set "title=%~2"
set "icon=%~3"
set "vbsfile=%temp%\msgbox.vbs"
echo msgbox "%msg%", %icon%, "%title%" > "%vbsfile%"
cscript //nologo "%vbsfile%" >nul
del "%vbsfile%"
exit /b