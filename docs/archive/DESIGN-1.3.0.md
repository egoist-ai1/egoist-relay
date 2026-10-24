# Egoist Relay: система интерфейса 1.3.0

Исторический контракт 1.3.0. Действующая система: [DESIGN.md](DESIGN.md).

Дата: 30 сентября 2026. Документ описывает реализованную оболочку и правила развития продукта. Полный план выпуска и backend проверок: [RELEASE-ROADMAP-1.3.0.md](RELEASE-ROADMAP-1.3.0.md). Доказательства и ограничения UI: [свежий аудит](audit-1.3.0/ui.md).

## Назначение и визуальное направление

Relay объединяет Telegram, X и Instagram в одном Windows окне. Пользователь выбирает сервис, читает материал, открывает медиа, сохраняет или готовит пересылку. Оболочка показывает выбранный сервис, доступные действия и состояние локальных служб. Состояние локальной службы не подтверждает доступность YouTube, X, Instagram или конкретного Telegram дата-центра.

Направление: спокойный тёмный рабочий интерфейс с монохромной навигацией, чёткими границами областей и выразительными заголовками Unbounded. Основной текст — Inter с кириллицей. Приоритет имеет содержимое сообщения; внешняя рамка занимает постоянную измеряемую область. Иконки брендов сохраняются из имеющихся SVG. Сервисные страницы X/Instagram принадлежат сторонним сайтам и оцениваются отдельно от оболочки Relay.

## Источник токенов

Общие значения находятся в `.multiRoot` файла `src/components/App.module.scss`. AppSidebar, Titlebar и социальные status surfaces используют эти переменные. Другие Telegram компоненты продолжают использовать существующие `--color-*` и typography tokens; их массовая миграция не выполнена.

| Роль | Токен | Значение | Применение |
| --- | --- | --- | --- |
| Основная поверхность | `--relay-shell-background` | `#09090a` | Rail, workspace, social background |
| Отдельная поверхность | `--relay-shell-surface` | `#111113` | Caption и одна панель состояния |
| Наведение | `--relay-shell-hover` | `#202023` | Навигация и caption actions |
| Выбранное/нажатое | `--relay-shell-active` | `#252528` | Активный сервис, login action |
| Граница областей | `--relay-shell-border` | `#252529` | Rail/caption/status panel |
| Граница элемента | `--relay-shell-border-strong` | `#404047` | Активная tile и status mark |
| Основной текст | `--relay-shell-text` | `#f4f4f5` | Выбранное состояние, заголовок, primary action |
| Вторичный текст | `--relay-shell-muted` | `#ababb4` | Подпись, пояснение, status |
| Фокус | `--relay-shell-focus` | `#f4f4f5` | Keyboard outline |
| Rail | `--relay-shell-rail-width` | `4.5rem` | Ширина навигации и caption inset |
| Caption | `--relay-shell-caption-height` | `2.5rem` | Высота caption и верхний край pane |

Переход выполнен в пределах оболочки: отдельные значения `#000000/#09090a` → background, `#111113/#141416` → surface, локальные серые подписи → muted, локальные белые focus outlines → focus. Значения не меняются автоматически вместе с темой стороннего сайта. Новая поверхность принимает эти роли, не добавляя произвольный оттенок для каждой кнопки.

## Типографика и иконки

| Область | Контракт при 16px root |
| --- | --- |
| Заголовок status panel | Unbounded, `1.125rem`, semibold, line-height 1.4, перенос длинных слов |
| Пояснение состояния | Inter, `0.875rem`, line-height 1.65, ограниченная ширина 24rem |
| Caption и подпись сервиса | Inter, `0.6875rem`, medium, короткая функциональная подпись |
| Основное действие | Inter, `0.875rem`, semibold, line-height 1.5 |
| Документ и исходный код | Существующий monospace token; общий row height для номера и строки |

Font weights используют существующие `--font-weight-*`; числовые веса не дублируются в компонентах. Кириллица входит в уже поставляемые Unbounded и Inter assets. Документы сохраняют путь к оригиналу, если форматированный preview не передаёт исходную структуру точно.

Telegram SVG имеет оптический размер 2.25rem, X/Instagram — 2rem внутри одинаковой navigation tile. На коротком окне все три SVG имеют размер 2rem. Caption использует имеющиеся icon font/SVG, а не текстовые символы для оконных действий. Цвет и размер иконки соответствуют её функции и области; загрузка и ошибка различаются движением/формой и доступным названием.

## Геометрия и адаптация

