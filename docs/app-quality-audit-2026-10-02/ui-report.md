# Relay UI audit — 2026-10-02

Production fixes and executable synthetic UI coverage are frozen for candidate 1.4.3. The broad all-functions audit remains **in progress**. No real account, foreground Relay process, DNS/DoH/Lagom setting or network strategy was changed by this audit.

## Verified scope

| Check | Result | Scope |
| --- | --- | --- |
| Actual App scenario sweep | 63/64 PASS,0FAIL,1 gate | FullHD controls, navigation, settings layout, themes,200%text,RTL,reducedmotion,DPR2 |
| Actual router sweep | 109/125 bodies rendered,16 gates,0errors | 91 SettingsScreens,22 ManagementScreens,12 RightColumn routes; forms never submitted |
| Theme contrast |11/11 PASS;66/66 overlay samples | Actual RadioGroup actions and checked/theme readback; body/reply/time + media.no-footer/custom-shape/invoice.has-photo |
| Actual custom dialog safety |31/31 PASS,0errors | DeletePhoto,Guard,DeleteMessage,Calendar,AI body portal,Button/Confirm; protected callbacks only |
| Keyboard capture contract |7/7 PASS | Actual TypeScript module + existing jsdom propagation; false/default/composition/release unchanged |
| Enhancers |7/7 PASS | Actual X/Instagram/share scripts in local DOM; no live website/decoder/native action claim |
| Lifecycle/frame stress |3/3 PASS |48 sequential service changes,24 modal cycles, poststress reducedmotion; observed rAF/long tasks |
| TypeScript / targeted ESLint / targeted SCSS |0 errors | src+fixture/imported state;9 owned TS/TSX files linted;SCSS15 existing warnings |

The main rapid stress dispatches120 service clicks and settles Telegram. Separate lifecycle stress records frame timing, not physical Windows compositor or sustained60fps certification: {"frameCount":1096,"frameIntervalMs":{"median":16.69999999999891,"p95":16.700000000000728,"maximum":16.80000000000291},"longTasks":[],"memory":{"usedJSHeapSize":72200000,"totalJSHeapSize":76600000},"remainingModalDialogs":0,"portalChildCount":1}. Console/unhandled errors are zero in final main/group/theme/performance/custom runs. Full project TypeScript and src+fixture TypeScript pass. Full ESLint first exhausted its default V8 heap (exit134). A bounded5120MiB retry completed1862 files with27 errors/1 warning before corrections. The26 new harness errors were fixed by explicit window/globalThis references and removing only pane/mkdir; scoped11JS harness files now pass0errors/0warnings and proportional runtime smoke passes (main4,group callback2,custom1,enhancers7,11themes66overlays,lifecycle3,existing media13). No rule/config suppression. Final whole-project lint completes with 0 errors/1 warnings (exit0); see types-eslint-final.json. Targeted9 changed TS/TSX files pass0errors. npm is absent on this host; existing Node entry points executed the equivalent checks. Full SCSS has0errors/509 existing warnings; targeted2 styles have0errors/15 existing warnings.

## Reproduced changes

