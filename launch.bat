@echo off
setlocal
cd /d "%~dp0"

:: Launch native Egoist Relay standalone desktop application directly
if exist "%~dp0Egoist Relay.exe" (
    start "" "%~dp0Egoist Relay.exe"
    exit /b 0
)

if exist "%LOCALAPPDATA%\Egoist Relay\Egoist Relay.exe" (
    start "" "%LOCALAPPDATA%\Egoist Relay\Egoist Relay.exe"
    exit /b 0
)

if exist "%LOCALAPPDATA%\Programs\Egoist Relay\Egoist Relay.exe" (
    start "" "%LOCALAPPDATA%\Programs\Egoist Relay\Egoist Relay.exe"
    exit /b 0
)

if exist "%LOCALAPPDATA%\Egoist Relay\egoist_relay.exe" (
    start "" "%LOCALAPPDATA%\Egoist Relay\egoist_relay.exe"
    exit /b 0
)

exit /b 0
