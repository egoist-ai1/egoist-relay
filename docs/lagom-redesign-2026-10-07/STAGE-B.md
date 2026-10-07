# Этап B — снятие хардкода (Lagom)

8 октября 2026, ветка `lagom-redesign`. Менялись только SCSS (74 файла) и один `.scss`-токен в `_variables.scss`; TSX, TS, Rust не трогались. Коммит не делался.

## 1. Что сделано

### 1.1 Блок `html.theme-dark` в `src/styles/index.scss`

- Селектор блока (раскладка: ширины, 2-lane чат, центровка, формы пузырей) заменён на `html:is(.theme-dark, .theme-light)` — та же специфичность, раскладка одинакова в обеих базовых темах. Так же заменён единственный `html.theme-dark &…` в конце файла (`Album` без текста).
- Цвета внутри блока переведены на роли: белый текст → `--color-text` / `--color-text-secondary`; белые оверлеи → `rgba(var(--color-text-rgb), a)`; «инверсия» (`#000/#FFF !important`: бейджи непрочитанного, кнопка «Открыть» мини-приложения, `bot-menu`, кнопка скачивания аудио, выбор сообщений) → `--color-primary` / `--color-primary-text`; тени → `--color-default-shadow` / `--color-light-shadow`; `#FF3B30` → `--color-error`; `pre { background:#000 }` → `--color-background`; `#1c1c20`, `#101014` → `--color-background-secondary(-accent)`; шапка даты (`sticky-date`) → `color-mix` на роли поверхности.
- Радиус пузырей `18px` → `var(--border-radius-messages)`; радиус медиа `14px` → то же; меню `14px` → `var(--radius-md)`.
- Нейтрализация цветов пиров (`[class*="peer-color-"]`, `.peer-color-0…25`) вынесена из общего блока в отдельный `html.theme-dark { … }`: в светлых темах цвета платформы остаются (решение F-18 за владельцем).
- Блок `.component-theme-dark` (принудительно тёмное поддерево историй) и верхние переопределения не менялись. Добавлено только: запасные значения `--color-text-rgb`, `--color-default-shadow`, `--color-light-shadow` для `html.theme-dark` (инлайн-переменные Lagom и `egoist-dark` их перекрывают; без них десять прежних тёмных вариантов получили бы чёрные оверлеи, потому что `--color-text-rgb` по умолчанию `0,0,0`), и `--color-toast-text` (см. 1.4).

### 1.2 «Белый/чёрный на акценте» (аудит 4.5)

Одноразовый скрипт (в temp-папке сессии) разобрал SCSS по блокам и нашёл `background: var(--color-primary|active|…)` с `color/fill/stroke` = white/#fff/#000: 21 совпадение в блоке, 19 вне запретных зон. Второй проход собрал все белые тексты вне зон (167) с фоном блока и родителей; каждая декларация классифицирована руками. Заменено на `--color-primary-text`: `Audio` (view-once), `ListTopPeers`, `PeerBadge`, `PeerChip`, `ChatOrUserPicker` (чекбокс, счётчик), `PremiumSubscriptionOption`, `BotKeyboardMenu` (hover), `EditableTable`, `Giveaway`, `ScrollDownButton`, `MiddleSearch`, `BrowserModal`, `MinimizedBrowserModal`, `TableAboutModal`, `RankModal`, `TextFormatter`, `AgeVerificationModal`, `Message` (выбор), `Composer` (главная кнопка, `bot-commands`, `bot-menu`, `paidStars`), `_mixins` (`composer-action-button-pill`), `ChatBadge`, `MiddleHeader`, `Folder`, `Tab`. Белое на серых/цветных семантических заливках (`--color-gray`, `--color-error`, `--color-green`) → `--color-background`: `Badge`, `FullNameTitle` (+ `font-weight: 500` → переменная), `MenuItem`, `Modal` (danger), `Button.danger/green`, `PeerChip.remove`.

### 1.3 Топ-файлы

