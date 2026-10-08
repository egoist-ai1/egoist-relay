# Sennit (внутреннее имя Egoist Relay): система интерфейса (Egoist DS, режим Lagom)

8 октября 2026, версия 1.7.0. Заменяет контракт композиции B ([1.6.1](DESIGN-1.6.1.md)). Основание: [план цикла](lagom-redesign-2026-10-07/PLAN.md), [frontend-аудит](lagom-redesign-2026-10-07/AUDIT-FRONTEND.md), дизайн-система владельца `Материалы\Egoist Design System\DESIGN.md` (режим Lagom: приложения, без акцента, движение — минимум и пружина на отклик). Значения цвета живут в одном месте — [`src/util/lagomTheme.ts`](../src/util/lagomTheme.ts); неколористические токены — [`src/styles/_lagom-tokens.scss`](../src/styles/_lagom-tokens.scss); шрифты — [`src/styles/_fonts.scss`](../src/styles/_fonts.scss).

## Назначение и характер

Личный Windows-хаб для чтения Telegram, X и Instagram, локального сохранения и явной пересылки. Содержимое важнее рамки: оболочка (rail 4.5rem, caption 2.5rem, правая панель 24rem по Ctrl+J) нейтральна, иерархия строится ступенями графита и инверсией, а не цветом. Акцента нет; опасность и успех — семантика (`--color-error`, `--color-success`).

## Цвет

Две основные темы: **Lagom Dark** (по умолчанию) и **Lagom Light**. Профили до 1.7.0 с прежним вариантом по умолчанию один раз переводятся на Lagom Dark; выбранные вручную варианты (десять прежних) сохраняются.

| Роль DS | Тёмная | Светлая | Роли Telegram Web A |
|---|---|---|---|
| bg | graphite-900 `#0E0E0F` | graphite-50 `#F5F5F2` | `--color-background`, sidebar |
| surface-1 | graphite-850 | white | `--color-background-secondary`, hover чата/списка, поле композера |
| surface-2 | graphite-800 | graphite-100 | `--color-background-secondary-accent`, выбранный фон |
| surface-3 | graphite-700 | graphite-200 | собственный пузырь, активный чат, реакции |
| line / line-strong | 700 / 600 | 200 / 300 | `--color-borders`, `--color-dividers` |
| control | graphite-500 | graphite-400 | `--color-borders-input` (≥ 3:1 к bg и surface-1) |
| text / text-soft / muted | 100 / 200 / 400 | 950 / 700 / 500 | `--color-text`, `-lighter`, `-secondary` |
| muted-strong | 300 | 600 | подпись на собственном пузыре (на surface-3) |
| inverse / on-inverse | 100 / 900 | 900 / 50 | `--color-primary`, `--color-primary-text` — «главная кнопка» |


Проверено расчётом (тест `antigravityThemes.test.ts`, `Color.contrastWCAG21`): основной текст ≥ 7:1 на всех четырёх поверхностях; вторичный ≥ 4,5:1 на bg, surface-1 и surface-2; усиленный вторичный на surface-3 ≥ 4,5:1; граница поля ≥ 3:1; опасность, успех, предупреждение ≥ 4,5:1 на bg. Запрещённые зоны для перекраски: содержимое платформ, цвета пиров и аватаров, медиа, подсветка кода, платёжные и звонковые экраны.

Дополнительные роли темы: `--shadow` (тень поднятых поверхностей), `--grid-ink`, `--grid-label` (фирменная сетка), `--color-toast-text`.

## Типографика

| Роль | Гарнитура | Где |
|---|---|---|
| Текст и интерфейс | Onest Variable (400/500; 600 только там, где был semibold) | всё приложение |
| Display | Unbounded 400 | короткое имя Relay в caption, редкие заголовки |
| Метки и данные | JetBrains Mono | индекс раздела `01/03`, код; числа в счётчиках — Onest с `tabular-nums` |

Файлы — subset woff2 (cyrillic, cyrillic-ext, latin, latin-ext), самохостинг, лицензии OFL рядом в `public/fonts/`. Первый экран предзагружает два файла Onest; 778 КБ TTF Unbounded и его preload удалены. Размеры — шкала DS (12/13/15/19/24); минимум 12 px (мелкий текст оболочки 10–11 px — долг, см. аудит F-27).

## Форма, глубина, отступы

Отступы кратны 4 px (`--space-1…7`); радиусы 6 / 12 / 20 и капсула (`--radius-*`); пузыри сообщений 12/6 (`--border-radius-messages`). Поверхность отделяется ступенью графита; линия — только внутри поверхности; тень (`--shadow`) — у меню, окон, тостов. Кнопка основного действия — инверсия (`--color-primary` на `--color-primary-text`); второстепенная — surface-2. Поле композера — surface-1 с границей `--color-borders-input`.

## Фирменная сетка (Egoist Grid)

Lagom: индекс раздела в caption (`01/03` — реальное положение сервиса в rail, JetBrains Mono, `aria-hidden`); кресты приводки — только на статусных и пустых экранах (не реализованы в 1.7.0, см. «Следующее»). Сетка не появляется в диалогах, меню, формах, на экране входа и поверх данных.

## Компоненты и состояния

- **Rail:** default/hover/selected/loading/error/focus. Семантика: `nav`, `aria-current="page"` на активном сервисе, roving tabindex (Tab входит в rail одной остановкой, стрелки Up/Down/Home/End перемещают фокус, Enter/Space выбирают).
- **Вкладки папок (`TabList`):** `role="tablist"`/`tab`, `aria-selected`, roving tabindex, стрелки/Home/End/Enter/Space.
- **Тосты:** `role="status"`, `aria-live="polite"`.
- **Панель операций (Ctrl+J):** текущие/история/пусто/прогресс/ошибка; закрытие по Esc возвращает фокус. Описание — в [1.6.1](DESIGN-1.6.1.md#компоненты-и-состояния).
- **Поля:** видимая граница ≥ 3:1, focus-visible, ошибка с текстом причины.

## Движение

Токены `--dur-instant/fast/base/slow` (90/160/280/600 мс) и `--ease-standard/spring/expo`. Отклик на действие — в пределах `--dur-base`, пружина — на нажатие и переключатели; декоративного движения в приложении почти нет. `prefers-reduced-motion: reduce` глобально сводит переходы и конечные анимации к ~0 мс (слой `reset`), индикаторы загрузки (`pinner`, `Loading`, `progress`) остаются. Прежние Telegram-анимации используют собственные константы; единый источник CSS↔TS — задача следующего цикла (аудит F-20).

## Адаптивность

Минимум окна 640×448; цели нажатия ≥ 24 px; масштаб текста 200% не должен ломать функции (проверяется `scripts/relay-display-scale.test.mjs`). Панель операций занимает рабочую область, если сервису остаётся меньше 40rem.

## Проверки и границы

Критерии: единая палитра caption/rail/чат/панель/share, нет синих декоративных оттенков вне контента, Tab/Esc/Ctrl+J работают, 640×448 / 800×560 / FullHD / 200%, reduced motion. Измеренное и непроверенное — в [QA-отчёте](lagom-redesign-2026-10-07/QA-REPORT.md). Нативные WebView2, физический DPI/GPU, Narrator и второе устройство остаются отдельной приёмкой. Экраны X и Instagram принадлежат платформам: оболочка вокруг них окрашена в Lagom, содержимое — нет.
