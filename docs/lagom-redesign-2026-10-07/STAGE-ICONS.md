# Этап «Иконки»: Phosphor Bold/Fill в иконочном шрифте

8 октября 2026, ветка `lagom-redesign`. Основание: [AUDIT-FRONTEND](AUDIT-FRONTEND.md) разд. 6, [PLAN](PLAN.md) решение 4, инвариант 7 Egoist DS (сетка 24, линия 2 px, заливка той же формы для активного и выбранного состояния).

## Итог

- Из 435 имён иконок шрифта на Phosphor переведены **244** (174 Bold, 70 Fill); **191** оставлены без изменений.
- API не менялся: `<Icon name="…"/>`, тип `IconName`, классы `icon-*` и кодовые точки шрифта те же; `src/types/icons/font.ts` не изменился.
- Размер шрифта: `icons.woff2` 58 100 → 52 620 байт (−5 480, −9,4 %), `icons.woff` 69 596 → 63 500 байт (−6 096, −8,8 %).
- Новых зависимостей нет. Phosphor берётся внешним архивом только при синхронизации; в проект попадают готовые SVG-глифы и лицензия MIT.

## Как устроен конвейер (проверено)

1. Источник — `src/assets/font-icons/**/*.svg`: 435 файлов (403 в корне и 32 в подпапках `device/`, `folder-tabs/`, `rating-icons/`); публичное имя = путь файла, склеенный через `-`.
2. `npm run icons:build` → `dev/buildIcons.ts` → `svgtofont` (`svgicons2svgfont`, `normalize: true`, `fontHeight: 1024`) → `src/styles/icons.woff2` и `.woff`, `icons.css`, `icons.scss` (карта `$icons-map`), `icons/preview.html`; тот же скрипт пишет `src/types/icons/font.ts`. Кодовые точки идут по алфавиту имён с `0xF101`, поэтому при неизменном наборе имён они не меняются.
3. `normalize: true` приводит каждый глиф к высоте em-box по высоте его `viewBox`. Квадратный Phosphor (viewBox 256) ложится в тот же em-box, что прежние 32×32; отдельная подгонка сетки не нужна.
4. Сборка воспроизводима: повторный запуск на неизменных SVG дал шрифты тех же размеров, менялся только хэш в `icons.css` (проверено до правок).

## Что добавлено и изменено

| Файл | Назначение |
|---|---|
| `dev/icons-phosphor-map.json` | Таблица «имя Relay → `phosphor[:fill][@масштаб]`», 244 записи |
| `dev/syncPhosphorIcons.ts` | Переписывает SVG из таблицы глифами Phosphor |
| `src/styles/icons/PHOSPHOR-LICENSE.txt` | MIT-лицензия Phosphor, `@phosphor-icons/core` 2.1.1 |
| `package.json` | скрипт `icons:phosphor` (зависимости не менялись) |

Изменены также 244 SVG в `src/assets/font-icons/` и сгенерированные `src/styles/icons.woff2`, `icons.woff`, `icons.css`, `icons.scss`, `icons/preview.html`.

## Как пересобрать

```sh
export PATH="/c/Program Files/nodejs:$PATH"
T="$TEMP/phosphor" && mkdir -p "$T/x" && cd "$T" && npm pack @phosphor-icons/core@2.1.1 && tar -xzf phosphor-icons-core-2.1.1.tgz -C x
cd "<папка проекта>"
npm run icons:phosphor -- "$T/x/package/assets"   # SVG по таблице dev/icons-phosphor-map.json
npm run icons:build                               # шрифт, CSS, типы
```

Изменить соответствие — правка `dev/icons-phosphor-map.json` и те же две команды. Вернуть прежний знак — `git checkout` его SVG и удалить запись из таблицы.

## Правила сопоставления

Способ в таблице: точное имя (32 записи: `archive`, `arrow-down`, `arrow-left`, `arrow-right`, `article`, `bug`, `camera`, `car`, `check`, `clock`, `code`, `copy`, `crop`, `eye`, `flag`, `folder`, `heart`, `info`, `key`, `keyboard`, `link`, `lock`, `microphone`, `pause`, `pause-circle`, `phone`, `play`, `tag`, `timer`, `truck`, `user`, `warning`), имя без суффикса `-filled/-outline/-outlined` (15) и словарь синонимов с ручными решениями (197). Точное совпадение имени принималось только после визуальной проверки значения.