| Файл | Что |
|---|---|
| `Auth.scss` | заголовки, подсказка, кнопки, шаги QR — на роли; QR-подложка и «самолёт» остаются `#FFF/#000` (код читает сканер), с комментарием |
| `Composer.scss`, `_mixins.scss` | инверсия на `primary/primary-text`, без `.theme-dark`; `bot-menu` на роли |
| `ChatBadge`, `ChatFolderTabList`, `Folder`, `Tab`, `MiddleHeader` | бейджи: единое правило `primary/primary-text`; блоки `.theme-dark` удалены; `#ed504f` → `--color-error`; `tabular-nums` на числах |
| `MiddleHeader`, `MessageMeta` | `#A0A5AC` → `--color-text-secondary`; «в сети» `#38BDF8` → `--color-text`; статусы доставки — роли (плашка поверх медиа остаётся тёмной, «прочитано» там белое вместо голубого) |
| `Chat.scss`, `ChatCallStatus` | `#0ac630` → `--color-success`; галочка верификации выбранного чата → цвет строки (без `.theme-dark`); значок монофорума/тег |
| `Notification.scss` | текст и кнопка — от `--color-toast-text` и `color-mix`, без `#2E2E34/#1C1C20` |
| `FoldersSidebar` | подложка `--color-background-secondary`, `blur(25px)` убран, оверлеи от `--color-text-rgb` |
| `Message.scss`, `_message-content.scss` | реакции: инверсия на роли, выбор — `primary`; рамки пузырей без синего `rgba(96,165,250)`; подсветка поиска `#cae3f7` → `color-mix` от `--color-text`; цитаты `#EFF3F4` → `--color-text` (были нечитаемы в светлой теме); кнопки действий рядом с сообщением — серый текст |
| `DocumentReaderModal`, `FormattedDateModal`, `SponsoredMessage`, `Audio`, `ChatForumLastMessage`, `Album`, `CommentButton`, `NewChatButton`, `Blockquote/Pullquote`, `VerifiedIcon`, `FloatingActionButton`, `ScrollDownButton`, `EmojiSearch`, `MessageList` | тёмные жёсткие цвета → роли, `.theme-dark` убран, где он только подставлял `#000/#FFF` |
| `StoryRibbon` | кнопка «Создать» в шапке списка (белое на светлом) — на роли; сам просмотр историй не тронут |
| `Button.scss`, `RippleEffect`, `ListItem`, `MenuItem`, `EmbeddedMessage`, `MessageSelectToolbar` | рябь от `--color-text-rgb`/`--color-primary-text` вместо чёрной |
| `_common.scss` | `::selection`, полоса прогресса: роли вместо белого |
| `Tab.scss`, `TabList.module.scss` | только цвета и `.theme-dark`-инверсия (TSX `ui/Tab*` не затрагивался) |

### 1.4 Радиусы, шрифты

- `--border-radius-messages`: `0.9375rem` (`_variables.scss`) и `1rem` (`body.is-ios`) → `0.75rem`; `-small` iOS `0.5rem` → `0.375rem` (в `_variables.scss` уже было `0.375rem`).
- RTL `--font-family`: `"Vazirmatn", "Unbounded"` → `"Vazirmatn", "Onest"`.
- Глобальных `tnum`/`font-feature-settings` в SCSS уже нет (поиск пуст). `font-variant-numeric: tabular-nums` добавлен на числа: `ChatBadge`, `ChatFolderTabList` (`.badge`), `MiddleHeader` (счётчик), `Tab` (`.badge`), `MessageMeta` (время и счётчики); в операциях уже было.
- `--color-toast-text` (`#FFFFFF`) добавлен в `_variables.scss`; в `index.scss` для `theme-variant-lagom-dark/light` он равен `--color-text`. Прежние варианты сохраняют белый текст на тёмном тосте. Правильнее перенести значение в `lagomTheme.ts` (файл координатора).

## 2. Цифры «до → после»

Команда `grep -rEn "#[0-9a-fA-F]{3,8}\b|rgba?\(" src --include=*.scss`; «вне зон» — без путей `_codeHighlight`, `PhoneCall`, `GroupCall`, `calls/`, `mediaViewer`, `story/`, `MediaEditor`, `payment/`, `stars/`, `*Gift*`, `*Avatar*`, `test/`, `_variables.scss`, `_lagom-tokens.scss`. «Реальные» — без строк `rgba(var(--…))`, которые теперь тоже попадают под этот grep, хотя уже на ролях.

