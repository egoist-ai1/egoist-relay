# Sennit

**Sennit 1.7.0** (by Egoist) — неофициальный Windows-хаб Telegram, X и Instagram. Знаки и названия этих сервисов принадлежат их владельцам; Sennit с ними не связан и не одобрен ими.

Бренд: [название и логотип](docs/brand/BRAND.md), [выбор названия](docs/brand/NAMING.md). Внутреннее имя продукта в сборке и установке остаётся `Egoist Relay` (exe, папка установки, идентификатор `com.egoist.relay`, Relay Control API): это сохраняет обновление «поверх» и профили; в интерфейсе, заголовке окна и «Приложениях и возможностях» показывается Sennit.

Оболочка сохраняет отдельные WebView2 и профили сервисов между переключениями. Скрытые медиа приостанавливаются. Telegram использует локальный MTProxy Egoist Lagom при доступной службе; адрес и secret читаются из защищённой конфигурации и передаются только внутри локального процесса. X и Instagram наследуют текущую сетевую конфигурацию Windows. Relay не перенастраивает DNS, Zapret или другие службы.

Диалоги используют общий учёт открытых окон, корректно закрываются при вложении и учитывают уменьшение анимации. Размеры ограничены viewport при увеличении текста; заголовки имеют доступное имя и подсказку. Отложенное открытие отменяется при закрытии и размонтировании. Панель Reels сохраняет нативные счётчики, а пересылка выбирает однозначный permalink поста; ссылка в подписи не скрывает действие Telegram. Поиск существующих кнопок в каждом проходе выполняется через общий индекс.

Подготовка медиа учитывает общий дедлайн и отмену до запуска worker. Проверка Node ограничена двумя секундами на кандидата. Определение PAC использует отменяемый WinHTTP API и общий дедлайн попытки; ошибка явно настроенного PAC не вызывает скрытый переход на DIRECT.

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
