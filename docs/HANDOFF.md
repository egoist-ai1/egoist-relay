# HANDOFF — Egoist Social (папка `Egoist Relay`)

Состояние на 24.10.2026. Читать первым при возобновлении работы. Правила проекта — `AGENTS.md`, дизайн — `docs/DESIGN.md`, сеть — `docs/product-cycle-2026-10-13/NETWORK-TUNNEL.md`.

## Версии

| Что | Версия | Где |
|---|---|---|
| Код (`lagom-redesign`) | **1.9.10** (`3ab231c`) | основное дерево, ветка слита fast-forward, не запушена |
| Установлена на ПК | 1.9.10 | `%LOCALAPPDATA%\Egoist Relay` |
| Опубликована на GitHub | 1.9.4 (`relay-v1.9.4`, pre-release) | `egoist-ai1/egoist-relay`, ветка `lagom-redesign` = `5419a62` |
| Установщики | 1.9.9, 1.9.10 (1.9.8 удалён 24.10) | `release/<версия>/`, вне Git |

Коммиты 1.9.5–1.9.10 есть только локально. `push` — только по «да» владельца (в `origin` пушить как ветку `lagom-redesign`, без force; история `main` на GitHub не связана с локальной).

Social MCP: `Проекты\Инфраструктура\Egoist Social MCP`, `main` = `51242e5` (аудитные правки слиты 24.10, ветка `audit-fixes-2026-10-17` осталась). Демон MCP может работать на старом коде до перезапуска.

## Что сделано в цикле 1.9.x (по релизным заметкам)

- 1.9.0–1.9.4: имя и знак «Egoist Social», собственный туннель (Xray, VPN+DoH вшиты в установщик), отдельные настройки, тихое обновление без потери ярлыков и закрепления.
- 1.9.5–1.9.8: DoH-таймаут, TG-прокси (H2 multiplexing для медиа), см. `docs/RELEASE-1.9.5.md` … `RELEASE-1.9.8.md`.
- 1.9.9–1.9.10: аудит 17.10.2026 — Xray API на приватном unix-сокете (уникальное имя на запуск, проба AF_UNIX, запасной каталог в ProgramData), tg-ws-proxy 1.11.2-social.2 (h2-liveness), прогрев X/Instagram, ошибки исследования (`ACCOUNT_RESTRICTED`, `PLATFORM_ERROR`). Детали — `docs/RELEASE-1.9.9.md`, `RELEASE-1.9.10.md`.

## Открытые задачи

1. Живая проверка трафика: Xray на сокете и tg-ws-proxy social.2 на реальных данных (в 1.9.10 тестами проверена только логика).
2. Фронтенд: у результата `REFRESH_BUSY` нет текста для пользователя.
3. tg-ws-proxy: патч-сборка из upstream + запись provenance (`scripts/telegram-runtime/`); сейчас собранный `runtime/telegram/tg-ws-proxy.exe` (SHA-256 `9d255211…`) берётся готовым.
4. Срок хранения raw-архива исследования не решён; в MCP не сделаны `goal.query`, сжатие raw, ленивая очередь.
5. До публичного релиза для других пользователей убрать фичу `devtools` из `tauri/Cargo.toml`.
6. Вопрос владельцу: запрет `taskkill /IM node.exe` в `hooks/guard.py` (мешает диагностике).
7. Предупреждения Stylelint (507) — давние, не блокируют.
8. Публикация: решить, выпускать ли 1.9.10 на GitHub (обновить README репозитория, release notes, проверить `main`).

## Как собирать и проверять

```sh
# сборка идёт из ASCII-пути: junction C:\e\relay -> папка проекта
npm run version:sync && npm run check && npm test
npm run release:preflight        # 99 файлов runtime, секреты
npm run tauri:build              # из C:\e\relay
node scripts/build-installer.mjs # -> release/<версия>/ + SHA256SUMS.txt
```

- Rust: `cargo test --lib` в `tauri/` (1.9.10: 270 пройдено, 1 ignored); тесты работы с каталогом требуют `EGOIST_RELAY_TEST_WORK=<папка>`.
- MCP: тесты требуют `EGOIST_RESEARCH_TEST_WORK=<абсолютный путь к пустой папке work>`; 312 тестов проходили на 17.10.
- Vitest: `research.contract.test.ts` падает из-за CRLF рабочей копии — не дефект.
- `provisioning.local.json` (ключ VPN и DoH) лежит в корне, в Git не попадает; `.env` не читать.
- Установленное приложение без «да» не трогать; технические id (`com.egoist.relay`, Control API, MAGIC установщика) не переименовывать.
- Известная особенность машины: AF_UNIX под `AppData` не работает (ошибка 1920), сокеты — в `C:\ProgramData\EgoistRelay`.

## Что где в `docs/`

- Актуальное: `PRODUCT.md`, `DESIGN.md`, `CODE-STYLE.md`, `TAURI.md`, `RELEASE-1.7.x`, `RELEASE-1.9.x`, `brand/`, `lagom-redesign-2026-10-07/`, `product-cycle-2026-10-13/`, `web-proxy-*.md`.
- Справочные, на них ссылаются README или тесты: `app-quality-audit-2026-10-02/` (тесты `instagram-attribution-*` читают его), `frontend-cycle-2026-10-06/`, `hotfix-1.6.1/`, `release-1.5.0/`.
- `archive/` — аудиты, планы и релизные заметки версий до 1.8 (перенесены 24.10.2026 через `git mv`, история сохранена).

## Прочее

- Выгрузки Social MCP — `Проекты\Материалы\Социальные исследования` (162 папки, 2,1 ГБ), это данные владельца; резерв хранилища исследований перед аудитом — `C:\e\backup-research-store-20261017` (удалить после подтверждения, что новое хранилище в порядке).
- `Egoist Relay Legacy` содержит уникальную папку `Egoist Relay Native`; `releaseengine-source/` — исходники Xray для лицензий. Не удалять.
- Отчёт аудита: `Проекты\Исследования и отчёты\2026-10-17 Аудит Egoist Social\ОТЧЁТ.md`.
