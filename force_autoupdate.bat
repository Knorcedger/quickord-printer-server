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

REM Run updater. Capture its exit code: CRITICAL_EXIT (3) means the updater left
REM the install in a mixed/partial state and refused to start it, so we must not
REM start the service either. Capture on the top-level line (not inside the
REM if-block) so %errorlevel% expands after updater.exe runs, not at parse time.
pushd ..
if not exist updater.exe (
    echo updater.exe not found in parent folder
    set UPDATER_RC=0
    popd
    goto :after_updater
)
echo Running updater...
updater.exe
set UPDATER_RC=%errorlevel%
popd
:after_updater
echo Updater finished with exit code %UPDATER_RC%

REM The updater can't overwrite its own running exe, so it stages the new one.
REM Swap it in now that updater.exe has exited.
if exist "..\updater.exe.new" (
    echo Updating updater.exe...
    move /Y "..\updater.exe.new" "..\updater.exe" >nul
)

REM The updater refused to start a knowingly-inconsistent install. Do NOT kill/
REM start the service on top of it - that would run the broken build the updater
REM deliberately left down. Stop here and leave it for manual restore.
if "%UPDATER_RC%"=="3" (
    echo.
    echo ============================================================
    echo CRITICAL: the updater reported an inconsistent install.
    echo The service was NOT started to avoid running a broken build.
    echo A manual restore is required - see the updater output above.
    echo ============================================================
    pause
    endlocal
    exit /b 3
)

REM An older updater.exe ends by spawning printerServer.exe detached, which
REM leaves the service stopped and an orphan on the port. Clear it and start
REM the service so the machine is left under SCM supervision either way.
taskkill /IM printerServer.exe /F >nul 2>&1
timeout /t 2 >nul

REM Same registry-side service settings applyServiceConfig() applies on the
REM --update path. updater.exe is a prebuilt binary that is already old on
REM venue machines, so this script is the only place the manual route can pick
REM them up. Both calls are idempotent; failures are printed, not swallowed.
echo Applying service config...
sc.exe config "%SERVICE_NAME%" start= delayed-auto depend= Tcpip/Dnscache/NlaSvc
if %errorlevel% neq 0 echo WARNING: sc config failed (%errorlevel%) - service start mode/dependencies not updated
sc.exe failure "%SERVICE_NAME%" reset= 86400 actions= restart/5000/restart/5000/restart/60000
if %errorlevel% neq 0 echo WARNING: sc failure failed (%errorlevel%) - the service will NOT be restarted after a crash

echo Starting service...
sc start "%SERVICE_NAME%"

pause
