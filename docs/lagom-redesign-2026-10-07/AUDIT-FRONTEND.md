# Egoist Relay: frontend-аудит «как есть» и карта миграции на Egoist DS / Lagom

Дата: 07.10.2026. Режим: только чтение (исходники не менялись, приложение и сборка не запускались, `.env` не читался). Единственный созданный файл — этот отчёт. Проект: `C:\Users\Egoist\Desktop\Проекты\Приложения\Egoist Relay`, версия 1.6.1. Эталон: `Материалы\Egoist Design System\DESIGN.md` v1.1 и `tokens\tokens.json` / `tokens.css` (прочитаны полностью).

## 0. Метод, границы, обозначения

Что читалось: `src/` (940 `.tsx` + 900 `.ts`, 525 `.scss`, около 59,7 тыс. строк SCSS), `index.html`, `vite.config.ts`, `package.json`, `tauri/tauri.conf.json`, выборочно `tauri/src/*.rs`, `dist/` (сборка от 06.10 17:05; ни один файл `src/` не новее `dist/index.html` по mtime), `docs/DESIGN.md`, `docs/CODE-STYLE.md`, `docs/frontend-cycle-2026-10-06/{README,RESULT}.md`. Подсчёты — `grep`/небольшие Python-скрипты (приложение A). Контраст считался по формуле WCAG 2.x из значений токенов.

| Метка | Смысл |
|---|---|
| [проверено] | Подтверждено прочитанным файлом или вычислением; указано где |
| [наблюдение] | Следует из кода/структуры, но поведение в рантайме не воспроизводилось |
| [гипотеза] | Вывод или оценка, нужна проверка |
| [не проверено] | Не удалось проверить в режиме «только чтение» |

Граница доказательности: рендер, WebView2, DPI, скринридеры, реальное время загрузки — не проверялись. Оценки трудоёмкости — [гипотеза]. Контекст: прошлый цикл (`docs/frontend-cycle-2026-10-06/RESULT.md`) уже выполнил композицию B и содержит свой rendered-аудит; здесь он не повторяется.

## 1. Сводка

1. **Цвет.** Токены Telegram (`src/styles/_variables.scss`, ~150 ролей `--color-*`) уже дают рычаг: 1 876 обращений `var(--color-*)` в SCSS и 92 обращения к слою `--relay-shell-*` оболочки. Но поверх лежит три слоя, мешающих «одному проходу токенами»: 1 422-строчный блок `html.theme-dark` с 602 `!important` и жёсткими `#FFF/#000` (`src/styles/index.scss:762–2183`), 1 058 строк с цветовыми литералами в 160 SCSS-файлах и 479 hex-литералов в TS (307 — сами темы). [проверено]
2. **Темы.** 11 вариантов определены неравномерно: «Egoist Black» — 116 ролей, остальные десять — по 21–24 роли (`antigravityThemes.ts:134–435`). Остальные ~90 ролей приходят из светлых значений по умолчанию Telegram. На тёмных вариантах это даёт, например, `--color-text-meta` #686c72 с контрастом 2,84–3,73 (приложение B). [проверено расчётом; рендер не открывался]
3. **Шрифты.** Onest и JetBrains Mono в репозитории отсутствуют; Inter подключён через `@fontsource-variable/inter`; Unbounded — файлы и OFL в `public/fonts/`, кириллица подтверждена разбором cmap (64/64 «А–я», Ё, ё; переменная ось wght 200–900). Но Unbounded подключён неэффективно: последняя `@font-face` без `unicode-range` отдаёт 778 КБ TTF для всех символов, а `index.html:52` ещё и предзагружает этот TTF. [проверено файлами; выбор грани — по спецификации CSS Fonts]
4. **Иконки.** Один иконочный шрифт из 403 SVG (435 имён), `Icon name="…"`, `npm run icons:build` на `svgtofont`. Переход на Phosphor возможен без поломки API через тот же конвейер; полное покрытие Phosphor — [не проверено].
5. **Доступность.** Основа неплохая (`trapFocus`, `dialog`/`aria-modal`, `inert` на скрытых сервисах, ListItem с Enter/Space). Реальные дыры: вкладки папок — `div` с `onClick` без роли и `tabindex`; тосты без `role`; reduced-motion покрывает 9 из 59 SCSS-файлов с анимацией; экран входа жёстко «белый на тёмном» и нечитаем в светлых вариантах (контраст 1,06). Подробно в разд. 7.
6. **Движение.** 878 строк `transition`, 202 `animation`, 135 `@keyframes`; 30 различных значений длительности, 248 `ease` при 33 `cubic-bezier`. Длительности продублированы в TS (~200 констант `*_DURATION/_MS/_DELAY` в 143 файлах, часть — неанимационные), поэтому токены нужно вводить в CSS и JS совместно.
7. **Производительность.** Начальная загрузка (modulepreload + CSS из `dist/index.html`) — 28 файлов, 1,22 МБ без сжатия, плюс предзагрузка TTF 0,78 МБ. 85% веса `dist` — эмодзи-PNG (104 из 122 МБ). Виртуализация списка чатов — по срезу с фиксированной высотой строки 72 px (`config.ts:88`). `manualChunks` не заданы.
8. **Качество.** 395 `eslint-disable`, 82 `stylelint-disable`, 1 915 `!important` (675 в `index.scss`). UI-тестов vitest всего 4 `.tsx` файла; основной UI-регресс — внешние скрипты `scripts/relay-*.mjs`. `tests/playwright` отсутствует, хотя `playwright.config.ts:4` и `vitest.config.ts` на него ссылаются.
9. **Риск миграции.** Самое трудоёмкое — не токены, а (а) снятие `html.theme-dark` и `!important`-слоя, (б) ~240 мест «белый текст на `--color-primary`», которые при светлом акценте Lagom станут нечитаемыми, (в) синхронизация длительностей CSS↔JS, (г) иконки и (д) нативные слои Tauri (чёрный фон WebView `Color(0,0,0,255)`, принудительная тёмная тема окна).
10. **База для сравнения.** Git: единственный коммит; рабочее дерево — 1 281 изменённый файл относительно него (652 M, 629 D, 156 новых), `dist/` отслеживается. Перед миграцией нужен снимок/ветка (см. B-01 в разд. 12).

## 2. Карта UI: где что лежит и на чём стоит

Условные обозначения: «роли» — CSS-переменные, которыми пользуется область; «хардкод» — цветовые/шрифтовые/радиусные литералы; числа — по `grep` (приложение A).

### 2.1 Оболочка Relay (`src/components/`)

| Часть | Файлы | Роли и особенности | Хардкод [проверено] |
|---|---|---|---|
| Корень, панели сервисов | `App.tsx` (1 053 строки), `App.module.scss` | Слой-алиас `--relay-shell-*` (`App.module.scss:15–25`): background, surface, hover, active, border, border-strong, text, muted, focus, rail 4.5rem, caption 2.5rem. Панели: `#relay-telegram-pane`, `#relay-x-pane`, `#relay-instagram-pane`, `nativeViewport`; панель операций `inset-inline-end: 24rem` (`:245–250`), `inert` + `aria-hidden` на неактивных (`App.tsx:853–854, 881–882, 952–953`) | Радиусы 1.25rem, 0.75rem; длительности 140ms/900ms; `--color-primary-shade` в hover кнопки (`App.module.scss:205`) |
| Rail (Telegram/X/Instagram) | `multi/AppSidebar.tsx` (201), `AppSidebar.module.scss` (211) | Только `--relay-shell-*`; контейнерный запрос `relayRail`; индикатор 3×24 px; кнопка 64 px | Иконки — инлайн SVG (Telegram — заливка, X — заливка, Instagram — обводка 2 px; `AppSidebar.tsx:92–183`); подпись 0.6875rem (11 px, `scss:149`); `140ms ease` |
| Caption (окно) | `common/Titlebar.tsx` (286), `Titlebar.module.scss` (347) | `--relay-shell-*`; `position: fixed; z-index: 9999; inset-inline: rail 0`; бренд Unbounded 11 px (`scss:43–44`); контролы окна, навигация X/Instagram, вход в X, переключатель операций (Ctrl+J, `aria-keyshortcuts`) | Иконки окна — SVG 12×12 со штрихом 1.1–1.25 (`tsx:225–279`); `Icon name=` для arrow/reload/download; `homeIcon` — отдельный SVG |
| Операции (панель 24rem / полная) | `multi/MediaOperationsPanel.tsx` (440), `.module.scss` (278), `mediaOperations*.ts`, `mediaOperationQueue.ts` | `--relay-shell-*` + `--color-error` (`scss:205`); `role="region"`, `tablist/tab/tabpanel`, `aria-live` на этапе | Размеры шрифта 11/12/13/14/15/16 px вперемешку; `animation: reveal 140ms cubic-bezier(0.2,0,0,1)` (`:19`); `accent-color` на `<progress>` |
| Share (ссылка/медиа/файл) | `multi/SocialShareModal.tsx` (431), `.module.scss` (311), `socialShare*.ts` | Обёртка — общий `ui/Modal`; свои стили на `--relay-shell-*`; `role=status/alert` | Радиусы 0.375/0.625/1.5rem; шрифты 12–18 px |
| Окна X / Instagram | HTML-часть: статус-карточки в `App.tsx:884–1000`, `.xStatus*` в `App.module.scss:109–216`; содержимое — нативные WebView2-окна в `tauri/src/multi_app.rs`, `research_social.rs` | Содержимое страниц принадлежит платформам; Relay рисует только рамку, статус, повтор | Нативный фон WebView `Color(0,0,0,255)` (`multi_app.rs:1024, 1639`; `bot_web_apps.rs:113`), принудительная тёмная тема (`multi_app.rs:517, 579, 1174`; `bot_web_apps.rs:157`) |

