# Egoist Relay 1.3.1 — итоговый аудит и проверенная сборка

Дата: 30 сентября 2026, Europe/Moscow. Платформа сборки и нативных проверок: Windows x64, WebView2 154. Обновление подготовлено из текущего проекта, включая сохранённые исправления 1.3.0.

**Статус: проверенный unsigned кандидат 1.3.1 для ручной установки. Публичный выпуск пока заблокирован.** Контрольное видео YouTube воспроизводится; нативное получение MP4 и отмена проходят. На текущем внешнем маршруте Instagram получает сброс соединения, Telegram — тайм-аут. Проверки чужих аккаунтов, независимого ПК и суточной эксплуатации не выполнены. Неполная поставка corresponding sources остаётся отдельным блокером публикации.

## 1. Что входит в результат

- [Установщик и инструкция](../release/1.3.1/README.md), [машинный протокол](../release/1.3.1/verification.json), [контрольные суммы](../release/1.3.1/SHA256SUMS.txt).
- [Исходники проекта](../release/1.3.1/Egoist-Relay-1.3.1-sources.zip), [manifest исходников](../release/1.3.1/source-manifest.json), [сведения об источниках зависимостей](../release/1.3.1/dependency-sources.json).
- [План оставшихся работ и критерии приёмки](RELEASE-ROADMAP-1.3.1.md).
- Подробные отчёты: [сеть](audit-1.3.1/network.md), [медиа](audit-1.3.1/media.md), [интерфейс](audit-1.3.1/ui.md), [упаковка](audit-1.3.1/release.md).

Эти четыре отчёта фиксируют результаты соответствующих этапов. Окончательные результаты сборки, установки и нативных проверок приведены здесь; они закрывают перечисленные там ожидания интеграции. [Аудит 1.3.0](AUDIT-1.3.0.md) сохраняется как история. Его описание собственного туннеля и личного установщика к версии 1.3.1 не относится.

Аудит охватывает критические пути frontend/backend, транспорт, обработку медиа, оболочку, IPC, зависимости и выпуск. Он не является построчной проверкой всех исходников сторонних библиотек или доказательством безошибочности каждого пользовательского сценария.

## 2. Сетевой контракт по последнему запросу

В поставляемом приложении нет собственного VPN/Xray, DNS-сервера, DPI engine, Telegram proxy bridge, импорта профиля Lagom или персонального enrollment. Удалены их запуск, мониторинг, восстановление, сетевой индикатор и кнопка переподключения. Сохранены обычные действия обновления страницы и настройки аккаунтов.

| Трафик | Как выбирается маршрут |
| --- | --- |
| Telegram, X, Instagram и окна входа | WebView2 использует действующую сетевую политику Windows. Relay не задаёт принудительный proxy или DNS flags. Telegram использует официальный WSS без собственного локального bridge. |
| Нативное получение медиа | Перед каждой новой операцией Rust читает текущую пользовательскую proxy policy Windows через WinHTTP. Node получает ровно выбранный proxy либо явное `direct`. |
| Direct-соединения | Обычные сокеты и системный resolver; уже действующие DNS, маршруты, TUN и DPI Lagom применяются на стороне ОС. |
| Proxy-соединения | Только endpoint, выбранный ОС. Фиксированных портов Lagom, поиска случайного listener и скрытого перехода на direct при ошибке нет. |

Relay не пишет hosts, registry proxy/DNS, routes, MTU, конфигурацию или службы Lagom. Его media/transcription helpers запускаются скрыто с приоритетом BelowNormal и принадлежат отдельным worker jobs. Это уменьшает конкуренцию фоновой обработки; приоритет всего WebView или всех процессов Lagom этим не изменяется. Запуск второго WinDivert/DPI/TUN исключён из новой поставки.

На проверяемом ПК manual proxy выключен, явного PAC нет; нативный WinHTTP сообщает AutoDetect=true, WPAD configuration не обнаружена. Выбранный маршрут — direct. Wi-Fi использует DNS 127.0.0.1; службы EgoistShieldSystemDoH и EgoistShieldZapret работают. Видимый default route проходит физический Wi-Fi. Наличие DoH/DPI не доказывает включение удалённого VPN или доступность каждого сервиса.

