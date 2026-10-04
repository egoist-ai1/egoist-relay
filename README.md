# Egoist Relay

**Egoist Relay 1.4.7** — неофициальный Windows-хаб Telegram, X и Instagram.

Оболочка сохраняет отдельные WebView2 и профили сервисов между переключениями. Скрытые медиа приостанавливаются. Telegram использует локальный MTProxy Egoist Lagom при доступной службе; адрес и secret читаются из защищённой конфигурации и передаются только внутри локального процесса. X и Instagram наследуют текущую сетевую конфигурацию Windows. Relay не перенастраивает DNS, Zapret или другие службы.

Диалоги используют общий учёт открытых окон, корректно закрываются при вложении и учитывают уменьшение анимации. Размеры ограничены viewport при увеличении текста; заголовки имеют доступное имя и подсказку. Отложенное открытие отменяется при закрытии и размонтировании. Панель Reels сохраняет нативные счётчики, а пересылка выбирает однозначный permalink поста; ссылка в подписи не скрывает действие Telegram. Поиск существующих кнопок в каждом проходе выполняется через общий индекс.

Подготовка медиа учитывает общий дедлайн и отмену до запуска worker. Проверка Node ограничена двумя секундами на кандидата. Синхронный WinHTTP PAC сохраняет фазовые ограничения Windows: немедленная отмена внутри этого вызова не гарантируется; после его возврата просроченная операция не запускает загрузчик.

## Сборка и проверки

```sh
npm run release:preflight
npm run check
npm test
npm run tauri:build
```

Требуются locked зависимости, Node.js 24, Rust/MSVC, Windows SDK и NSIS; Telegram API credentials находятся в локальном `.env`. Runtime включает только ресурсы из `scripts/release-runtime-manifest.json`. Обновление сохраняет пользовательские профили и неизвестные файлы.

Результаты версии: [docs/RELEASE-1.4.7.md](docs/RELEASE-1.4.7.md). Исходники публикуются в egoist-ai1/egoist-relay. Установщик не публикуется: соответствующие исходники сторонних бинарных зависимостей остаются неполными.

## Фоновая диагностика

Поддерживается привязанный к экземпляру Egoist Relay Control API. Исследовательский Social MCP использует authenticated Windows named pipes. Диагностические данные и аккаунты не входят в публичный исходный архив.


## Публичный пакет исходников

Этот пакет содержит исходники 1.4.7, проверенные публичные тесты и дополнительные исходники Egoist Social MCP.

[Изменения](docs/RELEASE-1.4.7.md) · [Сборка](BUILDING.md) · [Проверки](docs/VERIFICATION.md) · [Приватность](SECURITY.md) · [Архитектура](docs/ARCHITECTURE.md) · [Сторонние зависимости](THIRD-PARTY.md).

Проверены три конфигурации TypeScript, 26 Vitest suites / 322 tests и 43 native tests. Подробный статус других проверок и оставшихся ограничений указан в VERIFICATION.md. Проверки реальных авторизованных сервисов в текущем выпуске не приняты; полная квалификация выпуска приложения не заявляется.

Runtime binaries, models, credentials, cookies, account profiles and developer machine reports are excluded. Vendored Tauri source and license notices remain included. The binary corresponding-source gate remains unresolved; this publication does not clear it.
