# Egoist Relay 1.4.6 — подключение к Lagom и полный установщик

Подготовлен локальный совместимый patch Relay1.4.6. Полный штатный установщик готов к установке Root. Этот отчёт относится к исходникам и собранному пакету; установленный экземпляр, его аккаунты и Startup данный агент не менял.

## Доказанный отказ подключения

Normal-user Node воспроизвёл EPERM при открытии защищённой конфигурации Lagom Telegram. Предыдущая ветка инициализации Relay после такого отказа возвращала transport unavailable; GramJS выбирал прямой официальный WebSocket и сохранял этот выбор для текущего API init. Получение работающего MTProxy из Lagom отсутствовало при обычных правах пользователя. Это объясняет отказ автоматической связки Relay с Lagom, но не доказывает причину каждого внешнего сообщения «ожидание сети» или прежних DNS-разрывов. Исходная диагностика: [relay-bridge-audit.md](../../../Egoist%20Lagom/docs/social-coexistence-2026-10-03/relay-bridge-audit.md).

## Фактический механизм

Telegram использует существующий транспорт GramJS WebSocket → принадлежащий Relay локальный Node-адаптер → TCP MTProxy Lagom. Сохранены обфускация AES-CTR, abridged transport, DC1–5 и media DC. X и Instagram используют свои WebView2 профили и действующие системные DNS/обход Lagom. MTProxy является транспортом Telegram; он не задаётся в качестве HTTP-прокси для X/Instagram. Подключение голоса/WebRTC не следует из успешного TCP-пробника.

Root создал отдельную приватную проекцию `%LOCALAPPDATA%\EgoistRelay\interop\lagom-telegram.json`. Она содержит ровно schemaVersion1, loopback host, port и32hex secret. Конфигурация Lagom, privateDoH и IP его DC не копируются в Relay. Проекция расположена вне папки бинарной установки, не входит в Setup; права защищённой Runtime Lagom не расширены. Содержимое secret в отчёты и stdout не выводилось.

## Четыре целевых изменения

| Источник | Применённое поведение |
|---|---|
| scripts/telegram-transport.mjs:332 | При EPERM/EACCES/отсутствии защищённого config читает только фиксированную per-user проекцию. Проверяет exactshape, loopback, размер, обычный путь, realpath/links, стабильность прочитанного файла. Обнуляет буферы secret. Некорректная основная конфигурация не подменяется fallback. |
| scripts/telegram-transport.mjs:195 | При ранней недоступности Lagom оставляет стабильный WebSocket endpoint; для каждого нового соединения перечитывает конфигурацию и ограничивает TCP-попытки/таймеры. Уже рабочее соединение не перезапускает. |
| tauri/src/telegram_transport.rs:77 | Восстанавливает только собственный worker с прежними loopback port/token. Cancellable backoff1/2/4/8секунд, сброс после30секунд стабильной работы. Диагностика ограничена enum-причинами, без URL-токена и secret. |
| tauri/src/lib.rs:128 | `--start-hidden` задаёт hidden/no-focus до создания окна; повторный скрытый запуск не забирает фокус. Tray Open и обычный повторный запуск доступны. |
| src/components/App.tsx:534 | После регистрации listeners выполняет существующие hidden prewarm-команды X и Instagram. Учитывает блокировку/неактивное окно и unmount; ошибки каждой команды независимы от Telegram. |

Реестр всех3307 production inputs сравнен с опубликованным freeze1.4.6. Отличаются ровно четыре указанных файла; остальные3303 совпадают. Все3307 сохранены неизменными после source freeze и окончательной сборки. Настройки/службы/DNS/маршруты/адаптеры Windows этот агент не изменял; живые службы не останавливались.

## Проверки и результат

| Проверка | Результат |
|---|---|
| Node syntax, TypeScript, ESLint затронутых исходников | Exit0 |
| Существующие Vitest | 8/8: network selection3 и AppSidebar5 |
| Normal-user чтение приватной проекции и bare loopback TCP к текущему Lagom listener | Успех; без аккаунтных операций/внешних MTProto-запросов |
| Общий ESLint1878файлов | Две существующие docs parse-ошибки вне tsconfig, одна warning; правила не подавлялись |
| Release preflight / production frontend | Exit0;40runtime source SHA проверены |
| Окончательный native release + полный NSIS | Exit0;719.562секунды |
| Статическое чтение фактического packed EXE | Полный UI и adapter bytes embedded; payload извлечён без запуска |

При сборке использованы существующие Node24.21/Cargo offline locked/MSVC14.44/SDK10.0.26100. Окружение задавалось только дочернему процессу. Использованные40 runtime-файлов и offline Microsoft WebView2 сохранены; новые библиотеки не устанавливались. Ранние неудачные toolchain-попытки и отклонённый промежуточный пакет с ошибочной абсолютной frontendDist зарегистрированы отдельно. Промежуточный пакет не устанавливался и не распространялся. Окончательная относительная frontendDist дала ожидаемый полноценный80.96MB EXE с проверенными фактическими UI byte spans.