- **ui-range-controls**: Three actual failures: disabled keyboard changed value; readOnly keyboard changed value; step2 mapped50/100 to25% fill. → Native disabled/readOnly guard; change/option guards; value span normalization, clamped finite boundaries including0/1 option cases. Evidence: ui-before-fixes.json, ui-scenario-results.json.
- **ui-focus-confirmation**: Focus escaped nonnative modal; title autofocus was not focusable; nested/default selection could bypass visibility or disabled candidates; destructive confirmation default was unsafe. → Post-ref topmost trap, eligible visible enabled targets, nested safe fallback/return, safe Cancel/neutral destructive-only default and no disabled keyboard confirmation. Evidence: ui-modal-outside-before.json, ui-scenario-results.json, ui-focus-theme-after-probe.json.
- **ui-modal-owned-menu**: Native menu outside dialog was inert; div trap redirected outside-owned portal focus; after owned placement Enter triggered Modal.onEnter instead of item (0 item callbacks,+1 modal callback). → Stable modal-owned viewport Portal with lazy lifecycle; explicit scoped capture sentinel blocks earlier handlers and preserves real MenuItem/Menu key events. Native/div Enter/Space callback once, onEnter0, contextmenu and first Escape menu-only, trigger focus restored; outside-menu modal Enter still works. Evidence: ui-modal-more-before.json, ui-modal-menu-spy-before.json, ui-scenario-results.json, ui-keyboard-contract-results.json.
- **ui-custom-native-actions**: Actual DeleteProfilePhoto Cancel Enter invoked delete; Guard Keep Enter invoked confirm; Calendar repeat Enter submitted and Escape closed parent; default desktop Button keyboard was lost. Additional actual Confirm Enter invoked2 callbacks, Cancel confirmed1, DeleteMessage checkbox Enter deleted1. AI body portals outside native dialog were inert; two simultaneous Modal registrations intercepted Enter/Escape for the other owner. → Native detail0 click once/pointer mousedown once; target-aware safe Confirm fallback; owned interactive/multiline controls delegate DOM while singleline input keeps submit. Exact dynamic trigger owns portal and bubble positioning; initial closed portal waits for trigger, Escape restores trigger. Two active owners route Enter/Escape by exact target; AI language button is keyboard-accessible using real anchor rect.31 actual isolated cases pass with0errors/unhandled and protected callbacks. Evidence: ui-custom-modal-before.json, ui-custom-modal-additional-before.json, ui-custom-modal-after.json.
- **ui-theme-solid-overlay**: Actual LightModern radio selected but hardcoded dark bubbles gave unreadable body/reply; actual same-element media/custom-shape/invoice overlay time had16 light failures at1.04–1.93 contrast. → Existing themed backgrounds, scoped solid foreground/reply/time; SolarizedLight existing text90% black10% alias; white time kept only existing dark media overlay. All11 actual theme actions/readbacks, all solid samples and66 source-topology overlay samples meet4.5. Evidence: ui-focus-theme-probe.json, ui-overlay-topology-before.json, ui-focus-theme-after-probe.json.
- **ui-fixture-current-contract**: Mock start callback absent; GetDialogFilters returned legacy shape/string titles causing two undefined.map bootstrap errors; CreateTopic lacked matching default icon pack. → Test-only connected callback/schema/title normalization preserving typed titles; exact synthetic default-topic pack. Clean full/grouped bootstrap and route errors0. Evidence: ui-gate-triage.json, ui-scenario-results.json, ui-grouped-route-results.json.

Additional actual31-case evidence is in [custom dialog results](ui-custom-modal-after.json). Original10-case and additional13-case before receipts stay separate; failed transition/test-precondition probes are retained as historical intermediate evidence and are not counted as final PASS. Native and div menu acceptance both records Enter/Space exactlyone fake item callback and zero Modal.onEnter, ArrowDown skips disabled item, Tab remains in owning modal, contextmenu opens, first Escape closes menu and restores trigger focus, second Escape closes parent. Outside-menu input Enter still invokes its existing Modal callback. Tests execute no destructive/account action.

## Actual theme readbacks and contrast

| Theme | Minimum ratio | Actual checked radio/root match | Media overlay coverage |
| --- | --- | --- | --- |
| egoist-dark | 12.587 | yes | yes (6 samples) |
| dark-modern | 9.824 | yes | yes (6 samples) |
| dark-plus | 10.643 | yes | yes (6 samples) |
| tokyo-night | 9.772 | yes | yes (6 samples) |
| monokai | 12.587 | yes | yes (6 samples) |
| abyss | 8.862 | yes | yes (6 samples) |
| solarized-dark | 5.900 | yes | yes (6 samples) |
| light-modern | 11.193 | yes | yes (6 samples) |
| light-plus | 11.504 | yes | yes (6 samples) |
| quiet-light | 9.638 | yes | yes (6 samples) |
| solarized-light | 4.762 | yes | yes (6 samples) |