| Показатель | До | После |
|---|---|---|
| Строк grep, весь `src` | 1162 | 876 |
| Строк grep вне зон | 754 | 470 |
| Реальных литералов вне зон | 718 | **310** (−57 %) |
| то же без определения `.component-theme-dark` (67 строк, это токены, не использование) | 651 | **243** (−63 %) |
| Строк grep в `index.scss` | 176 | 106 |
| `!important` в `index.scss` | 675 | 675 (не менялось) |
| `theme-dark` в SCSS | 65 | 48 |

Цель плана «−65 %» не достигнута на 2 процентных пункта при честном подсчёте (−63 %); остаток в разделе 3. `!important` не трогал: раскладка зависит от специфичности и от `!important` в компонентных файлах, снятие без визуальной регрессии по всему приложению небезопасно.

## 3. Что оставлено и почему

- **Запретные зоны** (по плану): `_codeHighlight`, `PhoneCall`, `GroupCall`, `mediaViewer`, `story/` (кроме кнопки «Создать»), `MediaEditor`, `payment/`, `stars/`, подарки, аватары, цвета пиров `--color-peer-*`.
- **Оверлеи поверх медиа** (белое на тёмной подложке по смыслу): плашка `MessageMeta` на медиа/стикерах, `RoundVideo(+Recorder)`, `Media`, `MediaSpoiler`, `CompactMediaPreview`, `AttachmentModalItem`, `InvoiceMediaPreview`, `MediaBadge`, `ProgressSpinner`, `Spinner`, `Slideshow`, `ImageCropper`, `ProfileInfo` (градиенты по фото), `Button` варианты `translucent-white/black`, `dark`, `transparentBlured`, `bluredStarsBadge`, `stars`, `File.scss` (значки поверх иконок файла).
- **Градиенты и цвета платформы**: premium, stars, подарки, золото платных реакций, `IconBackdrop`, `SliderDots`, `ParticlesHeader`, статусные цвета `Management.scss`.
- **QR на экране входа** и `QrCodeModal`: подложка должна быть светлой.
- **Маски** (`mask-image` с `#000`) в `index.scss`, `MessageList.scss`, `EmojiSearch`: прозрачность, не цвет.
- **Определения токенов**: `.component-theme-dark` (67 строк), `--color-peer-*`, запасные тени `html.theme-dark`.
- **Белое на `--action-message-bg`**: `ActionMessage`, `ContactGreeting`, `NoMessages`, `MessageListAccountInfo`, `forward-custom-shape`, `MessageList .empty`. Подложку задаёт `App.tsx` по обоям, а не роль; текст белый по смыслу. На реальном рендере в харнессе таких сообщений нет — не проверено.
- **Сомнительное, не тронуто**: `PublicPostsSearchLauncher .searchQuery` (`--color-white`, неясно, на каком фоне), `SimilarChannels .badge`, `ProfileRatingModal .badge` (фон задаётся не в SCSS), `AutoDeleteIcon .glyph` (фон `--accent-color`, может быть цветом пира), `Checkout` (платёжный экран), `BotKeyboardMenu` `.primaryTint/.successTint/.destructiveTint` (белый на тонировке), `Reactions.scss` (плашки реакций на стикерах).
- **`.theme-dark`, который остался и нужен** (48): ассеты и поведение тёмной темы (`Spoiler`, `Spinner`, `_codeHighlight`), подарки/stars, рамка `ChatListPanes` и `ChatFolderTabList .tabList` (плоская панель с рамкой в тёмной), `Message.scss` `.theme-dark &` (моно-реакции), `Audio` (own-вариант), `Giveaway`, `TodoList`, `PollOption`, `CommentButton` (`filter: invert`), `WebAppTab`, `Profile`.

## 4. Найденные визуальные проблемы и решения владельцу

1. **Обои в светлой теме.** После переноса раскладки в общий блок сплошной фон чата и скрытие canvas с обоями (`!important`) действуют и в светлых темах. Пользовательские обои теперь работают в обеих базовых темах одинаково плохо (не работают). Решение владельца: вернуть обои в светлую или явно отключить в настройках.
2. **Peer-цвета** (F-18): в тёмных темах нейтрализованы (как было), в светлых цветные. В Lagom Light выбранная реакция в сообщении с цветным пиром остаётся цветной — противоречит «монохромной основе».
3. **Тост** (`--color-toast-text`): решение через `theme-variant-lagom-*` в `index.scss` — временное, лучше значение в `lagomTheme.ts`.
4. В **`lagomTheme.ts:106`** строка длиннее 120 знаков, `npm run check:ts` падает на eslint (файл координатора).
5. **`_lagom-tokens.scss`** (файл координатора): 9 ошибок stylelint (`number-leading-zero`, порядок `transition-*`).
6. Остались вопросы по реальному рендеру: тосты, экран входа, мини-приложения, `FoldersSidebar` в харнессе не показываются.

