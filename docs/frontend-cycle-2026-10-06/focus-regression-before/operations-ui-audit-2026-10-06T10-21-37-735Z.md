# Relay 1.5.0: browser operations acceptance

Run: 2026-10-06T10-21-37-735Z. 0/1 passed; 1 failed.

Real App/Panel, existing MockClient, terminal native mocks; all external requests blocked. Windows COM, physical DPI, live delivery and actual filesystem actions require separate native checks.

| Case | Result | Evidence |
| --- | --- | --- |
| full-panel-hidden-profile-keyboard-restoration | fail: AssertionError [ERR_ASSERTION]: Tab enters hidden Telegram/profile while full operations panel is open + actual - expected  + [ +   { +     label: 'Common.Close', +     tag: 'BUTTON' +   }, +   { +     label: 'Edit', +     tag: 'BUTTON' +   }, +   { +     label: 'Statistics', +     tag: 'BUTTON' +   }, +   { +     label: 'https://t.me/+relay-synthetic-fixtureSetUrlPlaceholder', +     tag: 'DIV' +   }, +   { +     label: 'Notifications', +     tag: 'DIV' +   }, +   { +     label: '', +     tag: 'INPUT' +   }, +   { +     label: 'MembersMediaFilesLinksMusicGIFVoice', +     tag: 'DIV' +   }, +   { +     label: 'EREgoist RelayOwner', +     tag: 'DIV' +   }, +   { +     label: 'МВМарина ВолковаAdminLastSeen.AtDate', +     tag: 'DIV' +   }, +   { +     label: 'МВМарина ВолковаAdminLastSeen.AtDate', +     tag: 'DIV' +   }, +   { +     label: 'EREgoist RelayOwner', +     tag: 'DIV' +   }, +   { +     label: 'MembersMediaFilesLinksMusicGIFVoice', +     tag: 'DIV' +   }, +   { +     label: '', +     tag: 'INPUT' +   }, +   { +     label: 'Notifications', +     tag: 'DIV' +   }, +   { +     label: 'https://t.me/+relay-synthetic-fixtureSetUrlPlaceholder', +     tag: 'DIV' +   }, +   { +     label: 'Statistics', +     tag: 'BUTTON' +   }, +   { +     label: 'Edit', +     tag: 'BUTTON' +   }, +   { +     label: 'Common.Close', +     tag: 'BUTTON' +   }, +   { +     label: 'МВМарина ВолковаAdminLastSeen.AtDate', +     tag: 'DIV' +   } + ] - []  | [Screenshot](ui-visuals/operations-2026-10-06T10-21-37-735Z/failure-full-panel-hidden-profile-keyboard-restoration.png) |

Machine-readable details: [operations-ui-audit-2026-10-06T10-21-37-735Z.json](operations-ui-audit-2026-10-06T10-21-37-735Z.json). Source hashes and precise native call order are attached to every failure.

Review: parent release board aggregates these cases under relay-1.5.0-operations-ui-acceptance. An approval accepts this evidence for the browser scope; it does not authorize release or substitute for native acceptance.
