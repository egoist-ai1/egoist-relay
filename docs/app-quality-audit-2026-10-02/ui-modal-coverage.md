# Relay: modal source registry and exact branch coverage

Read-only reconciliation for Relay 1.4.3. Only this JSON/Markdown report pair changed. Source, tests, old receipts, other reports and the package remain unchanged. No browser, application/process control, account/API/network actions or test reruns.

**Seven exact modal-category paths have direct receipts: two shared components and five specific partial bodies. The other 131 of 138 entries have no exact direct receipt. No complete service form or account workflow is certified.**

The inventory assigns the modal category by filename containing “Modal” or ending “Dialog”, after settings/auth/multi precedence. Its 138 entries are part of a 774-source catalogue, and include shells, nested views, headers and helpers. They are not 138 independent windows and do not form an exhaustive list of every possible dialog or form.

| Source role | Entries | Evidence boundary |
|---|---:|---|
| Specific modal-body source files | 123 | Five have partial branch receipts; 118 have none |
| Custom media-overlay body | 1 | OneTimeMediaModal div overlay; no exact receipt |
| Reusable shells/templates | 7 | Modal, ConfirmDialog, Gili Modal, PickerModal, TableAboutModal, TableInfoModal, PromptDialog; two shared components tested |
| Auxiliary entries | 7 | One header, one balance accessory, one attachment-item helper, two nested subviews, one registry, one minimized-browser control |
| Total filename category | 138 | No independent-window count inferred |

The 123 body files and one overlay describe source structure. Some delegate shared pickers, contain other dialogs or expose different states. Generic shell behavior does not certify 119 unexercised body sources or all branches of the five partial bodies.

Frozen inputs: main 64 cases (63 pass, one gate); grouped 125 (109 pass, 16 gates); custom 31 (all pass); generic lifecycle performance 3 (all pass). Published errors/unhandled arrays are empty. The grouped cases reference **zero exact modal-category components**, so route rendering adds no modal coverage.

## Exact direct body evidence

### CalendarModal

[src/components/common/CalendarModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/common/CalendarModal.tsx>)

Current source SHA-256: d04f40ba7d6e5436b84a400da2a797a8ab07e89a8df8e3305f4b251531061b9e.

Actual renderer: scripts/relay-ui-audit.fixture.tsx:50, scripts/relay-ui-audit.fixture.tsx:137.

| Actual case ID | Checked branch | Receipt |
|---|---|---|
| calendar-repeat-item-enter | Repeat menu Enter selects Daily; date-submit zero. | [ui-custom-modal-after.json](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/docs/app-quality-audit-2026-10-02/ui-custom-modal-after.json>) |
| calendar-repeat-escape-child-only | First Escape closes repeat menu; native parent remains open. | [ui-custom-modal-after.json](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/docs/app-quality-audit-2026-10-02/ui-custom-modal-after.json>) |
| calendar-repeat-item-space | Repeat menu Space selects Daily; date-submit zero. | [ui-custom-modal-after.json](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/docs/app-quality-audit-2026-10-02/ui-custom-modal-after.json>) |
| calendar-repeat-escape-restores-trigger | First Escape returns exact repeat trigger; second closes parent. | [ui-custom-modal-after.json](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/docs/app-quality-audit-2026-10-02/ui-custom-modal-after.json>) |
| calendar-time-input-enter-baseline | Time-input Enter invokes local submit once. | [ui-custom-modal-after.json](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/docs/app-quality-audit-2026-10-02/ui-custom-modal-after.json>) |

Only these named branches are proved. Other variants, validation, submit/account effects, native Windows/accessibility and media delivery remain unproved.

### DeleteMessageModal

[src/components/common/DeleteMessageModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/common/DeleteMessageModal.tsx>)

Current source SHA-256: 8357faf6645dc9ec6f6a85465416c5a2459f6e56a3d8cbbd1069b32becc8e963.

Actual renderer: scripts/relay-ui-audit.fixture.tsx:64, scripts/relay-ui-audit.fixture.tsx:67, src/components/main/Main.tsx:67, src/components/main/Main.tsx:681.

| Actual case ID | Checked branch | Receipt |
|---|---|---|
| delete-message-checkbox-enter | Actual message checkbox Enter invokes protected-delete zero; no deletion tested. | [ui-custom-modal-after.json](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/docs/app-quality-audit-2026-10-02/ui-custom-modal-after.json>) |

