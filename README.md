# Egoist Social

**Egoist Social 1.9.10** — неофициальный Windows-хаб Telegram, X и Instagram. Знаки и названия этих сервисов принадлежат их владельцам; Egoist Social с ними не связан и не одобрен ими.

Бренд: [название и логотип](docs/brand/BRAND.md), [выбор названия](docs/brand/NAMING.md). Имя сменено с Sennit на Egoist Social 13.10.2026 решением владельца. Внутреннее имя продукта в сборке и установке остаётся `Egoist Relay` (exe, папка установки, идентификатор `com.egoist.relay`, Relay Control API): это сохраняет обновление «поверх» и профили; в интерфейсе, заголовке окна и «Приложениях и возможностях» показывается Egoist Social.

Оболочка сохраняет отдельные WebView2 и профили сервисов между переключениями. Скрытые медиа приостанавливаются, скрытый в настройках Egoist Social сервис (X или Instagram) не грузится и не создаёт сетевой нагрузки.

С 1.9.0 у приложения своя сеть ([контракт](docs/product-cycle-2026-10-13/NETWORK-TUNNEL.md)). С версии 1.9.6 сообщения, медиа и GramJS Telegram используют собственный bundled `tg-ws-proxy` 1.11.2-social.1 через случайный loopback-порт и случайный эфемерный secret. Telegram media использует H2 multiplexing и автоматический выбор рабочего маршрута без жёсткой привязки к одному публичному серверу. Social запускает локальный прокси и Node WS adapter при каждом старте; оба дочерних процесса входят в JobObject и перезапускаются при сбое. Telegram не читает настройки Egoist Lagom, не использует Xray и при отказе локального прокси не переключается на WSS через Xray; после начального сбоя моста повтор запускается каждые 15 секунд. X и Instagram, а также внешние веб-страницы Mini Apps продолжают идти через собственный Xray на случайных loopback-портах с VPN-ключом или подпиской и приватным DoH. При недоступном VPN приложение использует прямой маршрут для этих сервисов со своим DoH и возвращается в туннель после восстановления. Системные DNS, прокси, маршруты, TUN и службы не меняются; порты Egoist Lagom не занимаются. Ключ и DoH вшиваются в личный установщик из `provisioning.local.json` (вне Git), хранятся под DPAPI текущего пользователя и заменяются в настройках Egoist Social (шестерёнка внизу rail). Внешнее поле MTProxy удалено из сетевых настроек; маршрут Telegram показывает локальный прокси.

Диалоги используют общий учёт открытых окон, корректно закрываются при вложении и учитывают уменьшение анимации. Размеры ограничены viewport при увеличении текста; заголовки имеют доступное имя и подсказку. Отложенное открытие отменяется при закрытии и размонтировании. Панель Reels сохраняет нативные счётчики, а пересылка выбирает однозначный permalink поста; ссылка в подписи не скрывает действие Telegram. Поиск существующих кнопок в каждом проходе выполняется через общий индекс.

Подготовка медиа учитывает общий дедлайн и отмену до запуска worker. Проверка Node ограничена двумя секундами на кандидата. Без готового туннеля медиа не загружаются (`MEDIA_TUNNEL_UNAVAILABLE`): прямого запасного пути мимо Xray нет.

Версия 1.7.0 переводит интерфейс на систему Egoist DS (режим Lagom): темы Lagom Dark/Light, Onest + Unbounded + JetBrains Mono, иконки Phosphor, индекс раздела в заголовке окна, согласованный фон нативных окон; исправляет ошибки сохранения оригинала из превью, загрузок Mini App, журнала операций и отправки сообщений; расширяет мост исследований для Egoist Social MCP (offset/min_id, probe, прямая передача байтов медиа). [Контракт интерфейса](docs/DESIGN.md), [план и отчёты цикла](docs/lagom-redesign-2026-10-07/PLAN.md), [итог](docs/RELEASE-1.7.0.md).

Предыдущая композиция B (1.6.x) объединяла оболочку и Telegram общей нейтральной темой: глубокий чёрный, серые поверхности, Inter для интерфейса и короткий бренд Relay в Unbounded. 11 вариантов темы сохранены. Панель «Загрузки и пересылки» открывается по Ctrl+J, хранит локальные результаты и освобождает чтение после закрытия. [Действующая дизайн-система](docs/DESIGN.md).

