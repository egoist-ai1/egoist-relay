# Relay 1.5.0: browser operations acceptance

Run: 2026-10-06T10-23-18-240Z. 1/1 passed; 0 failed.

Real App/Panel, existing MockClient, terminal native mocks; all external requests blocked. Windows COM, physical DPI, live delivery and actual filesystem actions require separate native checks.

| Case | Result | Evidence |
| --- | --- | --- |
| full-panel-hidden-profile-keyboard-restoration | pass | [Screenshot](ui-visuals/operations-2026-10-06T10-23-18-240Z/full-panel-hidden-profile-keyboard-restoration.png) |

Machine-readable details: [operations-ui-audit-2026-10-06T10-23-18-240Z.json](operations-ui-audit-2026-10-06T10-23-18-240Z.json). Source hashes and precise native call order are attached to every failure.

Review: parent release board aggregates these cases under relay-1.5.0-operations-ui-acceptance. An approval accepts this evidence for the browser scope; it does not authorize release or substitute for native acceptance.
