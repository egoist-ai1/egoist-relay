# Нейтральная тема: доказательства отдельного этапа

Этот receipt относится к двум файлам, переданным root до интеграции spinner aliases и остальных изменений фронтенда. Он подтверждает изолированные проверки темы; итоговая сборка и общая приёмка находятся в основном отчёте цикла.

Проверенный SHA-256 `src/util/antigravityThemes.ts`: `3529aae5ef1fcb13712f78e10e1492232bed97f4afb63aa16835c75ab8245274`. Проверенный SHA-256 тестов: `76ea43ce6566a8c889d9b490ab8a2bd80d0316a923a41b0512ce7a13e1b813d7`.

| Проверка | Наблюдаемый результат |
|---|---|
| Baseline, новые регрессии темы | 17 ожидаемых провалов, 15 успешных сценариев, exit 1 |
| После реализации и уточнения типов тестового RGB reader | 32/32, exit 0 |
| TypeScript: main / script / tests | Все exit 0 |
| ESLint двух изменённых файлов | Exit 0, без сообщений, heap 5120 МиБ |

Регрессии проверяют новый и сохранённый профиль, заблокированный localStorage, нейтральные CSS-роли, читаемые метаданные, согласованность RGB, семантические состояния, очистку предыдущих переменных и `theme-color`. DOM и localStorage настоящие в jsdom; Storage mock используется только для запрета доступа. Очистка сохраняет постороннюю CSS-переменную.

## Red: вывод baseline

Исходный SHA-256: `735e5ad2d14d1ddf727b10c1eba6548690c6ba5e1cdffb2b140bba4e1c10dc2b`. Ниже выдержка фактического `theme-red-refined.log`:

```text
FAIL  src/util/antigravityThemes.test.ts > Relay theme selection > Starts a fresh profile with the OLED theme
FAIL  src/util/antigravityThemes.test.ts > Relay theme selection > Recovers an unsupported saved variant to the OLED theme
FAIL  src/util/antigravityThemes.test.ts > Relay theme selection > Uses the default when storage access is blocked
FAIL  src/util/antigravityThemes.test.ts > Neutral Telegram palette > Applies neutral control, bubble and metadata colors without inherited blue
FAIL  src/util/antigravityThemes.test.ts > Neutral Telegram palette > Keeps metadata and secondary controls readable on raised surfaces
FAIL  src/util/antigravityThemes.test.ts > Neutral Telegram palette > Aligns RGB roles with their displayed colors
FAIL  src/util/antigravityThemes.test.ts > Theme switching boundaries > Removes OLED-only roles when changing to dark-modern
FAIL  src/util/antigravityThemes.test.ts > Theme switching boundaries > Removes OLED-only roles when changing to dark-plus
FAIL  src/util/antigravityThemes.test.ts > Theme switching boundaries > Removes OLED-only roles when changing to tokyo-night
FAIL  src/util/antigravityThemes.test.ts > Theme switching boundaries > Removes OLED-only roles when changing to monokai
FAIL  src/util/antigravityThemes.test.ts > Theme switching boundaries > Removes OLED-only roles when changing to abyss
FAIL  src/util/antigravityThemes.test.ts > Theme switching boundaries > Removes OLED-only roles when changing to solarized-dark
FAIL  src/util/antigravityThemes.test.ts > Theme switching boundaries > Removes OLED-only roles when changing to light-modern
FAIL  src/util/antigravityThemes.test.ts > Theme switching boundaries > Removes OLED-only roles when changing to light-plus
FAIL  src/util/antigravityThemes.test.ts > Theme switching boundaries > Removes OLED-only roles when changing to quiet-light
FAIL  src/util/antigravityThemes.test.ts > Theme switching boundaries > Removes OLED-only roles when changing to solarized-light
FAIL  src/util/antigravityThemes.test.ts > Theme switching boundaries > Removes a compact menu override when the next variant uses its base style
Test Files  1 failed (1)
Tests  17 failed | 15 passed (32)
Start at  13:25:05
Duration  764ms (transform 22ms, setup 14ms, import 33ms, tests 79ms, environment 508ms)
```

## Green: вывод после реализации

Ниже выдержка фактического `theme-green-final.log`:

```text
Test Files  1 passed (1)
Tests  32 passed (32)
Start at  13:28:44
Duration  793ms (transform 20ms, setup 19ms, import 32ms, tests 129ms, environment 498ms)
```

Команда использует существующий Vitest и конфигурацию проекта с переопределённым runtime cacheDir, `--configLoader runner --silent=true --no-cache`. Финальный запуск не содержит warnings. Первое исполнение с bundle loader выдавало warning об optional `@vitejs/devtools/config`; зависимости не устанавливались, runner loader устраняет этот warning конфигурационного bundling.

## TypeScript и ESLint

Успешные команды не выводили диагностику. Exit codes сохранены сразу после каждого запуска в фактических runtime receipts:

```json
{
  "tsconfig.json": 0,
  "tsconfig.script.json": 0,
  "tsconfig.test.json": 0,
  "affected ESLint, heap 5120 MiB": 0
}
```

TypeScript выполнялся установленным `node_modules/typescript/bin/tsc` для трёх проектных конфигураций с отдельным `--tsBuildInfoFile` в runtime. ESLint выполнялся для `src/util/antigravityThemes.ts` и `src/util/antigravityThemes.test.ts` с `--max-old-space-size=5120` и отдельным runtime cache.

Первый script/test type check выявлял nullable channels (`number | null`) из типов colorjs. Test-only `readRgbChannels` проверяет числовой канал; последующие script/test проверки и тесты проходят. Production-файл не менялся после успешной main TypeScript проверки.

## Граница доказательств

Это не проверка живых аккаунтов, native WebView, DPI/GPU, полного suite или финальной production-сборки. Root проверяет взаимодействие новой палитры с общими токенами и локальными overrides после объединения изменений. Успешные проверки при публикации выдержки не повторялись.

[Машиночитаемый receipt](verification-neutral-theme.json) содержит фактические exit codes, проверенные file hashes и SHA-256 исходных логов. Включение результата в общий review board фронтенд-цикла выполняет root; отдельное согласование на уже выбранную пользователем реализацию не требуется.