Чистая часть: пять файлов оболочки (около 1 650 строк SCSS) уже на ролях и почти не содержат цветовых литералов. [проверено]

### 2.2 Экран авторизации

`auth/Auth.tsx`, `AuthPhoneNumber/Code/Password/Register/QrCode.tsx`, `Auth.scss` (22 цветовых литерала), `CountryCodeInput.scss`. Анимация входа — GSAP (`util/animations/gsapMotion.ts`, три вызова: `AuthPhoneNumber/Password/QrCode.tsx`). Цвета заданы как `#FFFFFF`, `#121214`, `#28282C`, `#38383E`, `#A1A1A6`, `rgba(255,255,255,…)` без привязки к ролям (`Auth.scss:57, 94, 146–161, 247, 275, 297–306, 317–333`). Заголовки задаются как «heading» = Inter (`--font-family-heading: var(--font-family-body)`, `index.scss:60`). [проверено]

### 2.3 Список чатов

`left/LeftColumn.tsx/.scss`, `left/main/LeftMain.tsx/.scss`, `LeftMainHeader`, `ChatList.tsx`, `Chat.tsx` + `Chat.scss` (485), `ChatBadge.module.scss`, `ChatFolderTabList.module.scss`, `main/FoldersSidebar.tsx` + `.module.scss`, `ui/ListItem`, `ui/InfiniteScroll`, `ui/TabList`/`Tab`. Роли: `--color-background`, `--color-chat-hover/active`, `--color-text-secondary`, `--color-primary`. Высота строки — JS-константа `CHAT_HEIGHT_PX = 72` (`config.ts:88`), абсолютное позиционирование строк (`ChatList.tsx:214–218`). Хардкод: бейджи `#26262A` / `#FFFFFF` / `#000000` (`ChatFolderTabList.module.scss:25–46, 71–87`, `ChatBadge.module.scss:62–66, 92, 117–140`), онлайн-точка `#0ac630` (`Chat.scss:219`), реакция `#ed504f` (`ChatBadge.module.scss:92`), боковая панель папок с `rgba(255,255,255,0.15)` и `backdrop-filter: blur(25px)` (`FoldersSidebar.module.scss:22, 33, 109, 120–133`). [проверено]

### 2.4 Переписка

`middle/MiddleColumn`, `MiddleHeader.tsx/.scss`, `MessageList.tsx` (1 572), `message/Message.tsx` (2 548) + `Message.scss` (988) + `_message-content.scss` (1 267), `MessageMeta.scss`, `reactions/*`, `embedded/EmbeddedMessage`. Роли: `--color-background(-own/-secondary)`, `--color-text-*`, `--color-reply-*`, `--color-message-*`, `--accent-color` (peer-цвет). Хардкод: единый переопределяющий слой в `index.scss:762–2183` (формы пузырей `18px`, тени `0 2px 10px rgba(0,0,0,.35)`, белый текст, `pre { background:#000 }` и т. д.); цианный статус «в сети» `#38BDF8` и серый `#A0A5AC` (`MiddleHeader.scss:255–257`, `MessageMeta.scss:162–164`). [проверено]

### 2.5 Композер

`common/Composer.tsx` (3 403) + `Composer.scss` (1 236), `middle/composer/*` (63 `.tsx`, 36 `.scss`), `styles/_composer-primitives.scss`, rich-input на Tiptap. Кнопка отправки в `theme-dark` уже «инверсная» (белая плашка/чёрный значок) — хардкодом, `Composer.scss:555–570, 886–915`; это близко к главной кнопке Lagom, но завязано на `#FFF/#000` и `!important`. [проверено]

### 2.6 Настройки

`left/settings/*` (52 `.tsx`, 18 `.scss`), выбор темы — `SettingsGeneral.tsx:75–101` (две радиогруппы: 7 тёмных и 4 светлых вариантов), фон/обои — `SettingsGeneralBackground*.tsx`, `WallpaperTile`. Плоские секции на `ListItem`, `ui/Radio`, `ui/Switcher`, `ui/Checkbox`. [проверено]

### 2.7 Медиа-вьюер

`mediaViewer/*` (10 `.tsx`, 9 `.scss`, 921 строка). Нативный `<dialog>` с `showModal()` (`MediaViewer.tsx:335, 633–641`); поверхности намеренно «белое на чёрном» (`MediaViewer.scss:23–25, 110, 237`, `VideoPlayerControls.scss:18, 62–63, 97`). Это контент/оверлей — в Lagom остаётся чёрным. [проверено]

### 2.8 Модалки и меню

`ui/Modal.tsx` (436) + `Modal.scss` (355): используется в 85 файлах; новый слой `gili/modal/Modal.tsx` (531) — в 10 файлах (`@gili/*` алиас). `trapFocus` (`util/trapFocus.ts`) подключён в `ui/Modal`, `DocumentReaderModal`, `MediaEditor`. Меню: `ui/Menu.tsx` + `MenuItem.tsx` (`role="menu"/"menuitem"`), `ContextMenu`, `DropdownMenu`; тосты — `ui/Notification.tsx`. Кнопка `ui/Button.tsx` — в 222 файлах, `ListItem` — в 90. [проверено]

### 2.9 Прочее

`right/*` (51 `.tsx`), `story/*`, `calls/*`, `payment/*`, `iv/*` (instant view), `modals/*` (184 `.tsx`, 93 `.scss`), `gili/*` (11 `.tsx`: Control, Interactive, Island, Surface, Modal, Checkbox, Radio, Switch, IconBackdrop, CheckboxField, SwitchField) — это кандидаты на «первый слой» компонентов Lagom. `components/test/*` — 23 тестовых компонента внутри `src/`.

## 3. Хардкод и токены: цифры

Область — `src/**/*.scss` (525 файлов), если не указано иное. [проверено]

| Категория | Количество | Где сосредоточено |
|---|---|---|
| Строки с hex-цветом (без `_variables.scss`) | 585 в 108 файлах | `styles/index.scss` 119; `_codeHighlight.scss` 39; `MediaEditor.module.scss` 26; `Message.scss` 20; `Composer.scss` 16; `Auth.scss` 15 |
| Строки с hex или `rgb(a)` | 1 058 в 160 файлах (10 файлов дают 455, 25 файлов — 688) | `index.scss` 176; `PhoneCall.module.scss` 43; `Message.scss` 40; `_codeHighlight.scss` 39; `MediaEditor` 34; `ui/Button.scss` 33 |
| `rgba(255,255,255,…)` / `rgba(0,0,0,…)` | 229 / 166 | оверлеи, hover, границы |
| `#fff`/`#ffffff` / `#000`/`#000000` | 182 / 98 | белый/чёрный текст и фон |
| `color: white|#fff|var(--color-white)` | 53 (`var`) + 185 (литералы) | белый текст — самый рискованный класс при светлом акценте |
| `color: black|#000` | 51 | |
| hex в TS/TSX (кроме тестов, 42 файла) | 479 | `antigravityThemes.ts` 307; `map.ts` 21; `themeStyle.ts` 14; `gramjs/helpers/misc.ts` 12; `StarSlider.tsx` 10 |
| `font-family` | 84 строки (22 с `!important`) | |
| `font-size` (литералы) | 894 из 973 | на лестнице DS (12/13/15/19/24/30/37 px) — 315; 14 px — 212, 16 px — 146, 20 px — 79 (в основном размер иконок), ниже 12 px — 43 |
| `font-weight` | 442; без переменных — 7 | `FullNameTitle.module.scss:38`, `PublicPostsSearchLauncher.module.scss:36`, `AudioPlayer.scss:185` нарушают `CODE-STYLE.md` |
| `border-radius` | 841 строка; через `--border-radius-*` ~190; 138 × `50%` | 188 файлов с rem/px-литералами; значения: 0.25/0.375/0.5/0.625/0.75/1/1.25/1.5/2 rem |
| Отступы (`padding/margin/gap/inset`) | 3 103 значения, вне сетки 4 px — 809 (26,1%) | чаще всего 2 px (185), 6 px (173), 10 px (75), 3 px (46) |
| `box-shadow` | 205 | в основном литералы |
| `transition` / `animation` / `@keyframes` | 878 / 202 / 135 | 230 файлов с литеральными длительностями |
| `!important` | 1 915 в 228 файлах (675 — `index.scss`) | |
| `@media` по ширине / `@container` | 203 / 6 | `max-width: 600px` — 144 (недостижимо при `minWidth` окна 800) |
| `backdrop-filter` | 75 | в Lagom «эффектов: нет» |

Примеры «литерал вместо роли» (все [проверено]): `Auth.scss:146–161` (`#121214`, `#28282C`, `#38383E`), `ChatFolderTabList.module.scss:28, 40` (`#26262A`; это значение совпадает с `graphite-700` Lagom случайно, а не через роль), `MessageMeta.scss:19–21, 131–140` (`white`, `rgba(14,16,22,.85)`), `Notification.scss:74–87` (`#2E2E34`, `#1C1C20`, `#2A2A30`), `MediaViewer.scss:25` (`rgba(0,0,0,.9)` — оставить).

## 4. Токены и стратегия маппинга