Only these named branches are proved. Other variants, validation, submit/account effects, native Windows/accessibility and media delivery remain unproved.

### DeleteProfilePhotoModal

[src/components/common/DeleteProfilePhotoModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/common/DeleteProfilePhotoModal.tsx>)

Current source SHA-256: 9ebadad4d7c3eab0432c73e4b1edf518d2a957794a1b3ab94b5489c635bfcd8d.

Actual renderer: scripts/relay-ui-audit.fixture.tsx:48, scripts/relay-ui-audit.fixture.tsx:131.

| Actual case ID | Checked branch | Receipt |
|---|---|---|
| delete-photo-cancel-enter | Actual Cancel Enter closes once; confirm and protected-delete zero. | [ui-custom-modal-after.json](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/docs/app-quality-audit-2026-10-02/ui-custom-modal-after.json>) |
| delete-photo-safe-space | Actual Cancel Space closes once; protected-delete zero. | [ui-custom-modal-after.json](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/docs/app-quality-audit-2026-10-02/ui-custom-modal-after.json>) |

Only these named branches are proved. Other variants, validation, submit/account effects, native Windows/accessibility and media delivery remain unproved.

### FormattedDateModal

[src/components/middle/composer/FormattedDateModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/middle/composer/FormattedDateModal.tsx>)

Current source SHA-256: ab3c7abe5913f36f0a1f909f81675c46ca015e95034ee1a8c302acdf5a963033.

Actual renderer: scripts/relay-ui-audit.fixture.tsx:47, scripts/relay-ui-audit.fixture.tsx:178.

| Actual case ID | Checked branch | Receipt |
|---|---|---|
| formatted-date-modal-layout | Actual preview/input/control geometry and TabList presence at FullHD. Escape is pressed, but closure is not separately asserted. No options, Save or nested Calendar assertion. | [ui-scenario-results.json](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/docs/app-quality-audit-2026-10-02/ui-scenario-results.json>) |

Receipt surface rectangle has height0 while individual controls are measured. Control assertions do not establish whole-overlay bounds; Escape dispatch without close assertion is not closure proof.

Only these named branches are proved. Other variants, validation, submit/account effects, native Windows/accessibility and media delivery remain unproved.

### GuardReplaceBotModal

[src/components/right/management/GuardReplaceBotModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/right/management/GuardReplaceBotModal.tsx>)

Current source SHA-256: 3b6df7586bcf3b71383af697bbc10ec8bb15d9bba757fd5acb8b437d7a6b129c.

Actual renderer: scripts/relay-ui-audit.fixture.tsx:49, scripts/relay-ui-audit.fixture.tsx:133.

| Actual case ID | Checked branch | Receipt |
|---|---|---|
| guard-bot-keep-enter | Actual Keep Enter closes once; guardConfirm zero. | [ui-custom-modal-after.json](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/docs/app-quality-audit-2026-10-02/ui-custom-modal-after.json>) |
| guard-bot-safe-space | Actual Keep Space closes once; guardConfirm zero. | [ui-custom-modal-after.json](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/docs/app-quality-audit-2026-10-02/ui-custom-modal-after.json>) |

Only these named branches are proved. Other variants, validation, submit/account effects, native Windows/accessibility and media delivery remain unproved.

Shared Modal and ConfirmDialog provide their listed generic focus, keyboard, native-control and menu proofs. Every JSON row links exact case IDs, receipt SHA-256, checked branches, actual assertion readbacks and renderer/runner references. Service forms receive no blanket inherited pass.

## Count and version reconciliation

Earlier main/grouped snapshots linked two shared primitives and one FormattedDate partial body: 3 direct paths, 135 without. Final custom31 adds four exact body paths: 7 direct, 131 without. No route-derived promotion; safe-Space renderer mappings add branch detail, not path count.

37 in the older main snapshot, 40 in the current main receipt and 46 in the supplemented final union describe different input snapshots/unions, not modal-body counts.

DeletePhoto/Guard safe-Space receipts omit body paths from sources[]. The actual runner open(kind), owning button selector and imported fixture branch identify each body; this adds branch detail without increasing the seven-path count. A declared source path alone is not functional proof.

All 138 current source hashes match the final manifest; published production/harness freeze hashes also match. Receipts do not embed per-component/build hashes, so linkage uses published source/import/freeze evidence, not cryptographic runtime-bundle attestation.

