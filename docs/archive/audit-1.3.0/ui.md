# Свежий аудит UX/UI Egoist Relay

Дата: 29 сентября 2026, baseline исходников 1.2.6. Выполнено заново, предыдущие screenshots не использованы как доказательство.

## Метод и границы

Использован workflow impeccable. Сохраняется существующая идентичность: монохромная оболочка, Unbounded для заголовков, Inter для текста, кириллица, SVG и имеющийся icon font. Новых библиотек нет.

Headless Edge запущен с чистым временным browser context и локальной fixture на свободном loopback порту. В ней выполняются **реальные** Teact компоненты AppSidebar, Titlebar, DocumentReaderModal, InlineSocialMedia и SocialShareModal, с настоящими SCSS и глобальной типографикой. Подменены языковой provider, Tauri, Telegram state/API/media fetch, получатель/Modal/payment и отправка share. Внешние HTTP запросы блокировались. Реальные аккаунты, установленный Relay, clipboard и системная сеть не затрагивались.

Проверены 800×560, 1280×720, 1573×1163 и размер корневого текста 16/32px (текстовая масштабируемость 200%, это **не** проверка OS DPI или WebView2 zoom). Получено 37 случаев и свежие PNG/геометрия: [baseline-metrics.json](ui/baseline-metrics.json). JS ошибок fixture нет. Native X/Instagram bounds и live account media проверяет основной аудит отдельно.

## Подтверждённые дефекты baseline

| Приоритет | Дефект и доказательство | Адрес | Доработка |
|---|---|---|---|
| P1 | Одиннадцать объявленных читаемыми расширений открывают пустой body: htm, h, hpp, java, go, php, rb, bat, ps1, conf, config. Все11 воспроизведены, bodyElements=0. [go](ui/baseline-reader-extension-go.png) | `src/util/documentReaderState.ts:15`; `src/components/common/DocumentReaderModal.tsx:302`, `:471` | Единый контракт читаемых расширений и текстовый renderer для всех обычных исходников/конфигураций. |
| P1 | Reader header при800×560/32px выходит за правый край: scrollWidth1015 при clientWidth750; title width0, headerRight заканчивается в x1039. [32px](ui/baseline-reader-800x560-32px.png), [16px](ui/baseline-reader-800x560-16px.png) | `src/components/common/DocumentReaderModal.module.scss:33`, `:111`, `:126` | Header с переносом/двумя строками, гибкий search, компактные icon actions с доступными названиями; оставить close доступным. |
| P1 | Reader открывается с focus на фоновой кнопке, role=dialog отсутствует. Tab не удерживается в reader; автоматического focus/return нет. Header close — icon button без aria-label. | `src/components/common/DocumentReaderModal.tsx:362`, `:363`, `:416` | Использовать существующий modal/focus-stack contract, aria-modal/label, focus trap и восстановление, безопасное поведение Esc. |
| P1 | Файлы без size/line cap и отмены чтения дают неограниченную работу. 20тыс строк создали40 004 DOM узла (~438ms до готовности на этой машине, не сравнительный benchmark). fetch/response.text/arrayBuffer не имеют AbortController. | `src/components/common/DocumentReaderModal.tsx:234`, `:236`, `:243`, `:331`, `:474` | Ограничить preview/декомпрессию; ограничить DOM строками, показать понятный предел и скачать оригинал; отменять собственный fetch при смене/закрытии. |
| P2 | Поиск виден в Markdown/DOCX, но не использует searchQuery при HTML render. Поиск «Строка» дал0 mark в md/docx и1 в txt. [md](ui/baseline-reader-extension-md.png) | `src/components/common/DocumentReaderModal.tsx:331`, `:381`, `:450`, `:460` | Реальный безопасный поиск по text nodes formatted renderer или убрать недействующий control до реализации. |
| P2 | Titlebar z9999 выше reader z1510. При800×560/16px он перекрывает reader y29–40; при32px y29–80. | `src/components/common/Titlebar.module.scss:6`; `src/components/common/DocumentReaderModal.module.scss:4` | Согласованный overlay stacking и placement ниже штатной caption area. Native caption actions могут оставаться доступными без перекрытия содержимого. |
| P2 | Номер строки и текст имеют разную высоту строки (13px×1.6=20.8 против14px×1.6=22.4). Колонки расходятся с каждой строкой. | `src/components/common/DocumentReaderModal.module.scss:444`, `:459` | Общее line-height/row contract для номера и текста. |
| P2 | Loading/error/plain text/header labels жёстко заданы по-русски, error выводит String(err), неизвестные/пустые данные не имеют отдельного состояния. Search input без aria-label. | `src/components/common/DocumentReaderModal.tsx:226`, `:252`, `:387`, `:398`, `:409`, `:429` | lang() и действия для loading/empty/too-large/error, названия input/button, скрыть внутреннюю строку исключения. |
| P2 | Reader fade/scale/backdrop blur не учитывают prefers-reduced-motion. | `src/components/common/DocumentReaderModal.module.scss:14`, `:30`, `:482` | Отключить scale/fade при reduced motion; оценить blur на слабом GPU. |

