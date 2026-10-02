# Сборка Egoist Relay 1.4.6

Целевая платформа проверенного выпуска: Windows x64, Windows 10 1903 или новее. Инструменты: Node.js 24, npm 11, Rust 1.97 MSVC, Windows SDK, NSIS и WebView2. Lockfiles сохранены.

1. Выполните npm ci в корне репозитория.
2. Скопируйте .env.example в .env и задайте собственные TELEGRAM_API_ID и TELEGRAM_API_HASH. Получите их на https://my.telegram.org. Локальная .env исключена из Git. TEST_SESSION в production запрещён.
3. Подготовьте точные публичные runtime файлы из scripts/release-runtime-manifest.json: Node, media tools, whisper.cpp DLL и модели. В ветке присутствуют JS/PowerShell research helper и notices; executables/models не публикуются в Git. Каждая зависимость проверяется по размеру и SHA256.
4. Если имеется отдельно проверенный runtime archive, задайте RELAY_PUBLIC_RUNTIME_URL и RELAY_PUBLIC_RUNTIME_SHA256 и выполните node scripts/release-fetch-runtime.mjs. Репозиторий не содержит произвольной ссылки на непроверенный архив.
5. Выполните npm run release:preflight, npm run release:test, npm test, npm run check и cargo test --locked --manifest-path tauri/Cargo.toml.
6. Соберите npm run tauri:build -- --ci --no-sign -- --locked. Автоматическое обновление отключено до подписанного update channel.

Чистая независимая сборка на новом устройстве этим source publication не заявляется: требуется exact runtime и собственные credentials. Последняя локальная сборка 1.4.6 была собрана и прошла изолированный smoke.

## Social MCP

Компонент scripts/integrations/egoist-social-mcp использует Node.js 24 и встроенные Node libraries. Запуск: node src/research/mcp.mjs в каталоге компонента. Проверьте README.md и BRIDGE-CONTRACT.md компонента. Подключение использует собственный установленный Relay и локальные приватные state directories; пользовательские сессии создаются пользователем на его устройстве.

## Сторонние бинарные зависимости

Existing release-source gate отмечает незавершённые corresponding source для exact FFmpeg build/dependencies и source archives сторонних npm/Cargo/standalone dependencies. Поэтому эта публикация распространяет проектные исходники и notices, а не устанавливаемый бинарный пакет. Пропускать этот gate при выпуске бинарников нельзя; точный статус дан в THIRD-PARTY.md.
