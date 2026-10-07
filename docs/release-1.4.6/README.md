# Egoist Relay 1.4.6

Установлена и запущена финальная версия текущих UI исправлений.

Выровнены кнопки Reels, заменена подпись на «Нравятся», окно пересылки оформлено как native picker Telegram: поиск, недавние получатели, папки, выбор адресата, копирование ссылки и отправка.

Проверены 26 suites/322 tests,54 focused UI/helper scenarios,11 native checks и3 TypeScript configurations. Отдельная установка/запуск/удаление прошли; установленный EXE, версия реестра и40 runtime совпали с проверенным пакетом.

DNS/proxy hashes,7 protected files,4 running services и измеренные базовые приоритеты/identity служб совпали до и после установки и запуска MCP. MCP имеет Normal priority и0 TCP/UDP listeners, использует authenticated Windows named pipes. Вне сервисов состав UI/build процессов Lagom менялся независимо; Relay/MCP не управляли ими.

Telegram иX MCP ready. Пользователь подтвердил работающую ленту Instagram; автоматическое MCP account proof для Instagram пока pending. Исчерпывающая проверка всех возможностей и максимальной скорости CDN не заявляется.

Evidence: release-ready.json, installation.json, live-verification.json, network-preservation-after-install.json, source-qa.json, installer-smoke.json, offline-packaging.json.