## Оболочка и социальные функции

- AppSidebar: ArrowDown/End переводят focus корректно, Enter выбирает Instagram. 48px кнопки, видимые focus indicators и loading/error labels присутствуют. Состояния не полагаются только на цвет. Свежие [800×560](ui/baseline-shell-800x560.png), [1280×720](ui/baseline-shell-1280x720.png), [1573×1163](ui/baseline-shell-1573x1163.png).
- Titlebar: нормальный baseline800×560 помещает navigation/network/window controls; notices сокращаются с tooltip, кнопки названы. Статус относится к локальным службам и не обещает внешний доступ. Контролы уменьшаются на узкой ширине, reduced motion обработан.
- `src/components/App.tsx:80`, `:81`, `:107`: native bounds фиксированы72/40CSSpx, хотя SCSS shell4.5rem/2.5rem. При32px fixture измеряет144/80. Это **подтверждённое расхождение контрактов**, но реальное native наложение при WebView zoom не проверено этим агентом; требуется отдельный native readback. Варианты: измерять pane rect и подписывать ResizeObserver или явно согласовать размеры/zoom.
- InlineSocialMedia: placeholder/vertical/error copy/focus/reduced motion в коде есть; idle vertical [16px](ui/baseline-inline-800x560-16px.png), [32px](ui/baseline-inline-800x560-32px.png). Network/player recovery не доказывается blocked-network fixture, относится к media/native аудитам.
- SocialShareModal: действия в16px fixture видимы, source details имеют ограниченный scroll. При32px synthetic RecipientPicker source toggle перекрыт и actions compressed: [16px](ui/baseline-share-800x560-16px.png), [32px](ui/baseline-share-800x560-32px.png). **Не объявлять это live дефектом без проверки настоящего picker**: fixture подменяет его layout. Родитель должен проверить live min-height/zoom сценарий.
- Sticker layout: source document имеет приоритет перед cached thumb, метаданные вынесены в отдельную строку. Дополнительный свежий прогон ниже обнаружил оставшееся сжатие стикера общим emoji CSS и проверил его исправление. Точный личный sticker на текущем запуске не открывался; его декодирование/анимация не проверены.
- Отдельного нового `NetworkSettings` компонента в текущем `src` нет. Status/reconnect проверены в Titlebar; импорт/секреты/network isolation находятся в отдельной ветке аудита.

## Детектор и оценка дизайна

Impeccable scan11 custom surface files дал один advisory: DocumentReader Markdown blockquote `border-left:3px` (SCSS:354). Это корректное оформление цитаты, а не подтверждённый дефект. Автоматически убирать его не нужно.

Reader blue/green/purple file badges и синий markdown контрастируют с монохромной оболочкой. Практичная доработка — semantic tokens и спокойные monochrome badges, сохранив различимость формата текстом. Это consistency finding, а не ошибка функциональности. Главные критерии выпуска — читаемость, доступные действия и bounded preview.

## Исправления 1.3.0 и повторная проверка

Повторный прогон: 30 сентября 2026 по московскому времени. Адреса в таблице baseline выше относятся к исходникам до исправления. Новые адреса ниже относятся к проверенной реализации.

