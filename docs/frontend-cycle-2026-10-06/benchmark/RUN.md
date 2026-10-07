# Relay: воспроизводимое браузерное сравнение

Подготовлен scripts/relay-frontend-benchmark.mjs. Парное сравнение выполнено: три пары,1200действий; [2026-10-06T12-27-37-098Z-ea6a13ef](2026-10-06T12-27-37-098Z-ea6a13ef/README.md). Интерпретация и границы: [benchmark-assessment.md](../benchmark-assessment.md). verification-api-smoke.json остаётся первоначальной проверкой API на about:blank, не замером Relay.

Выполняющий агент сначала завершает сборку и тяжёлые проверки, фиксирует исходники и только затем разрешает запуск переменной READY. Frozen baseline не читается при --help или --smoke.

## Запуск в текущем task runtime

Замените единственный placeholder на уже подготовленный абсолютный путь frozen source. Этот каталог должен содержать src/, package.json и package-lock.json. Vite/TS support-конфиги хешируются только при наличии; отсутствие перечисляется в missingSupportSources. Не добавляйте текущие конфиги в baseline как исторические. Не создавайте baseline из изменённого кандидата.

```powershell
$relayProject = 'C:\Users\Egoist\Desktop\Проекты\Приложения\Egoist Relay'
$benchmarkBrainPointer = Get-Content -LiteralPath "$env:USERPROFILE\.codex\brain-pointer.json" -Raw | ConvertFrom-Json
$benchmarkTaskPaths = (& (Join-Path ([string]$benchmarkBrainPointer.root) 'brain.cmd') task paths --id $env:CODEX_THREAD_ID | Out-String) | ConvertFrom-Json
$env:RELAY_FRONTEND_BENCHMARK_OUTPUT = Join-Path ([string]$benchmarkTaskPaths.work) 'relay-frontend-benchmark'
$env:RELAY_FRONTEND_BASELINE = '<ABSOLUTE_FROZEN_SOURCE_DIRECTORY>'
$env:RELAY_FRONTEND_BENCHMARK_READY = '1'
Push-Location -LiteralPath $relayProject
try {
    & node scripts/relay-frontend-benchmark.mjs
    $benchmarkExitCode = $LASTEXITCODE
} finally {
    Pop-Location
    Remove-Item Env:RELAY_FRONTEND_BENCHMARK_READY -ErrorAction SilentlyContinue
}
Write-Output "Benchmark exit=$benchmarkExitCode"
```

По умолчанию: установленный Edge, headless, порт 1289, 20 наблюдений каждой метрики в одном прогоне. Можно изменить RELAY_FRONTEND_BROWSER, RELAY_FRONTEND_BENCHMARK_PORT, RELAY_FRONTEND_BENCHMARK_SAMPLES (10–100) и RELAY_FRONTEND_BENCHMARK_EVIDENCE. Runtime output всегда должен принадлежать фактической выполняющей задаче.

## Сопоставимые условия

Три пары: baseline → candidate; candidate → baseline; baseline → candidate. У каждого прогона новый локальный browser profile, одинаковые MockClient, native terminal mocks, RU, egoist-dark, root font 16px, LTR, 1920×1080. Три цикла прогрева исключены. После действий — 180 мс для установления состояния. Сеть за пределами audit origin и удалённые WebSocket закрыты.

Цикл: открыть чат 101; посеять синтетический результат сохранения; Ctrl+J открывает историю; действие «Открыть файл» записывается native mock; закрыть панель; переключить X → Instagram → Telegram; добавить синтетическую текущую операцию; Ctrl+J; выбрать историю; закрыть панель. Сохранение и отправка байтов не выполняются. Имя, размер и разрешение тестового фото фиксированы, состояние ролика — 60%.

Начало времени фиксируется в браузере через performance.now() на captured click/keydown либо непосредственно перед вызовом открытия чата. Конец — два последовательных RAF, в которых достигнуто целевое видимое состояние. Сохраняются отдельные наблюдения, median/p95/min/max каждого прогона и затем диапазон трёх batch medians. Для ratio >1,10 предупреждение возникает только при candidate.min > baseline.max; перекрытие диапазонов не объявляется доказательством равенства.

После измерения сохраняются settled снимки и геометрия при 1100×800: чтение, профиль, профиль с панелью. В geometry записаны bounds, display/visibility, aria-hidden/inert, horizontal overflow и наблюдаемое перекрытие центра. Наличие DOM не считается доказательством видимого профиля.

## Ресурсы и покрытие

CDP SystemInfo.getProcessInfo даёт PID именно запущенного browser. Get-CimInstance читает только PID/PPID и строит дерево этого PID; Get-Process запрашивается только для дерева. Измеряются CPU и PrivateMemorySize64, дополнительно CDP cumulative cpuTime. Командные строки, названия чужих процессов и profile paths не сохраняются. Наличие остальных Edge не расширяет выборку.

CPU считается по разности до/после циклов только при полном покрытии и неизменном составе дерева; при churn или пропущенном процессе сравнение помечается incomplete. Windows brackets включают задержку probes; CDP cross-check окружает только measured cycles. Эти величины не объединяются. Private bytes — endpoint snapshots, максимум двух snapshots не объявляется пиком.

## Evidence и ограничения

Каждый запуск создаёт каталог timestamp+UUID в docs/frontend-cycle-2026-10-06/benchmark: source-identities.json, results.json, шесть batch JSON, README с таблицей и 18 PNG. SHA-256 фиксирует фронтенд, package/lock, доступные support config-файлы и текущий audit harness/dependencies; отсутствие optional config-файла отдельно записано. Изменение этих файлов во время запуска инвалидирует сравнение.

Frozen 1.5.0 используется как source overlay. Оба прогона используют текущие audit harness, установленные зависимости и одинаковую изолированную Vite-конфигурацию (configFile:false); APP_VERSION берётся из текущего package.json кандидата и одинаков для обеих ветвей. Исторический упакованный runtime не воспроизводится; версия macro явно включена в results.json.

Измеряется дерево headless browser, без Node/Vite и native Tauri. Это не измерение физического GPU/DPI или всей установленной программы. Живые аккаунты, сеть, сохранённые на диск байты и качество отправки не проверяются. До парных данных улучшение скорости не заявляется.

Объекты для итогового review board проекта: review-objects.json. Ответы пользователя не выбраны заранее.