DNS меняет разрешение имён, DPI обход зависит от применённой внешней стратегии, а блокировку адресов/соединений они сами по себе не устраняют. На другом устройстве Relay наследует его сеть; он не устанавливает Lagom и не переносит персональный DNS автоматически. При блокировках нужен доступный внешний маршрут, настроенный в Windows/Lagom.

## 3. Найденные дефекты и выполненные изменения 1.3.1

| Проблема | Исправление | Подтверждение |
| --- | --- | --- |
| Несколько внутренних сетевых компонентов и самостоятельное восстановление мешали выбранной схеме Windows/Lagom | Удалены network/tunnel/dns backend, IPC управления сетью, polling, принудительные WebView overrides и три сетевых engine из payload | Preflight и точная проверка 37 runtime files; в нативной сессии нет собственных сетевых helpers, app listeners и WebViews с forced network flags |
| Node workers зависели от старого локального proxy, даже когда ОС выбирала direct | Явный маршрут на каждую операцию; очистка ambient proxy/TLS/runtime overrides; одинаковый маршрут metadata и download | TCP/TLS/HTTP/1.1/HTTP/2 и CONNECT/SOCKS fixtures; отказ proxy не вызывает direct fallback |
| Встроенный `node -e`/data URI превысил лимит командной строки Windows и давал `ENAMETOOLONG` | Файлы точных worker sources в принадлежащем операции каталоге; JSON через stdin; проверки имён, повторного использования и подмены, cleanup/cancel | Node/Rust регрессии и реальный нативный MP4 через Rust → Node → yt-dlp/ffprobe |
| В первом промежуточном кандидате после удаления сетевого startup осталось приложение в трее без main window | Main window создаётся в `Builder.setup` после инициализации трея | Cold launch окончательного установленного приложения создаёт main и оба service WebView; промежуточный установщик исключён из выдачи |
| Tao 0.35.3 паниковал `cannot move state from Destroyed` при воспроизведённом завершении сеанса Windows | Обновлены существующие Tauri/Tao/Wry до 2.12.0/0.37.1/0.57.0; release gate запрещает прежнюю цепочку | Отмена WM_ENDSESSION оставляет точную изолированную сессию живой; завершение выводит окончательный установленный exe с кодом 0 |
| Четыре TypeError чтения `plugins` в YouTube frame происходили в Tauri path initializer | Guard существующего `window.__TAURI_INTERNALS__?.plugins` в vendored Tauri 2.12.0; чужой frame не получает IPC object | Два VM теста; YouTube play/stop и последующие core checks окончательного payload: 0 зарегистрированных JS errors |
| Старые runtime files оставались после upgrade | Cleanup только точных старых размер/SHA-256 в выбранном INSTDIR; неизвестные, изменённые файлы и профили сохраняются | Из 59 seed files удалены 58 неизменённых, изменённый engine и пользовательские fixtures сохранены; uninstall также их сохранил |

