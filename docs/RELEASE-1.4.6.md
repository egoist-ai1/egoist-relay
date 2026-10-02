# Egoist Relay 1.4.6

Проверенный выпуск интерфейса Reels и пересылки в Telegram. Ветка: codex/release-1.4.6; тег: relay-v1.4.6.

## Reels

Панель действий использует ближайшую нативную вертикальную группу кнопок. Собственная кнопка Telegram размещается после Share, перед Bookmark. Размер иконки — 24 px, область нажатия — 44 px. Обычные числовые счётчики сохраняются; длинный placeholder заменён на «Нравятся». Собственные классы очищаются при смене маршрута.

## Окно пересылки

Используется существующий RecipientPicker: заголовок выбора получателей, поиск, недавние контакты, папки и выбранные строки. До выбора адресата доступно копирование ссылки, после выбора — Send. Сохранены проверки preview/media/download/cancel/payment и защита от повторной отправки. В коротком окне 640×560 при root font 20 px доступны элементы управления и полная строка получателя.

## Верификация

387 конечных software checks, три TypeScript configurations и отдельный installer smoke прошли. Native account proof подтвердил Telegram, X и Instagram. Периодический pending при обновлении proof является переходным состоянием; в проверенном warmup он сменяется ready.

## Публикация

3304 опубликованных production inputs совпадают с проверенным source freeze по SHA256. Исходный freeze содержит 3307 inputs: machine-generated public/build-stats.json, public/statoscope-report.html и standalone public/installer.html исключены из публикации из-за локальных путей build/install host. Исходники приложения не импортируют эти файлы. Дополнительно включены синтетические тесты, публичные notices и компонент Social MCP. Старую локальную Git историю, developer .env, build/evidence output и аккаунтные данные публикация не переносит. Runtime executables/models и локальный установщик не являются Git assets этой ветки.

Подробнее: [VERIFICATION.md](VERIFICATION.md), [BUILDING.md](../BUILDING.md), [SECURITY.md](../SECURITY.md).
