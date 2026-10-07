# Relay 1.5.0: browser operations acceptance

Run: 2026-10-06T11-09-39-487Z. 21/21 passed; 0 failed.

Real App/Panel, existing MockClient, terminal native mocks; all external requests blocked. Windows COM, physical DPI, live delivery and actual filesystem actions require separate native checks.

| Case | Result | Evidence |
| --- | --- | --- |
| ctrl-j-close-focus-native-toggle | pass | [Screenshot](ui-visuals/operations-2026-10-06T11-09-39-487Z/ctrl-j-close-focus-native-toggle.png) |
| empty-current-explicit-selection | pass | [Screenshot](ui-visuals/operations-2026-10-06T11-09-39-487Z/empty-current-explicit-selection.png) |
| last-active-auto-history | pass | [Screenshot](ui-visuals/operations-2026-10-06T11-09-39-487Z/last-active-auto-history.png) |
| adaptive-1920x1080 | pass | [Screenshot](ui-visuals/operations-2026-10-06T11-09-39-487Z/adaptive-1920x1080.png) |
| adaptive-800x560 | pass | [Screenshot](ui-visuals/operations-2026-10-06T11-09-39-487Z/adaptive-800x560.png) |
| adaptive-640x448 | pass | [Screenshot](ui-visuals/operations-2026-10-06T11-09-39-487Z/adaptive-640x448.png) |
| known-percent-unknown-stage | pass | [Screenshot](ui-visuals/operations-2026-10-06T11-09-39-487Z/known-percent-unknown-stage.png) |
| saved-visible-format-size-dimensions | pass | [Screenshot](ui-visuals/operations-2026-10-06T11-09-39-487Z/saved-visible-format-size-dimensions.png) |
| prepared-send-metadata-without-url-or-path | pass | [Screenshot](ui-visuals/operations-2026-10-06T11-09-39-487Z/prepared-send-metadata-without-url-or-path.png) |
| file-actions-known-id-missing-file | pass | [Screenshot](ui-visuals/operations-2026-10-06T11-09-39-487Z/file-actions-known-id-missing-file.png) |
| canonical-source-x-known-id-full-close | pass | [Screenshot](ui-visuals/operations-2026-10-06T11-09-39-487Z/canonical-source-x-known-id-full-close.png) |
| canonical-source-instagram-known-id-full-close | pass | [Screenshot](ui-visuals/operations-2026-10-06T11-09-39-487Z/canonical-source-instagram-known-id-full-close.png) |
| late-epoch-revision-lock-unlock | pass | [Screenshot](ui-visuals/operations-2026-10-06T11-09-39-487Z/late-epoch-revision-lock-unlock.png) |
| history-clear-keeps-files-no-late-resurrection | pass | [Screenshot](ui-visuals/operations-2026-10-06T11-09-39-487Z/history-clear-keeps-files-no-late-resurrection.png) |
| navigation-operation-continues-panel-close | pass | [Screenshot](ui-visuals/operations-2026-10-06T11-09-39-487Z/navigation-operation-continues-panel-close.png) |
| full-panel-sidebar-switch-content-order | pass | [Screenshot](ui-visuals/operations-2026-10-06T11-09-39-487Z/full-panel-sidebar-switch-content-order.png) |
| full-panel-check-chat-content-order | pass | [Screenshot](ui-visuals/operations-2026-10-06T11-09-39-487Z/full-panel-check-chat-content-order.png) |
| cancel-confirmed-file-warning-recovery | pass | [Screenshot](ui-visuals/operations-2026-10-06T11-09-39-487Z/cancel-confirmed-file-warning-recovery.png) |
| keyboard-tabs-rtl-long-text | pass | [Screenshot](ui-visuals/operations-2026-10-06T11-09-39-487Z/keyboard-tabs-rtl-long-text.png) |
| text-200pct-reduced-motion-bounds | pass | [Screenshot](ui-visuals/operations-2026-10-06T11-09-39-487Z/text-200pct-reduced-motion-bounds.png) |
| full-panel-hidden-profile-keyboard-restoration | pass | [Screenshot](ui-visuals/operations-2026-10-06T11-09-39-487Z/full-panel-hidden-profile-keyboard-restoration.png) |

Machine-readable details: [operations-ui-audit-2026-10-06T11-09-39-487Z.json](operations-ui-audit-2026-10-06T11-09-39-487Z.json). Source hashes and precise native call order are attached to every failure.

Review: parent release board aggregates these cases under relay-1.5.0-operations-ui-acceptance. An approval accepts this evidence for the browser scope; it does not authorize release or substitute for native acceptance.
