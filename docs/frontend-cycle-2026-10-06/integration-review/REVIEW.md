# Независимый review интеграции Relay 1.6.0

Статус: **подтверждённых регрессий или необоснованных функциональных изменений в перечисленных связках не найдено**. Это read-only review исходников, patch и опубликованных evidence; новые проверки не запускались, источники продукта не менялись. Автор: subagent shell_redesign, task `01a110b9-92a2-79f2-a809-498c13becc2d`, 2026-10-06.

## Проверенные связки

| Участок и строки | Статус и обоснование |
|---|---|
| `src/components/App.tsx:491`, `:501`, `:811`, `:853`; `src/components/multi/MediaOperationsPanel.tsx:80`, `:122` | **Пройдено по review.** Полный режим определяется реальной шириной workspace в rem. Inert и aria-hidden согласованы для трёх сервисов; DOM сервиса сохраняется. На открытии фокус получает кнопка возврата/закрытия, после закрытия возвращается только связанному элементу. Существующие captions/rail остаются доступными: панель имеет role=region, а не модального окна. Native visibility и bounds обновляются отдельным layout effect. |
| `src/components/main/Main.scss:5`, `:85`; `src/components/middle/MiddleHeader.scss:343`, `:364`; `src/components/middle/MiddleColumn.scss:290` | **Пройдено по review.** Cqw привязан к размеру Telegram, а не всему окну. Узкая область переопределяет резервирование профиля в header/footer; широкий профиль сохраняет свой отступ. Убранное смещение header соответствует новой ширине всей средней колонки. Порог контейнера не подменяет существующую viewport-навигацию Telegram; её полный спектр данным review не доказывается. |
| `src/util/applyMessageTextSize.ts:8`; `src/global/actions/ui/initial.ts:159`; `src/global/actions/ui/settings.ts:69`; `src/components/left/settings/SettingsGeneral.tsx:111` | **Пройдено по review.** Все три записи используют один контракт, сохраняют числовой setting/data-attribute и прежний минимум composer. Rem позволяет масштабу текста увеличивать сообщение, composer и meta одновременно. Потребители используют CSS length/calc; новых JS-зависимостей от единицы px не найдено. Начальная установка проходит вложенные requestMutation и поэтому ещё один update pass; функциональный отказ или заметная задержка не подтверждены, отдельным дефектом не объявляется. |
| `src/components/ui/ListItem.tsx:140`, `:142`, `:180`, `:267`; `src/components/ui/Modal.tsx:173`, `:194`; `src/util/captureKeyboardListeners.ts` | **Пройдено по review.** Modal разрешает Enter/Space собственного control. ListItem использует detail=0 native click для единственной активации, исключает repeat/composition/modifiers и события вложенных элементов. MouseDown остаётся прежним владельцем pointer-активации. Static/inactive/nonInteractive/disabled строки исключены из последовательности Tab. Modal.tsx в этом patch не менялся. |
| `src/util/antigravityThemes.ts:429`, `:432`, `:441`; `src/index.tsx:39`, `:77`; `src/util/switchTheme.ts:42`; `src/components/left/settings/SettingsGeneral.tsx:91` | **Пройдено по review.** Сохранённые ID всех 11 вариантов остаются валидными. Default изменён для нового/невалидного выбора, существующий variant не заменяется. Очистка ограничена множеством ролей палитры, не cssText: размеры текста и другие посторонние переменные не стираются. При выборе variant base class выставляется перед shared setting, поэтому прежний switchTheme не перетирает палитру в обычном пути выбора. |
| `src/styles/index.scss:59`, `:103`, `:107`, `:112`, `:140`, `:238`; `src/components/App.module.scss:14`; `src/util/themeStyle.ts` | **Пройдено по review.** Universal selector для font-family снят; тело/controls наследуют Inter, monospace остаётся отдельной ролью, brand сохраняет свой display font. Shell получает aliases текущей палитры вместо принудительной чёрной темы. themeStyle использует явный foreground primary control. Существующие широкие Telegram overrides не были автоматически признаны новыми изменениями: проверялась разница с frozen 1.5.0. |

## Проверенное evidence

Прочитаны опубликованные результаты, а не выполнены повторно:

- `candidate-acceptance-release/frontend-acceptance.json`: 6 pass / 0 fail, включая 1100px с панелью, 640×448 при 200%, изменение message size и удержание light-modern после запуска.
- `candidate-operations-release/operations-ui-audit-2026-10-06T11-09-39-487Z.json`: 21 pass / 0 fail; в том числе Ctrl+J/закрытие и full-panel-hidden-profile-keyboard-restoration. Отдельный after receipt подтверждает 25 Tab + 25 Shift+Tab без входа в скрытый профиль, восстановление доступа и сохранение профиля.
- `candidate-ui-release/ui-scenario-results.json`: 63 pass / 0 fail / 1 gated из 64; есть все 11 тем, размеры окна, RTL и вложенные modal/menu focus paths. Покрыто 37 отрисованных компонентов; это не все 775 исходных компонентов.
- `controls-settings/controls-keyboard-after.json`: 9 pass / 0 fail, включая ListItem в Modal, nested controls и однократную pointer/keyboard-активацию. `verification.json` явно отделяет ранние ошибки harness от финального результата.
- Прочитан `src/util/antigravityThemes.test.ts`: сохранённые варианты, неизвестный ID, отказ storage, очистка theme-only roles и сохранение unrelated inline property проверены отдельными сценариями.

## Граница заключения

`review-snapshot.json` содержит readback всех 59 candidate hashes, hashes patch/source-diff и точное время. При первом сопоставлении совпали 57/59; `src/styles/index.scss` и `scripts/relay-frontend-acceptance.mjs` уже дорабатывались root. Snapshot фиксирует актуальное расхождение на момент записи. Перед передачей полного кандидата нужно обновить общий patch/source-diff и привязать финальную приёмку к ним. Это ограничение доказательств, а не дефект продукта.

Итоговый контраст **Avatar/ProfilePhoto исключён** из заключения по прямому указанию root. Физические WebView2, DPI/GPU, второй Windows-компьютер, screen-reader, живые аккаунты и реальная отправка здесь не проверялись. Resize из боковой панели в полный режим при фокусе внутри Telegram не выделен отдельным сценарием в прочитанных receipts: явной регрессии в коде не найдено, но гарантии этого перехода review не добавляет. Полная release/build/performance-проверка остаётся у основного агента.

Объекты `review-objects.json` предназначены для общего companion review board цикла; пользовательские ответы нейтральны. Подтверждение принимает вывод и зафиксированные границы review, не означает подтверждения непроверенных областей или публикации продукта.