### 4.1 Как устроено сейчас

1. **Базовые роли** — `src/styles/_variables.scss` (Sass внутри `@layer variables`, `:root{…}`): светлая палитра Telegram по умолчанию (`$color-primary: #3390ec` и т. п.), радиусы `--border-radius-*` (`:234–249`), z-слои (`:271–318`), переходы слоёв `--layer-transition: 300ms cubic-bezier(.33,1,.68,1)` (`:333–338`), веса шрифта. [проверено]
2. **Варианты тем** — `src/util/antigravityThemes.ts`: массив из 11 объектов `{id, category, base, variables}`; `applyAntigravityTheme()` ставит классы `theme-dark|theme-light` и `theme-variant-<id>` на `<html>` и пишет переменные в `html.style` (инлайн), предварительно удалив все ключи всех вариантов (`:464–474`). Хранение выбора — `localStorage['egoist_theme_variant']`; недействительный id → `egoist-dark` (`:437–447`). Вызывается трижды: `index.tsx:39`, `index.tsx:77`, `global/actions/ui/initial.ts:191`. [проверено]
3. **Третий слой** — `src/styles/themes.json` + `util/switchTheme.ts`: анимированная интерполяция старого набора цветов (чёрный/серый с синим `#1D9BF0` для ссылок), записываемых тоже в `html.style`. Если класс `theme-<theme>` уже есть, `switchTheme` выходит сразу (`switchTheme.ts:28–31`), а `applyAntigravityTheme` ставит класс раньше (`index.tsx:39`). Поэтому `themes.json` в штатном потоке фактически не применяется [наблюдение]. Риск: при расхождении `shared settings.theme` и базы выбранного варианта значения из `themes.json` (в т. ч. `--color-green: #EFF3F4`) окажутся в инлайне и не будут очищены антигравити-слоем [гипотеза].
4. **Динамические переменные** — `util/theme.ts` (`peer colors`, `<style>` с `html{…} html.theme-light{…} html.theme-dark{…}`); цвета пиров `#D45246…` в `theme.ts:63–69` и `_common.scss:~270`.
5. **Слой оболочки** — `--relay-shell-*` в `App.module.scss:15–25`, это алиасы на Telegram-роли.
6. **Мини-приложения** — `util/themeStyle.ts` читает `--color-background/-text/-primary/-links/…` и отдаёт ботам `themeParams`; при сохранении имён переменных значения Lagom пройдут автоматически.

### 4.2 Рекомендуемая стратегия «минимальный риск»

Принцип: **не переименовывать роли Telegram, а назначить им значения Lagom через один слой**, затем по мере готовности переводить компоненты на роли DS.

| Telegram-роль (где) | Lagom-роль | Примечание |
|---|---|---|
| `--color-background`, `--color-background-sidebar` | `--bg` | |
| `--color-background-secondary` (панели, rail, caption, входящие пузыри, меню) | `--surface-1` | |
| `--color-background-secondary-accent`, `--color-background-selected`, `--color-background-own` | `--surface-2` | исходящий пузырь — `--surface-3`, если нужна заметная разница [решение] |
| `--color-item-hover`, `--color-chat-hover` | `--surface-1`→`--surface-2` | |
| `--color-item-active`, `--color-chat-active` | `--surface-3` | текст `--text` |
| `--color-borders`, `--color-dividers(-android)` | `--line` | |
| `--color-borders-input` | `--line-strong` | контраст 1,5–1,7 — см. 7.2 |
| `--color-text`, `-rgb` | `--text` (и RGB-тройка рядом) | `-rgb` обязательно синхронизировать (23 использования в SCSS) |
| `--color-text-secondary`, `-meta`, `-icon-secondary`, `--color-placeholders` | `--text-muted` | `--text-faint` только для декора/disabled |
| `--color-primary`, `--color-active`, `--color-interactive-active` | `--accent` (инверсия) | в Lagom акцента нет |
| `--color-primary-text`, `--color-white` как текст на primary | `--on-accent` | см. 4.5 |
| `--color-primary-shade(-darker)` | `color-mix(in srgb, var(--accent) 92%/84%, black)` | |
| `--color-primary-tint/-opacity(-hover)` | `color-mix(in srgb, var(--accent) 10%/20%/25%, transparent)` | исправляет невалидное `rgba(var(--color-primary), …)` (см. F-04) |
| `--color-links`, `--color-own-links` | `--text` + подчёркивание | синего в Lagom нет |
| `--color-error`, `-shade` | `--danger` | семантика, не акцент |
| `--color-success`, `--color-green` | `--success` | |
| `--color-warning` | собственная семантика (в DS роли нет) [решение владельца] | |
| `--color-default-shadow`, `--shadow-*` | `--shadow` | одна тень вместо пяти |
| `--border-radius-button` 1rem, `-default` 1rem, `-default-small` .625rem, `-default-tiny` .375rem | `--radius-md` 12, `--radius-md` 12, `--radius-sm` 6…12, `--radius-sm` 6 | |
| `--border-radius-modal` 2rem, `-island/-pane` 1.5rem | `--radius-lg` 20 | |
| `--border-radius-messages` .9375rem / `-small` .375rem | `--radius-md` / `--radius-sm` | |
| `--layer-transition`, `--slide-transition`, `--top-stack-transition` | `--dur-base` + `--ease-expo` (появление экранов) | менять только вместе с TS-константами |

Реализация «одним проходом»: (1) новый `src/styles/_lagom-tokens.scss` из `tokens.css` (≈180 строк) в `@layer variables` до `_variables.scss`; (2) в `:root` из `_variables.scss` заменить значения ролей на ссылки (`--color-background: var(--bg)` и т. д.); (3) в `antigravityThemes.ts` добавить две записи `lagom-dark` / `lagom-light` с полным набором ролей и сделать их значением по умолчанию; (4) `--relay-shell-*` перенаправить на `--bg/--surface-1/…` напрямую. Эти шаги затрагивают 3–4 файла и меняют вид всех компонентов, которые уже сидят на ролях. [гипотеза по объёму]

### 4.3 Одиннадцать тем

