<p align="center"><img src="tauri/icons/128x128.png" width="88" height="88" alt="Egoist Relay"></p>
<h1 align="center">Egoist Relay</h1>
<p align="center">Telegram · X · Instagram — единое приложение для Windows</p>
<p align="center"><img alt="Version" src="https://img.shields.io/badge/version-1.4.6-8B9DFF"><img alt="Platform" src="https://img.shields.io/badge/platform-Windows_x64-24292f"><img alt="License" src="https://img.shields.io/badge/license-GPL--3.0--or--later-2ea44f"></p>

Egoist Relay объединяет Telegram, X и Instagram в одном настольном окне. Ветка **codex/release-1.4.6** содержит проверенный снимок исходников версии 1.4.6, тесты и компонент Egoist Social MCP.

[Изменения 1.4.6](docs/RELEASE-1.4.6.md) · [Сборка](BUILDING.md) · [Проверки](docs/VERIFICATION.md) · [Приватность](SECURITY.md) · [Архитектура](docs/ARCHITECTURE.md)

## Возможности

| Компонент | Возможности |
| --- | --- |
| Telegram | Чаты и аккаунты в существующем клиенте, файлы, медиа и получатели пересылки |
| X и Instagram | Отдельные сессии, встроенные страницы и отправка выбранного источника в Telegram |
| Reels → Telegram | Кнопка в панели действий, выбор адресата, ссылки и поддерживаемые медиа |
| Social MCP | Поиск, чтение выбранных источников, экспорт, проверенные курсоры и локальный индекс |
| Локальные медиа | Загрузка поддерживаемых источников и распознавание наблюдаемого аудио/видео доступным локальным runtime |

## Что входит в 1.4.6

- Выровненная панель действий Reels с областью нажатия 44 px.
- Короткая подпись **«Нравятся»** с сохранением обычных числовых счётчиков.
- Окно пересылки в формате Telegram: поиск, недавние контакты, папки и выбранный получатель.
- Копирование ссылки до выбора адресата и отправка после выбора.
- Адаптация коротких окон, RTL, светлой/тёмной темы и reduced motion в проверенных сценариях.

## Проверенная версия

Для исходников версии выполнены **387 проверок**: 322 unit tests, 54 focused UI/helper scenarios и 11 native checks. Дополнительно прошли три конфигурации TypeScript и изолированная установка → запуск → удаление. Telegram, X и Instagram подтвердили готовность MCP в ограниченной live проверке.

Полный состав и границы проверки указаны в [VERIFICATION.md](docs/VERIFICATION.md). Готовность сессии не подтверждает доступ к любому источнику, универсальную скорость CDN или все возможные действия в аккаунте.

## Сеть и аккаунты

Приложение использует существующую сетевую конфигурацию Windows. Этот выпуск не меняет системные DNS/DoH, маршруты, proxy, службы Zapret/Lagom или их приоритеты. Текущий доступный MTProxy Lagom читается локальным адаптером приложения; секрет не является частью репозитория. MCP работает через аутентифицированные Windows named pipes.

Репозиторий содержит код и синтетические тесты. Сессий Telegram/X/Instagram, cookies, профилей WebView, API credentials, личных сообщений, выгрузок и пользовательских DNS-конфигураций в публикации нет. Для собственной сборки используются собственные Telegram API ID/hash в локальном .env.

## Быстрый старт для разработчика

~~~powershell
git clone --branch codex/release-1.4.6 https://github.com/egoist-ai1/egoist-relay.git
cd egoist-relay
npm ci
Copy-Item .env.example .env
~~~

Далее заполните собственные Telegram API credentials и подготовьте публичный runtime по [BUILDING.md](BUILDING.md). Бинарные runtime зависимости не хранятся в Git. Установщик этой проверенной локальной сборки пока не опубликован: комплект corresponding source для всех сторонних бинарных зависимостей требует завершения.

## Структура

~~~text
src/                         интерфейс, Telegram и действия приложения
tauri/                       native Windows оболочка и разрешения
scripts/                     сборка, release policy и synthetic сценарии
runtime/research/            app-owned bridge и DOM collection helper
scripts/integrations/egoist-social-mcp/  MCP сервис, экспорт и локальный индекс
docs/                        выпуск, проверка и архитектура
~~~

## Лицензия и происхождение

Исходники распространяются по **GPL-3.0-or-later**. Сохранены оригинальный LICENSE, заголовки авторства и notices vendored компонентов. Telegram UI использует Teact/GramJS; оболочка приложения — Tauri. Сторонние компоненты имеют собственные лицензии и source provenance. Подробнее: [THIRD-PARTY.md](THIRD-PARTY.md).