## Historical findings and remaining scope

- Original Cancel/Keep/checkbox and Calendar repeat Enter risks are historical. Final native-control/menu delegation and target-aware ConfirmDialog assertions pass in the final 31 actual cases. Original source hashes and dispatcher extraction remain historical evidence.
- Calendar repeat Enter/Space, child-first Escape, exact trigger return and ordinary time-input Enter have direct receipts. Validation, date constraints, layout variants, nested FormattedDate and actual scheduling remain unproved.
- FormattedDate control geometry and TabList are asserted. Escape is pressed but closure is not separately asserted; options, Save and nested Calendar are not inferred.
- Separate Gili native shell remains source-only. Generic .Modal.open/.modal-dialog tests do not establish its selectors, form semantics or focus.
- Actual AiTextTranslateEditor child has eight receipts in the composer category. Parent AiMessageEditorModal remains source-only. Attachment SymbolMenu remains source-only; Calendar repeat is inline.
- Real account/server effects, media delivery, native Windows/DPI/accessibility and unlisted body states remain outside callback-only receipts.

New ui-additional-modal-* fixtures/receipts are excluded from this frozen cutoff and receive no coverage credit.

## Safe source-only next forms

- src/components/modals/poll/PollModal.tsx: Exact synthetic chat + message-list; appConfig.pollMaxAnswers=10,pollClosePeriodMax=604800,pollCountriesMax=3,countryList.general populated or defined[]; starsBalance0,paidMessagesStars0. Gili native modal implementation. Gate: Sending poll/payment/remote acceptance not certified.
- src/components/middle/composer/ToDoListModal.tsx: appConfig.todoItemsMax=10,todoTitleLengthMax=128,todoItemLengthMax=256; onSend/onClear captured local. New-mode editingMessage absent; edit/add require exact ApiMessage.content.todo. Gate: Remote edit/append/send and account checklist permissions remain protected.
- src/components/middle/composer/RichEditorLinkModal.tsx: Pure onSubmit(text,url)/onClose callbacks and language; uses gili/modal/Modal, not ui/Modal; no account required. Gate: Applying link to real draft not performed.
- src/components/main/NewContactModal.tsx: tab.newContact={userId:'101'} or {isByPhoneNumber:true}; users.byId101 + global.countryList.phoneCodes and userFullInfo.note; intercept importContact/updateContact. Gate: Real contacts/share phone/account mutation not performed.
- src/components/modals/reportModal/ReportModal.tsx: Valid synthetic selected message; subsequent comment section {type:'comment',title:'Describe',option:'fixture-reason',isOptional:false}; intercept reportMessages/reportStory and previous-section actions. Gate: Moderation/report submission protected.
- src/components/middle/composer/AttachmentModal.tsx: Actual RichEditor instance from composer plus defined attachmentSettings/captionLimit/recentEmojis; onSend/onFileAppend/onAttachmentsUpdate/onClear/sendSilent/sendScheduled local callbacks. Object URL lifecycle only synthetic local bytes. Gate: Real upload/CDN/performance/media delivery remain separately gated.

Earlier Calendar/photo/guard plans remain partial in JSON, with proved case IDs separated from remaining validation/layout/submit checks.

## Full original 138-entry registry

