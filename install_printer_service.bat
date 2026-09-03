@echo off
cd /d "%~dp0"
setlocal enabledelayedexpansion

:: Use the actual Windows Service name (matches printerServerService.xml <id>)
set SERVICE_NAME=printerServer
set SERVICE_EXE=printerServerService.exe

:: sc create/delete need elevation; double-clicking does not give it.
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo Requesting administrator privileges...
    powershell -NoProfile -Command "try { Start-Process -FilePath '%~f0' -Verb RunAs -ErrorAction Stop } catch { exit 1 }"
    if errorlevel 1 (
        echo.
        echo Administrator privileges were declined - the service cannot be installed.
        echo Right-click this file and choose "Run as administrator".
        pause
    )
    exit /b
)

:: Without the WinSW binary there is nothing to install from.
if not exist "%SERVICE_EXE%" (
    echo %SERVICE_EXE% is missing from this folder - the install is incomplete.
    echo Run force_autoupdate.bat to re-download a full build, then run this again.
    pause
    exit /b 1
)

:: Check if the service is already installed
sc query "%SERVICE_NAME%" >nul 2>&1
if %errorlevel%==0 goto :registered
goto :install

:registered
:: A registration can outlive its binary (an update that lost the exe). Then
:: install says "already installed" and uninstall cannot run - a dead end.
:: Read where the SCM points and drop the entry if that file is gone. Read it
:: from the registry: sc qc's BINARY_PATH_NAME label is localized, ImagePath is
:: not.
set BINPATH=
for /f "tokens=2,*" %%a in ('reg query "HKLM\SYSTEM\CurrentControlSet\Services\%SERVICE_NAME%" /v ImagePath 2^>nul ^| findstr /i "ImagePath"') do set BINPATH=%%b
for /f "tokens=*" %%x in ("!BINPATH!") do set BINPATH=%%x
set BINPATH=!BINPATH:"=!

:: An unreadable path is not a reason to fail: the service is installed, which
:: is all this script had to guarantee before.
if not defined BINPATH (
    echo Service is already installed.
    pause
    exit /b 0
)

if exist "!BINPATH!" (
    echo Service is already installed ^(!BINPATH!^).
    pause
    exit /b
)

echo Service is registered but its binary is missing:
echo   !BINPATH!
echo Removing the orphaned registration...
sc stop "%SERVICE_NAME%" >nul 2>&1
timeout /t 3 >nul
sc delete "%SERVICE_NAME%"
if %errorlevel% neq 0 (
    echo Failed to remove the orphaned service. Reboot and try again.
    pause
    exit /b 1
)
timeout /t 2 >nul

:install
:: Try to install the service
echo Installing service...
%SERVICE_EXE% install

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