- **Вес.** Имя с `-filled` и знаки, у которых прежний глиф сплошной (`heart`, `eye`, `send`, `play`, `pause`, `warning`, `video`, `microphone`, `speaker`, `volume-*`, `sell`, `tag`, `crown-wear`, `muted` и т. п.), получают Phosphor **Fill**. Парные `-outline/-outlined` и контурные знаки — **Bold**. Пары «контур/заливка» сохраняют смысл активного состояния, а сплошной глиф не превращается в контурный там, где UI рассчитан на него.
- **Оптический размер.** Прежние глифы занимают в em-box в среднем 86,5 % (медиана по max(ширина, высота)), Phosphor 84,4 %; медиана отношения 1,01. Габариты сверены для каждого знака (Chromium `getBBox`); если отличие больше 3 %, множитель записан как `@k` в пределах 0,85…1,10, чтобы линия оставалась близкой к 2 px. Масштаб реализован через `viewBox` вокруг центра, геометрия Phosphor не меняется. Применён к 175 из 244 знаков.
- **Ничего не рисовалось.** Знаки без точного аналога оставлены прежними: у них тот же em-box и близкий штрих (в контактном листе «после» разницы в весе не видно).

## Оставлены без изменений (191) и почему

| Группа | Имена |
|---|---|
| Продуктовые знаки Telegram (Premium, Stars, Boosts, подарки, крафт, аукцион, TON, рейтинг) | `premium-filled`, `star` (Stars/Premium, не обычная звезда), `stars-filled`, `stars-lock`, `stars-refund`, `boost`, `boost-outline`, `boostcircle`, `boosts`, `boost-craft-chance`, `gift`, `gift-filled`, `closed-gift`, `gift-transfer-inline`, `craft`, `combine-craft`, `auction-next-round`, `diamond`, `gram-filled`, `toncoin`, `fragment`, `frozen-time`, `trade`, `revenue-split`, `refund`, `unique-profile`, `proof-of-ownership`, `profile-music`, `user-stars`, `user-tag`, `crown-take-off`, `crown-take-off-outline`, `rating-icons-*` (20) |
| Бейджи (малые знаки на аватарах, чатах, папках) | `add-one-badge`, `double-badge`, `radial-badge`, `chat-badge`, `chats-badge`, `file-badge`, `folder-badge`, `link-badge`, `lock-badge`, `unlock-badge`, `pin-badge`, `poll-badge`, `one-filled` |
| Папки чатов | `folder-tabs-bot`, `-channel`, `-chat`, `-chats`, `-folder`, `-group`, `-star`, `-user` |
| Платформы устройств (сессии) | `device-android`, `-apple`, `-linux`, `-ubuntu`, `-unknown`, `-weba`, `-webk`, `-windows`; у Phosphor нет Ubuntu, WebK и WebA, поэтому набор остаётся единым |
| Заглушки аватаров | `avatar-archived-chats`, `avatar-deleted-account`, `avatar-saved-messages` |
| Истории | `story-caption`, `story-expired`, `story-priority`, `story-reply`, `save-story`, `play-story`, `stealth-future`, `stealth-past`, `view-once` |
| ИИ и инструменты композера | `ai`, `ai-edit`, `ai-fix`, `tone`, `transcribe`, `clear-formatting`, `blockquote`, `pullquote`, `quote`, `quote-open`, `quote-close`, `quote-text`, `remove-quote`, `details-block`, `footer`, `word-wrap`, `monospace`, `mark`, `move-caption-up`, `move-caption-down`, `copy-media`, `grouped`, `grouped-disable`, `spoiler`, `spoiler-disable`, `spoiler-text` |
| Редактор таблиц (21) | `table`, `table-align-*` (6), `table-delete`, `table-fill`, `table-insert-*` (4), `table-merge-*` (2), `table-move-*` (2), `table-split-*` (2): в Phosphor нет набора операций над таблицей |
| Составные знаки без аналога | `allow-share`, `allow-speak`, `no-download`, `no-share`, `nochannel`, `password-off`, `share-screen`, `share-screen-outlined`, `share-screen-stop`, `animations`, `animations-filled`, `archive-from-main`, `archive-to-main`, `unarchive`, `auto-delete-clock`, `auto-delete-empty`, `calendar-filter`, `sort-by-date`, `sort-by-number`, `sort-by-price`, `tag-add`, `tag-crossed`, `tag-filter`, `tag-name`, `unlist`, `unlist-outline`, `clock-edit`, `close-topic`, `choice-selected`, `bot-commands-filled`, `replace`, `replace-round`, `reorder-tabs`, `readchats`, `replies`, `revote`, `rotate`, `round-video`, `unread`, `user-online`, `voice-chat`, `topic-new`, `show-message`, `stop-raising-hand`, `permissions`, `non-contacts`, `my-notes`, `note`, `forums`, `understood`, `pin-list`, `collapse-modal`, `expand-modal` |
| Дефект источника | `more-circle`: в `dots-three-circle` Bold (core 2.1.1) на пути две точки вместо трёх; оставлен прежний знак |

