# Сборка headless Telegram proxy

Этот набор собирает CLI EXE из исходника Flowseal `tg-ws-proxy` и локального патча `cf-h2-selection.patch`. Патч является отдельным входом сборки. Выбор CF WebSocket и H2-маршрута ограничен пятью параллельными пробами и двумя секундами на пробу; исправные H2-соединения переиспользуются. Общий дедлайн H2 и запасной WS-маршрут сохраняются; после неудачи быстрых WS-проб остаётся исходный последовательный перебор с таймаутом 10 секунд.

## Зафиксированные входы

- Upstream: `https://github.com/Flowseal/tg-ws-proxy.git`, tag `v1.11.2`.
- Ожидаемый upstream commit до патча: `307a384ab7f522e34bb1a045884d0bd90f40bee5`.
- Python: `3.12.14`.
- Python-пакеты: точные версии из `requirements-build.txt`; `pip` не закреплён этим файлом.
- Локальный патч: `scripts/telegram-runtime/cf-h2-selection.patch`.

Версия исходного коммита и хеш каждого готового EXE фиксируются отдельно. Одинаковые версии входов не гарантируют побайтную воспроизводимость EXE.

## PowerShell

Запускайте команды из корня репозитория. Все временные файлы, виртуальное окружение и результаты сборки остаются внутри `%TEMP%`.

```powershell
$ErrorActionPreference = 'Stop'
$repo = (Get-Location).Path
$build = Join-Path $env:TEMP ('egoist-tg-ws-proxy-1.11.2-' + [guid]::NewGuid().ToString('N'))
$source = Join-Path $build 'source'
$venv = Join-Path $build 'venv'
$python = 'C:\Users\Egoist\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
$entry = Join-Path $repo 'scripts\telegram-runtime\entry.py'
$patch = Join-Path $repo 'scripts\telegram-runtime\cf-h2-selection.patch'
$requirements = Join-Path $repo 'scripts\telegram-runtime\requirements-build.txt'

New-Item -ItemType Directory -Path $build -Force | Out-Null
git clone --depth 1 --branch v1.11.2 https://github.com/Flowseal/tg-ws-proxy.git $source
if ($LASTEXITCODE -ne 0) { throw 'Source clone failed' }
$sourceCommit = (git -C $source rev-parse HEAD).Trim()
if ($sourceCommit -ne '307a384ab7f522e34bb1a045884d0bd90f40bee5') {
    throw "Unexpected upstream commit: $sourceCommit"
}
git -C $source apply --check $patch
if ($LASTEXITCODE -ne 0) { throw 'Patch check failed' }
git -C $source apply $patch
if ($LASTEXITCODE -ne 0) { throw 'Patch application failed' }

& $python -m venv $venv
if ($LASTEXITCODE -ne 0) { throw 'Virtual environment creation failed' }
$venvPython = Join-Path $venv 'Scripts\python.exe'
& $venvPython -m pip install --isolated --index-url https://pypi.org/simple -r $requirements
if ($LASTEXITCODE -ne 0) { throw "Dependency installation failed: $LASTEXITCODE" }

$dist = Join-Path $build 'dist'
$work = Join-Path $build 'pyinstaller-work'
$spec = Join-Path $build 'spec'
& $venvPython -m PyInstaller --onefile --console --name tg-ws-proxy `
    --paths $source --collect-data certifi --hidden-import h2 `
    --distpath $dist --workpath $work --specpath $spec $entry
if ($LASTEXITCODE -ne 0) { throw "PyInstaller failed: $LASTEXITCODE" }

git -C $source rev-parse HEAD
Get-FileHash -Algorithm SHA256 (Join-Path $dist 'tg-ws-proxy.exe')
```

`--help` можно использовать для проверки CLI. Не запускайте прокси для сетевого подключения в рамках проверки сборки.