The66 overlay samples are separate synthetic media styles using the actual MessageMeta component and source-matching topology; they do not establish actual live media decoding/download. All recorded small text samples meet4.5; minimum 4.762. Screenshots: [LightModern](ui-visuals/after-radio-theme-light-modern.png), [SolarizedLight](ui-visuals/after-radio-theme-solarized-light.png), [native owned menu](ui-visuals/modal-more-menu-native-open.png). Theme before/after images stay separate. Historical targeted failure screenshot names were reused by early probes, so their before JSON error/callback receipts are authoritative and those reused PNGs are not claimed as exact before-state proof. Final main/group/probe results have distinct files.

## Honest coverage limits

Source catalogue: 774 entries, 46 directly asserted components, 25 additional body-rendered components, 10 exact component gates and 690 source-only components. The138 modal-category catalogue rows include 7 exact receipts (CalendarModal, DeleteMessageModal, DeleteProfilePhotoModal, FormattedDateModal, GuardReplaceBotModal, ConfirmDialog, Modal); other131 modal bodies remain source-only. AI editor is additionally tested as its actual composer component. Those receipts cover the listed branches only; no blanket custom dialog certification is claimed. Parent/child catalogue membership is not evidence that every referenced child function works. A route PASS establishes its selected rendered body/control layout; it does not prove server acceptance, settings persistence or all transitions. FullHD baseline screenshots are not an all-theme matrix for all125 route bodies.

Main ActiveWebsites initially resets with unseeded backend state; grouped synthetic websession later renders the body. Account acceptance/revocation remains unverified. Localization fallbacks (e.g. raw General/SetColor/LastSeen.AtDate) remain fixture/live gates, not proven production translation defects. Remote X/Instagram page, account search/DM/create/privacy/live playback, true uploads/CDN delivery, auth recovery, calls/payments/stories, physical DPI/touch/screen reader/GPU remain outside this runner.

| Grouped gate | Reason | Exact FullHD screenshot |
| --- | --- | --- |
| settings-route-PrivacyAddByPhone | Header-only screen; exact child content is not rendered for this standalone route | ui-visuals/settings-route-PrivacyAddByPhone-fullhd.png |
| settings-route-PrivacyPhoneP2P | Header-only screen; exact child content is not rendered for this standalone route | ui-visuals/settings-route-PrivacyPhoneP2P-fullhd.png |
| management-route-GroupType | Enum is present but Management router has no corresponding content branch | ui-visuals/management-route-GroupType-fullhd.png |
| management-route-GroupUserPermissions | Only loading/empty body reached; matching server payload fixture is absent | ui-visuals/management-route-GroupUserPermissions-fullhd.png |
| management-route-GroupRecentActions | Enum is present but Management router has no corresponding content branch | ui-visuals/management-route-GroupRecentActions-fullhd.png |
| management-route-ChatAdminRights | Only loading/empty body reached; matching server payload fixture is absent | ui-visuals/management-route-ChatAdminRights-fullhd.png |
| management-route-ChatNewAdminRights | Only loading/empty body reached; matching server payload fixture is absent | ui-visuals/management-route-ChatNewAdminRights-fullhd.png |
| management-route-JoinRequests | Only loading/empty body reached; matching server payload fixture is absent | ui-visuals/management-route-JoinRequests-fullhd.png |
| right-route-Statistics | Only loading/empty body reached; matching server payload fixture is absent | ui-visuals/right-route-Statistics-fullhd.png |
| right-route-BoostStatistics | Body dataset is absent; header visibility does not verify this component | ui-visuals/right-route-BoostStatistics-fullhd.png |
| right-route-MessageStatistics | Body dataset is absent; header visibility does not verify this component | ui-visuals/right-route-MessageStatistics-fullhd.png |
| right-route-StoryStatistics | Body dataset is absent; header visibility does not verify this component | ui-visuals/right-route-StoryStatistics-fullhd.png |
| right-route-PollResults | Body dataset is absent; header visibility does not verify this component | ui-visuals/right-route-PollResults-fullhd.png |
| right-route-EditTopic | Only loading/empty body reached; matching server payload fixture is absent | ui-visuals/right-route-EditTopic-fullhd.png |
| right-route-MonetizationStatistics | Body dataset is absent; header visibility does not verify this component | ui-visuals/right-route-MonetizationStatistics-fullhd.png |
| right-route-NewGroup | Router resolved empty instead of requested NewGroup | ui-visuals/right-route-NewGroup-fullhd.png |

