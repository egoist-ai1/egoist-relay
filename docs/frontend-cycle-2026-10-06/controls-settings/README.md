# Контролы и настройки — итог участка

Участок общего фронтенд-цикла Relay, 6 октября 2026. Исходники освобождены для интеграции root; этот отчёт не подтверждает готовность всего приложения или native-отправку.

В 13 SCSS файлах контролы и настройки переведены на Inter, rem, semantic theme tokens и плоские разделы. Состояния ошибки и danger сохранены. Белая primary-кнопка использует чёрный текст и spinner из alias нейтральной темы; другие темы используют собственные цвета. Новые зависимости и изменения пользовательских настроек отсутствуют.

В `Switcher.tsx` самостоятельный input с onCheck теперь получает Tab-фокус и aria-label; input внутри owner-строки либо inactive не создаёт второй Tab target. В `ListItem.tsx` Enter/Space проходят к существующему click-action ровно один раз; mouse mousedown и drag-поведение не менялись. Keydown обрабатывается только для самого owner, с guards для disabled/static/inactive/nonInteractive, repeat, IME и modifiers; вложенные input/button/link оставляют действие у себя.

| Проверка | Результат | Доказательство |
|---|---|---|
| TypeScript main/script/test | 3 × exit 0 | tsc-final-*.log |
| ESLint 2 изменённых TSX, heap 5120 MiB | 0 ошибок / 0 предупреждений | eslint-controls-final.log |
| Stylelint 13 SCSS | 0 ошибок / 60 предупреждений | stylelint-controls-final.log |
| Настоящий App: Main, General, Performance; 640×448, 800×560, FullHD 200%, RTL; long controls; Modal more div/native | 10 pass / 0 fail / 0 gated | final-ui/ui-focused-results.json |
| Настоящие Switcher/ListItem в callback-only fixture: scoped before → after | 1/9 → 9/9 выполненных критериев; after 0 page errors | controls-keyboard-before.json; controls-keyboard-after.json |

Сравнение «до» заменяет только 15 сохранённых файлов участка, остальной App остаётся текущим. Несколько невыполненных критериев до изменения относятся к одному и тому же keyboard-дефекту: это не восемь независимых ошибок продукта. Исходные bytes сохранены в `baseline-src`, SHA-256 до/после — в `source-hashes.json`, review diff — в `source.patch`.

Снимки `final-ui/ui-visuals/settings-Main-fullhd.png`, `layout-small-640.png`, `layout-fullhd-200pct-text.png` и `controls-long-text-fullhd.png` осмотрены. Текст в root32 увеличивается, длинные radio-подписи переносятся, primary/result и focus различимы. RTL и viewport checks показывают layout в эмуляции; это не покрывает физические DPI/GPU, screen reader и всё поведение языка RTL. Floating input-label остаётся однострочным с ellipsis. Главный заголовок SETTINGS наблюдался в EN mock и передан root как пункт общего header/localization review вне участка.

## Воспроизведение keyboard regression

Из корня проекта в PowerShell задайте собственные временные пути; probe импортирует реальные Teact, Switcher, ListItem, Modal и Button. Он использует только MockClient и локальные callbacks, блокирует внешние requests и закрывает сервер/браузер после проверки.

```powershell
$env:RELAY_UI_PROJECT=(Get-Location).Path
$env:RELAY_UI_AUDIT_OUTPUT='<runtime текущей задачи>/controls-check'
$env:RELAY_UI_AUDIT_EVIDENCE='<runtime текущей задачи>/controls-check-evidence'
$env:RELAY_UI_AUDIT_BROWSER='C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$env:RELAY_UI_AUDIT_PORT='1284'
node docs/frontend-cycle-2026-10-06/controls-settings/verify-controls-keyboard.mjs
```

Для scoped «до» дополнительно задайте `RELAY_CONTROLS_BASELINE` абсолютным путём к `docs/frontend-cycle-2026-10-06/controls-settings/baseline-src`. Этот режим ожидает подтверждённый отказ standalone Tab; exit 0 означает успешное воспроизведение ожидаемого дефекта, а не зелёную исходную версию. Для candidate уберите этот env var. Указанный browser должен быть установлен локально.

Промежуточные failed receipts сохранены: первоначально harness ожидал zero-size Modal root; затем nested assertion учитывал callback предыдущего отдельного случая. `verification.json` объясняет обе корректировки. Финальный nested сценарий отдельно считает свою дельту, проверяет реальные focus targets, Enter/Space child Button, Enter link и редактирование child input.

## Обратная связь

Три независимых объекта результата и их точные версии находятся в `review-objects.json`; SHA-256 снимка указан в `verification.json`. Root включает их в отдельный companion review board всего цикла. Нейтральные пользовательские ответы и комментарии хранятся отдельно; приёмка этого участка не подтверждает недоступные native/live проверки и не требуется для продолжения уже порученной реализации.