| Exact component | Structural role | Evidence | Actual case IDs |
|---|---|---|---|
| [src/components/calls/phone/RatePhoneCallModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/calls/phone/RatePhoneCallModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/common/AboutMonetizationModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/common/AboutMonetizationModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/common/CalendarModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/common/CalendarModal.tsx>) | specific_modal_body | specific_body_partial | calendar-repeat-item-enter, calendar-repeat-escape-child-only, calendar-repeat-item-space, calendar-repeat-escape-restores-trigger, calendar-time-input-enter-baseline |
| [src/components/common/CountryPickerModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/common/CountryPickerModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/common/CustomEmojiSetsModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/common/CustomEmojiSetsModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/common/DeleteChatModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/common/DeleteChatModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/common/DeleteMessageModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/common/DeleteMessageModal.tsx>) | specific_modal_body | specific_body_partial | delete-message-checkbox-enter |
| [src/components/common/DeleteProfilePhotoModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/common/DeleteProfilePhotoModal.tsx>) | specific_modal_body | specific_body_partial | delete-photo-cancel-enter, delete-photo-safe-space |
| [src/components/common/DocumentReaderModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/common/DocumentReaderModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/common/PasswordConfirmModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/common/PasswordConfirmModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/common/PaymentMessageConfirmDialog.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/common/PaymentMessageConfirmDialog.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/common/PinMessageModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/common/PinMessageModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/common/PrivacySettingsNoticeModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/common/PrivacySettingsNoticeModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/common/RemoveFormattingModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/common/RemoveFormattingModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/common/ReportAvatarModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/common/ReportAvatarModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/common/SeenByModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/common/SeenByModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/common/SensitiveContentConfirmModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/common/SensitiveContentConfirmModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/common/StickerSetModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/common/StickerSetModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/common/UnpinAllMessagesModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/common/UnpinAllMessagesModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/common/VerificationMonetizationModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/common/VerificationMonetizationModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/common/pickers/PickerModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/common/pickers/PickerModal.tsx>) | reusable_picker_template | source_only_exact_component |  |
| [src/components/gili/modal/Modal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/gili/modal/Modal.tsx>) | alternate_native_modal_primitive | source_only_exact_component |  |
| [src/components/left/ChatFolderModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/left/ChatFolderModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/left/MuteChatModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/left/MuteChatModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/main/BotTrustModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/main/BotTrustModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/main/BrowserCloseConfirmationModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/main/BrowserCloseConfirmationModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/main/DeleteFolderDialog.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/main/DeleteFolderDialog.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/main/GameModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/main/GameModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/main/NewContactModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/main/NewContactModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/main/SafeLinkModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/main/SafeLinkModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/main/premium/GiveawayChannelPickerModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/main/premium/GiveawayChannelPickerModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/main/premium/GiveawayModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/main/premium/GiveawayModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/main/premium/GiveawayUserPickerModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/main/premium/GiveawayUserPickerModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/main/premium/PremiumFeatureModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/main/premium/PremiumFeatureModal.tsx>) | nested_body_subview | source_only_exact_component |  |
| [src/components/main/premium/PremiumMainModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/main/premium/PremiumMainModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/main/premium/StarsGiftingPickerModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/main/premium/StarsGiftingPickerModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/main/premium/common/PremiumLimitReachedModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/main/premium/common/PremiumLimitReachedModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/middle/ChatLanguageModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/middle/ChatLanguageModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/middle/ReactorListModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/middle/ReactorListModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/middle/composer/AiMessageEditorModal/AiMessageEditorModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/middle/composer/AiMessageEditorModal/AiMessageEditorModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/middle/composer/AiMessageEditorModal/AiToneEditorModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/middle/composer/AiMessageEditorModal/AiToneEditorModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/middle/composer/AiMessageEditorModal/AiToneEmojiPickerModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/middle/composer/AiMessageEditorModal/AiToneEmojiPickerModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/middle/composer/AttachmentModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/middle/composer/AttachmentModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/middle/composer/AttachmentModalItem.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/middle/composer/AttachmentModalItem.tsx>) | body_item_helper | source_only_exact_component |  |
| [src/components/middle/composer/FormattedDateModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/middle/composer/FormattedDateModal.tsx>) | specific_modal_body | specific_body_partial | formatted-date-modal-layout |
| [src/components/middle/composer/RichEditorLinkModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/middle/composer/RichEditorLinkModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/middle/composer/ToDoListModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/middle/composer/ToDoListModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/modals/ModalContainer.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/modals/ModalContainer.tsx>) | modal_registry | source_only_exact_component |  |
| [src/components/modals/aboutAds/AboutAdsModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/modals/aboutAds/AboutAdsModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/modals/ageVerification/AgeVerificationModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/modals/ageVerification/AgeVerificationModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/modals/aiTonePreview/AiTonePreviewModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/modals/aiTonePreview/AiTonePreviewModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/modals/attachBotInstall/AttachBotInstallModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/modals/attachBotInstall/AttachBotInstallModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/modals/autoDeleteTimer/AutoDeleteTimerModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/modals/autoDeleteTimer/AutoDeleteTimerModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/modals/birthday/BirthdaySetupModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/modals/birthday/BirthdaySetupModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/modals/boost/BoostModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/modals/boost/BoostModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/modals/browser/BrowserModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/modals/browser/BrowserModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/modals/browser/MinimizedBrowserModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/modals/browser/MinimizedBrowserModal.tsx>) | minimized_window_control | source_only_exact_component |  |
| [src/components/modals/chatInvite/ChatInviteModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/modals/chatInvite/ChatInviteModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/modals/chatlist/ChatlistModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/modals/chatlist/ChatlistModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/modals/cocoon/CocoonModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/modals/cocoon/CocoonModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/modals/collectible/CollectibleInfoModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/modals/collectible/CollectibleInfoModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/modals/common/TableAboutModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/modals/common/TableAboutModal.tsx>) | reusable_information_template | source_only_exact_component |  |
| [src/components/modals/common/TableInfoModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/modals/common/TableInfoModal.tsx>) | reusable_information_template | source_only_exact_component |  |
| [src/components/modals/deleteAccount/DeleteAccountModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/modals/deleteAccount/DeleteAccountModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/modals/deleteMember/DeleteMemberModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/modals/deleteMember/DeleteMemberModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/modals/disableSharing/DisableSharingAboutModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/modals/disableSharing/DisableSharingAboutModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/modals/emojiStatusAccess/EmojiStatusAccessModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/modals/emojiStatusAccess/EmojiStatusAccessModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/modals/frozenAccount/FrozenAccountModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/modals/frozenAccount/FrozenAccountModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/modals/gift/AboutStarGiftModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/modals/gift/AboutStarGiftModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/modals/gift/GiftModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/modals/gift/GiftModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/modals/gift/GiftModalResaleScreen.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/modals/gift/GiftModalResaleScreen.tsx>) | nested_body_subview | source_only_exact_component |  |
| [src/components/modals/gift/StarGiftPriceDecreaseInfoModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/modals/gift/StarGiftPriceDecreaseInfoModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/modals/gift/auction/ActiveGiftAuctionsModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/modals/gift/auction/ActiveGiftAuctionsModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/modals/gift/auction/GiftAuctionAcquiredModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/modals/gift/auction/GiftAuctionAcquiredModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/modals/gift/auction/GiftAuctionBidModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/modals/gift/auction/GiftAuctionBidModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/modals/gift/auction/GiftAuctionChangeRecipientModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/modals/gift/auction/GiftAuctionChangeRecipientModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/modals/gift/auction/GiftAuctionInfoModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/modals/gift/auction/GiftAuctionInfoModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/modals/gift/auction/GiftAuctionModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/modals/gift/auction/GiftAuctionModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/modals/gift/craft/GiftCraftInfoModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/modals/gift/craft/GiftCraftInfoModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/modals/gift/craft/GiftCraftModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/modals/gift/craft/GiftCraftModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/modals/gift/craft/GiftCraftSelectModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/modals/gift/craft/GiftCraftSelectModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/modals/gift/info/GiftInfoModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/modals/gift/info/GiftInfoModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/modals/gift/locked/GiftLockedModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/modals/gift/locked/GiftLockedModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/modals/gift/message/GiftDescriptionRemoveModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/modals/gift/message/GiftDescriptionRemoveModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/modals/gift/offer/GiftOfferAcceptModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/modals/gift/offer/GiftOfferAcceptModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/modals/gift/preview/GiftPreviewModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/modals/gift/preview/GiftPreviewModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/modals/gift/resale/GiftResalePriceComposerModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/modals/gift/resale/GiftResalePriceComposerModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/modals/gift/status/GiftStatusInfoModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/modals/gift/status/GiftStatusInfoModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/modals/gift/transfer/GiftTransferConfirmModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/modals/gift/transfer/GiftTransferConfirmModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/modals/gift/transfer/GiftTransferModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/modals/gift/transfer/GiftTransferModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/modals/gift/upgrade/GiftUpgradeModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/modals/gift/upgrade/GiftUpgradeModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/modals/gift/value/GiftInfoValueModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/modals/gift/value/GiftInfoValueModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/modals/gift/withdraw/GiftWithdrawModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/modals/gift/withdraw/GiftWithdrawModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/modals/giftcode/GiftCodeModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/modals/giftcode/GiftCodeModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/modals/inviteViaLink/InviteViaLinkModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/modals/inviteViaLink/InviteViaLinkModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/modals/leaveGroup/LeaveGroupModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/modals/leaveGroup/LeaveGroupModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/modals/locationAccess/LocationAccessModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/modals/locationAccess/LocationAccessModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/modals/map/MapModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/modals/map/MapModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/modals/oneTimeMedia/OneTimeMediaModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/modals/oneTimeMedia/OneTimeMediaModal.tsx>) | specific_media_overlay_body | source_only_exact_component |  |
| [src/components/modals/paidReaction/PaidReactionModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/modals/paidReaction/PaidReactionModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/modals/passkey/PasskeyModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/modals/passkey/PasskeyModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/modals/poll/PollModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/modals/poll/PollModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/modals/preparedMessage/PreparedMessageModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/modals/preparedMessage/PreparedMessageModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/modals/priceConfirm/PriceConfirmModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/modals/priceConfirm/PriceConfirmModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/modals/profileRating/ProfileRatingModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/modals/profileRating/ProfileRatingModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/modals/prompt/PromptDialog.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/modals/prompt/PromptDialog.tsx>) | reusable_prompt_template | source_only_exact_component |  |
| [src/components/modals/qrCode/QrCodeModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/modals/qrCode/QrCodeModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/modals/quickChatPicker/QuickChatPickerModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/modals/quickChatPicker/QuickChatPickerModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/modals/quickPreview/QuickPreviewModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/modals/quickPreview/QuickPreviewModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/modals/quickPreview/QuickPreviewModalHeader.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/modals/quickPreview/QuickPreviewModalHeader.tsx>) | window_header | source_only_exact_component |  |
| [src/components/modals/rank/EditRankModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/modals/rank/EditRankModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/modals/rank/RankModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/modals/rank/RankModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/modals/reportAd/ReportAdModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/modals/reportAd/ReportAdModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/modals/reportModal/ReportModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/modals/reportModal/ReportModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/modals/sharePreparedMessage/SharePreparedMessageModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/modals/sharePreparedMessage/SharePreparedMessageModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/modals/stars/StarsBalanceModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/modals/stars/StarsBalanceModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/modals/stars/StarsPaymentModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/modals/stars/StarsPaymentModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/modals/stars/chatRefund/ChatRefundModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/modals/stars/chatRefund/ChatRefundModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/modals/stars/gift/StarsGiftModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/modals/stars/gift/StarsGiftModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/modals/stars/subscription/StarsSubscriptionModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/modals/stars/subscription/StarsSubscriptionModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/modals/stars/transaction/StarsTransactionModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/modals/stars/transaction/StarsTransactionModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/modals/storyStealthMode/StealthModeModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/modals/storyStealthMode/StealthModeModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/modals/suggestMessage/SuggestMessageModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/modals/suggestMessage/SuggestMessageModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/modals/suggestedPostApproval/SuggestedPostApprovalModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/modals/suggestedPostApproval/SuggestedPostApprovalModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/modals/suggestedStatus/SuggestedStatusModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/modals/suggestedStatus/SuggestedStatusModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/modals/twoFaCheck/TwoFaCheckModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/modals/twoFaCheck/TwoFaCheckModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/modals/urlAuth/UrlAuthModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/modals/urlAuth/UrlAuthModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/payment/PaymentModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/payment/PaymentModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/payment/ReceiptModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/payment/ReceiptModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/right/management/GuardReplaceBotModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/right/management/GuardReplaceBotModal.tsx>) | specific_modal_body | specific_body_partial | guard-bot-keep-enter, guard-bot-safe-space |
| [src/components/right/management/RemoveGroupUserModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/right/management/RemoveGroupUserModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/story/StoryDeleteConfirmModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/story/StoryDeleteConfirmModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/story/StoryPublisherModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/story/StoryPublisherModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/story/StoryViewModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/story/StoryViewModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/ui/ConfirmDialog.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/ui/ConfirmDialog.tsx>) | shared_confirmation_template | shared_primitive | confirmation-focus-cancel, confirmation-disabled-keyboard, confirmation-destructive-only-neutral-focus, modal-nested-focus-return-and-hidden-disabled, modal-nested-disabled-first-fallback, standard-confirm-confirm-enter, standard-confirm-cancel-enter |
| [src/components/ui/CropModal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/ui/CropModal.tsx>) | specific_modal_body | source_only_exact_component |  |
| [src/components/ui/Modal.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/ui/Modal.tsx>) | shared_modal_primitive | shared_primitive | controls-long-content-and-keyboard, modal-outside-focus-containment, confirmation-focus-cancel, modal-nested-focus-return-and-hidden-disabled, modal-nested-disabled-first-fallback, modal-more-menu-div, modal-more-menu-native, default-button-enter, default-button-space, delete-photo-cancel-enter, guard-bot-keep-enter, calendar-repeat-item-enter, calendar-repeat-escape-child-only, ai-portal-div-focus, ai-portal-native-focus, standard-confirm-confirm-enter, standard-confirm-cancel-enter, delete-message-checkbox-enter, delete-photo-safe-space, guard-bot-safe-space, calendar-repeat-item-space, calendar-repeat-escape-restores-trigger, calendar-time-input-enter-baseline, ai-portal-div-keyboard-enter, ai-portal-div-keyboard-space, ai-portal-native-keyboard-enter, ai-portal-native-keyboard-space, ai-two-modal-owner-geometry, contained-textarea-enter, contained-contenteditable-enter, contained-select-enter, contained-radio-enter, contained-native-link-enter, contained-single-line-input-baseline, unowned-outside-enter-blocked, fullhd-24-modal-lifecycle-cycles |
| [src/components/ui/ModalStarBalanceBar.tsx](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/src/components/ui/ModalStarBalanceBar.tsx>) | window_accessory | source_only_exact_component |  |