| Дефект | Реализация | Повторное доказательство |
|---|---|---|
| Пустые объявленные расширения | `src/util/documentPreview.ts:24` выводит контракт текстовых расширений из `READABLE_EXTENSIONS`; `DocumentReaderModal.tsx:58` выбирает общий текстовый renderer. | Проверены все11 ранее пустых расширений и txt/md/docx: текст присутствует, поиск «Строка» даёт1 подсветку. [go](ui/after-reader-extension-go.png). |
| Обрезание header/перекрытие Titlebar | Две строки header, гибкий search, компактные icon actions на узком окне, 44px targets при обычном размере текста. `DocumentReaderModal.module.scss:62`, `:109`, `:544`. Native `<dialog>` в top layer: `DocumentReaderModal.tsx:201`. | Во всех6 сочетаниях размеров окна и текста title сохраняет ненулевую ширину, действия внутри modal, `elementFromPoint` над header принадлежит modal. При800×560/32px header scrollWidth=clientWidth=750. [800×560/32px](ui/after-reader-800x560-32px.png). |
| Отсутствие focus/modal contract | Нативная модальность, aria-labelledby/aria-modal и названия действий; существующие `trapFocus`/keyboard capture/direct input helpers; восстановление предыдущего фокуса. `DocumentReaderModal.tsx:82`, `:97`, `:201`. | Первый focus внутри reader;13 последовательных Tab остаются внутри; Esc закрывает reader и возвращает focus фоновой кнопке. Проверено в каждом из6 сочетаний viewport/текста. |
| Поиск Markdown/DOCX | Подсветка безопасных text nodes сохраняет форматирование и адреса ссылок. `DocumentReaderModal.tsx:149`; `src/util/documentPreview.ts:292`. | На реальных Teact renderer md/docx поиск даёт1 mark. Utility тесты проверяют кириллицу, буквальные `a+b`, сохранение href и ограничение2000 marks. [Markdown](ui/after-reader-extension-md.png). |
| Расходящиеся номера строк | Общие font-size/line-height и row contract: `DocumentReaderModal.module.scss:514`. | Y координаты номеров и текста совпадают на первых3 строках во всех6 viewport/text случаях, включая32px. |
| Неограниченный preview | Собственное потоковое чтение ограничено фактическим количеством байтов; текст2MiB, DOCX archive/XML4MiB, PDF32MiB. Текстовый preview100тыс символов/2000 строк; DOCX дополнительно4000 runs. `src/util/documentPreview.ts:33`, `:92`, `:160`. | 20тыс строк дают2000 строк и4004 DOM узла вместо40 004 в baseline. Объявленные3MB и незаявленные2.2MB текста отклонены. Показано явное уведомление, оригинал доступен для скачивания. [Большой preview](ui/after-reader-large.png), [превышенный размер](ui/after-reader-too-large-stream.png). |
| Повреждённые/опасные DOCX | ≤1024 ZIP records; единственный `word/document.xml`; проверка локальных/центральных offsets, метода и flags; поддерживаются stored/deflate. Existing fflate `Inflate` получает compressed chunks по1KiB и останавливается по наблюдаемому XML cap. | Unit тесты: malformed ZIP/XML, missing/duplicate critical entry,1025 entries, encrypted/unsupported method, неверные offsets/name, объявленный и фактический oversized XML. Архив с8MiB фактического XML и поддельным originalSize=1 отклоняется по cap, без полного разжатия. |
| Устаревшая загрузка после смены/закрытия | AbortController для собственного fetch/stream и guards после async этапов; media lease сохраняет открытый blob от idle cleanup. `DocumentReaderModal.tsx:113`, `:116`, `:144`. | Запрос старого документа задержан на800ms; при переключении показывается только CURRENT_DOCUMENT, старый результат отсутствует. Utility тест подтверждает cancel ожидающего stream при abort. |
| Loading/error/empty и сырой stderr | `lang()` keys в существующем fallback, typed safe errors, retry для недоступного документа, download original, aria-busy/status/alert. `DocumentReaderModal.tsx:266`. | Проверены loading, empty, unavailable, invalidDOCX, oversize; UI retry после synthetic recovery действительно показывает новый документ. [Ошибка](ui/after-reader-error.png), [пустой](ui/after-reader-empty.png). |
| Reduced motion/визуальная согласованность | Monochrome badges/highlights и semantic tokens; reduced motion отключает animation/transition. `DocumentReaderModal.module.scss:554`. | При `prefers-reduced-motion:reduce` computed animationName=none. PNG после стабилизации анимации просмотрены вручную. |

