# Relay 1.5.0: browser operations acceptance

Run: 2026-10-06T01-22-39-856Z. 8/8 passed; 0 failed.

Real App/Panel, existing MockClient, terminal native mocks; all external requests blocked. Windows COM, physical DPI, live delivery and actual filesystem actions require separate native checks.

| Case | Result | Evidence |
| --- | --- | --- |
| prepared-send-metadata-without-url-or-path | pass | [Screenshot](ui-visuals/operations-2026-10-06T01-22-39-856Z/prepared-send-metadata-without-url-or-path.png) |
| file-actions-known-id-missing-file | pass | [Screenshot](ui-visuals/operations-2026-10-06T01-22-39-856Z/file-actions-known-id-missing-file.png) |
| canonical-source-x-known-id-full-close | pass | [Screenshot](ui-visuals/operations-2026-10-06T01-22-39-856Z/canonical-source-x-known-id-full-close.png) |
| canonical-source-instagram-known-id-full-close | pass | [Screenshot](ui-visuals/operations-2026-10-06T01-22-39-856Z/canonical-source-instagram-known-id-full-close.png) |
| history-clear-keeps-files-no-late-resurrection | pass | [Screenshot](ui-visuals/operations-2026-10-06T01-22-39-856Z/history-clear-keeps-files-no-late-resurrection.png) |
| cancel-confirmed-file-warning-recovery | pass | [Screenshot](ui-visuals/operations-2026-10-06T01-22-39-856Z/cancel-confirmed-file-warning-recovery.png) |
| keyboard-tabs-rtl-long-text | pass | [Screenshot](ui-visuals/operations-2026-10-06T01-22-39-856Z/keyboard-tabs-rtl-long-text.png) |
| text-200pct-reduced-motion-bounds | pass | [Screenshot](ui-visuals/operations-2026-10-06T01-22-39-856Z/text-200pct-reduced-motion-bounds.png) |

Machine-readable details: [operations-ui-audit-2026-10-06T01-22-39-856Z.json](operations-ui-audit-2026-10-06T01-22-39-856Z.json). Source hashes and precise native call order are attached to every failure.

Review: parent release board aggregates these cases under relay-1.5.0-operations-ui-acceptance. An approval accepts this evidence for the browser scope; it does not authorize release or substitute for native acceptance.
