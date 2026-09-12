@echo off
cd /d "%~dp0"
echo Starting Egoist Relay server...
start "" /B npm run dev
timeout /t 2 /nobreak >nul
if exist "C:\Program Files\Yandex\YandexBrowser\Application\browser.exe" (
    start "" "C:\Program Files\Yandex\YandexBrowser\Application\browser.exe" --app="http://localhost:1234" --window-size=1280,820
) else if exist "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" (
    start "" "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --app="http://localhost:1234" --window-size=1280,820
) else (
    start http://localhost:1234
)