## Проверки

| Проверка | Результат |
|---|---|
| `npx tsc` (и `tsconfig.script.json`, `tsconfig.test.json`) | 0 ошибок |
| `npm test` | 37 файлов, 459 тестов, все прошли (на старте этапа было 445; прирост не от иконок: параллельные этапы добавили тесты) |
| `npx eslint dev/syncPhosphorIcons.ts` | чисто |
| `npm run check` | падает **не из-за иконок**: `eslint` — 3 ошибки в `src/components/common/Titlebar.tsx:141` (max-len, jsx-one-expression-per-line; файл не мой, правка параллельного участника), `stylelint` — 1 ошибка в `Titlebar.module.scss:73` (`order/properties-order`); остальное — 508 прежних предупреждений `text-wrap` и 1 предупреждение `dangerouslySetInnerHTML` в `DocumentReaderModal.tsx` |
| Типы имён (`lang:ts` не затрагивается) | `src/types/icons/font.ts` не изменился: набор имён тот же |
| Визуально: контактные листы «до → после» (244 знака) и «после» (все 435) | просмотрены; найдены и исправлены `list` (получал глиф меню вместо списка с маркерами), `star` (знак Stars, возвращён прежний), `more-circle` (дефект источника, возвращён прежний), `pin` (был наклонный, стал прямой `push-pin-simple`); добавлен `undo` ради симметрии с `redo` |
| Визуально: реальный UI (MockClient, `lagom-dark`) | шапка, поиск, композер, меню сообщения и шапки чата, настройки с цветными плитками: глифы читаются, смещений и обрезки не замечено |

Скриншоты: `screens/icons/` — `contact-pairs-01…04.png` (до → после), `contact-all-after-01…05.png` (весь набор после), `01…04` (чат 1280/1920/800 и панель операций), `12-settings-icons.png`, `22-menus.png`.

## Не сделано и риски

- Инлайн-SVG в TSX (около 51 в 28 файлах: rail, caption, статус-карточки) не затронуты: этап ограничен иконочным шрифтом; файлы `AppSidebar.tsx`, `Titlebar.tsx` правят параллельные участники. Бренды Telegram/X/Instagram в rail по условию не меняются.
- Скриншоты «до» реального UI не снимались (не подменял шрифт в рабочем дереве при параллельной работе); сравнение «до → после» — по контактным листам с реальными шрифтами обеих версий.
- Не проверено в Tauri/WebView2 и в светлой теме; на скриншотах только `lagom-dark` на 1280/1920/800.
- Смысловая замена нескольких знаков — вкусовое решение владельца: `lock`/`lock-filled` (Phosphor рисует замок с отверстием-замочной скважиной), `eats` (яблоко → гамбургер), `admin` (щит со звездой), `2fa-filled` (замок с ключом вместо щита), `author-hidden` (детектив), `reply` (то же начертание в Bold и Fill: у стрелки Phosphor нет заливки). Каждый меняется одной правкой в таблице.
- Контрольный сигнал для будущего: если обновить `@phosphor-icons/core`, запись `dots-three-circle` стоит проверить повторно.

## Таблица соответствия (244)

Колонка «Масштаб» — множитель оптического размера (1 — без изменений).