Функции reader проверены с безопасными synthetic adapters: кнопка копирования md/docx отдаёт ожидаемый текст, ограниченный текстовый preview копирует ровно2000 показанных строк; кнопка download передаёт исходный document объект в существующий `downloadMedia`. Реальный системный clipboard и запись файла на диск этим прогоном не проверялись. Это проверка UI dispatch и преобразования текста, а не всей цепочки загрузки Telegram.

Основной аудит исправил App bounds через измеряемый `nativeViewport`. Дополнительная fixture использует **настоящий App.module.scss**, Sidebar и Titlebar: при800×560 pane `(72,40,728,520)` для16px и `(144,80,656,480)` для32px; при1652×1160 — `(72,40,1580,1120)` и `(144,80,1508,1080)`. Во всех4 случаях края совпадают с sidebar/titlebar и viewport. [800×560/32px](ui/after-native-pane-800x560-32px.png). Это CSS geometry проверка, а не native HWND/DPI/WebView2 интеграция.

### Результаты проверок

- Fresh Edge fixture: **52 случая,0 JS ошибок**,26 новых PNG. [after-metrics.json](ui/after-metrics.json). Строки, размеры и metadata искусственные; личных данных нет.
- Vitest: **45/45** в `src/util/documentPreview.test.ts` и существующем `src/util/documentClipboard.test.ts`. Включены отрицательные/потоковые/large/ZIP-bomb случаи, UTF16LE/BE BOM и безопасный HTML/search.
- `tsc --noEmit`: exit0 после завершения reader реализации.
- Scoped ESLint:0 errors,1 warning на `dangerouslySetInnerHTML`. Renderer получает только HTML, сформированный из escaped text и разрешённых inline tags/links; исходный HTML документа не вставляется.
- Scoped stylelint:0 errors,31 warnings о предпочтениях стиля/селекторных соглашениях существующего HTML renderer. Предупреждения не объявлены исправленными.
- Наблюдаемое wall-ready для20тыс строк: baseline438ms, повторный80ms на этом ПК. Это единичные измерения с разным объёмом DOM; они подтверждают работу cap и не являются стабильным benchmark или гарантией на другом устройстве.

## Ограничения и оставшиеся задачи

- Preview намеренно частичный. Markdown parser поддерживает базовые headings/quotes/lists/fences/inline links, а не весь CommonMark. DOCX показывает текст, простые runs/heading/bold/italic/underline; таблицы, картинки, списки, страницы и поля Word не воспроизводятся точно. Full fidelity остаётся за внешним редактором оригинала.
- DOCX ZIP64, encrypted и методы кроме stored/deflate не поддерживаются. Отказ сопровождается безопасным сообщением и download original. Это не сканер архивов или документов.
- Text decode: UTF8 и UTF16 с BOM. Старые локальные кодировки без BOM автоматически не распознаются.
- PDF ограничен32MiB до открытия, но встроенный native PDF renderer, его controls/focus/печать и чтение реального PDF в установленном Relay этим агентом не проверены.
- Abort отменяет собственное чтение. Общая Telegram/media загрузка может продолжиться для других потребителей; этот reader не прерывает shared запросы. Не заявляется гарантия мгновенной отмены native media API.
- Полная доступность screen reader и OS high contrast не сертифицирована; проверены DOM semantics, keyboard и focus в Edge fixture. Native caption/webviews/real accounts, сеть и multi-hour soak относятся к основному аудиту.
- SocialShare32px obstruction выше остаётся ограничением synthetic RecipientPicker. Без настоящего picker это не доказанный продуктовый дефект. Фото/playback/forwarding/live YouTube и внешние account ошибки нельзя оценивать по reader fixture. Геометрия стикеров проверена отдельно ниже; это не проверка декодирования или живых аккаунтов.