- Rail сохраняет ширину 4.5rem. Иконка и подпись находятся **в одной кнопке** шириной `calc(100% - 0.75rem)` и обычной минимальной высотой 4.75rem. Вся видимая tile выбирает сервис. Label переносится в пределах кнопки, не выходит за rail.
- Rail имеет собственную вертикальную прокрутку. При высоте rail меньше 20rem уменьшаются gaps, padding и минимальная tile height до 4rem. Это позволяет показать все три подписи при 800×560 и root 32px; содержимое не уменьшается принудительно в пикселях.
- Caption сохраняет высоту 2.5rem. Window controls находятся справа. Название сервиса, notices, navigation, login и локальный status используют отдельные flex области. Внутренние action buttons получают видимый hover/pressed/focus.
- `mainWorkspace` — именованный inline-size container. При доступной ширине меньше 46rem скрывается только дублирующая подпись локального status; его доступное название и tooltip остаются. При ширине меньше 34rem уменьшаются caption controls/gaps, notices сокращаются с tooltip, login показывает «Войти» с полным `aria-label`/title. Название выбранного сервиса получает минимальную область. Window controls и reconnect сохраняются.
- Геометрия native pane измеряется основным App кодом. Caption inset и rail width согласованы токенами; фиксированные screen pixels не подставляются вместо фактического DOM rect.
- Social state panel имеет ширину до 30rem, одинаковые padding/radius/border, читаемый текст и один primary action. При большой высоте содержимого прокручивается рабочая область; кнопка остаётся достижимой. Полный текст не заменяется фиксированной высотой или скрытым overflow.
- Reader использует собственный top-layer dialog, адаптивный header и ограниченный scroll body. Status panel не изменяет его focus stack.

Проверенная матрица: 800×560, 1280×720 и 1573×1163, root 16/32px. 32px — увеличение текста на 200%, не OS DPI и не WebView zoom. На 800×560/32px длинное описание или инструкция входа требуют вертикальной прокрутки; screenshot всей инструкции на одном экране не является критерием. Критерий — читаемый текст, отсутствие горизонтального clipping и достижимое действие.

## Компоненты и состояния

| Компонент | Состояние | Видимое и доступное поведение |
| --- | --- | --- |
| Service tile | idle/ready | Иконка и подпись, hover, одна область нажатия |
| Service tile | selected | Более светлая поверхность, граница и боковой marker; `aria-current=page`/pressed |
| Service tile | loading | Малый spinner, state в доступном названии, `aria-busy`; переход к сервису остаётся возможен |
| Service tile | error | Статичный квадратный marker и state в доступном названии; выбор сервиса не заблокирован |
| X | auth-required | Понятная инструкция штатного входа в X и login action; Google пароль не предлагается как пароль X |
| Social pane | idle/loading | Brand mark и spinner, heading/пояснение, `role=status`/polite |
| Social pane | error | Тот же layout, heading/пояснение и retry, `role=alert` |
| Caption navigation | available | Back/forward/home/reload с названием, tooltip и focus |
| Caption navigation | unavailable/busy | Disabled по существующему состоянию; повторный вызов не создаётся нажатием disabled control |
| Local network status | ready | Круглый marker и название локальных служб; details разделяют DNS и workers |
| Local network status | unavailable/degraded/restart-required | Пустой квадратный marker, точное доступное сообщение; внешний доступ не обещается |
| Reconnect | busy | Disabled, `aria-busy`, вращение имеющейся иконки |
| Reader | loading/error/empty/partial | Отдельные понятные состояния, retry/download по контексту, ограниченный preview |
| Share/download | preparing/sending/failed/cancelled | Существующие typed states и безопасные error codes; успешная подготовка не равна фактической отправке или записи файла |

Без видимого сообщения не вводится новый фоновой «успешный» статус. Ошибка должна объяснять следующее действие. Rate limit, запрет доступа, авторское ограничение и сетевой отказ имеют разные смыслы; оболочка не обещает снять их одним retry.

## Keyboard и motion

Rail: Tab входит в кнопки, ArrowUp/Down циклически меняют focus, Home/End переводят к первой/последней кнопке, Enter/Space выбирают сервис. Перемещение focus само не переключает сервис. Нажатие подписи использует тот же callback, что и иконка.

Caption: все window/navigation/login/reconnect controls имеют доступное название. Focus outline виден в пределах кнопки. Проверены Tab и hit-test каждой из девяти caption кнопок в auth сценарии при root 16/32px, включая Close. Реальные maximize/minimize/close IPC выполняются отдельной native проверкой.

Feedback transitions занимают 120–160ms; spinner cycle — 900ms. Нет blur/gradient или фонового декоративного animation loop. При `prefers-reduced-motion:reduce` transitions и spinner animation отключены; static marker сохраняет состояние. Автоматические повторы соединения регулирует backend, не CSS animation.

## Основные сценарии

