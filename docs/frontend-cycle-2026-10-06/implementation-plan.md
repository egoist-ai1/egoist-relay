# Relay: единый нейтральный фронтенд — план реализации

> For agentic workers: execute this plan task-by-task using the existing project workflow. The user authorizes bounded parallel implementation; file ownership below prevents shared edits.

**Goal:** реализовать выбранную композицию B с единым чёрно-серым стилем и сохранить рабочие сценарии чтения, медиа и восстановления.

**Architecture:** сохраняются Tauri/Teact/GramJS и существующие компоненты. Telegram `--color-*` становятся источником цвета для совместимых алиасов `--relay-shell-*`; приватная модель операций не меняется. Размеры областей вычисляются по доступной рабочей ширине, native WebView сохраняется и получает отдельное обновление геометрии.

**Tech Stack:** текущие TypeScript/Teact/SCSS, Rust/Tauri/WebView2, Vite/Vitest/Playwright, без новых зависимостей.

**Spec:** [дизайн-система](../DESIGN.md), [явный выбор пользователя](accepted-direction.json), [карта](audit-map.md).

## Ограничения

- Канонический проект, сохранённые чужие изменения и frozen baseline 1.5.0.
- Панель 24rem/Ctrl+J; полный рабочий экран при остатке сервису менее 40rem; без повторного монтажа WebView.
- Нейтральная Egoist Dark по умолчанию для нового профиля; сохранённый выбор всех 11 существующих вариантов и light mode доступны.
- Отдельное значение опасных/подтверждённых состояний и цвета содержимого сохраняются.
- Никаких живых отправок, изменений установленного профиля, новых облачных зависимостей, телеметрии, монетизации или публикации.
- Кэши и временные данные — собственный Brain work, финальные материалы — проект.

## Review focus

- Profile + full panel + 200%: скрытый Telegram исключён из Tab; после закрытия доступен тот же контекст.
- 1100px + panel: ширина списка определяется рабочей областью; переписка читаема, composer не зажат.
- Theme switch: нейтральные дополнительные переменные не остаются в другой теме; Mini App button foreground читаем.
- Focus/disabled/RTL/длинные имена: общие контролы сохраняют видимые состояния и не обрезают действия.
- Reduced motion/native bounds: анимация содержимого 140ms; границы native не обновляются покадрово.

## Задачи

### 1. Скрытая рабочая область — root

Files: `src/components/App.tsx`, `scripts/relay-operations-ui-audit.mjs`.
Consumes: `isOperationsOpen`, `isOperationsFull`, `activeApp`. Produces: согласованные `inert`/`aria-hidden` для всех service panes.

- [x] Воспроизвести keyboard leak на существующем App, profile + 1280×800/root32.
- [x] Добавить regression `full-panel-hidden-profile-keyboard-restoration`: 25 Tab + 25 ShiftTab, none in hidden Telegram, restoration and switching.
- [x] Применить inert без размонтирования, получить fail → pass.
- [x] Повторить соседние операции/native ordering в итоговой сборке UI.

### 2. Полная нейтральная палитра — neutral_theme

Files: `src/util/antigravityThemes.ts`, `.test.ts`; root: `src/styles/_variables.scss`, `src/util/themeStyle.ts`.
Consumes: существующие темы. Produces: полноценные `--color-*` роли, `--color-primary-text`, очистка переменных предыдущего варианта, default Egoist.

- [x] Тестами подтвердить neutral primary/own/meta/reactions/RGB, сохранённые/недоступные/invalid storage и theme switching.
- [x] Применить палитру; сохранить альтернативные темы, error/success.
- [x] Mini App theme export использует primary foreground; проверить контраст в render.

### 3. Оболочка B — shell_redesign

Files: `multi/AppSidebar.*`, `common/Titlebar.*`; root: `App.module.scss`, localization.
Consumes: shell compatibility aliases, RelayBrand. Produces: rail4.5rem/caption2.5rem, service/status/window actions, visible keyboard focus.

- [x] Реализовать B без декоративной перегрузки; brand Unbounded, UI Inter.
- [x] Проверить существующие shell tests и responsive/RTL/long labels.

### 4. Контролы и настройки — controls_settings + root

Files: `ui/{Button,ListItem,Menu,MenuItem,Modal,Checkbox,Radio,Switcher,SearchInput}.scss`, `styles/_forms.scss`, `Settings.scss`, `SettingsMain.module.scss`, `gili/layout/Island.module.scss`; root: `SettingsGeneral.tsx` + module/localization.
Consumes: semantic color/primary-text/body/motion roles. Produces: flat grouped settings, readable controls, visible focus/disabled/error.

- [x] Заменить локальные hardcodes, сохранить valid variants/actions.
- [x] Фокусируемый Switcher input, inactive nested input исключён.
- [x] Локализовать theme groups, извлечь inline styles, проверить dark/light.

### 5. Чтение и операции — root

Files: `main/Main.scss`, `middle/MiddleHeader.scss`, `right/RightColumn.scss`, `multi/MediaOperationsPanel.*`, `SocialShareModal.module.scss`, `styles/index.scss`, `middle/message/MessageMeta.scss`.
Consumes: выбранная B, ясная подача результата C, source/file metadata существующей модели. Produces: aligned header, workspace-relative columns, flat operations and readable receipt/actions.

- [x] Убрать конфликтующие визуальные глобальные overrides; сохранить aspect ratios/selection/media behavior.
- [x] Согласовать всю типографику, links, own/incoming/meta/reactions с палитрой.
- [x] Адаптировать чтение и проверить profile/panel/keyboard/source/file results.

### 6. Проверки и сравнение — root

Files: existing audit scripts, new cycle acceptance runner and evidence.

- [x] TSC три конфигурации, relevant/full linters heap5120, Vitest и native/release/preflight.
- [x] UI dark/light, 11 themes, 640×448/800×560/FullHD, RTL/text200%, menus/forms/settings/share/profile, operations.
- [x] Одинаковые сценарии baseline/candidate: result access/recovery, timings/motion, CPU/private bytes tree 3 repeats where available. Регрессии >10% вне разброса расследовать.
- [x] Изучить diff и rendered screens, исправить подтверждённые регрессии.

### 7. Локальный кандидат и продолжение — root

- [x] Синхронизировать версию, production build и локальный NSIS installer; не устанавливать в пользовательский профиль.
- [x] Проверяемый diff относительно frozen 1.5.0, source hashes, отчёт до → после, launch/acceptance и companion review board с нейтральными ответами.
- [x] Отдельно отметить live TG/files/physical DPI/GPU/second Windows/competitors как непроверенные до реальной приёмки.

## Статус текущего исполнения

Локальный цикл 1.6.0 завершён: реализация, проверки, три парных browser-прогона, production/NSIS,59-file diff, отчёт и companion board. Детальные scope и непроверенное: RESULT.md/verification.json. Живые медиа, installed-native GPU/DPI/COM и вторая Windows остаются ручной приёмкой ACCEPTANCE.md; они не отмечены выполненными.