| Relay | Phosphor | Вес | Масштаб | Способ |
|---|---|---|---|---|
| `2fa-filled` | `lock-key` | Fill | 1 | словарь |
| `account-filled` | `user-circle` | Fill | 1 | словарь |
| `active-sessions` | `devices` | Bold | 1 | словарь |
| `add` | `plus` | Bold | 0.91 | словарь |
| `add-caption` | `list-plus` | Bold | 1.05 | словарь |
| `add-filled` | `plus-circle` | Fill | 1.1 | словарь |
| `add-music` | `music-notes-plus` | Bold | 1.04 | словарь |
| `add-user` | `user-plus` | Bold | 0.96 | словарь |
| `add-user-filled` | `user-plus` | Fill | 1 | словарь |
| `admin` | `shield-star` | Bold | 1.1 | словарь |
| `animals` | `cat` | Bold | 1.1 | словарь |
| `appearance-filled` | `palette` | Fill | 1 | словарь |
| `archive` | `archive` | Bold | 1 | точное имя |
| `archive-filled` | `archive` | Fill | 1 | имя без суффикса |
| `arrow-down` | `arrow-down` | Bold | 0.85 | точное имя |
| `arrow-down-circle` | `arrow-circle-down` | Bold | 0.87 | словарь |
| `arrow-left` | `arrow-left` | Bold | 0.85 | точное имя |
| `arrow-right` | `arrow-right` | Bold | 0.85 | точное имя |
| `article` | `article` | Bold | 1 | точное имя |
| `ask-support` | `chat-circle-dots` | Bold | 1.09 | словарь |
| `attach` | `paperclip` | Bold | 1.1 | словарь |
| `auction` | `gavel` | Bold | 1.06 | словарь |
| `auction-drop` | `parachute` | Bold | 1.1 | словарь |
| `auction-filled` | `gavel` | Fill | 1.1 | словарь |
| `author-hidden` | `detective` | Bold | 0.88 | словарь |
| `bio-filled` | `info` | Fill | 1 | словарь |
| `birthday-filled` | `cake` | Fill | 0.91 | словарь |
| `block-filled` | `prohibit` | Fill | 0.94 | словарь |
| `bold` | `text-b` | Bold | 1 | словарь |
| `bot-command` | `command` | Bold | 1.1 | словарь |
| `bots` | `robot` | Bold | 1.05 | словарь |
| `brush` | `paint-brush` | Bold | 0.93 | словарь |
| `bug` | `bug` | Bold | 0.95 | точное имя |
| `bullet-list` | `list-bullets` | Bold | 1 | словарь |
| `calendar` | `calendar-blank` | Bold | 1 | словарь |
| `camera` | `camera` | Bold | 1 | точное имя |
| `camera-add` | `camera-plus` | Bold | 1.1 | словарь |
| `car` | `car` | Bold | 0.95 | точное имя |
| `card` | `credit-card` | Bold | 0.92 | словарь |
| `cash-circle` | `currency-circle-dollar` | Bold | 1.09 | словарь |
| `channel` | `megaphone` | Bold | 1 | словарь |
| `channel-filled` | `megaphone` | Fill | 1.1 | словарь |
| `channelviews` | `eye` | Fill | 0.85 | словарь |
| `check` | `check` | Bold | 0.92 | точное имя |
| `check-bold` | `check` | Bold | 0.85 | словарь |
| `check-filled` | `check-square` | Fill | 1.1 | словарь |
| `clear` | `broom` | Bold | 0.92 | словарь |
| `clock` | `clock` | Bold | 1.1 | точное имя |
| `clock-filled` | `clock` | Fill | 1 | имя без суффикса |
| `close` | `x` | Bold | 0.89 | словарь |
| `close-circle` | `x-circle` | Bold | 1.09 | словарь |
| `cloud-download` | `cloud-arrow-down` | Bold | 1 | словарь |
| `code` | `code` | Bold | 0.87 | точное имя |
| `collapse` | `arrows-in-simple` | Bold | 1.1 | словарь |
| `collapse-square` | `corners-in` | Bold | 1.1 | словарь |
| `colorize` | `eyedropper` | Bold | 1 | словарь |
| `comments` | `chat-circle` | Bold | 1.09 | словарь |
| `comments-sticker` | `chat-circle` | Fill | 1 | словарь |
| `copy` | `copy` | Bold | 1.07 | точное имя |
| `crop` | `crop` | Bold | 1 | точное имя |
| `crown-wear` | `crown` | Fill | 1.07 | словарь |
| `crown-wear-outline` | `crown` | Bold | 0.89 | словарь |
| `darkmode` | `moon-stars` | Bold | 1 | словарь |
| `data` | `database` | Bold | 0.94 | словарь |
| `delete` | `trash` | Bold | 1 | словарь |
| `delete-filled` | `trash` | Fill | 1 | словарь |
| `delete-left` | `backspace` | Bold | 1.09 | словарь |
| `delete-user` | `user-minus` | Bold | 0.94 | словарь |
| `devices-filled` | `devices` | Fill | 0.92 | имя без суффикса |
| `direct` | `chat-circle-text` | Bold | 1.09 | словарь |
| `document` | `file` | Fill | 1 | словарь |
| `down` | `caret-down` | Bold | 0.93 | словарь |
| `download` | `download-simple` | Bold | 0.96 | словарь |
| `dropdown-arrows` | `caret-up-down` | Bold | 0.85 | словарь |
| `eats` | `hamburger` | Bold | 1 | словарь |
| `edit` | `pencil-simple` | Bold | 0.95 | словарь |
| `email` | `envelope` | Bold | 1 | словарь |
| `enter` | `arrow-elbow-down-left` | Bold | 1 | словарь |
| `expand` | `arrows-out-simple` | Bold | 1.1 | словарь |
| `expand-square` | `corners-out` | Bold | 1.1 | словарь |
| `eye` | `eye` | Fill | 0.89 | точное имя |
| `eye-crossed` | `eye-slash` | Fill | 0.89 | словарь |
| `eye-crossed-outline` | `eye-slash` | Bold | 1 | словарь |
| `eye-outline` | `eye` | Bold | 0.93 | имя без суффикса |
| `favorite` | `star` | Bold | 1.1 | словарь |
| `favorite-filled` | `star` | Fill | 1.1 | словарь |
| `flag` | `flag` | Bold | 1.08 | точное имя |
| `flag-filled` | `flag` | Fill | 1.1 | имя без суффикса |
| `flip` | `flip-horizontal` | Bold | 1.07 | словарь |
| `folder` | `folder` | Bold | 1.09 | точное имя |
| `folder-filled` | `folder` | Fill | 1 | имя без суффикса |
| `fontsize` | `text-aa` | Bold | 0.94 | словарь |
| `formula` | `sigma` | Bold | 1.1 | словарь |
| `forward` | `share-fat` | Bold | 1 | словарь |
| `fullscreen` | `corners-out` | Bold | 0.93 | словарь |
| `gifs` | `gif` | Bold | 1.05 | словарь |
| `group` | `users` | Bold | 1 | словарь |
| `group-filled` | `users` | Fill | 0.95 | словарь |
| `hand-stop` | `hand-palm` | Bold | 1.09 | словарь |
| `hand-stop-filled` | `hand-palm` | Fill | 1 | словарь |
| `hashtag` | `hash` | Bold | 0.85 | словарь |
| `hd-photo` | `high-definition` | Bold | 1.1 | словарь |
| `heading` | `text-h` | Bold | 1 | словарь |
| `heading-1` | `text-h-one` | Bold | 1.06 | словарь |
| `heading-2` | `text-h-two` | Bold | 1.1 | словарь |
| `heading-3` | `text-h-three` | Bold | 1.1 | словарь |
| `heading-4` | `text-h-four` | Bold | 1.08 | словарь |
| `heading-5` | `text-h-five` | Bold | 1.08 | словарь |
| `heading-6` | `text-h-six` | Bold | 1.09 | словарь |
| `heart` | `heart` | Fill | 0.91 | точное имя |
| `heart-outline` | `heart` | Bold | 0.88 | имя без суффикса |
| `help` | `question` | Bold | 1.09 | словарь |
| `help-filled` | `question` | Fill | 1 | словарь |
| `info` | `info` | Bold | 1.09 | точное имя |
| `info-filled` | `info` | Fill | 1.1 | имя без суффикса |
| `install` | `plus-circle` | Bold | 1.09 | словарь |
| `italic` | `text-italic` | Bold | 1 | словарь |
| `key` | `key` | Bold | 1.04 | точное имя |
| `key-filled` | `key` | Fill | 0.94 | имя без суффикса |
| `keyboard` | `keyboard` | Bold | 0.92 | точное имя |
| `lamp` | `lightbulb` | Bold | 1 | словарь |
| `language` | `translate` | Bold | 1 | словарь |
| `large-pause` | `pause` | Fill | 0.85 | словарь |
| `large-play` | `play` | Fill | 0.85 | словарь |
| `link` | `link` | Bold | 0.92 | точное имя |
| `link-broken` | `link-break` | Bold | 1.1 | словарь |
| `list` | `list-bullets` | Bold | 1.05 | словарь |
| `location` | `map-pin` | Bold | 1 | словарь |
| `location-filled` | `map-pin` | Fill | 0.95 | словарь |
| `lock` | `lock` | Bold | 1.1 | точное имя |
| `lock-filled` | `lock` | Fill | 1 | имя без суффикса |
| `logout` | `sign-out` | Bold | 1.1 | словарь |
| `loop` | `repeat` | Bold | 1 | словарь |
| `megaphone-filled` | `megaphone` | Fill | 0.93 | имя без суффикса |
| `mention` | `at` | Bold | 1.09 | словарь |
| `mention-filled` | `at` | Fill | 1.04 | словарь |
| `menu` | `list` | Bold | 0.96 | словарь |
| `message` | `chat` | Bold | 1.04 | словарь |
| `message-failed` | `warning-circle` | Fill | 0.86 | словарь |
| `message-pending` | `clock` | Bold | 0.85 | словарь |
| `message-read` | `checks` | Bold | 0.89 | словарь |
| `message-succeeded` | `check` | Bold | 0.85 | словарь |
| `microphone` | `microphone` | Fill | 1 | точное имя |
| `microphone-alt` | `microphone` | Bold | 0.93 | словарь |
| `microphone-outline` | `microphone` | Bold | 1 | имя без суффикса |
| `more` | `dots-three-vertical` | Bold | 1 | словарь |
| `mute` | `bell-slash` | Bold | 1.09 | словарь |
| `muted` | `speaker-x` | Fill | 0.92 | словарь |
| `new-chat-filled` | `pencil-simple` | Fill | 0.96 | словарь |
| `new-send` | `paper-plane-tilt` | Fill | 0.89 | словарь |
| `next` | `caret-right` | Bold | 0.85 | словарь |
| `next-link` | `caret-right` | Bold | 1.1 | словарь |
| `noise-suppression` | `waveform` | Bold | 1.1 | словарь |
| `notifications-filled` | `bell` | Fill | 1.08 | словарь |
| `numbered-list` | `list-numbers` | Bold | 1 | словарь |
| `open-in-new-tab` | `arrow-square-out` | Bold | 1.07 | словарь |
| `pause` | `pause` | Fill | 0.89 | точное имя |
| `pause-circle` | `pause-circle` | Bold | 1.1 | точное имя |
| `phone` | `phone` | Bold | 1 | точное имя |
| `phone-discard` | `phone-disconnect` | Fill | 1 | словарь |
| `phone-discard-outline` | `phone-disconnect` | Bold | 1 | словарь |
| `phone-filled` | `phone` | Fill | 1.07 | имя без суффикса |
| `photo` | `image` | Bold | 1 | словарь |
| `piechart-filled` | `chart-pie-slice` | Fill | 1.06 | словарь |
| `pin` | `push-pin-simple` | Bold | 1 | словарь |
| `pinned-chat` | `push-pin` | Bold | 1.1 | словарь |
| `pinned-message` | `push-pin` | Fill | 1 | словарь |
| `pip` | `picture-in-picture` | Bold | 1 | словарь |
| `play` | `play` | Fill | 0.96 | точное имя |
| `poll` | `chart-bar` | Bold | 1 | словарь |
| `previous` | `caret-left` | Bold | 0.85 | словарь |
| `previous-link` | `caret-left` | Bold | 1.1 | словарь |
| `privacy-policy` | `shield-check` | Bold | 1.1 | словарь |
| `privacy-policy-filled` | `shield-check` | Fill | 1.08 | словарь |
| `recent` | `clock` | Bold | 1.09 | словарь |
| `record-dot` | `circle` | Fill | 0.85 | словарь |
| `record-play` | `play` | Fill | 1.08 | словарь |
| `redo` | `arrow-u-up-right` | Bold | 0.85 | словарь |
| `reload` | `arrow-clockwise` | Bold | 1.09 | словарь |
| `reload-arrows` | `arrows-clockwise` | Bold | 1.1 | словарь |
| `remove` | `minus` | Bold | 0.85 | словарь |
| `remove-music` | `music-notes-minus` | Bold | 1 | словарь |
| `reopen-topic` | `play-circle` | Bold | 1.09 | словарь |
| `reply` | `arrow-bend-up-left` | Bold | 1.04 | словарь |
| `reply-filled` | `arrow-bend-up-left` | Bold | 1 | словарь |
| `saved-messages` | `bookmark-simple` | Bold | 1.04 | словарь |
| `schedule` | `clock-clockwise` | Bold | 1.1 | словарь |
| `scheduled` | `clock-counter-clockwise` | Bold | 1.1 | словарь |
| `sd-photo` | `standard-definition` | Bold | 1.1 | словарь |
| `search` | `magnifying-glass` | Bold | 0.89 | словарь |
| `select` | `check-circle` | Bold | 1.09 | словарь |
| `select-filled` | `check-circle` | Fill | 1.1 | словарь |
| `sell` | `tag` | Fill | 0.96 | словарь |
| `sell-outline` | `tag` | Bold | 0.93 | словарь |
| `send` | `paper-plane-right` | Fill | 1 | словарь |
| `send-outline` | `paper-plane-right` | Bold | 1 | словарь |
| `settings` | `gear` | Bold | 1.08 | словарь |
| `settings-filled` | `gear` | Fill | 1.1 | словарь |
| `share-filled` | `share-fat` | Fill | 0.94 | словарь |
| `sidebar` | `sidebar-simple` | Bold | 1 | словарь |
| `skip-next` | `skip-forward` | Fill | 0.85 | словарь |
| `skip-previous` | `skip-back` | Fill | 0.85 | словарь |
| `smallscreen` | `corners-in` | Bold | 0.93 | словарь |
| `smile` | `smiley` | Bold | 1.1 | словарь |
| `smile-filled` | `smiley` | Fill | 1 | словарь |
| `sort` | `list` | Bold | 1.07 | словарь |
| `speaker` | `speaker-high` | Fill | 1.1 | словарь |
| `speaker-muted-story` | `speaker-x` | Bold | 0.87 | словарь |
| `speaker-outline` | `speaker-high` | Bold | 1.06 | словарь |
| `speaker-story` | `speaker-high` | Bold | 1 | словарь |
| `sport` | `soccer-ball` | Bold | 1.09 | словарь |
| `stats` | `chart-line-up` | Bold | 1 | словарь |
| `stickers` | `sticker` | Bold | 1.1 | словарь |
| `stop` | `minus-circle` | Bold | 1.09 | словарь |
| `strikethrough` | `text-strikethrough` | Bold | 1 | словарь |
| `subscript` | `text-subscript` | Bold | 1 | словарь |
| `superscript` | `text-superscript` | Bold | 1 | словарь |
| `support-filled` | `chat-circle-text` | Fill | 1 | словарь |
| `tag` | `tag` | Fill | 1 | точное имя |
| `task-list` | `list-checks` | Bold | 1 | словарь |
| `timer` | `timer` | Bold | 0.9 | точное имя |
| `timer-filled` | `timer` | Fill | 1.07 | имя без суффикса |
| `tools` | `sliders` | Bold | 0.89 | словарь |
| `truck` | `truck` | Bold | 0.96 | точное имя |
| `underlined` | `text-underline` | Bold | 1.09 | словарь |
| `undo` | `arrow-u-up-left` | Bold | 0.85 | словарь |
| `unlock` | `lock-open` | Bold | 1 | словарь |
| `unmute` | `bell` | Bold | 1.09 | словарь |
| `unpin` | `push-pin-simple-slash` | Bold | 1 | словарь |
| `up` | `caret-up` | Bold | 0.93 | словарь |
| `user` | `user` | Bold | 0.94 | точное имя |
| `user-filled` | `user` | Fill | 1.1 | имя без суффикса |
| `video` | `video-camera` | Fill | 0.96 | словарь |
| `video-outlined` | `video-camera` | Bold | 0.96 | словарь |
| `video-stop` | `video-camera-slash` | Bold | 0.95 | словарь |
| `volume-1` | `speaker-none` | Fill | 0.85 | словарь |
| `volume-2` | `speaker-low` | Fill | 0.85 | словарь |
| `volume-3` | `speaker-high` | Fill | 0.88 | словарь |
| `warning` | `warning` | Fill | 1.1 | точное имя |
| `web` | `globe` | Bold | 1.09 | словарь |
| `web-filled` | `globe` | Fill | 1 | словарь |
| `webapp` | `browser` | Bold | 1 | словарь |
| `zoom-in` | `magnifying-glass-plus` | Bold | 0.89 | словарь |
| `zoom-out` | `magnifying-glass-minus` | Bold | 0.89 | словарь |