1. **Запуск → выбор сервиса.** Rail назван как переключатель приложений. Main pane следует выбранному сервису; ready означает только наличие его текущего представления. Login/error/loading не маскируются пустым экраном оболочки.
2. **Просмотр → сохранение.** Placeholder сохраняет пропорции. Копирование/скачивание сообщает фактический результат операции; queued save click не подтверждает файл на диске. Недоступный формат оставляет download original.
3. **Просмотр → пересылка.** Source и recipient понятны, подготовка и отправка различаются. Cancel освобождает подготовленные ресурсы; retry сохраняет ограничение paid sending и идентификаторы существующей реализации.
4. **Открытие документа → поиск → закрытие.** Focus в dialog, безопасная подсветка текста, явный предел preview, Esc возвращает focus к исходному действию.
5. **Отказ сервиса → retry.** Role/message и кнопка доступны. Причина upstream ограничения сохраняет безопасный код; локально готовый proxy не переименовывается в «YouTube работает».
6. **Обновление.** Пользователь штатно завершает Relay, пакет проверяет version/path/process guard, сохраняет профиль. Неполный installation outcome не подменяется успешным UI уведомлением. Детали этого контракта — в release roadmap.

## Реализовано и проверено

В 1.3.0 внедрены shell tokens, цельные navigation tiles, более читаемые подписи, одинаковая геометрия иконок/targets, компактная rail по высоте, caption container adaptation, короткий локализованный login label и согласованные social state panels. Сохранены App/native/network state logic и внешние сервисные страницы.

До доработки auth caption при 800×560/32px имел scrollWidth 989 при clientWidth 656; Close выходил до x1133. После scrollWidth=clientWidth=656, Close занимает x736–800. Все три rail labels видимы. [До](audit-1.3.0/ui/shell-baseline-x-auth-required-800x560-32px.png), [после](audit-1.3.0/ui/shell-after-x-auth-required-800x560-32px.png).

Fresh Edge fixture: **37 случаев, 0 JS ошибок**, реальные Sidebar/Titlebar/SCSS, synthetic social status DOM и Tauri callbacks. Проверены labels, pane alignment, горизонтальный overflow, длинный текст, достижимость retry через scroll, keyboard/focus, navigation dispatch/disabled и reduced motion. [Метрики](audit-1.3.0/ui/shell-after-metrics.json). Sidebar/Titlebar unit tests: **16/16**. `npm run check:ts` и `check:css` завершились exit 0; предупреждения перечислены в UI audit. Механический impeccable scan пяти изменённых surfaces не дал findings; это не заменяет визуальную/функциональную проверку.

## Измеримый следующий этап

| Приоритет | Область и работа | Критерий завершения |
| --- | --- | --- |
| P1 | Native DPI/zoom и новые shell styles на точном release payload | 100/125/150/200% OS DPI, min 800×560 и maximized: pane/readback совпадают, Close/reconnect доступны, screenshots без clipping/overlap |
| P1 | Полные media действия с разрешёнными аккаунтами | Copy/save/open/forward каждого поддерживаемого формата с фактическим clipboard/file/message readback; причина отказа и cancel/stale не теряются |
| P1 | Backend отказ/восстановление и длительная работа | 24–72ч, sleep/resume, смена сети, отказ DNS/endpoint, port conflicts и используемые VPN: нет системных сетевых изменений/чужих worker действий, bounded retries, measured downtime и resource trend |
| P2 | Network onboarding и settings по этой системе | Неподготовленный профиль, корректный импорт, повреждённый профиль, unavailable endpoint и restart-required дают понятный следующий шаг без раскрытия secrets |
| P2 | Share picker/Telegram menus/settings consistency | Настоящие компоненты при 800×560, 16/32px, длинном русском тексте: zero geometry overlap, keyboard путь полностью проверен; synthetic picker не считается доказательством |
| P2 | Screen reader/high contrast | Narrator в точном Windows build: имя/роль/состояние каждого действия, modal focus return, announcements без спама; OS high contrast сохраняет focus и границы |
| P2 | Performance budget после warm-up | Фиксированная повторяемая нагрузка и машина; журнал CPU/RSS/worker counts и p50/p95 interaction times, отсутствие монотонного роста после циклов открытия/закрытия и cancel |
| P2 | Сборка и новый ПК | Чистое устройство без Lagom: installer/uninstaller/update/path limits/profile setup, assets/localization и dependencies доступны; источник каждого bundled binary установлен |

Это реальные remaining gates. Headless CSS проверка не сертифицирует backend, screen reader, стороннюю страницу, файл на диске, аккаунтную отправку или долгую работу. Полная публичная готовность оценивается совместно с [network](audit-1.3.0/network.md), [media](audit-1.3.0/media.md), [release](audit-1.3.0/release.md) и release roadmap.
