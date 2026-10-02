# Архитектура

Интерфейс src/ использует Teact и общий GlobalState. Telegram API и media transfers выполняются существующим клиентом GramJS. Tauri обслуживает Windows окно, tray, install lifecycle и ограниченные native команды. X и Instagram имеют отдельные app-owned WebViews и аккаунтную привязку.

Social MCP выполняет bounded jobs через HMAC-authenticated Windows named pipes. Account ref/epoch привязываются доверенным владельцем до source dispatch; смена аккаунта прерывает старый scope. По платформе работает одна collection очередь; разные платформы могут выполняться независимо. Экспорт сохраняет JSONL, source locators, manifests, accepted bytes и explicit partial coverage. Локальный индекс строится по явно выбранным accepted jobs.

Media downloader сохраняет исходный размер и SHA256 доступного поддерживаемого потока. Неполные .part файлы не объявляются готовыми. Локальное распознавание использует доступный whisper.cpp runtime и отмечает неполный/unsupported результат.

Репозиторий содержит реализацию, а не runtime account stores. Его публикация не управляет системными DNS/DoH, proxy, маршрутизацией, службами Lagom/Zapret или их приоритетами.
