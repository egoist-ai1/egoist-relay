# Relay 1.3.1 — упаковка и выпуск

Дата: 30 сентября 2026. Область этого отчёта: installer, runtime allowlist, privacy/source gates и CI. Функциональные сетевые/UI результаты и окончательные хеши установщика фиксируются в общем отчёте проекта.

## Изменённый состав продукта

- Один generic installer; отдельной персональной сборки, импорта Lagom, DNS/tunnel enrollment и NSIS provisioning больше нет.
- Новая явная карта Tauri resources содержит 37 разрешённых файлов. Xray, ciadpi, egoist-tg-proxy, их provenance и отдельные лицензии не входят в payload. Node.js сохраняется для обработки медиа/JavaScript runtime; FFmpeg и локальное распознавание также сохранены.
- `build:proxy`, его вызов из `build:desktop` и устаревшие сетевые тесты/bridge build в CI удалены. Нужные локальные TS/JS imports всё ещё проверяются; Telegram session modules не исключаются из source archive по имени.
- Подготовка source archive не читает исторические Xray sources и не добавляет их component sources/notices. Архивы `release/1.3.0`, установленные приложения и профили владельца этим изменением не затрагивались.

В каталоге исходников остаются 59 прежних public runtime assets, суммарно 50 092 452 байта. Автоматическая проверка разрешения отклонила batch удаления и затем узкое literal удаление трёх EXE до запуска, сообщив только `blocked by policy`. Выбран обратимый вариант: эти файлы считаются retired assets и допускаются в checkout только с прежними точными SHA-256/размерами. Новая карта ресурсов и runtime ZIP allowlist их исключают. Это удаление из поставляемого продукта; физическое удаление из checkout не заявляется.

## Installer и миграция

`tauri/installer.nsh` сохранил ранние проверки Windows x64/build 18362+, доступности версии installer и запрет silent downgrade. Updater отключён до подписанного канала. Длина нового installation path ограничена 208 UTF-16 units; longest runtime file path — 50, directory — 21. Значения выводятся из manifest и проверяются preflight. Настройка Windows long paths не изменяется.

После установки helper читает только встроенный public `installer-legacy-runtime.json` и выбранный `INSTDIR`. Он удаляет только старые runtime файлы с точным совпадением размера и SHA-256. Изменённые/неизвестные файлы сохраняются; профили вне runtime не перебираются. Все записи manifest и path chains проверяются до первого удаления; traversal, ADS и reparse points отклоняются. Cleanup не делает recursive purge. Слишком длинные legacy notice paths сохраняются как недоступные для classic Win32 cleanup; это не разрешает включать старые engines в новый payload.

Installer process handling ограничен точными исполняемыми путями выбранной установки. Активное приложение требует штатного выхода через трей. Старые network engine paths больше не входят в список принудительного завершения процессов; cleanup не управляет Lagom/другими VPN.

## Выполненные проверки

| Проверка | Результат |
| --- | --- |
| Release policy tests | 12/12 PASS: identity, embedded UI, pinned resources, provisioning rejection, privacy, runtime/retired integrity, source imports, bounded download, ZIP metadata, path budget |
| Windows PowerShell migration fixtures | 3/3 PASS: exact old notice removal; modified engine/unknown file/account profile preserved; repeatable cleanup; malformed manifest fails before deletion; relative/drive root rejected; runtime junction rejected without external target mutation |
| Scoped ESLint, actionlint, PowerShell parser | PASS |
| Real NSIS 3.11 hook compile fixture | PASS, including early hook before VERSION/plugin declarations and PREINSTALL/POSTINSTALL macros; wrapper-only LegalCopyright warning |
| Final project preflight before native build | PASS, 37 packaged runtime entries; retired files excluded by explicit resources |

Эти проверки не заменяют запуск окончательного установщика, native verification, тест на независимом устройстве или длительное наблюдение соединений. Первоначальные preflight/source preparation остановились на synthetic URL-userinfo fixtures нового `tauri/src/system_proxy.rs`; privacy gate сообщил только filename, значения не выводились. После исправления fixtures основной процесс подтвердил PASS preflight37 и начал native build. Подготовка окончательного source archive выполняется после завершения документации проекта, чтобы архив соответствовал финальному снимку исходников.

## Остаточные gates

Технические:

1. Подготовить и проверить окончательный source ZIP после завершения документации. Исправление test-only credential literals подтверждено прошедшим preflight; проверка секретов не ослаблена.
2. Проверить финальный NSIS payload: ровно 37 runtime entries и отсутствие трёх network engines/enrollment. Проверить реальное silent upgrade/downgrade, Unicode/default/max-path installation в изолированной identity.
3. Exact corresponding source delivery всё ещё неполна: FFmpeg exact dependency sources/build recipe и dependency source archives npm/Cargo/standalone yt-dlp. Удалённые ciadpi/TG/Xray больше не являются требованиями источников новой поставки. `correspondingSourceComplete=false`, `publicationBlocked=true` сохраняются; source archive не объявляется полной GPL поставкой.

Внешние:

- Пользователь выбрал unsigned release; сертификат/подписанный publisher и updater channel отсутствуют.
- Декларируемый WebView2 minimum 143 не является отдельно проверенным минимумом; на рабочем ПК наблюдался 154.0.4258.37.
- Независимый чистый ПК, реальные сторонние аккаунты/сети и 24-часовая стабильность требуют отдельных фактических результатов. Приложение наследует доступность host/Lagom сети; упаковка не гарантирует обход региональных/сервисных ограничений.

Публикация не выполнялась. CI запускается вручную, сохраняет review artifacts и требует явного выбора draft; automatic publish отсутствует, draft блокируется незавершённой corresponding source delivery.
