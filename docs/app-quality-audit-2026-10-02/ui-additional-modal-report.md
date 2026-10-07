# Дополнительный аудит конкретных модальных компонентов

Проверены 14 точных source-path targets в 17 состояниях, включая 68 проверок геометрии: Full HD,640×900, root font32px и RTL/reduced-motion. Это не число независимых окон и не сертификат всех функций приложения.

После четырёх исправлений:123 проверки —117PASS,0FAIL,6gate receipts. Они описывают три нативных Tab-flow gates; три boundary-proof записи подтверждают те же ограничения. Точечный набор16/16PASS; прежний неизменённый primitive31/31PASS при warm повторе. Все pageErrors/unhandled —0.

Четыре исправления:

- `src/components/main/BrowserCloseConfirmationModal.tsx`: Actual Cancel Enter/Space and default focused Cancel call zero protected actions; Confirm Enter/pointer call once; existing ConfirmDialog and checkbox/callbacks reused
- `src/components/common/CountryPickerModal.tsx`: Exact search-input-owned dialog delegates interactive controls via existing keyboard sentinel; Close Enter/Space0, checkbox Enter0/Space selects, filter Enter1, OK Enter1
- `src/components/common/PasswordConfirmModal.tsx`: Native disabled and handler guard block loading or empty value; nonempty loading0, empty0, existing synthetic password with surrounding spaces preserved and submits once; no new minLength or trim
- `src/components/common/PasswordForm.tsx`: Direct existing useLastCallback handles Enter/Space once, prevents default scroll and ignores held-key repeat; pointer and keyboard activate real toggle without simulated click

Before: raw fourth102PASS/8FAIL сохранён; пять failurecases относятся к четырём product defects, три — к native-host Tab. Полный cold primitive31 дал30PASS и message-readiness fixture failure, затем unchanged warm31/31PASS. Предварительные ошибки самого harness сохранены и не объявляются product defects.

Coverage по точным путям:

| Source / ID | Renderer и assertion scope |
|---|---|
| `src/components/main/NewContactModal.tsx` / `ui-additional-component-NewContactModal` | Additional fixture direct actual component import; layouts=8, functional assertions=7. |
| `src/components/modals/reportModal/ReportModal.tsx` / `ui-additional-component-ReportModal` | Additional fixture direct actual component import; layouts=8, functional assertions=4. |
| `src/components/common/CountryPickerModal.tsx` / `ui-additional-component-CountryPickerModal` | Additional fixture direct actual component import; layouts=4, functional assertions=7. |
| `src/components/common/PasswordConfirmModal.tsx` / `ui-additional-component-PasswordConfirmModal` | Additional fixture direct actual component import; layouts=4, functional assertions=9. |
| `src/components/common/RemoveFormattingModal.tsx` / `ui-additional-component-RemoveFormattingModal` | Additional fixture direct actual component import; layouts=4, functional assertions=2. |
| `src/components/main/SafeLinkModal.tsx` / `ui-additional-component-SafeLinkModal` | Additional fixture direct actual component import; layouts=4, functional assertions=3. |
| `src/components/main/BrowserCloseConfirmationModal.tsx` / `ui-additional-component-BrowserCloseConfirmationModal` | Additional fixture direct actual component import; layouts=4, functional assertions=6. |
| `src/components/left/MuteChatModal.tsx` / `ui-additional-component-MuteChatModal` | Additional fixture direct actual component import; layouts=4, functional assertions=4. |
| `src/components/common/PinMessageModal.tsx` / `ui-additional-component-PinMessageModal` | Additional fixture direct actual component import; layouts=4, functional assertions=4. |
| `src/components/common/DeleteChatModal.tsx` / `ui-additional-component-DeleteChatModal` | Additional fixture direct actual component import; layouts=4, functional assertions=3. |
| `src/components/middle/composer/AttachmentModalItem.tsx` / `ui-additional-component-AttachmentModalItem` | Actual preview child inside existing Modal; does not certify AttachmentModal parent/editor/upload; layouts=8, functional assertions=0. |
| `src/components/common/DocumentReaderModal.tsx` / `ui-additional-component-DocumentReaderModal` | Existing Main actual DocumentReaderModal via public openDocumentReader with local text/Markdown Blob; layouts=5, functional assertions=2. |
| `src/components/middle/ChatLanguageModal.tsx` / `ui-additional-component-ChatLanguageModal` | Existing MiddleColumn actual ChatLanguageModal via public synthetic openChatLanguageModal; layouts=4, functional assertions=0. |
| `src/components/common/DeleteMessageModal.tsx` / `ui-additional-component-DeleteMessageModal` | Existing Main actual DeleteMessageModal via source-valid synthetic selected message and public open action; layouts=4, functional assertions=0. |

PasswordForm проверен как настоящий вложенный компонент PasswordConfirm; это не ещё одно окно. AttachmentModalItem — preview child, родительский AttachmentModal/editor/upload остаётся gate. DeleteMessage уже есть в older7, поэтому7+14 нельзя складывать без union.

Text200 — CSS root font-size16→32px, а не device DPI/browser zoom.17 дополнительных measurements содержат computed p/h1-h3/button/label/input/textarea values. BrowserClose: root32px, paragraph16px/line23.2px, buttons16px/line19.2px. Значит несколько явных px-fonts не увеличились: это root-rem/layout emulation, не uniformly200% text. Legacy div.modal-title не попал в selector и остаётся measurement gate. Вся типографика/все locales/themes/physical200%DPI не сертифицируются.

Checks: whole source+new fixture TSC exit0; scoped4product+2JS ESLint 0errors/0warnings; syntax2 exit0. TSX scripts игнорируются существующей ESLint конфигурацией — это отдельный lint gate, не PASS; типы fixture проверены TSC.

Реальные аккаунты, серверные действия, premium/payments, OTP, реальные загрузки файлов и весь editor не выполняются. Все опасные/внешние действия перехватываются локально. Сетевые настройки, DNS, Lagom, приоритеты, пользовательский Relay и установленный пакет не меняются. Старые11source/13harness и receipts сохранены.

Нейтральные reviewObjects находятся в ui-additional-modal-review-objects.json; подтверждение означает принятие указанного source-change/report для parent1.4.4, не выполнение account action.

Авторитетные файлы: ui-additional-modal-report.json, ui-additional-modal-source-freeze.json, ui-additional-modal-product-diff.md; after receipts — after-full, after-targeted-clean, primitive-regression и text200-computed.