## Дополнительная проверка стикера и времени

Свежий прогон 30 сентября 2026. Воспроизведён **P1 дефект геометрии**, соответствующий узкой полосе на исходном screenshot: `src/styles/index.scss:1321` применял к standalone sticker правило emoji `width:auto!important; max-width:var(--custom-emoji-size,100%)!important`. При обычном тексте оно сжимало квадратный стикер до **20×208px**, хотя реальные `buildStickerFromDocument` и `getStickerDimensions` возвращали208×208px. Высота оставалась прежней. Приоритет source512×512 перед cached thumb48×512 уже был корректен; одного исправления размеров source было недостаточно. [Свежий дефект](ui/sticker-baseline-900x1000-16px-tiny-thumb-valid-source-incoming-no-reactions.png), [baseline geometry](ui/sticker-baseline-metrics.json).

Исправление ограничено standalone sticker media:

- `src/styles/index.scss:1321` исключает `.sticker-message > .content-inner > .media-inner` из emoji sizing. Исходная группа прозрачности сохранена полностью.
- `src/styles/index.scss:1343` позволяет этому контейнеру помещаться в ширину сообщения. Его изображение, video/AnimatedSticker wrapper и локальный `.tlottie-canvas` подстраиваются под размеры media, включая пиксельные inline styles дочерних элементов.
- `src/components/middle/message/Sticker.tsx:182` задаёт `aspect-ratio` из фактических dimensions, чтобы уменьшение доступной ширины сохраняло пропорции и высоту. Inline custom emoji и отдельные animated emoji не входят в новое правило.

Повторная fixture использует настоящие Message/MessageMeta/Sticker/StickerView/Avatar/OutgoingStatus/Reactions и глобальные SCSS, реальные GramJS TL constructors, `buildStickerFromDocument` и `getStickerDimensions`. DOM сообщения собран по текущей standalone ветке `Message.tsx`, с `.Message.open`, отдельной строкой metadata и внешними reactions. Изображения, аватары и тексты искусственные. Это проверка **реального CSS и helpers на synthetic DOM**, а не запуск полного Telegram Message или Lottie worker.

### Матрица и результат

- **96 сочетаний**: ширины320/900/1573px × корневой текст16/32px × incoming/outgoing × reactions on/off × квадрат512×512 / широкий512×128 / высокий128×512 / узкий cached thumb48×512 при валидном source512×512.
- До исправления96/96 имели искажённое соотношение сторон. После: **0 искажений, 0 выходов media/metadata за viewport или media за content, 0 пересечений времени со стикером/аватаром/реакциями, 0 JS ошибок**. [after geometry](ui/sticker-after-metrics.json).
- **288 дополнительных проверок дочерних размеров**: в каждом случае synthetic AnimatedSticker wrapper, `.tlottie-canvas` и video с настоящими классами и исходными пиксельными inline dimensions совпадают с parent media по x/y/width/height. Проверено применение CSS; TGS/WASM decode, кадровый цикл и video playback не выполнялись.
- **18 before/after emoji controls**: inline custom emoji, standalone animated emoji и custom emoji в metadata в6 сочетаниях viewport/text. Размеры, размеры дочернего media, max-width, background и color совпадают до/после. Это проверка отсутствия побочного изменения размеров/цветов, не семантическая оценка всех emoji.
- Компилированный PostCSS AST подтверждает3 узко ограниченных responsive rules и целую исходную transparency group: [sticker-css-scope.json](ui/sticker-css-scope.json). Ширина сообщения/emoji не менялась широким групповым селектором.
- При900px/16px квадрат после исправления208×208px, metadata начинается на4px ниже media; его правый край совпадает с правым краем стикера. [Исправленный квадрат](ui/sticker-after-900x1000-16px-tiny-thumb-valid-source-incoming-no-reactions.png). Высокий outgoing с reactions: [320px/32px](ui/sticker-after-320x1000-32px-tall-outgoing-reactions.png). 320px ниже native window minimum800px и использованы как дополнительная нагрузка на узкую колонку;32px — масштабирование текста, не OS DPI.