See [full coverage manifest](ui-coverage-manifest.json), [exact requested/reached route receipts](ui-grouped-route-results.json) and independent [source prerequisite triage](ui-gate-triage.md). These gates remain open for the parent audit; no all-route certification is claimed.

## Harness lint correction proof

[Namespace and runtime smoke receipt](ui-harness-lint-smoke.json) preserves the accepted full64/125/31 results separately. Browser aliases and unused-binding removals keep callback behavior; smoke uses actual App/components and the exact source group measure callback. Initial media invocation had a missing task-work environment gate; the properly scoped existing fixture passes13/13.

## Reproduce

Use the already installed Node/Playwright/headless Chromium runtime. Set RELAY_UI_AUDIT_OUTPUT to this task own runtime work/ui-audit, RELAY_UI_AUDIT_EVIDENCE to this exact project docs directory and RELAY_UI_AUDIT_BROWSER to existing Chromium1243 executable. Run the commands in ui-report.json sequentially (own127.0.0.1:1251, fresh browser profile, all remote requests aborted). No installation/new dependencies required. FILTER writes distinct ui-focused-results.json.

## Source freeze

| Source | SHA256 exact bytes |
| --- | --- |
| src/components/ui/RangeSlider.tsx | 0859997f137f10c0e750094b6cf3a5b80244b447193e3b2dcf059c20eb15da38 |
| src/lib/gramjs/client/MockClient.ts | c7e9f966e96e9971fad8bc09b7bb9b3f03e28585a44c68ddcf9d420c5d968d20 |
| src/components/ui/Modal.tsx | 65c49d093d9e45cd25eea8d0c8f21e0bfcbc3dbe90561954c328b5ccdb2d29dd |
| src/util/trapFocus.ts | 8314b161a5716198d4137b37e5bfb92810da5f33c3c887a24bfd363d594edaa6 |
| src/components/ui/ConfirmDialog.tsx | d79524dc3ed17aabff744528f53e823c06cd87221c75062a4935ebf9f87ab8a0 |
| src/components/middle/message/Message.scss | 45783b340c40994671d694c3c734e650e8b4a5a234c662b18ef95ca7fbb0bc38 |
| src/components/middle/message/MessageMeta.scss | 9cc58cab3932616beb44c7758766bb129a22698808a8e01326f8154040b8a8fc |
| src/components/ui/Menu.tsx | 0f3260175f6b4a64da0502675b3af0ee80b0105d9bf547527bce9d90d1907768 |
| src/util/captureKeyboardListeners.ts | 79dc4df2c069d49292f0119e7aa9b718fe381970eed5c15fdaf84d1562473207 |
| src/components/ui/Button.tsx | 6f042ec8d3f10f537978047d7834ac7d9638dec70a8de753d1e4449d8c9d10e4 |
| src/components/middle/composer/AiMessageEditorModal/AiTextTranslateEditor.tsx | 6fc9461fa8482e7045f384138a4a4bf7a80a7b2cc2454c06a6bb80f4a9aa241f |

Harness hashes are in [ui-source-freeze.json](ui-source-freeze.json). [Neutral review objects](ui-review-objects.json) feed the parent companion board; no decision is selected and account actions do not run when accepting this report.