Обновление жизненного цикла основано на официальном исправлении Tao для WM_ENDSESSION ([upstream PR](https://github.com/tauri-apps/tao/pull/1157)) и текущем [Tauri 2.12.0](https://github.com/tauri-apps/tauri/releases/tag/tauri-v2.12.0). Во время раннего smoke прежний binary также неожиданно завершился с той же паникой; исходный триггер того события не установлен. Воспроизведён и проверен конкретный сценарий session end, а не все возможные причины аварий.

Vendored Tauri содержит 143 upstream файла; изменён только `src/path/init.js`. Provenance, upstream SHA-256, локальный diff и лицензии MIT/Apache-2.0 включены в исходники. Guard не создаёт internals или новые разрешения. Обновлены существующие `tauri-build` 2.7.0 и npm `@tauri-apps/api` 2.12.0. Новых продуктовых библиотек по назначению не добавлено.

## 4. Интерфейс, стикеры и сохранённые функциональные исправления

Дизайн оболочки из 1.3.0 сохранён: согласованные размеры и состояния, единая кнопка icon+label для сервиса, полная подпись Instagram, keyboard navigation/focus, адаптивный caption и действия окна. В 1.3.1 удалён лишний сетевой блок и проверены текущие компоненты. Полное пересоздание интерфейса не заявляется. [Система дизайна](DESIGN-1.3.0.md) остаётся основой.

Полоса вместо стикера на исходном скриншоте возникала из-за monochrome emoji rule: контейнер 208×208 становился 20×208. Standalone sticker исключён из этого правила; размер берётся по исходному документу, aspect ratio сохраняется, время/реакции размещаются отдельно. Эти изменения включены в 1.3.1. Исторические 96 геометрических случаев и 288 проверок вложенных image/video/canvas в 1.3.0 проходят после исправления; они не выдаются за новый прогон настоящих TGS/premium стикеров в 1.3.1.

Сохранены leases и освобождение Blob URLs, защита от запоздалого сохранения отменённой загрузки, локализованные причины отказа CDN/media, ограниченное восстановление YouTube, безопасный reader и поиск документов, ограничения stream/DOM/DOCX inflate, deep links и измерение native bounds по реальной CSS области. Полная таблица первоначальных дефектов находится в [аудите 1.3.0](AUDIT-1.3.0.md).

| Запрошенная функция | Что фактически проверено | Что остаётся проверить |
| --- | --- | --- |
| Копирование изображения/документа | Unit-тесты формата, blob/fallback, признаков разрешённого действия и ошибок | Запись в настоящий глобальный Windows clipboard и вставка в стороннее приложение не выполнялись |
| Скачивание | Native save синтетического PNG 70 B с совпадением SHA-256; cancel завершён, файл отсутствует; реальный public MP4 744 412 B получен | Все Telegram форматы, защищённые/платные медиа, auth и большие реальные загрузки |
| Пересылка/добавление/публикация | Типизированные contracts, выбор descriptors, обработка отмены/ошибок, synthetic recipient/upload paths в тестах | Реальная отправка, публикация и загрузка в аккаунты не выполнялись; серверные права/лимиты этим не подтверждены |
| Открытие | Native main reuse, запрет чужого origin, close/restore того же профиля; reader и deep-link tests | Все системные file associations и все реальные документы/вложения |
| Обновление | Native upgrade fixture и запрет downgrade; действия reload/navigation оболочки | Обновление owner install не выполнялось; автоматический updater отключён |
| YouTube/Shorts | Точные play/stop iframe и native resolver контрольного публичного видео; распознавание Shorts/ошибок в unit tests | Точный Shorts другого пользователя, его аккаунт и сеть не получены; авторские/geo/bot restrictions не устраняются кодом |

## 5. Свежие автоматические проверки

| Проверка | Результат | Граница |
| --- | --- | --- |
| Vitest | **281/281**, 22 файла | Component/unit fixtures; включает 17 shell/bounds checks и 3 Telegram route regressions |
| Node | **68/68**, 0 skipped | 51 media, 12 release policy, 3 installer migration, 2 Tauri frame initializer |
| Rust | **17/17** | System proxy, workers, URL/input/cancel contracts; удалённые внутренние network suites не входят в новый набор |
| TypeScript | **0 errors**, 1 существующее предупреждение reader `dangerouslySetInnerHTML` | Не заменяет нативный запуск |
| SCSS | **0 errors**, 509 baseline warnings | Общий warning backlog не исправлен и не скрыт |
| Shell UI | **37 случаев**, 0 JS errors/горизонтальных переполнений | Headless Edge с mock native window |
| UI regression | **54 случая + 11 behavioral checks**, 0 geometry/browser errors | 800×560 / 1280×720 / 1573×1163, font 16/32 px; keyboard, длинный текст, error/login/reduced motion |
| Scoped ESLint / actionlint / PowerShell parser | PASS | Изменённые release/media/CI участки |
| Preflight | PASS | Версии, embedded UI, runtime allowlist, privacy, source imports, updater OFF |

Browser raster scale 1.25/1.5/2 дополнительно проверен; это не physical multimonitor Windows DPI test. При 800×560/32 px длинная карточка может требовать вертикальной прокрутки; все проверенные caption controls остаются доступны. Исчезновение горизонтального overflow не означает, что весь длинный текст одновременно помещается.

## 6. Нативная проверка окончательного payload

Все действия привязаны к точному процессу и пустому изолированному профилю через Relay Control SDK. Пользовательские аккаунты, foreground input и принудительное завершение owner процесса не использовались. Подготовленный test executable побайтно совпал с exe, извлечённым из окончательного production installer. Отдельный session-end прогон выполнен на точном установленном exe после isolated install.

| Сценарий | Результат |
| --- | --- |
| Cold launch / main / X / Instagram targets | Bound к точному приложению; main window создан. Первая привязка ожидания удалённого metadata завершилась тайм-аутом 15 s; поддерживаемая повторная привязка к тому же PID прошла без перезапуска |
| Core checks | **31/31**: 7 переключений/snapshots, native save/cancel, 3 window probes, 4 transcription cases, диагностика, короткий performance sample, normal shutdown |
| YouTube iframe | **PASS**, состояние playing; Stop → idle, iframe/video удалены; matching official embed referer hook зарегистрирован |
| Native public video | **PASS**, MP4 744 412 B; отдельная cancel операция подтверждена, terminal `MEDIA_CANCELLED`, settled |
| JavaScript diagnostics | **0 errors** в финальном play/stop и core интервале; не означает отсутствие всех ошибок remote providers |
| Windows session end | **2/2**: cancel остаётся живым; complete → exit 0, без Tao panic |
| Process/network inventory | 19 descendants, 0 Relay network helpers, 0 app listeners, 0 WebViews с forced proxy/DNS flags |
| Normal test exit | Подтверждён; test install после проверки штатно удалён |

Распознавание: synthetic Russian reference совпал; silence/malformed отклонены; cancel подтверждён и settled. Реальные пользовательские audio/transcripts в отчёт не включены.

Двухсекундный sample main WebView: 120 frames, median 16.7 ms, p95 16.8 ms, 0 long tasks. Это короткое наблюдение, без общего CPU/RSS, нагрузочного сравнения и суточного memory budget. В отдельном 180 009 ms startup interval — 5 659 read-only samples, 0 Relay foreground samples, 0 cursor/clipboard sequence changes. Интервал не охватывает всю последующую тестовую сессию и не доказывает отсутствие изменений при любых условиях.

На обычном завершении остаётся сообщение Chromium `Failed to unregister class Chrome_WidgetWin_0`, Error 1412. Выход проходит; отсутствие всех runtime warnings не заявляется. Сборка также выводит существующее предупреждение deprecated STATIC_VCRUNTIME и сообщения linker.

## 7. Реальные внешние отказы — остаются

| Сервис | Наблюдение окончательной сборки | Вывод |
| --- | --- | --- |
| YouTube | Official public sample воспроизводится, native MP4 доступен | Подтверждён один контрольный ролик на этом маршруте |
| X | Публичный document ready, ожидаемый title | Не проверены login, authenticated feed, все CDN/загрузка/пересылка |
| Instagram | `net::ERR_CONNECTION_RESET`, recovering, два document failure | На текущем внешнем маршруте доступа нет; требуется работающий внешний proxy/VPN маршрут |
| Telegram | `zws2.web.telegram.org/apiw1` → `net::ERR_CONNECTION_TIMED_OUT`, три fetch failure | Готовность оболочки не доказывает соединение с Telegram. Успешный login/MTProto на этой сети не подтверждён |

**31 core PASS не означает доступность Instagram или Telegram.** Эти checks доказывают работу управляемых механизмов, окон и локальных функций. Сеть с выключенным системным proxy может блокировать внешние endpoints. Relay не возвращает скрытый internal tunnel и не меняет Lagom для обхода этого отказа. Смена внешнего proxy во время уже начатой операции может её прервать; следующая операция получает актуальную policy. Бесшовная миграция установленного stream не обещается.

## 8. Installer и перенос

Один generic unsigned NSIS installer: **570 371 549 bytes**. Поставляет app и 37 runtime files, включая Node/media/transcription и лицензии; приватного DNS/tunnel profile нет. Большая часть размера связана с сохранёнными движками/моделью и offline WebView2 installer (212 373 712 B, подпись Microsoft Valid).

| Проверка | Результат и точный scope |
| --- | --- |
| Production LZMA | Финальный archive извлечён; версия app и 37/37 runtime hashes совпали, внутренних engines/enrollment нет |
| Install/uninstall | Изолированный NSIS template с отдельной identity/protocol и zlib, теми же final app/resources/hooks. Exact payload/registration/uninstaller проверены; штатное удаление успешно |
| Upgrade | Exact app 1.3.0 + synthetic registration → 1.3.1; новый app hash совпал; 58 exact legacy files удалены, changed/unknown/profile fixtures сохранены |
| Downgrade | Synthetic newer DisplayVersion 9.9.9: exit 1, app hash и версия сохранены |
| Путь 208 UTF-16 units | Install 37/37 runtime и версия 1.3.1, затем uninstall — PASS |
| Путь 209 units | Exit 1 до создания target/registration — PASS |
| Final cleanup | Test registration/protocol/payload удалены; modified engine, unknown file и synthetic profile сохранены |

Изолированный template не является запуском production installer под его обычной identity поверх owner install. Точный LZMA payload проверен отдельно. Декларируются Windows x64 build 18362+ и WebView2 minimum 143; независимые прогоны на этих минимальных версиях не выполнены.

Старые 59 runtime assets (50 092 452 B) остаются в checkout после отказа автоматической approval review на их удаление. Новый payload и source archive исключают их по явной карте. Физическая очистка checkout не заявляется. Установщик не делает recursive purge и не останавливает Lagom или чужие VPN.

## 9. Сохранность host и owner install

После окончательного uninstall сравнение с baseline подтвердило:

- Hosts, Windows user proxy, DNS, IPv4 **и IPv6** routes — без изменений.
- EgoistShieldSystemDoH и EgoistShieldZapret — Running.
- Task-owned приложения и helpers — отсутствуют.
- Установленный owner Relay **1.3.0** и его SHA-256 — без изменений; обновление владельцу автоматически не выполнялось.

Это проверка текущего ПК, не сертификат совместимости со всеми VPN/filter drivers. Owner был запущен пользователем независимо от изолированных испытаний. В отчёт не перенесены переписка, credentials, cookies, bindings или личные профили.

## 10. Зависимости и источники

Npm audit: **0 известных advisory**. Cargo audit: **0 известных vulnerabilities**, 3 unmaintained и 1 unsound warning. RustSec DB — 1 277 advisories, commit `9b3a3b73a7f42606494c943e95f8196e9994df46`, обновлена 30 сентября 2026. Полный pentest, проверка вредоносности всех dependency sources и отсутствие неизвестных уязвимостей этим не доказаны.

| Остаточное предупреждение | Статус |
| --- | --- |
| paste 1.0.15, RUSTSEC-2024-0436 | Unmaintained transitive dependency |
| proc-macro-error 1.0.4, RUSTSEC-2024-0370 | Unmaintained transitive dependency |
| ttf-parser 0.25.1, RUSTSEC-2026-0192 | Unmaintained transitive dependency |
| glib 0.18.5, RUSTSEC-2024-0429 | Unsound; `cargo tree --target x86_64-pc-windows-msvc -i glib@0.18.5` пуст, crate не входит в проверенный Windows target |

Source ZIP: **3 279 files**, 3 294 entries, 16 830 checked local imports; текущие файлы и архив побайтно совпадают с manifest. Изменённый Tauri и обе лицензии включены. Это whitelisted исходники проекта/выбранных компонентов; release docs и private logs не входят в этот снимок. Полная воспроизводимая clean-room сборка всех сторонних компонентов не выполнена.

`correspondingSourceComplete=false`, `publicationBlocked=true`: отсутствуют exact FFmpeg dependency sources/build recipe и полная доставка dependency source archives npm/Cargo/standalone yt-dlp. Наличие project ZIP, URL upstream и лицензий не выдаётся за полную corresponding source delivery. Автоматический updater отключён; публикация не выполнялась.

## 11. Контрольные суммы окончательных файлов

| Файл | SHA-256 |
| --- | --- |
| Egoist Relay_1.3.1_x64-setup.exe | `f84e2e9f907fc3eaed0276c24b6bf6c543ecfa8a53e23ac0b510de8a6739f24b` |
| App exe из payload | `50c77b5515cf0c0b69f661d72d4b0d5ac1d56cfbb97662b2308216760f0bc048` |
| Egoist-Relay-1.3.1-sources.zip, 20 156 488 B | `94035400bc28d9426c6151ab21444718282962a6d45b7128b828fd5945a8edfb` |

Приложение и установщик NotSigned, по выбранному пользователем варианту. Исторические и отклонённые промежуточные binaries не являются выдаваемой 1.3.1. Публичный статус остаётся ограничен перечисленными gates; обещаний «100%», отсутствия любых отключений или готовности всех аккаунтов на любом устройстве нет.