Дополнительно просмотрены пути дочерних элементов: `AnimatedSticker.tsx:297` и `src/lib/tlottie/TLottie.ts:306` задают пиксельные размеры, которые покрывает только standalone правило. Standalone Sticker использует `withSharedAnimation` для общего animation ID, но не передаёт `sharedCanvasRef`; его canvas остаётся локальным. Общая canvas схема inline emoji не менялась. MediaSpoiler уже растягивает root/canvas на100%. Premium effect находится в отдельном Portal с fixed placement и `pointer-events:none`, позиция рассчитывается относительно anchor; новое правило его не затрагивает. Реальное premium effect playback этой fixture не подтверждено.

Scoped проверки: `src/api/gramjs/apiBuilders/symbols.test.ts` **4/4**, Sticker ESLint exit0, финальный `index.scss` stylelint **0 errors/65 warnings**. Предупреждения существующего stylesheet не объявлены устранёнными. Приняты12 свежих baseline PNG и12 after PNG; before CSS создан из текущего файла удалением только данного исправления, без отката продукта.

Геометрическая причина полосы устранена и проверена на заявленной матрице. Точное личное сообщение, загрузка с Telegram, расшифровка/декодирование анимации, native DPI и многочасовое воспроизведение остаются за основным live/native аудитом. В baseline этой fixture время уже находилось в отдельной строке и не пересекалось с media; повторная проверка подтверждает разделение после восстановления ширины стикера, но не доказывает первоначальное наложение на личном screenshot.

## Доработка целостной оболочки

Дополнительная реализация 30 сентября 2026 после расширения задачи дизайна. Система описана в [DESIGN-1.3.0.md](../DESIGN-1.3.0.md); полный план frontend/backend выпуска — в [RELEASE-ROADMAP-1.3.0.md](../RELEASE-ROADMAP-1.3.0.md). Сохраняются монохромная идентичность, имеющиеся SVG/icon font, Inter/Unbounded и функции сервисов. Новых библиотек, сетевых запросов, listeners или worker loops для оформления нет.

### Конкретные изменения

| Область | Реализация и назначение | Доказательство |
| --- | --- | --- |
| Общие поверхности и акценты | `src/components/App.module.scss:14`: shell semantic tokens для background/surface/hover/active/border/text/muted/focus и размеров. Sidebar, caption и social status используют одну систему. | Просмотрены свежие PNG нормального и увеличенного текста. [Instagram error](ui/shell-after-instagram-error-1573x1163-16px.png). |
| Tile сервиса | `AppSidebar.tsx`: icon и label внутри одной кнопки. `AppSidebar.module.scss:53`, `:69`: подпись 11px при root16, одинаковая target height, читаемый активный state и focus внутри rail. Название Instagram помещается полностью. | Нажатие label вызывает тот же callback. Во всех 30 сочетаниях viewport/font/state labels внутри rail и видимой высоты. [800×560](ui/shell-after-telegram-ready-800x560-16px.png). |
| Короткая rail | `AppSidebar.module.scss:204`: container по высоте уменьшает только padding/gaps/tile min-height и оптический SVG size. | При 800×560/32px три label видимы; Instagram заканчивается примерно на y509, не ниже края окна. [32px](ui/shell-after-x-auth-required-800x560-32px.png). |
| Caption overflow | `App.module.scss:38` задаёт workspace container; `Titlebar.module.scss:287`, `:297` адаптируют controls по реальной доступной ширине, включая увеличенный текст. Notice сохраняет роль/status и tooltip, label локальных служб имеет полный aria-label даже в компактном виде. | **Свежий P1 baseline:** auth caption800×560/32px scrollWidth989/clientWidth656, Close до x1133. После656/656, Close `(736,0,64,78)` полностью внутри окна. [До](ui/shell-baseline-x-auth-required-800x560-32px.png), [после](ui/shell-after-x-auth-required-800x560-32px.png). |
| Компактный login | `Titlebar.tsx:240`: отдельные full/short labels, полное доступное имя/title; локализованный `RelayLoginShort` присутствует в fallback, initialRussian, initialKeys и generated strings/types. | На800×560/32px «Войти» видно целиком; доступное имя остаётся «Вход по логину X». Сетевой health logic не менялся. |
| Loading/error/auth surfaces | `App.module.scss:109`: общая ограниченная ширина, спокойная поверхность/граница, согласованный brand mark, hierarchy текста и primary action. Большое содержимое прокручивается без горизонтального clipping. | Во всех tested cases text/card не выходят по ширине; длинное пояснение и auth instruction при32px сохраняют reachable action через scroll. [Retry после scroll](ui/shell-after-x-error-800x560-32px-retry-visible.png). |
| Loading/error marker | Sidebar spinner900ms и статичный error square согласованы с caption/status; reduced motion отключает вращение и transitions. | Fresh reduced-motion case: sidebar/status/network animationName=none; accessible state сохраняется. |