## Готовый пакет

`release/1.4.6-lagom-interop/Egoist Relay_1.4.6_x64-setup.exe`

| Объект | Размер | SHA256 |
|---|---:|---|
| Полный Setup | 570618798 B | b521b6055d68bc930483b98b0952ae1a8c242f6d74511a1b76d380bcdaf6a2e8 |
| Ожидаемый установленный Egoist Relay.exe, непосредственно из Setup | 80960000 B | 899d06548a994766d8dd70a55a10c6aaff4c307564f1d7bbed1127eafbff996b |
| Восстановленный bundler target EXE | 80960000 B | f37412269dfbfa7bdcb1ad68efd71dcc21141e551828ba15d60d2ca29ac4e534 |

Последние два хеша отличаются ровно тремя байтами штатного Tauri bundle-type slot UNK→NSS; строгий readback фиксирует смещения. Для проверки установленного EXE применяется хеш899d0654…, непосредственно полученный из Setup. Product/FileVersion и installer/native ProductName прочитаны штатным Windows API: Egoist Relay1.4.6; обе записи NotSigned. Исторический `release/1.4.6` Setup SHA3f723548… сохранён без изменений. Полный механизм установки: currentUser/Russian/x64/LZMA, прежние icons/header/sidebar/hook, offline WebView2 minimum143, updater OFF. Все40 runtime-пути/размеры прочитаны из фактического NSIS, sourceSHA проверены preflight; полный повторный hash extraction всех40 packedфайлов не выполнялся.

## Установка и эксплуатационные границы

Root выполняет установку и readback живого экземпляра отдельно. Главный процесс Relay закрывается через существующий tray Quit/`app.exit(0)`; WM_CLOSE только скрывает окно. Подтверждённого CLI `--quit` нет. Setup hook требует закрытый главный процесс и не завершает его самостоятельно. Подробности и точный локальный process plugin API: [installation-semantics.md](installation-semantics.md). Фоновый старт допускает per-user Startup shortcut с `--start-hidden`; этот агент ярлык не создавал.

Обычный запуск/перезапуск/stop-start Telegram службы Lagom сохраняет существующий key/port, поэтому созданная проекция остаётся применимой. Ручная смена key/port в Lagom требует обновления отдельной проекции; Relay не получает административный доступ к полному Runtime. Живая UI/account-проверка Telegram/X/Instagram, долгий режим24/7, доступность всех CDN и отсутствие внешних обрывов здесь не подтверждаются. Сборка не заявляет субсекундного восстановления всех TCP/WebRTC сессий. Публикация GitHub не выполнялась.

## Проверяемые материалы и обратная связь

Авторитетные receipts: [release-ready.json](release-ready.json), [packed-payload-readback.json](packed-payload-readback.json), [native-embedded-assets.json](native-embedded-assets.json), [pe-metadata.json](pe-metadata.json), [baseline-comparison.json](baseline-comparison.json), [source-patch.diff](source-patch.diff), [source-checks.json](source-checks.json). Source-checks сохраняет отдельный статус старых общих lint-ошибок, успешные целевые проверки не подменяют общий lint.

Нейтральный реестр значимых объектов: [review-objects.json](review-objects.json), snapshotSHA256 `c5a17786bfb625f381d189955e1e516ec70b81d353bdbb9c12217113a561dae4`. Root включает exact IDs/версии в общий companion review board с ✓/✕/? и комментарием. Выбор не встроен в интерфейс Relay; отсутствие ответа не означает согласия и не добавляет ожидания к уже порученной установке.

## Фактическая установка Root и уточнение видимости

[Receipt установки](relay-installation-receipt.json): обычная per-user установка завершилась 3 октября в 16:40:41 МСК с NSIS 0; установленный EXE совпал с payload SHA256 `899d06548a994766d8dd70a55a10c6aaff4c307564f1d7bbed1127eafbff996b`. Root заменил точно проверенный собственный процесс Relay; это не была общая очистка процессов.

[Реальный worker](installed-worker-payload-readback.json) совпал с embedded JS: 58338 байт, SHA256 `6c9377f1992b3aa21061b25f523fd25c40b85cf4a24f0a3b20a84a053c6b8775`; он подключён к локальному TG-прокси Lagom. Автозапуск и фактический --start-hidden подтверждены. Позднее окно пользователь открыл сам — прямой ответ «Да, открывал сам». Ошибка автоматического показа не установлена; исходники и Setup после аудита не менялись. Немедленная видимость после старта и следующий вход Windows отдельно не измерялись. Основной итог этапа Root и ограничения доставки/тайм-аутов — в [отчёте совместимости](../../../Egoist%20Lagom/docs/social-coexistence-2026-10-03/README.md).
