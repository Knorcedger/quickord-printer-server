@echo off
cd /d "%~dp0"
setlocal
set SERVICE=printerServerService.exe
set SERVICE_NAME=printerServer
set PORT=7810

:: Starting a service and killing a SYSTEM-owned process both need elevation.
:: Double-clicking does not give it, and WinSW's own UAC prompt is why this
:: script used to work only sometimes.
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo Requesting administrator privileges...
    powershell -NoProfile -Command "try { Start-Process -FilePath '%~f0' -Verb RunAs -ErrorAction Stop } catch { exit 1 }"
    if errorlevel 1 (
        echo.
        echo Administrator privileges were declined - the service cannot be started.
        echo Right-click this file and choose "Run as administrator".
        pause
    )
    exit /b
)

:: Fail with the real reason instead of cmd's "is not recognized" further down.
if not exist "%SERVICE%" (
    echo %SERVICE% is missing from this folder - the install is incomplete.
    echo Run force_autoupdate.bat to re-download a full build, then run this again.
    pause
    exit /b 1
)

:: Stop a running service properly first. Killing WinSW's child instead makes
:: WinSW stop (or, with the failure actions, restart) the service underneath the
:: sc start below.
call :serviceisrunning
if not errorlevel 1 (
    echo The service is already running - stopping it first...
    sc stop "%SERVICE_NAME%" >nul
    call :waitstopped 30
)

:: Kill any stale printerServer.exe processes first
echo Cleaning up stale processes...
taskkill /IM printerServer.exe /F >nul 2>&1

:: Also kill any process on the port. netstat's state column is localized, so a
:: listener is matched by its wildcard foreign address, not by "LISTENING".
for /f "tokens=2,3,5" %%a in ('netstat -ano -p TCP ^| findstr /R /C:":%PORT% "') do (
    if "%%b"=="0.0.0.0:0" taskkill /pid %%c /f >nul 2>&1
    if "%%b"=="[::]:0" taskkill /pid %%c /f >nul 2>&1
)

:: Poll instead of sleeping a fixed amount: a killed process releases the port
:: when Windows says so, not when a timeout says so.
echo Checking if port %PORT% is available...
call :waitfree 10
if errorlevel 1 (
    echo Port %PORT% is still in use! Service will not start.
    pause
    exit /b 1
)

echo Starting service...
sc start "%SERVICE_NAME%"
:: 1056 = already running, 1061 = the SCM is still busy with the stop above.
if %errorlevel% equ 1061 (
    timeout /t 5 >nul
    sc start "%SERVICE_NAME%"
)
if %errorlevel% equ 1060 (
    echo The service is not installed. Run install_printer_service.bat as administrator.
    pause
    exit /b 1
)
if %errorlevel% equ 5 (
    echo Access denied - this window is not elevated.
    echo Right-click this file and choose "Run as administrator".
    pause
    exit /b 1
)

:: printerServer.exe is a ~90MB nexe binary: WinSW spawn + unpack + node boot is
:: ~3s on a fast machine and more on a venue PC, so a fixed wait reported
:: "Failed to start" on a perfectly good start. Wait for the listener instead.
echo Waiting for the server to open port %PORT%...
call :waitlisten 45
set "LISTENING=%errorlevel%"

call :serviceisrunning
set "RUNNING=%errorlevel%"

if "%LISTENING%"=="0" (
    if "%RUNNING%"=="0" (
        echo Service started successfully on port %PORT%.
        pause
        exit /b 0
    )
    echo.
    echo WARNING: port %PORT% is open but the %SERVICE_NAME% service is NOT running.
    echo The printer server is running as a plain process: it will die at logoff
    echo and nothing will restart it. Run stop_printer_service.bat, then this
    echo file again, both as administrator.
    pause
    exit /b 1
)

if "%RUNNING%"=="0" (
    echo.
    echo The service is running but nothing is listening on port %PORT% yet.
    echo Check builds\app.log for the reason ^(a port conflict, or a crash at boot^).
    pause
    exit /b 1
)

echo Failed to start the service. Check builds\app.log and the Windows Event Log.
pause
exit /b 1

:: Sets PORT_IN_USE when something holds %PORT%. A listener is identified by its
:: wildcard foreign address because the state column is localized.
:portinuse
set "PORT_IN_USE="
for /f "tokens=2,3" %%a in ('netstat -ano -p TCP ^| findstr /R /C:":%PORT% "') do (
    if "%%b"=="0.0.0.0:0" set "PORT_IN_USE=1"
    if "%%b"=="[::]:0" set "PORT_IN_USE=1"
)
exit /b

:: Wait up to %1 seconds for the port to be listening. 0 = it is.
:waitlisten
set "WAIT_LEFT=%~1"
:waitlisten_loop
call :portinuse
if defined PORT_IN_USE exit /b 0
set /a WAIT_LEFT-=1
if %WAIT_LEFT% leq 0 exit /b 1
timeout /t 1 >nul
goto :waitlisten_loop

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

:: 0 = the service is Running. Get-Service because sc.exe's state word is
:: localized and never matches "RUNNING" on a Greek Windows.
:serviceisrunning
powershell -NoProfile -NonInteractive -Command "if ((Get-Service -Name '%SERVICE_NAME%' -ErrorAction SilentlyContinue).Status -eq 'Running') { exit 0 } else { exit 1 }"
exit /b %errorlevel%
