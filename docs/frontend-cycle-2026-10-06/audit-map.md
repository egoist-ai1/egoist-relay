# Egoist Relay 1.5.0: карта фронтенда перед переработкой

Дата: 6 октября 2026. Канонический проект: C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay. Project ID: egoist-relay.

Это адресный инженерный аудит исходников и сохранённых доказательств. В этой части продукта не запускали, аккаунты не использовали, сборку и тесты не повторяли, исходники не меняли. Запуск и визуальные варианты относятся к отдельной части текущего цикла. Все числа ниже имеют обозначенный источник; членство компонента в карте не означает, что его взаимодействия проверены.

## 1. Исходная точка и границы доказательности

- Текущий package.json: версия 1.5.0. Основной агент сверил 2534/2534 source hashes с переданным кандидатом. В этой части отдельно прочитаны и хешированы шесть ключевых файлов; значения приведены в конце.
- Текущий source-каталог содержит 772 .tsx файла компонентов после исключения .async.tsx и .test.tsx. Это включает вспомогательные компоненты, а не 772 самостоятельных экрана.
- Старый manifest docs/release-1.4.7/ui-audit/full-coverage-manifest.json (2026-10-04T14:44:58.285Z) содержит 774 объекта, включая три injected enhancer. 37 объектов имели actual-ui-scenario, 736 — только source catalogue, один — gated. Этот старый manifest не переносится автоматически на новый цикл.
- Последний отчёт 1.5.0 operations-ui-audit-2026-10-06T01-24-06-761Z.md: 20/20 browser-сценариев настоящих App/Panel с MockClient и terminal native mocks. Он включает narrow/full layout, unknown progress, file/source actions по зарегистрированному ID, lock/late events, очистку, uncertain, переключение, RTL, keyboard и 200%/reduced motion.
- Основной агент в новом цикле сообщил 13/13 выбранных browser baseline-сценариев и осмотр actual chat 101 + SettingsGeneral dark/light. Это новая ограниченная выборка, а не проверка всего каталога.
- Живое медиа и actual delivery в этом аудите не проверены. Заблокированные remote images в fixture ожидаемы; LastSeen.AtDate и смесь RU/EN требуют triage fixture/локализации до объявления продуктового дефекта. Browser mock не подтверждает physical DPI, native GPU, COM focus, реальные аккаунты, filesystem UI actions и установленное восстановление.

Источники: docs/release-1.5.0/README.md:32–73; docs/release-1.5.0/operations-ui-audit-2026-10-06T01-24-06-761Z.md; scripts/relay-ui-audit.inventory.mjs:16–81.

## 2. Карта экранов, состояний и адресов