## Сборка и проверки

```sh
npm run release:preflight
npm run check
npm test
npm run tauri:build
```

Требуются locked зависимости, Node.js 24, Rust/MSVC, Windows SDK и NSIS; Telegram API credentials находятся в локальном `.env`. Runtime включает только ресурсы из `scripts/release-runtime-manifest.json`. Обновление сохраняет пользовательские профили и неизвестные файлы.

Точечное исправление меню, строк форума и окон Mini App: [1.6.1](docs/hotfix-1.6.1/README.md), локальный установщик в `release/1.6.1/`. Предыдущий фронтенд-цикл: [отчёт 1.6.0](docs/frontend-cycle-2026-10-06/RESULT.md), [приёмка](docs/frontend-cycle-2026-10-06/ACCEPTANCE.md), [review board](docs/frontend-cycle-2026-10-06/review-result.html); локальные артефакты: `release/1.6.0/`. Архив медиарелиза: [1.5.0](docs/release-1.5.0/README.md). Публичные исходники размещаются в `egoist-ai1/egoist-relay`. Публикация Windows установщика требует полного corresponding source для поставляемых сторонних бинарных зависимостей; текущий source inventory перечисляет недостающие компоненты. Проверки синтетического интерфейса и локальных сценариев не заменяют приёмку реальных аккаунтов и независимых устройств.

## Фоновая диагностика

Поддерживается привязанный к экземпляру Egoist Relay Control API. Исследовательский Social MCP использует authenticated Windows named pipes. Диагностические данные и аккаунты не входят в публичный исходный архив.

## Local setup

```sh
mv .env.example .env

npm i
```

Obtain API ID and API hash on [my.telegram.org](https://my.telegram.org) and populate the `.env` file.

## Dev mode

```sh
npm run dev
```

### Invoking API from console

Start your dev server and locate GramJS worker in the console context.

All constructors and functions available in global `GramJs` variable.

Run `npm run gramjs:tl full` to get access to all available Telegram methods.

Example usage:
``` javascript
await invoke(new GramJs.help.GetAppConfig())
```

### Dependencies
* [GramJS](https://github.com/gram-js/gramjs) ([MIT License](https://github.com/gram-js/gramjs/blob/master/LICENSE))
* [fflate](https://github.com/101arrowz/fflate) ([MIT License](https://github.com/101arrowz/fflate/blob/master/LICENSE))
* [cryptography](https://github.com/spalt08/cryptography) ([Apache License 2.0](https://github.com/spalt08/cryptography/blob/master/LICENSE))
* [emoji-data](https://github.com/iamcal/emoji-data) ([MIT License](https://github.com/iamcal/emoji-data/blob/master/LICENSE))
* [twemoji-parser](https://github.com/jdecked/twemoji-parser) ([MIT License](https://github.com/jdecked/twemoji-parser/blob/master/LICENSE.md))
* [tlottie](https://github.com/dkaraush/tlottie) ([MIT License](https://github.com/dkaraush/tlottie/))
* [opus-recorder](https://github.com/chris-rudmin/opus-recorder) ([Various Licenses](https://github.com/chris-rudmin/opus-recorder/blob/master/LICENSE.md))
* [qr-code-styling](https://github.com/kozakdenys/qr-code-styling) ([MIT License](https://github.com/kozakdenys/qr-code-styling/blob/master/LICENSE))
* [music-metadata](https://github.com/Borewit/music-metadata) ([MIT License](https://github.com/Borewit/music-metadata/blob/master/LICENSE.txt))
* [Tiptap](https://github.com/ueberdosis/tiptap) ([MIT License](https://github.com/ueberdosis/tiptap/blob/main/LICENSE.md))
* [marked](https://github.com/markedjs/marked) ([MIT License](https://github.com/markedjs/marked/blob/master/LICENSE.md))
* [lowlight](https://github.com/wooorm/lowlight) ([MIT License](https://github.com/wooorm/lowlight/blob/main/license))
* [idb-keyval](https://github.com/jakearchibald/idb-keyval) ([Apache License 2.0](https://github.com/jakearchibald/idb-keyval/blob/main/LICENCE))
* [fasttextweb](https://github.com/karmdesai/fastTextWeb)
* fastblur

## Bug reports and Suggestions
If you find an issue with this app, let Telegram know using the [Suggestions Platform](https://bugs.telegram.org/c/4002).