Состав сейчас: тёмные `egoist-dark` (Egoist Black, чистый #000), `dark-modern` (синий primary #0078D4), `dark-plus` (синий), `tokyo-night` (синий/фиолетовый), `monokai` (лаймовый primary #A6E22E), `abyss` (тёмно-синий), `solarized-dark`; светлые `light-modern`, `light-plus`, `quiet-light` (фиолетовый), `solarized-light`. Десять из одиннадцати нарушают инвариант 1 DS («монохромная основа»). Предлагаю решение владельцу (разд. 13):

- **Вариант 1 (рекомендуется).** Lagom Dark и Lagom Light становятся первыми и единственными «основными»; остальные 10 временно остаются в списке как «Прежние палитры» без поддержки новых компонентов, после выпуска — удаляются. Миграция сохранённого выбора: `egoist-dark` → `lagom-dark` (тест `antigravityThemes.test.ts:84–90` ожидает fallback на `egoist-dark` — обновить).
- **Вариант 2.** Удалить 10 вариантов сразу. Проще слой темы, но меняется сохранённое состояние части пользователей [не проверено, сколько их].
- **Вариант 3.** Оставить все 11, достроив каждый до полного набора ролей генератором из базовой палитры. Дороже всего и противоречит курсу на монохром.

В любом случае сначала нужно закрыть F-04: неполные варианты.

### 4.4 Светлая тема

В DS светлая тема «выводится теми же ролями». Сейчас фактически светлые варианты не получают слой `html.theme-dark` (раскладка сообщений, ширины, формы пузырей живут под `html.theme-dark`, `index.scss:846–1130`), то есть **структура переписки в светлых вариантах отличается от тёмных не только цветом** [проверено по селекторам; рендер светлой темы не открывался]. Для Lagom Light раскладочные правила надо вынести из `html.theme-dark` в общий слой, оставив под ним только то, что действительно зависит от темы.

Принудительно тёмные поддеревья: `.component-theme-dark` используется в 10 `tsx` для истории/story-диалогов (`index.scss:688–705`, жёсткие `#0D0D0D…`). В Lagom это должно стать скоупом `[data-theme="dark"]` с теми же ролями.

### 4.5 Белый текст на акценте (главный технический долг миграции)

Сейчас `--color-primary` — светлый (#F5F5F5) в Egoist Black, поэтому светлый текст на нём исправляется `!important`-блоками (`Composer.scss:555–570`, `ChatFolderTabList.module.scss:33–46`, `ChatBadge.module.scss:62–66`, `index.scss:2137–2140, 2275–2284`). Роль `--color-primary-text` используется всего 7 раз при 68 фонах `--color-primary` и 53 + 185 «белых» текстовых декларациях. Для Lagom (акцент = светлая инверсия `#EDEBE6`, текст на нём `#0E0E0F`) каждое такое место надо классифицировать: **(а)** оверлей поверх медиа — оставить белым; **(б)** текст на заливке акцента — `--on-accent`; **(в)** текст на нейтральной поверхности — `--text`. Объём: порядка 240 деклараций в ~120 файлах [гипотеза: доли (а)/(б)/(в) не размечались].

### 4.6 Пользовательские цвета чата, пузырей, фон

- **Фон чата.** В `html.theme-dark` градиентный canvas скрыт и фон заменён сплошным (`index.scss:843–857`), поэтому обои реально работают только в светлых вариантах [наблюдение]. Настройки обоев (`SettingsGeneralBackground*`, `util/wallpaper.ts`) остаются, но в Lagom Dark должны быть сознательно отключены или оформлены, иначе пользовательский фон снова будет «пробиваться» через снятый `!important`.
- **Цвета пиров** (`--color-peer-*`, `.peer-color-N`, `util/theme.ts`, `_common.scss:~270`) — идентичность, трогать нельзя. Сейчас в тёмных вариантах она принудительно обелена: `[class*="peer-color-"]{--accent-color:#FFF !important}` (`index.scss:2093–2096`) и цикл `.peer-color-0…25` (`:2175–2181`); аватар-заглушка берёт `--color-user: var(--accent-color)` (`_common.scss:241`, `Avatar.scss:3`) — то есть цвета аватаров в тёмных темах уже нейтрализованы [наблюдение]. Это контрадикция с «не трогать цвета аватаров» (разд. 13, вопрос 3).
- **Градиенты платформы** (stars, premium, gifts, stories) — семантика Telegram, не переводить (`_variables.scss:216–229, 329`).
- **Цвета пользователя в редакторе медиа/опросах** (`useColorPicker.ts`, `PollModal.tsx`) — контент, не трогать.

### 4.7 Нативный слой

Окно и WebView X/Instagram/ботов: фон `#000` и `Theme::Dark` в Rust (`tauri/src/multi_app.rs:517, 579, 1024, 1174, 1639`; `bot_web_apps.rs:113, 157`). Для `--bg: #0E0E0F` (Lagom) шов между HTML и нативным WebView будет различим (вспышка #000 при загрузке); для светлой темы — резкий. Менять цвет надо синхронно с темой UI через команду Tauri (по `AGENTS.md`: каждая новая команда — отдельный файл в `tauri/capabilities/`). [наблюдение; визуально не проверено]

## 5. Типографика

### 5.1 Подключение сейчас

| Шрифт | Как подключён | Что лежит в репозитории | Кириллица | Лицензия |
|---|---|---|---|---|
| Inter (текст) | `@use "@fontsource-variable/inter"` (`index.scss:3`), семейство `"Inter Variable"` (`:61`) | В `dist/assets`: `inter-{latin 48 КБ, latin-ext 85, cyrillic 18,7, cyrillic-ext 26, greek, greek-ext, vietnamese}-wght-normal-*.woff2`, подгрузка по `unicode-range` [проверено в `dist`; `node_modules` отсутствует, пакет не проверен] | да (cyrillic + cyrillic-ext) | OFL (пакет Fontsource) [не проверено в репозитории: лицензия Inter отдельным файлом не лежит] |
| Unbounded (бренд, `.icon-char`, две модалки) | 4 `@font-face` в `index.scss:15–55`: три subset-woff2 с `unicode-range` и **четвёртая — полный TTF без `unicode-range`**; `index.html:52` предзагружает TTF | `public/fonts/`: `Unbounded.ttf` 778 КБ, `unbounded-latin.woff2` 50,9 КБ, `unbounded-cyrillic.woff2` 31,4 КБ (**md5 совпадает с `Unbounded-Variable.woff2`**), `unbounded-cyrillic-ext.woff2` 1,8 КБ, `Unbounded-OFL.txt` | [проверено] разбор cmap TTF: 64/64 «А–я», Ё, ё; ось `wght` 200–900 | OFL 1.1, файл лицензии рядом [проверено] |
| Onest | **отсутствует** (поиск по `src`, `public`, `tauri`, `index.html`, `package.json`) | — | по общим сведениям есть [не проверено] | OFL [не проверено] |
| JetBrains Mono | **отсутствует** | — | по общим сведениям есть [не проверено] | OFL [не проверено] |
| Roboto, Nunito, Roboto Condensed, Numbers Rounded | `import './assets/fonts/roboto.css'` (`index.tsx:35`), 19 `@font-face` | `src/assets/fonts/` (~320 КБ), в `dist` Roboto 82,8 КБ (10 файлов) | Roboto — да | Apache-2/OFL [не проверено] |
| Vazirmatn | `roboto.css` (персидский), `index.scss:245–253` | woff + woff2 | — | OFL [не проверено] |
| `tauri/fonts/Roboto-Bold.ttf` | не подключён из CSS | 147 КБ | — | |

`font-display: swap` у 28 из 29 лиц; `block` — у иконочного шрифта. Предзагрузка в HTML одна — TTF Unbounded.

### 5.2 Что не так с Unbounded [проверено файлами]

- Последнее по порядку `@font-face` с тем же семейством/весом/стилем и без `unicode-range` по спецификации CSS Fonts получает приоритет для всех символов. Поэтому subset-woff2 фактически не используются, а при первом обращении к Unbounded загружается 778 КБ TTF (`index.scss:48–54`).
- `index.html:52` предзагружает тот же TTF при каждом запуске.
- `util/fonts.ts:1` перед показом интерфейса ждёт `document.fonts.load()` для четырёх весов Unbounded (`'400…700 1em Unbounded'`), тогда как основной текст — Inter, а Unbounded виден в бренде 11 px и двух модалках (`Titlebar.module.scss:44`, `FormattedDateModal.module.scss:7,59`, `StoryPublisherModal.module.scss:54,126`). `UiLoader.tsx:90–107` включает `preloadFonts()` в условия готовности (`main`, `authPhoneNumber`, `authQrCode`, `lock`). [наблюдение: эффект на время старта не замерялся]
- `@font-face` объявляет диапазон `100 900`, а ось TTF — 200–900.
- `font-feature-settings: "tnum"` ставится на `html, body` (`index.scss:86`): все цифры в любом тексте табличные. DS требует tnum только для данных (счётчики, таблицы). Поддержка `tnum` в Onest — [не проверено].
- Мёртвый груз: `Roboto`, `Nunito`, `Roboto Condensed`, `Numbers Rounded` объявлены в `roboto.css`, но `--font-family-rounded/condensed/numbers-rounded` указывают на `--font-family-body` (`index.scss:64–67`), и поиск `'Roboto'`/`Nunito` в SCSS не находит обращений [проверено]. ≈160 КБ в `dist` [гипотеза: возможны обращения из TS-строк].

### 5.3 Как перейти на Onest + Unbounded + JetBrains Mono

1. Добавить в `public/fonts/` Onest (variable woff2: latin + cyrillic, при необходимости cyrillic-ext) и JetBrains Mono (variable woff2: latin + cyrillic), каждый с файлом OFL рядом; оценка веса — порядка десятков КБ на файл [гипотеза]. Внутри репозитория DS файлов шрифтов нет (`Material\Egoist Design System`: поиск `.woff2/.ttf/.otf` пуст), источник и лицензию надо зафиксировать при добавлении.
2. Заменить объявление в `index.scss:15–55`: оставить subset-woff2 Unbounded, удалить TTF-лицо и `preload` TTF (`index.html:52`); добавить `preload` на Onest latin/cyrillic.
3. `--font-family-body` → `'Onest', 'Segoe UI', system-ui, sans-serif`; `--font-family-display` → Unbounded (с `font-weight: 400`, `--display-tracking: -0.02em`, `text-wrap: balance`); `--font-family-monospace` → JetBrains Mono только для сетки/данных, но не для блоков кода без решения (в коде сообщений моноширинный шрифт остаётся по смыслу, `--font-family-monospace` в 17 местах).
4. `util/fonts.ts:1` — `SITE_FONTS` на Onest 400/500/600.
5. Убрать `tnum` с `html, body`, включать `font-variant-numeric: tabular-nums` для счётчиков, времени, размеров (в ops-панели `.operationCount` уже так).
6. Лестница: DS `--fs-md: 15px` при базе приложения 16 px (`index.scss:body 1rem`, 211 деклараций `0.875rem`, 141 — `1rem`). Размер текста сообщений пользователь меняет (`--message-text-size`, `util/applyMessageTextSize.ts`), поэтому менять нужно значение по умолчанию, а не жёстко все `rem` [решение].
7. `font-weight` в DS для Onest — 400/500; в проекте 232 раза `medium`, 130 раз `semibold` (600), 28 раз `bold`. Нужно решить, остаётся ли 600 [решение].

## 6. Иконки

Текущая система [проверено]:

- 403 SVG в `src/assets/font-icons/` (32×32, один `<path>`, заливка) → `npm run icons:build` (`dev/buildIcons.ts`, `svgtofont`) → `src/styles/icons.woff2` (58 КБ в `dist`) + `.woff` + `icons.css` (1 328 строк) + `src/types/icons/font.ts` (тип `IconName`, 435 имён).
- Компонент `common/icons/Icon.tsx`: `<i className="icon icon-<name">`; 361 использование `<Icon>`; размер задаётся через `font-size` (24 px — 79 деклараций, 20 px — 79), цвет через `color`.
- Дополнительно: 51 инлайн `<svg` в 28 `.tsx` (в т. ч. rail и caption), `src/assets/icons/{forumTopic,gram,star,qr.svg}`, лотти/TGS-анимации (не иконки).
- По строковому поиску около 389 из 435 имён где-то упомянуты в TS [приближённо].

Переход на Phosphor Bold/Fill (24 px, линия 2 px):

1. Сохранить публичный API (`Icon name`, `IconName`, класс `icon-*`) и менять только набор SVG-источников и сборку: положить Phosphor Bold в `src/assets/font-icons/` под теми же именами файлов, для `*-filled` (48 имён) — Phosphor Fill, запустить `icons:build`. Так не ломается ни один потребитель. Лицензия Phosphor — MIT [по общим сведениям, не проверено в репозитории]; текст лицензии положить рядом.
2. Составить таблицу соответствия «имя Relay → имя Phosphor» (≈435 строк); покрытие Phosphor для Telegram-специфичных знаков (gifts, stars, premium, boost, craft, auction, 2FA и т. п.) [не проверено] — для них нужна собственная отрисовка в сетке 24/2 px по правилу DS.
3. Размер: подмена нужна на 435 глифах + 28 TSX-файлах с инлайн-SVG (минимум rail, caption, `AppSidebar`, `Titlebar`, статус-карточки). Габариты не меняются, так как всё на `font-size`.
4. Визуальный риск: заливочные контуры Telegram (32 px) против линейных Bold (24 px, 2 px): оптическая плотность и размеры (20/24 px вместо 1.25/1.5rem) надо проверять на скриншотах, не автоматически.
5. Иконки платформ (логотип Telegram, X, Instagram в rail) — это бренды сервисов, их в Phosphor подменять не нужно.

## 7. Доступность

### 7.1 Что хорошо [проверено]

`ui/Modal.tsx:224` подключает `trapFocus`, `role="dialog"` + `aria-modal`, нативный `<dialog>` с `showModal()` (`Modal.tsx:243`); `MediaViewer.tsx:335`; `inert` + `aria-hidden` на скрытых панелях (`App.tsx:853–854`); `ListItem` — `role="button"`, `tabIndex`, Enter/Space (`ListItem.tsx:262–267`); `Menu`/`MenuItem` с `role`; панель операций: `role=region`, `tablist`, `tabpanel`, Escape, возврат фокуса (`MediaOperationsPanel.tsx:155–206`); `focus-visible` в 40 правилах; единые контуры оболочки (`outline: 0.125rem solid var(--relay-shell-focus)`).

### 7.2 Контраст (расчёт по значениям токенов)

Порог: текст 4,5:1 (крупный 3:1), элементы интерфейса 3:1. Полные таблицы — приложение B; ключевое:

| Пара | Контраст | Оценка |
|---|---|---|
| Egoist Black: текст #F5F5F5 / фон #000 | 19,26 | да |
| Egoist Black: вторичный #A0A0A0 / #000, #101010, #181818, #292929 | 8,03 / 7,28 / 6,79 / 5,56 | да |
| Egoist Black: граница #292929 / #000 | 1,44 | ниже 3:1 для границ |
| Lagom Dark: `--text` / `--surface-3` | 12,65 | да |
| Lagom Dark: `--text-muted` / bg, s1, s2, **s3** | 5,59 / 5,33 / 4,93 / **4,37** | на `surface-3` ниже 4,5 |
| Lagom Dark: `--text-faint` / bg, s1, s2, s3 | 3,25 / 3,10 / 2,86 / 2,54 | только для отключённого/декора |
| Lagom Dark: `--danger` / s3 | 4,90 | да |
| Lagom Dark: `--line` / bg; `--line-strong` / bg, s1 | 1,28; 1,70; 1,62 | границы не достигают 3:1 |
| Lagom Light: `--text-muted` / bg, s1, s2, **s3** | 5,44 / 5,94 / 4,99 / **4,04** | на `surface-3` ниже 4,5 |
| Lagom Light: `--text-faint` / bg | 3,16 | только декор |
| Lagom Light: `--danger` / **s3**; `--success` / **s2**, **s3** | 4,45; 4,51; 3,66 | на s3 успех ниже порога |
| Lagom Light: `--line-strong` / bg | 1,92 | границы ниже 3:1 |
| Варианты тем: вторичный текст / фон (из 10 непервичных) | solarized-light 2,93; solarized-dark 3,37; quiet-light 3,94; monokai 4,40; light-modern 4,33 | пять вариантов ниже 4,5 |
| `--color-text-meta` по умолчанию Telegram (#686c72), которым остаются 10 вариантов без собственного значения | 2,84–3,73 на тёмных вариантах | ниже порога |
| Placeholders по умолчанию (#a2acb4) на светлых | 2,17–2,31 | ниже порога |
| Auth: белый `h1` на светлых вариантах | 1,06–1,08 | нечитаемо |

Вывод для Lagom: `--text-muted` допустим на `bg`, `surface-1`, `surface-2`; на `surface-3` и выше — только для крупного/некритичного текста; рамки полей не опираются только на цвет границы (нужен фон поля + видимый фокус); `--text-faint` не использовать для текста, несущего смысл. [проверено расчётом]

### 7.3 Дефекты (привязка к файлам — в реестре, разд. 12)

Кратко: вкладки папок без роли/фокуса (F-07); тосты без `role` (F-08); rail: `aria-pressed` и `aria-current` одновременно, три Tab-остановки при стрелочной навигации (F-09); список чатов без выбранного состояния (`ListItem` не принимает `aria-current/selected`, F-10); reduced-motion покрывает 9 из 59 файлов (F-11); `outline: none` без замены в 79 местах — часть корректна (контролы с `:focus-visible` выше), но `Tab.scss:19–23`, `ChatFolderTabList.module.scss:75`, `MessageSelectToolbar.scss:125`, `ProfileInfo.module.scss:200` убирают индикатор без замены (F-12); экран входа (F-02); у ячеек сообщений и списка сообщений нет `role="log"`/`aria-live` (поиск `role="log"` и `role="feed"` пуст, F-13).

### 7.4 Порядок Tab, цели нажатия, масштаб

- Порядок: rail (`nav`, 3 кнопки, по одной Tab-остановке каждая) → caption (`role="banner"` внутри рабочей области) → активная панель → панель операций. Скрытые сервисы получают `inert`. Совпадает с визуальным порядком. [проверено по DOM-порядку `App.tsx:811–1021`]
- Цели: rail-кнопка 64 px высоты; кнопки окна 46×40 px; навигация 36×32 px; кнопка отправки/композера крупнее. В узких контейнерах (`≤24rem`) `.button` 24 px и `.navigationButton` 20 px (`Titlebar.module.scss:305–311`) — меньше 24×24 по WCAG 2.2 (2.5.8); при `minWidth: 800` окна (`tauri.conf.json`) ширина рабочей области ≥ 728 px и эти правила недостижимы в приложении, только в браузерном стресс-тесте [проверено].
- Масштаб: корень 16 px, размеры в rem, `--message-text-size` в rem (`applyMessageTextSize.ts`) — масштабируется; `<meta viewport … user-scalable=no>` (`index.html:15`) для WebView2 на десктопе не влияет [наблюдение].
- Подпись rail 11 px и бренд caption 11 px ниже минимума DS (`--fs-xs`=12 px); 43 литерала `font-size` < 12 px по проекту.

## 8. Движение

Инвентаризация [проверено, приложение A]:

- Длительности в `transition`/`animation`: 0.15 s — 166, 0.2 s — 125, 0.25 s — 91, 150 ms — 50, 0.3 s — 50, 140 ms — 41, 200 ms — 30, 0.4 s — 29 и «хвост» до 5 s. Кривые: `ease` — 248, `ease-out` — 105, `ease-in-out` — 105, `ease-in` — 28, `linear` — 26, `cubic-bezier(…)` — 33 (в т. ч. пружина `.34,1.56,.64,1` — 4 раза, `.16,1,.3,1` — 1).
- Слой оболочки (140 ms `ease`) и `reveal` панели операций (140 ms, `cubic-bezier(.2,0,0,1)`) — отдельная, согласованная система прошлого цикла (`docs/DESIGN.md`, «Motion»).
- Переходы слоёв Telegram — переменные в `_variables.scss:333–338, 354–362`: 300/450/650 ms с `cubic-bezier(.33,1,.68,1)` и `.25,1,.5,1`; Teact `Transition` + `Modal` управляют анимациями и уважают `prefers-reduced-motion` в JS (`Transition.tsx:72, 104`, `Modal.tsx:33, 83`).
- Пользовательские переключатели: `body.no-page-transitions/no-message-sending-animations/…` (`util/perfomanceSettings.ts`) — независимы от `prefers-reduced-motion`.
- GSAP: только вход на экране авторизации (`gsapMotion.ts:6–36`, 400 ms, `power3.out`, stagger 40 ms); `animateButtonPress` (`:38–52`) нигде не вызывается (F-17).
- Переходы по лэйаутным свойствам: `transition` на `height` — 16, `width` — 12, `top/bottom/left/right` — 15 (часть подавлена `stylelint-disable`).

Сопоставление с токенами Lagom:

| Сейчас | Токен Lagom |
|---|---|
| 90–100 ms | `--dur-instant` 90 |
| 140–200 ms (0.15 s, 0.2 s, 150/140/200 ms) | `--dur-fast` 160 |
| 250–350 ms (0.25 s, 0.3 s, 300/350 ms) | `--dur-base` 280 |
| 400–600 ms | `--dur-slow` 600 только для декоративного (с `--motion-amp: 0.4` в Lagom) |
| `ease`, `ease-out`, `ease-in-out` | `--ease-standard` |
| пружинные `cubic-bezier(.34,1.56,.64,1)` и подобные | `--ease-spring` только для отклика (нажатие, переключатель) |
| `cubic-bezier(.16,1,.3,1)`, слайды экранов | `--ease-expo` |

Риски: (а) десятки TS-констант должны совпадать с CSS (`MediaViewer.tsx:108` = 250, `MediaViewerSlides.tsx:66` = 350, `SymbolMenu.tsx:35` = 350, `Settings.tsx:48` = 200, `CustomSendMenu.tsx:54` = 200, `gili/modal/Modal.tsx:30` = 200 и др.): сначала нужен единый источник (читать токены из CSS в JS или собрать общий файл); (б) `--motion-amp` Lagom 0.4 применяется только к декоративному; отклик остаётся ≤ `--dur-base`; (в) reduced-motion нужно включать глобально (единый блок), а не по файлам. [гипотезы по реализации]

## 9. Производительность

Только факты из файлов.

**Сборка** (`vite.config.ts`): Vite 8/Rolldown, `base: './'`, `assetsInlineLimit` для изображений отключён, `manualChunks` нет, sourcemap только вне production, статическое копирование эмодзи (`:42–51`), диагностические файлы `build-stats.json` и `statoscope-report.html` удаляются из `dist` плагином (`vite.config.ts:316–335`). Лёгкие входные бандлы (`src/bundles/{auth,main,extra,calls,stars}.ts`) — разделение на уровне приложения. `browserslist: baseline widely available`. [проверено]

**`dist/` (06.10.2026)**:

| Показатель | Значение |
|---|---|
| Общий размер | 122 МБ, 624 файла в `assets` |
| Эмодзи-PNG (`img-apple-160` 66 МБ / 5 813 файлов; `img-apple-64` 38 МБ / 5 172) | 104 МБ (85%); используются `renderText.tsx:123`, `EmojiButton.tsx:33`, `tiptap/extensions/emoji.ts:119` |
| JS (461 файл) | 5,88 МБ; CSS (22) — 1,0 МБ; WASM (4) — 2,43 МБ; SVG (58) — 1,17 МБ; woff2/woff — 0,49/0,13 МБ |
| Начальная загрузка (28 файлов из `index.html`: `modulepreload` + CSS) | 1,22 МБ без сжатия (JS ≈ 0,96 МБ, CSS ≈ 0,26 МБ) |
| Самые тяжёлые JS-чанки | `extra` 821 КБ; `useConnectionStatus` 493 КБ (общий чанк, имя не отражает состав); `renderMessageText` 404 КБ; `main` 395 КБ; `encoderWorker` 339 КБ; `editor` (Tiptap) 308 КБ; `index` (вход) 298 КБ; `Modal` 275 КБ; `fallback` 204 КБ; `worker-*.js` 796 КБ |
| Самые тяжёлые CSS | `useConnectionStatus` 266 КБ; `extra` 211 КБ; `index` 185 КБ; `main` 74 КБ; `stars` 59 КБ |
| WASM | `fasttext` 1,12 МБ; `tlottie` 595 КБ + `tlottie-no-simd` 580 КБ; `decoderWorker` 137 КБ |
| Дополнительно | `public/build-stats.json` 93 МБ и `statoscope-report.html` 2,7 МБ лежат в `public/` и вырезаются плагином из `dist` [проверено], но раздувают репозиторий/dev-сервер |

**Ленивая загрузка**: `*.async.tsx` для модалок и экранов, отдельные бандлы `auth/main/extra/calls/stars`, Web Workers (`worker`, `fasttext`, `localTranscription`, `sharedState`, `service`). GSAP попадает во входной чанк (`index-BQ-gim0-.js`) ради анимации входа в 3 файлах [проверено grep по `dist`]. Тестовый компонент `YouTubePlayerSmoke` импортируется во вход (`index.tsx:33`) [проверено].

**Виртуализация/срезы**: чаты — срез `CHAT_LIST_SLICE` 25–30 строк с абсолютным позиционированием и высотой 72 px (`config.ts:88–92`, `ChatList.tsx:104–124, 210–218`); сообщения — окно `MESSAGE_LIST_SLICE` 40–60 и `MESSAGE_LIST_VIEWPORT_LIMIT` ×2 (`config.ts:84–85`). Это не DOM-виртуализация, а срез по данным. [проверено]

**Потенциальные источники long tasks** [наблюдение, замеров нет]: `backdrop-filter` в 75 местах (в т. ч. `blur(25px)` на постоянно видимых `FoldersSidebar.module.scss:33`, `UiLoader.module.scss:34`, `blur(100px)` в `ProfileInfo.module.scss:348`, `blur(50px)` в `ChatOrUserPicker.scss:304`); 11 `will-change`; бесконечные анимации в 20 файлах; 135 ключевых кадров; тяжёлые компоненты в одном файле (`Composer.tsx` 3 403 строки, `Message.tsx` 2 548, `MessageList.tsx` 1 572); селекторы с `[class*="…"]` и каскадом `!important` в блоке `html.theme-dark` — стоимость пересчёта стилей при смене темы не измерялась; теминг через JS-запись ~116 CSS-переменных в `html.style`. Прошлый цикл измерял отклик действий (`RESULT.md`: Ctrl+J ≈ 135 ms, переключение сервиса ≈ 35 ms, CPU — incomplete), но не загрузку и не long tasks.

**Миграционные последствия**: удаление TTF Unbounded и `blur` даст прямую экономию; добавление Onest/JetBrains Mono — плюс несколько десятков КБ [гипотеза]; новые токены CSS не увеличат бандл существенно.

## 10. Качество кода и тесты

- **Соответствие `docs/CODE-STYLE.md`**: SCSS-модули, camelCase, `buildClassName`, `lang()` — в оболочке выдержаны. Нарушения: numeric `font-weight` (3 места, см. разд. 3), `style={{` — 0 (хорошо), `as any` — 48 (вне gramjs), `console.log` — 82 (в основном под `DEBUG`), TODO/FIXME/HACK — 51. Большие файлы: `index.scss` 2 431 строка, `_message-content.scss` 1 267, `Composer.scss` 1 236. Правило «предпочитать rem» нарушают 561 литерал px > 1 px. Правило «шрифты через переменные веса» соблюдается в 98%. [проверено]
- **Отключения проверок**: 395 `eslint-disable` и 82 `stylelint-disable`; прошлый цикл фиксирует 509 предупреждений stylelint и 1 предупреждение eslint (`RESULT.md`).
- **Дублирование**: повторяющиеся блоки белого/чёрного «инверсного» текста под `theme-dark` в `Composer.scss`, `ChatBadge`, `ChatFolderTabList`, `MiddleHeader.scss:83–84`, `index.scss` (≥ 30 мест с `color:#000!important; background:#FFF!important`); три слоя темы (разд. 4.1); два набора модалок (`ui/Modal` и `gili/modal/Modal`), два набора переключателей (`ui/Switcher`, `gili/primitives/Switch`).
- **Мёртвый код**: `animateButtonPress` (`gsapMotion.ts:38–52`); `styles/themes.json` + интерполяция `switchTheme` (фактически не применяется, разд. 4.1); `roboto.css` для неиспользуемых семейств; `src/components/test/*` (23 файла, из них один — в продакшн-входе); `tests/playwright` указан в конфигах, но каталога нет.
- **Тесты**: 31 файл `*.test.ts(x)` в `src/` (27 `.ts`, 4 `.tsx`), 255 вызовов `test/it`; UI-тесты: `Titlebar.test.tsx` (196 строк), `AppSidebar.test.tsx` (120), `InlineSocialMedia.test.tsx`, `DownloadManager.test.tsx`; тема — `antigravityThemes.test.ts` (контраст primary для 11 вариантов, нейтральность Egoist Black). Вне vitest: 16 `scripts/*.test.mjs` и harness `scripts/relay-ui-audit*.mjs`, `relay-frontend-acceptance.mjs` (рендерят реальный `App` с MockClient в headless-браузере; хэши источников; `window.__relayAudit.applyTheme`) — они требуют внешнего браузера (`RELAY_UI_AUDIT_BROWSER`). Playwright-тестов (`test:playwright`) нет. Прошлый цикл: rendered-доказательства для 37 из ~775 компонентов, 63 pass / 1 gated. **Покрытие UI автотестами — малое (4 из 940 `.tsx`), а визуальной регрессии в CI нет** [проверено, `.github/workflows` не читался].
- **Репозиторий**: единственный коммит; рабочее дерево — 1 281 отличий (652 M, 629 D, 156 `??`); `dist/` отслеживается (618 `D` в `dist/assets`), хотя `AGENTS.md` велит `git rm -r --cached dist`.

## 11. Риски миграции на Lagom и порядок работ

### 11.1 Что делается токенами за один проход

(≈ 8–12 файлов, ≈ 600–900 строк) Подключение `tokens.css`, назначение значений ролям `--color-*` в `:root`, новые `lagom-dark/light` в `antigravityThemes.ts`, перенаправление `--relay-shell-*`, радиусы/тени/длительности слоя `_variables.scss`, замена `--font-family-*`. Автоматически меняют вид: оболочка, Button/ListItem/Menu/Modal/Switcher/Checkbox/Radio/Search, настройки, большая часть списка чатов, панель операций, Share. [гипотеза по охвату]

### 11.2 Что требует переработки компонентов

1. Блок `index.scss:762–2183` (1 422 строки, 602 `!important`): раскладка вынести из `theme-dark` в общий слой; цвета — на роли; обёртки, формы пузырей, тени — по DS (радиус 12/6, одна `--shadow`). Это самая рискованная правка.
2. Белый/чёрный текст на акценте (разд. 4.5): ~240 деклараций, ~120 файлов.
3. Auth.scss (22 литерала), Composer.scss (16), `ChatBadge`, `ChatFolderTabList`, `MiddleHeader`, `MessageMeta`, `Notification`, `FoldersSidebar` — перевод на роли; топ-25 файлов закрывают 65% цветовых литералов.
4. Иконки (разд. 6) и инлайн-SVG в rail/caption.
5. Шрифты (разд. 5) + размер/вес по лестнице.
6. Движение: единый источник длительностей CSS↔JS, глобальный reduced-motion.
7. Нативный слой: цвет фона WebView, `set_theme`.
8. `CHAT_HEIGHT_PX`, если меняется высота строки списка чатов (`config.ts:88`, `Chat.scss`).
9. Фирменная сетка (разд. 11.4).

### 11.3 Что нельзя трогать

- Содержимое X/Instagram и Mini Apps (страницы платформ, нативные WebView).
- Цвета пиров и аватаров (`--color-peer-*`, `.peer-color-N`, `Avatar`), градиенты stars/premium/gifts/stories, цвета качества подарков.
- Медиа: фото/видео, лотти/TGS, эмодзи-PNG Apple, стикеры; оверлеи медиа-вьюера, плеера, историй, редактора медиа (белое на чёрном — по смыслу контента).
- Подсветка кода `_codeHighlight.scss` (39 литералов) — синтаксические цвета.
- Цвета статусов платёжных и звонковых экранов, пока нет решения владельца (`PhoneCall.module.scss` 43 литерала, `GroupCall`).
- Структура `Teact` и порядок хуков; JS-таймеры анимаций менять только вместе с CSS.

### 11.4 Фирменная сетка (Egoist Grid)

Правила DS: кресты на 2–4 углах области контента, индекс раздела, `aria-hidden`, на полях кадра (между краем и `--grid-field` = 32 px), не в диалогах/меню/формах/редакторах. В Relay [наблюдение]:

- Честный индекс есть — три сервиса: `01/03 Telegram`, `02/03 X`, `03/03 Instagram` (реальная последовательность rail). Место — caption (2.5rem), справа от названия сервиса; шрифт JetBrains Mono, `--grid-label-size` 11 px.
- Кресты в Telegram-панели упираются в плотный интерфейс (список чатов без полей, шапка переписки, композер): поля 32 px вокруг контента нет, на `minWidth` 800 они стоили бы заметной площади. В панелях X/Instagram основную область перекрывает нативный WebView2 — HTML-кресты скрыты под ним.
- Пригодные места: статус-карточки X/Instagram (`App.module.scss:97–124`, «пустые» состояния без нативной страницы), экран «нет открытого чата» (`NoMessages`), панель операций (рабочая панель, не диалог). Экран авторизации — запрещён правилом «ввод/форма».
- Решение — разд. 13, вопрос 5. Рекомендация: в первом релизе индекс в caption, кресты — только на пустых/статусных экранах, без перестройки раскладки Telegram.

### 11.5 Порядок работ и оценка объёма [гипотеза]

| Этап | Содержание | Объём |
|---|---|---|
| 0. Подготовка | Снимок/ветка (B-01), базовые скриншоты через `relay-frontend-acceptance.mjs`/`visual-audit.mjs`, решения владельца (разд. 13) | 0 файлов исходников |
| 1. Токены и темы | `_lagom-tokens.scss`, маппинг в `_variables.scss`, `lagom-dark/light`, тест `antigravityThemes.test.ts`, shell-алиасы, исправление F-04/F-05 (достроить роли, убрать `themes.json`-слой) | 6–8 файлов, ≈ 500–700 строк |
| 2. Типографика | Onest/JetBrains Mono, удаление TTF-лица и preload, `fonts.ts`, `tnum`, `roboto.css` | 6 файлов + 4–6 ресурсов |
| 3. Снятие `theme-dark` и хардкода | `index.scss:762–2183`; `Auth`, `Composer`, `Chat*`, `Message*`, `Notification`, `FoldersSidebar`, `MiddleHeader` | ≈ 1 500 строк SCSS в ~25 файлах (65% литералов), остальные 135 файлов — по мере касания |
| 4. Компоненты ядра | Button, ListItem, Menu, Modal, Switcher/Checkbox/Radio, Search, Tab/TabList (+ a11y F-07), Notification (+F-08); радиусы по шкале; оболочка (rail/caption/operations) | ≈ 15–20 файлов, ≈ 3 000 строк SCSS/TSX |
| 5. Иконки | Phosphor-источники в `font-icons`, таблица имён, 28 TSX с SVG | 435 глифов + ~30 файлов |
| 6. Движение | `--dur-*`/`--ease-*`, кодомод по 230 SCSS-файлам, синхронизация TS-констант, единый reduced-motion | 230 SCSS + ≈ 40–60 TS |
| 7. Нативные слои | Rust: цвет фона WebView и тема окна по теме UI | 3 файла Rust + 1 capability |
| 8. Сетка (опц.) | Индекс в caption, кресты на статусных экранах | 3–5 файлов |
| 9. Проверка | Контрастные тесты на реальные пары Lagom, Tab/Escape/Ctrl+J, 200% текста, reduced-motion, 640×448/800×560/FullHD | обновить `scripts/relay-*`, `antigravityThemes.test.ts` |

## 12. Реестр дефектов

Серьёзность: В — высокая, С — средняя, Н — низкая. Статус — по метке. «Влияние» относится к текущему состоянию и/или миграции.

| ID | С | Файл:строка | Сценарий пользователя | Влияние | Статус |
|---|---|---|---|---|---|
| F-01 | В | `index.scss:48–54`; `index.html:52`; `util/fonts.ts:1`; `UiLoader.tsx:90–107` | Каждый запуск приложения | Подгрузка и предзагрузка 778 КБ TTF вместо subset-woff2; ожидание 4 весов Unbounded перед показом экрана; font-display swap у Inter даёт FOUT | проверено (файлы), эффект — наблюдение |
| F-02 | В | `Auth.scss:57, 94, 146–161, 247, 275, 297–306, 317–333` | Повторный вход в светлом варианте темы | Белый заголовок на светлом фоне, контраст 1,06–1,08; экран входа не следует теме | проверено по коду |
| F-03 | В | `index.scss:762–2183` | Любое использование тёмного варианта; переключение на светлый | 602 `!important`, цвета и раскладка под `theme-dark`; светлые варианты получают иную раскладку; токены Lagom не проходят | проверено |
| F-04 | В | `antigravityThemes.ts:134–435`; `_variables.scss:117–119` | Выбор любого из 10 неосновных вариантов | 21–24 роли из ~116; остальное — светлые значения Telegram (напр. `--color-text-meta` #686c72 на тёмных, контраст 2,84–3,73); `--color-primary-tint/opacity` = `rgba(var(--color-primary), …)` — невалидно для hex, подсветки выбора пропадают | расчёт проверен; рендер не открывался |
| F-05 | С | `util/switchTheme.ts:28–31`; `styles/themes.json`; `index.tsx:39`; `initial.ts:189–191` | Расхождение темы в общих настройках и базы выбранного варианта | Третий слой темы (палитра X, ссылки #1D9BF0) в штатном потоке не применяется, при расхождении оставляет в инлайне неуправляемые переменные | наблюдение / гипотеза |
| F-06 | С | `Composer.scss:555–570, 886–915`; `ChatBadge.module.scss:62–66, 117–140`; `ChatFolderTabList.module.scss:25–46` | Любая тема | «Инверсия» сделана `#FFF/#000 !important`, привязанной к `theme-dark`; в светлых вариантах поведение иное | проверено |
| F-07 | В | `ui/Tab.tsx:136–138`; `ui/TabList.tsx:192–201`; `ui/Tab.scss:19–23` | Клавиатура: переключить папку чатов | Вкладки — `div` с `onClick`, без роли, `tabindex`, `aria-selected`; фокус не доходит; есть только `Ctrl+Shift+Цифра` (`ChatFolders.tsx:196`) | проверено |
| F-08 | С | `ui/Notification.tsx:209` | Скринридер: «скопировано», ошибка отправки | Тост без `role="status"/"alert"`, не озвучивается | проверено |
| F-09 | С | `multi/AppSidebar.tsx:84–85, 116–117, 160–161`; `AppSidebar.module.scss:149–150` | Клавиатура/скринридер в rail | Одновременно `aria-pressed` и `aria-current`; три Tab-остановки при стрелочной навигации; подпись 11 px | проверено |
| F-10 | С | `ui/ListItem.tsx:262–267`; `left/main/Chat.tsx:474` | Скринридер: какой чат открыт | `ListItem` не выставляет выбранное состояние; список чатов без `role=list/listbox` | наблюдение |
| F-11 | С | 59 SCSS с `animation:` против 9 с `prefers-reduced-motion`; `ui/Button.scss:432` (`wave` бесконечно); 20 файлов с `infinite` | Windows → «Отключить анимацию» | Бесконечные индикаторы/волны/скелетоны продолжают двигаться; защита только в `Transition`, `Modal`, оболочке | проверено (счёт) |
| F-12 | С | `ui/Tab.scss:19–23`; `left/main/ChatFolderTabList.module.scss:75`; `middle/MessageSelectToolbar.scss:125`; `common/profile/ProfileInfo.module.scss:200` | Клавиатурная навигация | `outline: none` без видимой замены | проверено |
| F-13 | Н | `middle/MessageList.tsx`, `message/Message.tsx` (нет `role="log"/"feed"`/`aria-live`) | Скринридер читает чат | Новые сообщения не озвучиваются как лента | проверено (поиск пуст) |
| F-14 | С | `index.scss:86` | Любой текст с цифрами | Глобальные `tnum` противоречат DS (tnum — для данных) | проверено; поддержка в Onest не проверена |
| F-15 | С | `MiddleHeader.scss:255–257`; `MessageMeta.scss:162–164`; `Management.scss:210`; `Chat.scss:219`; `ChatBadge.module.scss:92` | Статус «в сети», бейджи | Голубой `#38BDF8`/`#3390ec`, зелёный `#0ac630`, красный `#ed504f` вне ролей; противоречит `docs/DESIGN.md` («нет blue tint») | проверено |
| F-16 | С | `multi_app.rs:517, 579, 1024, 1174, 1639`; `bot_web_apps.rs:113, 157` | Светлая тема; запуск X/Instagram/ботов | Фон WebView #000 и принудительная тёмная тема окна → шов/вспышка | наблюдение |
| F-17 | Н | `util/animations/gsapMotion.ts:38–52`; `index.tsx:33`; `roboto.css`; `components/test/*` | Сборка | Мёртвые функции/шрифты/тестовые компоненты в продакшн-пути; GSAP в входном чанке ради 3 экранов | проверено |
| F-18 | В | `index.scss:2093–2096, 2175–2181`; `_common.scss:241` | Аватары/цветные имена в тёмных вариантах | Peer-цвета принудительно белые → идентичность аватаров потеряна; требует решения до миграции | наблюдение |
| F-19 | С | `config.ts:88`; `Chat.scss`; `ChatList.tsx:104, 214–218` | Любое изменение высоты строки чата | Высота строки хранится и в JS (72 px), и в CSS; расхождение ломает позиционирование | проверено |
| F-20 | С | ~200 констант в 143 TS-файлах (`MediaViewer.tsx:108`, `SymbolMenu.tsx:35`, `gili/modal/Modal.tsx:30` и др.) | Смена длительностей в CSS | Анимация закончится раньше/позже, чем размонтируется DOM | наблюдение |
| F-21 | Н | `Titlebar.module.scss:305–311, 330` | Узкое окно | Цели 20–24 px, но недостижимо при `minWidth` 800 (рабочая область ≥ 728 px) | проверено |
| F-22 | Н | `playwright.config.ts:4`; `vitest.config.ts`; `package.json:test:playwright` | `npm run test:playwright` | Каталога `tests/playwright` нет | проверено |
| F-23 | С | `public/build-stats.json` (93 МБ), `public/statoscope-report.html` (2,7 МБ) | Репозиторий/dev | Диагностика в `public/`; из `dist` вырезается плагином (`vite.config.ts:316–335`) | проверено |
| F-24 | В | git (1 281 отличий от единственного коммита; 618 `D` в `dist/assets`; 156 `??` в `docs`) | Начало миграции | Нет чистой базы для отката/сравнения | проверено |
| F-25 | Н | `FullNameTitle.module.scss:38`; `PublicPostsSearchLauncher.module.scss:36`; `AudioPlayer.scss:185` | — | Числовой/`bold` `font-weight` вопреки `CODE-STYLE.md` | проверено |
| F-26 | Н | `ui/Modal.scss` vs `gili/modal/Modal.module.scss`; `ui/Switcher` vs `gili/primitives/Switch` | Миграция | Две параллельные реализации модалки и переключателя удваивают работу | проверено |
| F-27 | Н | `MediaOperationsPanel.module.scss:136, 229`; `AppSidebar.module.scss:149`; `Titlebar.module.scss:38–44, 334–335` | Мелкий текст в оболочке | 10–11 px при минимуме DS 12 px | проверено |

## 13. Открытые вопросы владельцу

1. Что делать с 10 неосновными темами (разд. 4.3)? Рекомендация — вариант 1: Lagom Dark/Light основные, остальные «прежние» до удаления.
2. Нужна ли светлая тема Lagom в первом релизе или только тёмная (сейчас светлые варианты имеют иную раскладку из-за `theme-dark`)?
3. Peer-цвета и аватары (F-18): оставить принудительно монохромными или вернуть цвета платформы, как требует «не трогать цвета аватаров»?
4. Исходящий пузырь: `--surface-3`, `--surface-2` или инверсия (`--accent`)? Размер текста сообщений по умолчанию: 15 px (DS) или 16 px?
5. Фирменная сетка: индекс «01/03» в caption и кресты только на статусных/пустых экранах — достаточно ли, или требуется поле вокруг Telegram-области?
6. Вес 600 (`semibold`) оставляем или остаёмся на 400/500 Onest?
7. `--color-warning` (янтарный) — вводим отдельную семантическую роль или убираем предупреждения?
8. Phosphor: разрешён ли переход на Bold/Fill для Telegram-специфичных знаков, у которых нет аналога (рисуем свои в сетке 24/2 px)?
9. Нативные окна: допускается ли синхронное изменение цвета фона WebView и темы окна из UI (новая команда Tauri и capability)?

## 14. Приложения

### A. Методика подсчётов (воспроизводимо)

Все счётчики — `grep -rE` по `src/**/*.scss|tsx|ts`:

- hex: `#[0-9a-fA-F]{3,8}\b` (исключая `_variables.scss`); `rgb(`/`rgba(`; `font-family`, `border-radius`, `box-shadow`, `^\s*transition`, `^\s*animation(-name)?:`, `@keyframes`, `cubic-bezier`, `!important`, `prefers-reduced-motion`.
- Распределения длительностей и кривых — по строкам `transition:`/`animation:`; размеры шрифта, отступы (`padding|margin|gap|inset*`), доля вне сетки 4 px — Python-скриптом по SCSS (значения `px`/`rem`).
- Контраст — формула относительной яркости WCAG 2.x (sRGB), значения из `antigravityThemes.ts` и `tokens.json`.
- `dist` — `ls -la`, `du`, разбор `dist/index.html` (28 начальных файлов).
- TTF Unbounded — разбор таблиц `cmap` и `fvar` без внешних библиотек.

### B. Контраст: расчёт

Egoist Black (`antigravityThemes.ts:15–132`): текст #F5F5F5 / #000 = 19,26; / #101010 = 17,45; / #181818 = 16,29. Вторичный #A0A0A0 / #000 = 8,03; / #101010 = 7,28; / #181818 = 6,79; / #292929 = 5,56. Граница #292929 / #000 = 1,44; / #101010 = 1,31; / #181818 = 1,22. Ошибка #EF5B5B / #000 = 6,32. Предупреждение #EFB45B / #000 = 11,35.

Варианты (текст/фон, вторичный/фон, вторичный/поверхность, вторичный/«свой» пузырь, текст primary/primary, ссылки/фон):

| Вариант | text/bg | sec/bg | sec/surface | sec/own | on-primary | links/bg |
|---|---|---|---|---|---|---|
| dark-modern | 11,06 | 5,77 | 5,36 | 5,06 | 4,53 | 5,79 |
| dark-plus | 11,25 | 6,73 | 6,18 | 3,43 | 6,40 | 8,26 |
| tokyo-night | 10,59 | 4,54 | 3,87 | 3,57 | 8,34 | 9,96 |
| monokai | 15,54 | 4,40 | 3,95 | 2,91 | 13,54 | 10,04 |
| abyss | 11,07 | 4,64 | 4,31 | 3,36 | 5,30 | 7,12 |
| solarized-dark | 5,61 | 3,37 | 2,92 | 2,17 | 5,71 | 4,75 |
| light-modern | 15,52 | 4,33 | 4,59 | 3,82 | 6,31 | 4,89 |
| light-plus | 21,00 | 6,19 | 5,58 | 5,68 | 4,51 | 5,75 |
| quiet-light | 11,59 | 3,94 | 4,29 | 3,27 | 6,99 | 5,28 |
| solarized-light | 4,99 | 2,93 | 2,58 | 2,38 | 5,71 | 2,93 |

Lagom (`tokens.json`), тёмная: `--text` / bg, s1, s2, s3 = 16,20 / 15,44 / 14,28 / 12,65; `--text-muted` = 5,59 / 5,33 / 4,93 / 4,37; `--text-faint` = 3,25 / 3,10 / 2,86 / 2,54; `--danger` = 6,27 / 5,98 / 5,53 / 4,90; `--success` = 10,18 / 9,70 / 8,97 / 7,95; `--on-accent` / `--accent` = 16,20; `--grid-label` / bg = 5,59; `--grid-ink` / bg = 1,70 (метка сетки по замыслу тусклая).
Светлая: `--text` = 18,12 / 19,79 / 16,61 / 13,46; `--text-muted` = 5,44 / 5,94 / 4,99 / 4,04; `--text-faint` = 3,16 / 3,45 / 2,89 / 2,35; `--danger` = 5,98 / 6,54 / 5,49 / 4,45; `--success` = 4,92 / 5,37 / 4,51 / 3,66; `--on-accent` / `--accent` = 17,66.

Скрипт расчёта лежит во временной папке сессии и в отчёт не включён.

### C. Ссылки

- Предыдущий цикл: `docs/frontend-cycle-2026-10-06/{RESULT,audit-map,implementation-plan,ACCEPTANCE}.md`, `docs/DESIGN.md`, `docs/CODE-STYLE.md`.
- Эталон: `Материалы\Egoist Design System\DESIGN.md`, `tokens\tokens.json`, `tokens\tokens.css`.
- Существующая испытательная оснастка для регрессии: `scripts/relay-frontend-acceptance.mjs`, `relay-ui-audit.*.mjs`, `visual-audit.mjs`, `ui-regression.mjs`.
