@echo off
cd /d "%~dp0"
setlocal enabledelayedexpansion
set SERVICE=printerServerService.exe
set SERVICE_NAME=printerServer
set PORT=7810

:: sc stop and killing a SYSTEM-owned process both need elevation. Without this
:: the script silently failed to stop anything, or "succeeded" by killing an
:: unmanaged process while the real service kept running.
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo Requesting administrator privileges...
    powershell -NoProfile -Command "try { Start-Process -FilePath '%~f0' -Verb RunAs -ErrorAction Stop } catch { exit 1 }"
    if errorlevel 1 (
        echo.
        echo Administrator privileges were declined - the service cannot be stopped.
        echo Right-click this file and choose "Run as administrator".
        pause
    )
    exit /b
)

:: What was actually running before we touched anything - the messages at the
:: end are only true if they say which of the two it was.
call :serviceisrunning
set "WAS_RUNNING=%errorlevel%"

echo Stopping service...
sc stop "%SERVICE_NAME%"
set "STOP_RC=%errorlevel%"
:: 1062 = not started, 1060 = not installed. Neither is a failure here.
if "%STOP_RC%"=="5" (
    echo.
    echo Access denied - this window is not elevated.
    echo Right-click this file and choose "Run as administrator".
    pause
    exit /b 1
)

:: WinSW fallback, only when sc could not do it and something was running.
if not "%STOP_RC%"=="0" (
    if "%WAS_RUNNING%"=="0" %SERVICE% stop
)

if "%WAS_RUNNING%"=="0" (
    echo Waiting for the service to stop...
    call :waitstopped 30
    if errorlevel 1 echo WARNING: the service has not reported Stopped yet.
)

:: Kill whatever still holds the port (an unmanaged printerServer.exe left by an
:: older update). netstat's state column is localized, so a listener is matched
:: by its wildcard foreign address rather than by the word LISTENING.
set "killed=0"
for /f "tokens=2,3,5" %%a in ('netstat -ano -p TCP ^| findstr /R /C:":%PORT% "') do (
    set "is_listener="
    if "%%b"=="0.0.0.0:0" set "is_listener=1"
    if "%%b"=="[::]:0" set "is_listener=1"
    if defined is_listener (
        echo Killing process using port %PORT% with PID %%c
        taskkill /pid %%c /f
        if not errorlevel 1 set "killed=1"
    )
)

:: Force kill printerServer.exe by name as final fallback
taskkill /IM printerServer.exe /F >nul 2>&1

call :waitfree 10
if errorlevel 1 (
    call :msgbox "Failed to free port %PORT%! Some process is still using it." "Printer Server Service" 16
    exit /b 1
)

if "%WAS_RUNNING%"=="0" (
    call :msgbox "Service stopped. Port %PORT% is free." "Printer Server Service" 64
    exit /b 0
)

if "%killed%"=="1" (
    call :msgbox "No service was running. An unmanaged printerServer.exe was holding port %PORT% and has been killed - the service needs repairing with install_printer_service.bat." "Printer Server Service" 48
    exit /b 0
)

call :msgbox "Nothing was running: the service was already stopped and port %PORT% was free." "Printer Server Service" 64
exit /b 0

:: Sets PORT_IN_USE when something holds %PORT%.
:portinuse
set "PORT_IN_USE="
for /f "tokens=2,3" %%a in ('netstat -ano -p TCP ^| findstr /R /C:":%PORT% "') do (
    if "%%b"=="0.0.0.0:0" set "PORT_IN_USE=1"
    if "%%b"=="[::]:0" set "PORT_IN_USE=1"
)
exit /b

:: Wait up to %1 seconds for the port to be free. 0 = it is.
:waitfree
set "WAIT_LEFT=%~1"
:waitfree_loop
call :portinuse
if not defined PORT_IN_USE exit /b 0
set /a WAIT_LEFT-=1
if %WAIT_LEFT% leq 0 exit /b 1
timeout /t 1 >nul
goto :waitfree_loop

:: Wait up to %1 seconds for the service to leave Running. 0 = it did.
:waitstopped
set "WAIT_LEFT=%~1"
:waitstopped_loop
call :serviceisrunning
if errorlevel 1 exit /b 0
set /a WAIT_LEFT-=1
if %WAIT_LEFT% leq 0 exit /b 1
timeout /t 1 >nul
goto :waitstopped_loop

:: 0 = the service is Running. Get-Service because sc.exe's state word is
:: localized and never matches "RUNNING" on a Greek Windows.
:serviceisrunning
powershell -NoProfile -NonInteractive -Command "if ((Get-Service -Name '%SERVICE_NAME%' -ErrorAction SilentlyContinue).Status -eq 'Running') { exit 0 } else { exit 1 }"
exit /b %errorlevel%

:msgbox
set "msg=%~1"
set "title=%~2"
set "icon=%~3"
set "vbsfile=%temp%\msgbox.vbs"
echo msgbox "%msg%", %icon%, "%title%" > "%vbsfile%"
cscript //nologo "%vbsfile%" >nul
del "%vbsfile%"
exit /b
