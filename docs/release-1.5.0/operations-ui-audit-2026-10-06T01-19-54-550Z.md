# Relay 1.5.0: browser operations acceptance

Run: 2026-10-06T01-19-54-550Z. 13/18 passed; 5 failed.

Real App/Panel, existing MockClient, terminal native mocks; all external requests blocked. Windows COM, physical DPI, live delivery and actual filesystem actions require separate native checks.

| Case | Result | Evidence |
| --- | --- | --- |
| ctrl-j-close-focus-native-toggle | fail: TimeoutError: locator.waitFor: Timeout 8000ms exceeded. Call log: [2m  - waiting for locator('#relay-media-operations') to be hidden[22m [2m    19 × locator resolved to visible <div role="region" id="relay-media-operations" data-relay-operations="true" aria-labelledby="relay-operations-title" class="MediaOperationsPanel-module__root">…</div>[22m  | [Screenshot](ui-visuals/operations-2026-10-06T01-19-54-550Z/failure-ctrl-j-close-focus-native-toggle.png) |
| empty-current-explicit-selection | pass | [Screenshot](ui-visuals/operations-2026-10-06T01-19-54-550Z/empty-current-explicit-selection.png) |
| last-active-auto-history | pass | [Screenshot](ui-visuals/operations-2026-10-06T01-19-54-550Z/last-active-auto-history.png) |
| adaptive-1920x1080 | pass | [Screenshot](ui-visuals/operations-2026-10-06T01-19-54-550Z/adaptive-1920x1080.png) |
| adaptive-800x560 | pass | [Screenshot](ui-visuals/operations-2026-10-06T01-19-54-550Z/adaptive-800x560.png) |
| adaptive-640x448 | pass | [Screenshot](ui-visuals/operations-2026-10-06T01-19-54-550Z/adaptive-640x448.png) |
| known-percent-unknown-stage | pass | [Screenshot](ui-visuals/operations-2026-10-06T01-19-54-550Z/known-percent-unknown-stage.png) |
| saved-visible-format-size-dimensions | pass | [Screenshot](ui-visuals/operations-2026-10-06T01-19-54-550Z/saved-visible-format-size-dimensions.png) |
| file-actions-known-id-missing-file | fail: AssertionError [ERR_ASSERTION]: The input did not match the regular expression /не найден\|недоступ\|missing\|unavailable/i. Input:  'Файл перемещён или удалён. Запись в журнале не восстанавливает файл.'  | [Screenshot](ui-visuals/operations-2026-10-06T01-19-54-550Z/failure-file-actions-known-id-missing-file.png) |
| canonical-source-known-id-full-close | pass | [Screenshot](ui-visuals/operations-2026-10-06T01-19-54-550Z/canonical-source-known-id-full-close.png) |
| late-epoch-revision-lock-unlock | pass | [Screenshot](ui-visuals/operations-2026-10-06T01-19-54-550Z/late-epoch-revision-lock-unlock.png) |
| history-clear-keeps-files-no-late-resurrection | fail: AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:  0 !== 1  | [Screenshot](ui-visuals/operations-2026-10-06T01-19-54-550Z/failure-history-clear-keeps-files-no-late-resurrection.png) |
| navigation-operation-continues-panel-close | pass | [Screenshot](ui-visuals/operations-2026-10-06T01-19-54-550Z/navigation-operation-continues-panel-close.png) |
| full-panel-sidebar-switch-content-order | pass | [Screenshot](ui-visuals/operations-2026-10-06T01-19-54-550Z/full-panel-sidebar-switch-content-order.png) |
| full-panel-check-chat-content-order | pass | [Screenshot](ui-visuals/operations-2026-10-06T01-19-54-550Z/full-panel-check-chat-content-order.png) |
| cancel-confirmed-file-warning-recovery | fail: AssertionError [ERR_ASSERTION]: The input did not match the regular expression /журнал\|journal/i. Input:  'Не удалось записать результат в защищённую историю. Он доступен, пока приложение открыто. После перезапуска проверьте файл или чат.'  | [Screenshot](ui-visuals/operations-2026-10-06T01-19-54-550Z/failure-cancel-confirmed-file-warning-recovery.png) |
| keyboard-tabs-rtl-long-text | fail: AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:  'false' !== 'true'  | [Screenshot](ui-visuals/operations-2026-10-06T01-19-54-550Z/failure-keyboard-tabs-rtl-long-text.png) |
| text-200pct-reduced-motion-bounds | pass | [Screenshot](ui-visuals/operations-2026-10-06T01-19-54-550Z/text-200pct-reduced-motion-bounds.png) |

Machine-readable details: [operations-ui-audit-2026-10-06T01-19-54-550Z.json](operations-ui-audit-2026-10-06T01-19-54-550Z.json). Source hashes and precise native call order are attached to every failure.

Review: parent release board aggregates these cases under relay-1.5.0-operations-ui-acceptance. An approval accepts this evidence for the browser scope; it does not authorize release or substitute for native acceptance.
