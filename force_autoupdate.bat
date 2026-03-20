@echo off
cd /d "%~dp0"
REM Force auto-update batch file
REM This assumes updater.exe is in the parent folder

echo 🚀 Running updater...
pushd ..
if exist updater.exe (
    updater.exe
    echo ✅ Updater finished
) else (
    echo ❌ updater.exe not found in parent folder
)
popd

pause
