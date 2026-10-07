# Egoist Relay: единая система интерфейса

6 октября 2026. Действующий контракт выбранной композиции B. [Решение пользователя](frontend-cycle-2026-10-06/accepted-direction.json), [исследование](frontend-cycle-2026-10-06/research.md), [исторический контракт 1.3.0](DESIGN-1.3.0.md).

## Назначение и иерархия

Личный Windows продукт для чтения Telegram/X/Instagram, локального сохранения и явной пересылки. Содержимое и доступный результат важнее внешней рамки. Постоянный rail обозначает сервис, caption содержит действия текущего сервиса и окна, рабочая область сохраняет контекст, панель показывает операции и локальную историю.

## Цвета и совместимость

Авторитет значений: `src/util/antigravityThemes.ts` (варианты), `src/styles/_variables.scss` (базовые роли). Egoist Dark использует глубокий чёрный и нейтральные серые, без синих декоративных поверхностей/акцентов. Основной текст и primary — светлые; foreground светлого primary — тёмный. Ошибка/опасное действие и подтверждение сохраняют семантические цвета; изображения, имена пользователей и содержание платформ сохраняют собственную окраску.

Сохранённые альтернативные темы и светлый режим доступны. Цвет не фиксируется отдельно на caption, navigation или operation panel: shell aliases наследуют Telegram роли. Смена варианта очищает значения предыдущего, включая дополнительные роли.

| Предыдущая роль | Общая роль | Потребители | Переход |
|---|---|---|---|
| shell background | `--color-background` | App/rail/caption/social states | совместимый alias |
| shell surface | `--color-background-secondary` | panel/caption/state | совместимый alias |
| shell hover/active | `--color-item-hover/active` | controls/navigation | совместимые aliases |
| shell border/strong | `--color-borders/borders-input` | separators/focus grouping | совместимые aliases |
| shell text/muted | `--color-text/text-secondary` | все shell подписи | совместимые aliases |
| локальный white button foreground | `--color-primary-text` | Button/switch/Mini App theme | default white, Egoist dark foreground |
| фон и мета своих сообщений | existing own/meta roles | Message/MessageMeta/reactions | полноценная палитра, без наследуемой синевы |
| общий heading Unbounded | body Inter | UI/title/list/settings/panel/modal | display только короткий Relay brand |

## Типографика, формы и глубина

Inter с локальным кириллическим набором — чтение, заголовки интерфейса, подписи и данные. Unbounded — короткое имя Relay в caption. Числа используют текущие tabular numerals. Список чатов различает имя, текст и время размером/насыщенностью, без одинаковой выразительности каждой строки. Настройки группируются плоскими секциями; поля, выбранный элемент и raised поверхности отличимы границей и нейтральным тоном. Основное действие не зависит от blue hue. Кнопки обычного регистра, текст переносится по задаче. Shadow применяется к перекрывающим menu/modal, а не каждой области чтения.

## Компоновка

B сохраняет rail 4.5rem и caption 2.5rem. Telegram header выровнен с рабочей областью, без отдельной плавающей капсулы. Ширина списка чатов зависит от доступной ширины Telegram, а не всего окна. Панель 24rem остаётся справа при остатке сервису не менее 40rem; иначе занимает рабочую область. Назад возвращает предыдущий сервис и его контекст. Full panel делает скрытые service panes inert и aria-hidden; после закрытия восстанавливается доступ к тому же DOM/WebView. Native границы обновляются отдельно, без CSS анимации.

## Компоненты и состояния

Rail: default/hover/selected/loading/error/focus; service click выбирает сохранённый контекст. Caption: существующие навигация, операции и window controls; disabled действие объясняется доступным состоянием. Никакой старой network badge/reconnect из исторических планов.

Operations: current/history/empty/progress-known/progress-unknown/completed/interrupted/uncertain/locked. Источник, файл, этап, размер/разрешение, адресат/формат и confirmed показываются только из модели. «Исход неизвестен» виден отдельно; автоматический send retry не добавляется. File/source actions используют зарегистрированный ID, не создают неизвестную ссылку. Clear history сохраняет файлы.

Share: новый диалог Ссылка; Ссылка/Медиа/Файл явны. Confirm передаёт владение приложению, закрытие не отменяет подтверждённую операцию. Полученные байты и качество остаются в пределах согласованной модели.

Controls: keyboard focus-visible, disabled/read-only/error, checkbox/radio/switch checked различаются формой и контрастом. Inactive input внутри ListItem исключён из Tab, самостоятельный Switcher доступен клавиатуре. Settings темы имеют RU/EN подписи и наследуют текущие роли.

## Motion

Panel content: reveal 140ms, opacity и небольшое перемещение; reduced motion — без движения. Hover/press: 140ms изменение цвета/opacity, без изменения геометрии native panes. Переключение вкладки/сервиса сохраняет settled state и очередность владельца. Уже действующие Telegram history/media transitions сохраняются с их настройками отключения; глобальное движение при reduced motion исключается на затронутых поверхностях. Motion не означает визуально подтверждённую частоту кадров на физическом GPU.

## Проверки и границы

Критерии: видимая единая палитра caption/rail/chat/settings/panel/share; нет blue tint в Egoist UI; readable own/meta/reactions/primary; рабочий Tab/Escape/CtrlJ; 640×448, 800×560, FullHD; RTL, 200%, reduced motion. Сравнение с frozen 1.5.0 использует одинаковые fixture и включает timings/ресурсы с обозначенными условиями. Внешние X/Instagram страницы принадлежат платформам. Реальные delivery/file quality, Narrator, COMfocus, physical DPI/GPU и второе Windows устройство остаются отдельной приёмкой.

Существующие Inter/Unbounded/icon assets и лицензии сохраняются; новые сторонние ассеты и библиотеки не нужны. Обратная связь хранится в companion review board проекта и не встраивается в UI Relay.
