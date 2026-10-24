# Egoist Social (папка Egoist Relay)

Состояние, версии и открытые задачи — [docs/HANDOFF.md](docs/HANDOFF.md) (читать первым). Неофициальный Windows-хаб Telegram, X и Instagram: Tauri 2 (Rust) + Teact/GramJS (форк Telegram Web A, GPLv3). Отдельные профили WebView2 на сервис, локальные прокси, Node runtime и медиа-инструменты в `runtime/`. Версия — в `package.json` (`npm run version:sync` синхронизирует остальное). Общие правила владельца приходят из `C:\Users\Egoist\Desktop\EgoistCODEX AI\rules.md`; карта проектов — `..\..\PROJECTS.md`.

## Где что

| Путь | Что |
|---|---|
| `src/` | Приложение (TypeScript, Teact, SCSS-модули). Стиль, глобальное состояние, локализация — [docs/CODE-STYLE.md](docs/CODE-STYLE.md) (читать перед правкой `src/`) |
| `tauri/` | Rust-оболочка: `src/`, `tauri.conf.json`, `capabilities/`, установщик NSIS (`installer.nsh`) |
| `runtime/` | Бандл-инструменты (node, ffmpeg, yt-dlp, proxy) и лицензии; состав проверяет `release-runtime-manifest.json` |
| `scripts/` | Сборка, preflight, тесты оболочки (`release-*.mjs`, `relay-*.test.mjs`) |
| `docs/` | [HANDOFF.md](docs/HANDOFF.md), [DESIGN.md](docs/DESIGN.md), релизные заметки 1.7+; старые аудиты и планы — `docs/archive/` |
| `release/<версия>/` | Готовые установщики (вне Git) |

## Команды

```sh
npm run dev                 # режим разработки (веб)
npm run check               # tsc + eslint + stylelint
npm test                    # vitest
npm run release:preflight   # проверка конфигурации, runtime, секретов
npm run tauri:build         # установщик (нужны Node 24, Rust/MSVC, Windows SDK, NSIS)
```

Из Git Bash пути с пробелами и кириллицей — в кавычках. Сборка идёт из ASCII-пути, если инструмент не принимает кириллицу: `New-Item -ItemType Junction -Path C:\e\relay -Target '<папка проекта>'`.

## Правила работы

- Секреты: `.env` (Telegram API ID/hash) не читать и не печатать; `.env.example` — образец. Preflight проверяет, что секреты не попали в сборку.
- Менять только то, что относится к задаче; существующие типы и компоненты переиспользовать; новых библиотек не добавлять без причины.
- Релиз: `npm run version:sync` → `check` → `test` → `release:preflight` → `tauri:build`; установщик в `release/<версия>/` с `SHA256SUMS.txt`. Хранить 3 последние версии, старые удалять; обновить docs/HANDOFF.md.
- В Git не попадают `dist/`, `release/`, `scratch/`, бинарники `runtime/*.exe`, `whisper-env.zip` (см. `.gitignore`). Перед первым коммитом: `git rm -r --cached dist`.
- Коммиты — по шаблону из [docs/CODE-STYLE.md](docs/CODE-STYLE.md#commit-messages); `push` — только по просьбе владельца.

## Границы безопасности Tauri (решения, не недосмотры)

- CSP (`tauri/tauri.conf.json`) широкая намеренно: `connect-src` и `frame-src` допускают `http:`/`https:` для прокси, Telegram Mini Apps и кошельков; `script-src` разрешает только `https://t.me/_websync_` (стандарт Telegram Web A) и своё. Не расширять дальше и не добавлять другие внешние скрипты.
- `withGlobalTauri: true` нужен коду оболочки (`src/util/tauri/initTauriApi.ts`). Любая новая команда Tauri получает **отдельный файл** в `tauri/capabilities/` с `local: true` и только нужным webview (`main`), а не добавляется в `default.json`.
- `default.json` относится к Telegram-контенту: окна с UUID-метками (шаблон `????????-????-????-????-????????????`) получают тот же набор разрешений, включая `shell:default` (открытие ссылок) и `core:window:allow-destroy`. Не добавлять туда ничего сверх закрытия, показа и перетаскивания окон.
- Социальные окна X/Instagram ограничены `research-social.json` по удалённым URL; новые домены — только явным решением владельца.
- Фича `devtools` в `tauri/Cargo.toml` оставлена для диагностики владельцем; в публичный релиз для других пользователей её надо убрать.
- Версии `tauri` и плагинов зафиксированы (`=`); обновлять осознанно вместе с вендорным патчем в `tauri/vendor/`, затем `npm run release:preflight` и сборка.
- Управление приложением снаружи (Social MCP) идёт через Relay Control API по именованному каналу Windows с проверкой; его не открывать на сеть.
