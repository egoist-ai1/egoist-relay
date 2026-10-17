# Сборка headless Telegram proxy

Этот набор собирает CLI EXE из исходника Flowseal `tg-ws-proxy` и двух локальных патчей: `cf-h2-selection.patch` и `h2-liveness.patch`. Патчи являются отдельными входами сборки. Выбор CF WebSocket и H2-маршрута ограничен пятью параллельными пробами и двумя секундами на пробу; исправные H2-соединения переиспользуются. Общий дедлайн H2 и запасной WS-маршрут сохраняются; после неудачи быстрых WS-проб остаётся исходный последовательный перебор с таймаутом 10 секунд.

`h2-liveness.patch` применяется строго после первого и добавляет три защиты от зависания на мёртвом H2-соединении: таймаут первого байта ответа 15 с (при полной тишине на соединении оно закрывается), H2 PING каждые 12 с с ack-таймаутом 5 с (нет ack и нет входящих байтов - соединение закрывается и заменяется новым при следующем запросе) и `failed_until` для lane с экспоненциальным баном 5 с -> 60 с (сброс после успешного ответа; если в бане все lane, берётся уже открытый lane с наименьшим `failed_until`, но только когда до конца бана осталось не больше `LANE_BAN_BASE`, иначе открытие H2 возвращает `None` и работает запасной WS-маршрут). «Мёртвым» маршрут считается по отсутствию HEADERS/DATA по любым стримам после отправки запроса; ack на PING от edge Cloudflare в счёт не идёт. Повторная проба (replay) без первого байта на живом соединении lane не банит. Параметры вынесены константами в начало `proxy/cf_h2.py` и `proxy/h2_transport.py`. WS-мосты (`bridge_ws_reencrypt`) и протокол не менялись.

## Зафиксированные входы

- Upstream: `https://github.com/Flowseal/tg-ws-proxy.git`, tag `v1.11.2`.
- Ожидаемый upstream commit до патча: `307a384ab7f522e34bb1a045884d0bd90f40bee5`.
- Python: `3.12.14`.
- Python-пакеты: точные версии из `requirements-build.txt`; `pip` не закреплён этим файлом.
- Локальные патчи, порядок применения: сначала `scripts/telegram-runtime/cf-h2-selection.patch`, затем `scripts/telegram-runtime/h2-liveness.patch`.

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
$patches = @(
    (Join-Path $repo 'scripts\telegram-runtime\cf-h2-selection.patch'),
    (Join-Path $repo 'scripts\telegram-runtime\h2-liveness.patch')
)
$requirements = Join-Path $repo 'scripts\telegram-runtime\requirements-build.txt'

New-Item -ItemType Directory -Path $build -Force | Out-Null
git clone --depth 1 --branch v1.11.2 https://github.com/Flowseal/tg-ws-proxy.git $source
if ($LASTEXITCODE -ne 0) { throw 'Source clone failed' }
$sourceCommit = (git -C $source rev-parse HEAD).Trim()
if ($sourceCommit -ne '307a384ab7f522e34bb1a045884d0bd90f40bee5') {
    throw "Unexpected upstream commit: $sourceCommit"
}
foreach ($patch in $patches) {
    git -C $source apply --check $patch
    if ($LASTEXITCODE -ne 0) { throw "Patch check failed: $patch" }
    git -C $source apply $patch
    if ($LASTEXITCODE -ne 0) { throw "Patch application failed: $patch" }
}

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

Хеш каждого патча: `Get-FileHash -Algorithm SHA256 <патч>`.

## Заметка о размере EXE

Прежний `tg-ws-proxy.exe` (14 866 887 байт, версия `1.11.2-social.1`) собирался другим окружением: в него попали `ucrtbase.dll` и 43 файла `api-ms-win-*.dll`. PyInstaller 6.10.0 из `requirements-build.txt` их исключает, поэтому EXE `1.11.2-social.2` (около 13,8 МБ) меньше; разница объяснена этим, а не потерей кода. Процедура выше выполняется целиком из `$source` (клон v1.11.2 с двумя патчами), хеш EXE в `provenance.json` относится к такой сборке.

## Тест liveness (без сети)

После применения патчей и создания `$venv`, до сборки EXE. Запускайте из корня репозитория, не из клона; `-I` отключает текущую папку и `PYTHONPATH`, поэтому путь к клону передаётся аргументом:

```powershell
& $venvPython -I scripts\telegram-runtime\test_h2_liveness.py $source
```

Исходные тесты upstream (только прокси-часть; `test_h2_settings` и `test_tray_common` не импортируются без `psutil`, которого нет в `requirements-build.txt`, это не ошибка патчей):

```powershell
& $venvPython -I -m unittest discover -s "$source\tests" -t $source -p 'test_[bchepfrt]*.py'
```

`--help` можно использовать для проверки CLI. Не запускайте прокси для сетевого подключения в рамках проверки сборки.