| Область | Реальные компоненты и роутеры | Состояния и границы |
|---|---|---|
| Оболочка Relay | src/components/App.tsx:134–164, :811–1027; App.module.scss; multi/AppSidebar.tsx; common/Titlebar.tsx | Telegram/X/Instagram, выбранный сервис, switch queue, краткое notice, windows minimize/maximize/close, social back/forward/home/reload, X direct login, operations count |
| Telegram root | App.tsx:82–87, :550+; auth/Auth.tsx; main/Main.tsx | Auth/Main/Lock/Inactive; QR/phone/code/password/Telegram registration; passcode/decrypt/timeout; other-client/auth inactive. Это существующая авторизация Telegram, не новая регистрация Relay |
| Chat list и поиск | left/LeftColumn.tsx:500+; left/main/LeftMain.tsx, LeftMainHeader.tsx, ChatList.tsx; left/search/LeftSearch.tsx; main/FoldersSidebar.tsx | 9 LeftColumnContent: chats/search/settings/contacts/archive/new-channel/new-group. 9 GlobalSearchContent: chats/channels/bot-apps/public-posts/media/links/files/music/voice. Empty/loading/connection/permission states зависят от каждого child |
| Чтение и composer | middle/MiddleColumn.tsx; MiddleHeader.tsx; MessageList.tsx; MessageListContent.tsx; message/Message.tsx, MessageMeta.tsx, MessageContextMenu.tsx; composer/MessageInput.tsx, AttachMenu.tsx, AttachmentModal.tsx, SymbolMenu.tsx | Loading/history/empty, reply/forward/edit/draft/scheduled/thread, search/select, media/caption/reactions/link-preview, input/record/upload/send/permissions. Виртуализация и scroll restoration принадлежат MessageList; стили не должны менять её алгоритм |
| Profile и right panes | right/RightColumn.tsx:323+; Profile.tsx; management/Management.tsx; statistics/* | 12 RightColumnContent enum, 22 ManagementScreens. Info/members/topics/management/statistics/poll-results. Наличие enum не подтверждает reachable branch: NewGroup не имеет прямого render branch в прочитанном RightColumn |
| Настройки | left/settings/Settings.tsx; SettingsMain.tsx; SettingsGeneral.tsx; SettingsPerformance.tsx; folders/*, passcode/*, twoFa/* | 91 SettingsScreens enum: general/theme/background, notifications/storage/language/sessions, privacy/exceptions, performance, folders, 2FA/passcode/passkeys, translation/stickers/experimental. Header-only fixture не доказывает body |
| Медиа viewer, stories, calls | mediaViewer/MediaViewer.tsx; story/StoryViewer.tsx; calls/group/GroupCall.tsx; calls/phone/PhoneCall.tsx | Open/loading/playback/controls/error/permission; actual native/media content, calls и hardware не проверены этим read-only проходом |
| Документы | common/DocumentReaderModal.tsx:46–324; DocumentReaderModal.module.scss; util/documentReaderState.ts, documentPreview.ts | Собственный HTML dialog.showModal(), search/copy/download; loading/error/empty/truncated/text/markdown/docx/pdf; bounded preview и источник оригинала. Top layer и cleanup должны сохраниться |
| Inline social media | middle/message/InlineSocialMedia.tsx:91+, :429–550; InlineSocialMedia.module.scss | Idle/loading/ready/playing/paused/error; native/embed source; play/stop/retry/save/cancel; error codes и download state. Remote player success нельзя выводить из isolated fixture |
| Relay share | multi/SocialShareModal.tsx:50–109, :240–415; SocialShareModal.module.scss; common/pickers/ChatOrUserPicker.tsx; multi/socialShare.ts | Источник, recipient/topic, Link/Media/File, rights/paid Telegram confirmation, idle/preparing/closing/error; новый dialog Link, recovery сохраняет прежний mode/recipient. Confirm handoff принадлежит controller, не modal |
| Operations | multi/MediaOperationsPanel.tsx:62–386; MediaOperationsPanel.module.scss; mediaOperations.types.ts; mediaOperations.ts | Current/History; queued/resolving/downloading/writing/preparing/sending/cancelling/completed/failed/cancelled/interrupted/uncertain; empty/locked/journal error/missing file; cancel/retry/open/reveal/source/check-chat/clear |
| Остальные modal families | modals/ModalContainer.tsx; main/Dialogs.tsx; main/Main.tsx:631–682; ui/ConfirmDialog.tsx | Bot trust, forward/draft/recipient, delete, folders, gifts/premium/payment и служебные flows Telegram. Существующие Telegram rights/payment guards не являются монетизацией Relay и не удаляются по визуальному запросу |
| Injected enhancement | scripts/x-enhancer.js, instagram-enhancer.js, social-share-enhancer.js | First-party DOM buttons/capture; локальный DOM fixture не доказывает актуальность каждой живой страницы X/Instagram. Эти страницы принадлежат внешнему продукту |

Эта карта задаёт адресное чтение. Для перечня enum: src/types/index.ts:204, :303, :315, :327, :507. Для динамического перечня — существующий scripts/relay-ui-audit.inventory.mjs, с отдельным evidence level на каждый источник.

## 3. Shared components и дизайн-токены

| Слой | Источник | Контракт / практический смысл |
|---|---|---|
| Shell | App.module.scss:16–28 | --relay-shell-background #09090a, surface #111113, hover #202023, active #252528, border #252529, strong #404047, text/focus #f4f4f5, muted #ababb4, rail 4.5rem, caption 2.5rem. Scope .multiRoot; portals вне него эти tokens не наследуют |
| Telegram colors | styles/_variables.scss:69+, :378+; styles/themes.json; util/antigravityThemes.ts | --color-background*, --color-text*, --color-borders*, --color-primary/links/error/warning и accent roles. 11 variant definitions: 7 dark + 4 light. Variant сохраняется egoist_theme_variant локально, применяется при boot и init |
| Theme selector | left/settings/SettingsGeneral.tsx:74–94, :164–181; src/index.tsx:39, :77 | applyAntigravityTheme задаёт class theme-dark/light и inline root variables; SettingsGeneral сохраняет base theme и отключает system theme при ручном выборе |
| Typography | styles/index.scss:57–192 | Inter для текста; Unbounded для heading/peer/title/tab/picker roles; monospace для code; веса --font-weight-*; rem measurements preferred. Заголовочные broad selectors и !important влияют и на короткие data labels, не только заголовки страницы |
| Geometry | styles/_variables.scss:231–257; main/Main.scss:75–126 | Button radii1rem, modal2rem, island1.5rem, message0.9375rem; messages-container48rem, right-column26.5rem, header4rem; эти значения не являются одним density profile |
| UI primitives | ui/Button.tsx/SCSS, InputText.tsx + styles/_forms.scss, ListItem.tsx/SCSS, Checkbox/Radio/Switcher, TabList/Tab, Menu/MenuItem, Modal/ConfirmDialog, Spinner/ProgressSpinner, Transition | Повторно использовать typed props и существующие semantics. Button имеет fast mouse-down click path и отдельный keyboard click; замена wrapper не должна удвоить действие |
| Spacing | styles/_spacing.scss | Существующая utility scale 0/.25/.5/1/1.5/2/3rem. Utilities physical left/right не превращаются автоматически в RTL |
| Global overrides | styles/index.scss:762–2216, :2218–2457 | Тёмные messages/modal/date/geometry и глобальные portal/menu/selection/topic/tab стили содержат direct colors + !important. Это самостоятельный слой каскада, который ограничивает effect обычной смены tokens |
| Layering | styles/_variables.scss:268–315; ui/Portal.ts; ui/Modal.tsx | Меню/модали/viewer/lock используют existing z-index roles; native WebView не является обычным DOM layer. Native dialog top layer нельзя заменить только большим z-index |

Практический вывод: новые shell tokens сами по себе не создают цельный редизайн Telegram. У каждой изменяемой поверхности нужно найти её локальный stylesheet, token inheritance и победившее global override; менять единственный фактический owner свойства, а не добавлять ещё один общий !important.

## 4. Teact/native/keyboard/motion контракты

**Teact.** Это React-подобный локальный renderer, а не замена на React. style prop — строка; inline objects не поддерживаются. Использовать существующие useLastCallback, memo/withGlobal и hooks. Структурные данные cache/global остаются serializable; новые state fields требуют migration. Fasterdom разделяет measure и mutation; read/write циклы в анимации рискуют forced reflow. Правила заданы AGENTS.md:451–560 и библиотеками lib/teact, lib/fasterdom.

**Native geometry.** App.tsx:167–241 измеряет nativeViewport DOM rect и масштабирует через текущие window innerSize/scaleFactor; util/tauri/appBounds.ts валидирует rect. Native X/Instagram controllers получают bounds отдельной командой multi_set_active_app/multi_update_x_bounds. На social-share используется multi_social_overlay (App.tsx:260–308). Обычный DOM transition/opacity на pane не перемещает отдельный HWND автоматически. Контекст сохраняется при скрытии; геометрию нельзя анимировать frame-by-frame.

**Operations placement.** App.tsx:491–548 измеряет workspace width <64rem; панель24rem оставляет сервису40rem или занимает весь workspace. Rem берётся из computed root font size, не фиксированных16px. Full mode вызывает multi_set_content_visible(false), не уничтожает WebView; App.module.scss:249–258 скрывает pane. Native min window800×560; 640×448 — browser layout probe, не обещание native window min size (tauri.conf.json:12–13).

**Keyboard.** AppSidebar — обычные кнопки с ArrowUp/Down/Home/End, Enter/Space, aria-current/pressed/busy. Ctrl+J у App.tsx:519+ и native AcceleratorKeyPressed в tauri/src/multi_app_downloads.rs:457–471 для каждого controller. Panel — region, roving Current/History tabs, Escape close, close focus, предыдущий focus в App. Модали используют trapFocus stack, owner-specific Menu portal и captureKeyboardListeners; перевод Enter/Space/Arrow в новый toolbar требует сохранения propagation contract. Модальные меню и native dialog имеют существующие адресные browser проверки, их поведение нельзя упростить до document-global preventDefault.

**Motion.** Shell hover/press/marker120–160ms; loading spinner900ms; Panel reveal140ms и no animation при reduced motion; Modal200ms; Menu150/200ms (fast close70ms); shared layer/slide300ms, top-stack450ms с платформенными override. Transition.tsx:107–114 учитывает matchMedia и selectCanAnimateInterface. SettingsPerformance хранит animation levels и per-feature flags. GSAP уже установлен и используется util/animations/gsapMotion.ts для auth entrance(.4s, stagger.04) и press(.1s); reduced motion исключает эти calls. Новая библиотека motion не требуется. CSS duration и JS cleanup durations должны согласовываться; простая замена duration в SCSS может оставить ghost focus/layers до старого JS timeout.

**Scale и RTL.** Фиксированный html16px; root32px — text200%, не OS DPI. Panel имеет logical inset/borders/margins и lang.code date formatting; rail/titlebar содержат physical left/right (fixed Windows chrome), Telegram содержит lang.isRtl/rtl states. Нельзя считать весь shell автоматически зеркальным. Проверять real overflow/target/focus отдельно; source scan не подтверждает screen-reader/high-contrast conformance.

## 5. Подтверждённое исходниками, старое проверенное и предложения

### Подтверждённые факты и контрактные риски

| ID | Вывод | Точный источник | Что делать в текущем цикле |
|---|---|---|---|
| F01 | DESIGN-1.3.0 описывает network badge/reconnect, которых текущий Titlebar не содержит; тест прямо требует отсутствие DNS/VPN/network actions | docs/DESIGN-1.3.0.md:69–71; common/Titlebar.tsx:120–286; Titlebar.test.tsx:89 | Не возвращать старые network controls как «недоделанную функцию». Обновить документацию по действующему поведению |
| F02 | Shell и Telegram palette имеют разных owners; глобальные overrides частично обходят palette variants | App.module.scss:16; antigravityThemes.ts:333–356; styles/index.scss:762, :2218–2285 | Согласовать token roles для затронутых surfaces; не удалять11 пользовательских вариантов молча |
| F03 | Некоторые Panel styles используют h2/h3/p/button/span/time tag selectors, хотя AGENTS требует собственные camelCase classes | MediaOperationsPanel.module.scss:21+, :74+, :93+; AGENTS.md SCSS rules | При её переработке переименовать собственные style owners в classes, без blanket переписывания всего Telegram |
| F04 | История не хранит media previews/CDN/text; receipts имеют только metadata+paths+recipient+confirmed | mediaOperations.types.ts:5–52; release-1.5.0/ARCHITECTURE.md «Хранение и IPC» | Детальный receipt рисовать на реальных полях; не обещать thumbnails/text поста после restart |
| F05 | Window-level Telegram breakpoints и pane-level24rem narrowing не согласованы одним container contract | useAppLayout.ts:53–64; config.ts:201–205; Main.scss:75–126; App.tsx:491–548 | Проверить actual narrow pane + RightColumn. Основной агент воспроизвёл тесную область чтения; см. доказательство ниже. Function-blocking failure не установлен |
| F06 | JS component durations и CSS transition durations лежат в нескольких модулях | Modal.tsx:32; Menu.tsx:54; Transition.tsx; _variables.scss:330–358 | Перед motion правкой обозначить owners/cleanup/cancellation и проверить rapid interruption |

### Новое наблюдение основного агента, прочитанное в этом проходе

В baseline-detail/rendered-details.json (2026-10-06T09:51:23.190Z, existing MockClient/synthetic operations, external requests blocked, errors[]) и просмотренном снимке baseline-detail/right-info-panel-1100-16.png есть подтверждение F05: при1100×800/root16 LeftColumn363px, MiddleColumn265px и Composer225px. Панель имеет384px. Фразы сообщения переносятся на1–2 слова в строке, placeholder composer сокращён. RightColumn в этом размере visibilityhidden. Это конкретный недостаток распределения читаемой ширины; основной сценарий не блокирован, panel contract24rem/40rem сохраняется.

При1280×800/root32 режим full operations с width1136px работает по геометрии. JSON при этом показывает RightColumn computedvisibilityvisible при скрытых Left/Middle. Это ещё не доказательство focus leak: opaque operations панель может его визуально перекрывать. Нужно отдельно проверитьTab/ShiftTab/click containment. Источники: App.tsx:848+, App.module.scss:256–258, main/Main.scss#RightColumn. aria-hidden Telegram pane зависит от activeApp, а CSS visibility может переопределяться child. После interaction допустим вывод о дефекте либо отметка passed.

### Нужна новая rendered-проверка

1. RightColumn + operations на desktop threshold: 1100×800/root16,1280×800/root16,FullHD/root16, затемroot32. Проверить видимость profile controls, message/composer, отсутствие overlapping панели и корректный nativeViewport rect.
2. Тема light-modern и минимум два существенно разных dark variants: chat/link/selected-message/context menu/owned modal menu/share/operations. CSS literal!=выбранный variant — факт каскада; плохой contrast объявлять после actual computed foreground/background и rendered state.
3. Длинный RU/EN source/filename/recipient, history500, missing-file и uncertain одновременно с keyboard/200%. Изображения и source quote доступны только если модель действительно содержит эти данные.
4. Быстрые open→close→open, switch во время reveal, отмена операции и уход с панели; следить за stale DOM, focus return, callback count и cleanup. Reduced motion проверять и после смены OS preference во время session.
5. На native: отдельные bounds readback, all3 Ctrl+J with WebView focus, Windows chrome drag/window buttons, physical DPI100/125/150/200%, GPU. Эти вопросы не решаются browser screenshot.
6. Подлинный recipient picker и document dialog, включая nested owned menu, Enter/Space, Esc twice, fallback error/loading. Старые synthetic wrappers не являются доказательством заменённого child.

### Визуальные предложения, не дефекты

- Разделить reading text и короткие navigation/data labels по рольной типографике; Unbounded и Inter доступны локально. Конкретный heading scale выбрать по одинаковому сценарию на четырёх вариантах.
- Представить операции как последовательность stage/result/actions с имеющимися metadata; Completed, Cancelled и Uncertain не должны выглядеть одинаково. Percent толькоприknown total, source link толькоприverified source.
- Согласовать action roles и surface hierarchy между share/reader/panel и базовыми primitives, без одного card на каждую фразу.
- Сохранить content-first density; wider rail labels/top tabs/compact commands — выбор пользователя с actual workspace cost, не универсальное улучшение.

## 6. Как воспроизвести главный layout-риск без live account

Использовать настоящий существующий audit fixture, не HTML twin и не установленный профиль. scripts/relay-ui-audit.server.mjs экспортирует startAuditServer(taskWork, port) и initializeAuditBrowser; external HTTP блокируется, Tauri commands заканчиваются terminal native mock.

1. Открыть fixture и дождаться __relayAudit.state().chatCount >=2.
2. page.evaluate(() => window.__relayAudit.groups.openRight('ChatInfo')) — готовый setter в scripts/relay-ui-audit.group-state.ts:44–59. Он создаёт synthetic group и real Profile route, не отправляет сообщения.
3. Открыть operations кнопкой [data-relay-operations-toggle=true] или Ctrl+J. При необходимости seed корректной записи через native mock; реальный send не нужен.
4. Измерить #LeftColumn/#MiddleColumn/#RightColumn/[data-relay-operations=true], pane and nativeViewport; осмотреть composer/header/profile/action edges при вышеуказанной матрице. Проверить реальные видимые child controls, а не лишь наличие root element.
5. При1100px/root16 rail≈72px, workspace≈1028px, split service≈644px; window media query остаётся desktop. Это конкретная ситуация для теста. Приroot32 switch threshold равен2048CSSpx, поэтому на1280px expectedfull operations.

Браузерные observation/screenshots из нового прохода добавляет основной агент. Эта карта не выдаёт ожидаемые числа за измеренные geometry results.

## 7. Безопасный охват и порядок изменений

1. Зафиксировать выбранные визуальные принципы, data/style owners, state descriptions и критерии, сохранив1.5.0 contracts. До выбора не менять source layout/typography на вкус агента.
2. Shared tokens и targeted stylesheet ownership: _variables.scss, App.module.scss, antigravityThemes.ts, конкретные overrides index.scss. Не менять настройки/IDs тем и migrations без отдельной причины.
3. Shell state/status/navigation и caption: AppSidebar, Titlebar, App. Structural positioning проверить native bounds отдельно. Если выбран top-tabs/no-rail вариант, только существующий measured viewport contract; прежняя fallback72px и Windows chrome нуждаются в проверке, не silent swap.
4. Daily reading/selection/input: LeftMain/ChatList + MiddleHeader/Message/MessageMeta + MessageInput; алгоритмы routing/virtualization/drafts/transport остаются. Проверять content and focus, не только внешний вид.
5. Share/operations/reader: только presentation и local UI state. Не редактировать controller queue/journal/backend/save/send. Сохранять mode/rights/uncertain/account/retry/clear semantics.
6. Motion на изменённых элементах с explicit trigger/easing/interrupt/cleanup/reduced/performance flags; native edgesбезframe animation.
7. Повторить targeted real-component browser сценарии, триTSconfig, changedlinters, существующие затронутые тесты, preflight/production/native проверки у основного агента. Full product compatibility и hardware scope отдельно от passing synthetic tests.

Никаких новых dependencies, cloud services, telemetry, monetization или account actions карта не требует. No new Telegram feature/API contract, persistent UI entity или backend change здесь не предложены.

## 8. Source identity для этого read-only прохода

SHA-256 точных bytes, прочитанных6 октября2026:

| Источник | SHA-256 |
|---|---|
| src/components/App.tsx | 9c87b27d7e3c158118e3bbac001619ed9cef59c4e27f758b63eaa18fafb39221 |
| src/components/App.module.scss | 02510618c48a03f77358df0c3526680bf54a9fc49aadee4d65e482c7c6325de3 |
| src/components/common/Titlebar.tsx | fedc8d16e4e12cb6e2a7f08049b8f9ceb89f5c57b0ad1288e6f656f35cc72c64 |
| src/components/multi/MediaOperationsPanel.tsx | 0b5e533e3ec526065b0f24d339ac2dd5f8eff769a5024f77edc8816b8ddb8cea |
| src/styles/index.scss | 59ac3f33081fa679d043e49f3b14831f90384684fa56debd59d62db540d7bd81 |
| src/util/antigravityThemes.ts | 735e5ad2d14d1ddf727b10c1eba6548690c6ba5e1cdffb2b140bba4e1c10dc2b |

## 9. Обратная связь

Самостоятельные выводы F01/F02/F04/F05/F06 и визуальные предложения включаются в общий companion review board текущего frontend cycle с отдельными нейтральными ответами. Подтверждение карты принимает её как source audit; оно не подтверждает непроверенные live/native сценарии и не разрешает автоматическую пересылку.