### Проверки оболочки

- Fresh Edge fixture: **37 случаев, 0 JS ошибок**. 30 основных сочетаний: 800×560, 1280×720, 1573×1163 × root16/32px × Telegram ready / X loading / X error / X auth / Instagram error. Дополнительно keyboard+label activation, navigation dispatch/disabled, две caption keyboard traces, два long-description случая, reduced motion. [Метрики после](ui/shell-after-metrics.json), [baseline](ui/shell-baseline-metrics.json).
- Настоящие Teact Sidebar/Titlebar, их модули и App/global SCSS. Tauri window/callbacks/lang provider безопасно подменены. Social status DOM следует App.tsx; полный App с account/native WebViews не запускается.
- Caption: Tab достигает всех девяти action controls при16/32px, включая login/reconnect/minimize/maximize/Close. Каждая находится на экране, получает solid focus outline и проходит `elementFromPoint` hit-test. Изменение настоящего Windows окна этим прогоном не выполнялось.
- Во всех 30 основных случаях native pane CSS rect совпадает с rail/caption/viewport; caption и страница не имеют горизонтального overflow, подписи внутри rail, кнопки не выходят по ширине. Это не проверка native HWND placement.
- Vitest `AppSidebar.test.tsx` + существующий `Titlebar.test.tsx`: **16/16**. Новые 5 случаев проверяют полный tile click, keyboard wrap/Home/End без незапрошенного выбора и доступные loading/error/auth состояния, сохраняя возможность навигации.
- `npm run check:ts`: exit0, 0 errors/1 существующее reader `dangerouslySetInnerHTML` warning. `npm run check:css`: exit0, 0 errors/509 warnings всего проекта. Scoped shell SCSS: 0 errors/3 `user-select` baseline warnings; scoped TS/TSX ESLint exit0. Warning-free состояние не заявляется.
- Impeccable mechanical detector пяти изменённых source surfaces: exit0, findings `[]`. Результат не сертифицирует весь дизайн или доступность.
- Приняты 19 after PNG, 3 относящихся к caption/rail baseline PNG и оба metrics файла. Только synthetic тексты/данные, без аккаунтов и личных материалов.

### Реальные пределы доработки

32px — text expansion, а не OS DPI/zoom. Длинная auth instruction в560px окне требует вертикальной прокрутки; action достигается и текст остаётся полным. Sidebar/Titlebar visuals проверены на реальных компонентах; social status — на synthetic DOM с реальным CSS. Сторонние сайты не получили новый дизайн. Native layout, window commands, реальный picker, screen reader/high contrast, доступность внешних сервисов, поддержка на другом ПК и длительная сеть требуют соответствующих gates из design document и release roadmap. Изменение CSS не служит доказательством устранения этих рисков.

## Статус

Подтверждённые P1/P2 reader defects, P1 сжатие standalone sticker и P1 caption overflow устранены и повторно проверены в указанной области. Доработка целостной оболочки реализована и проверена. Все принадлежащие этому аудиту product files окончательно заморожены для общих release gates. Принятая evidence — baseline и fresh after — лежит рядом с отчётом. Готовность всего пакета к публикации определяется общим build/install/native/network аудитом; этот отчёт её отдельно не подтверждает.