## 5. Проверка

Скриншоты (харнесс с MockClient): `screens/b-dark`, `b-light`, `b-legacy` (`tokyo-night`) — `01-chat-1280`, `02-chat-1920`, `03-chat-800`, `04-operations-1280`, плюс `11-settings-general`, `12-settings-main` (экран настроек в харнессе не открылся: снят пустой левый столбец, настройки видны под модалками), `2-controls`, `2-date`, `2-confirm`, `2-menu-div` (модалки из фикстуры). Просмотрены в Read: в светлой теме найден и исправлен белый «All» во вкладке папок (`ChatFolderTabList` + `Tab`/`TabList`) и белая кнопка «Создать» (`StoryRibbon`); в тёмной раскладка и цвета совпадают с `a1-dark`, радиус пузырей стал 12 px; в `tokyo-night` ничего не сломано.

| Команда | Результат |
|---|---|
| `npx stylelint` по изменённым SCSS | 0 ошибок в моих файлах |
| `npm run check:css` | 508 предупреждений (было 509), 9 ошибок — все в `_lagom-tokens.scss` (не мой файл) |
| `npm run check:ts` | `tsc` (3 проекта) прошёл; eslint: 1 ошибка в `lagomTheme.ts:106` (max-len, файл координатора) и 1 старое предупреждение в `DocumentReaderModal.tsx` |
| `npm test` | 36 файлов, 445 тестов — все прошли |

Не проверено: экран входа и тосты в рендере, `DocumentReaderModal`, `SponsoredMessage` (скрыт), мини-приложения, реальный Tauri, wallpapers.

## 6. Изменённые файлы

74 SCSS: `src/styles/{index,_common,_mixins,_variables}.scss`; `src/components/` — `auth/Auth`; `common/` — `AnimatedTabList.module`, `Audio`, `ChatForumLastMessage.module`, `Composer`, `DocumentReaderModal.module`, `FullNameTitle.module`, `LastMessageMeta`, `ListTopPeers.module`, `PeerBadge.module`, `PeerChip.module`, `VerifiedIcon`, `embedded/EmbeddedMessage`, `pickers/ChatOrUserPicker`, `quote/Blockquote.module`, `quote/Pullquote.module`; `gili/modal/Modal.module`; `left/` — `NewChatButton`, `main/{Chat,ChatBadge.module,ChatCallStatus.module,ChatFolderTabList.module,LeftMainHeader}`, `search/ChatMessage`; `main/FoldersSidebar.module`, `main/premium/PremiumSubscriptionOption.module`; `middle/` — `MessageList`, `MessageSelectToolbar`, `MiddleHeader`, `ScrollDownButton.module`, `composer/{AiMessageEditorModal/AiMessageEditorModal.module,AttachmentModal.module,AttachmentModalItem.module,BotKeyboardMenu.module,DropTarget,EmojiSearch.module,FormattedDateModal.module,StickerPicker.module,richInput/EditableTable.module}`, `message/{Album,CommentButton,Giveaway.module,Message,MessageMeta,SponsoredMessage,TimeMenuItem.module,_message-content}`, `search/{MiddleSearch.module,MiddleSearchResult.module}`; `modals/{ageVerification/AgeVerificationModal.module,browser/BrowserModal.module,browser/MinimizedBrowserModal.module,chatlist/ChatlistModal.module,common/TableAboutModal.module,rank/RankModal.module}`; `right/RightColumn`; `story/StoryRibbon.module`; `ui/` — `Badge.module`, `Button`, `FloatingActionButton`, `Folder.module`, `ListItem`, `MenuItem`, `Modal`, `Notification`, `RippleEffect`, `SquareTabList`, `Tab`, `TabList.module`, `textInput/TextFormatter.module`. Документ и скриншоты: `docs/lagom-redesign-2026-10-07/STAGE-B.md`, `screens/b-dark`, `b-light`, `b-legacy`.