## Input bytes and neutral review objects

| Input | Generated at | SHA-256 |
|---|---|---|
| [ui-coverage-manifest.json](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/docs/app-quality-audit-2026-10-02/ui-coverage-manifest.json>) | 2026-10-02T06:40:49.557Z | 7457956bfb6d780c365fb4ff8b5203f56eac3e6a292d6a9c129362d4d61050b6 |
| [ui-scenario-results.json](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/docs/app-quality-audit-2026-10-02/ui-scenario-results.json>) | 2026-10-02T06:05:05.402Z | deb97f5bd92c1083a95f43d461f49af3a890f4f1c9a58d2dd4c3c2090133ce4c |
| [ui-grouped-route-results.json](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/docs/app-quality-audit-2026-10-02/ui-grouped-route-results.json>) | 2026-10-02T06:06:33.783Z | 861b34598bb1724a0353a0a04bb6257b0e04fbc0ff1440ac5e51951b1359b953 |
| [ui-custom-modal-after.json](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/docs/app-quality-audit-2026-10-02/ui-custom-modal-after.json>) | 2026-10-02T06:10:55.427Z | 7a7d3aa9468b20bc22dd179ebe96ca017fb2a7928b38b4eec30bdcdccf8d8d09 |
| [ui-performance-results.json](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/docs/app-quality-audit-2026-10-02/ui-performance-results.json>) | 2026-10-02T06:11:53.746Z | 409c30ecf3786541c05baab636842852bc2a1f25883d4cd90cb9658f2a1c0099 |
| [ui-report.json](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/docs/app-quality-audit-2026-10-02/ui-report.json>) | 2026-10-02T06:40:49.575Z | b4169d803c325c633d6d988628e9f0eb383f83717da13a08625a7a0c9dad5f37 |
| [ui-source-freeze.json](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/docs/app-quality-audit-2026-10-02/ui-source-freeze.json>) | 2026-10-02T06:40:49.574Z | 6595a64af41b2691d5dafd0d41ccb1a39a9becac2be0a7940e7e8e1f552ff304 |
| [ui-keyboard-code-review.json](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/docs/app-quality-audit-2026-10-02/ui-keyboard-code-review.json>) |  | ad3e917490091481a30ab2e9b918a94c8116aed9ce21eed40fafd8b906e3413d |

Four review objects in JSON remain unreviewed: scope boundaries, historical branch resolution, remaining fixtures and child-versus-parent portal evidence. Accepting evidence does not authorize account actions.
