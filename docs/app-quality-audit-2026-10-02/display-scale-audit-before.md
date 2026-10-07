# Проверка масштаба дисплея

58/68 actual-component cases passed; failures 10; pageErrors 0. Источники неизменны: true.

Модель физических 1920×1080: DPR1 с CSS1920×1080 и DPR2 с CSS960×540; две настоящие темы. Это контролируемая headless-проверка responsive layout, а не native Windows DPI или browser text-only zoom.

- delete-chat-dpr1-light: TimeoutError: locator.waitFor: Timeout 5000ms exceeded.
Call log:
[2m  - waiting for locator('dialog[open], .Modal.open:not(dialog) .modal-dialog').last() to be visible[22m

- chat-language-dpr1-light: Error: page.evaluate: TypeError: Cannot read properties of undefined (reading 'byId')
    at AdditionalModals.audit.openChatLanguage (http://127.0.0.1:1268/scripts/relay-ui-additional-modals.fixture.tsx:185:65)
    at eval (eval at evaluate (:303:30), <anonymous>:3:74)
    at UtilityScript.evaluate (<anonymous>:305:16)
    at UtilityScript.<anonymous> (<anonymous>:1:44)
- delete-message-dpr1-light: Error: page.evaluate: TypeError: Cannot read properties of undefined (reading 'byId')
    at AdditionalModals.audit.openDeleteMessage (http://127.0.0.1:1268/scripts/relay-ui-additional-modals.fixture.tsx:192:67)
    at eval (eval at evaluate (:303:30), <anonymous>:4:75)
    at UtilityScript.evaluate (<anonymous>:305:16)
    at UtilityScript.<anonymous> (<anonymous>:1:44)
- delete-chat-dpr1-dark: TimeoutError: locator.waitFor: Timeout 5000ms exceeded.
Call log:
[2m  - waiting for locator('dialog[open], .Modal.open:not(dialog) .modal-dialog').last() to be visible[22m

- chat-language-dpr1-dark: Error: page.evaluate: TypeError: Cannot read properties of undefined (reading 'byId')
    at AdditionalModals.audit.openChatLanguage (http://127.0.0.1:1268/scripts/relay-ui-additional-modals.fixture.tsx:185:65)
    at eval (eval at evaluate (:303:30), <anonymous>:3:74)
    at UtilityScript.evaluate (<anonymous>:305:16)
    at UtilityScript.<anonymous> (<anonymous>:1:44)
- delete-message-dpr1-dark: Error: page.evaluate: TypeError: Cannot read properties of undefined (reading 'byId')
    at AdditionalModals.audit.openDeleteMessage (http://127.0.0.1:1268/scripts/relay-ui-additional-modals.fixture.tsx:192:67)
    at eval (eval at evaluate (:303:30), <anonymous>:4:75)
    at UtilityScript.evaluate (<anonymous>:305:16)
    at UtilityScript.<anonymous> (<anonymous>:1:44)
- contact-edit-dpr2-light: AssertionError [ERR_ASSERTION]: Modal bounds outside controlled viewport
- chat-language-dpr2-light: AssertionError [ERR_ASSERTION]: Modal bounds outside controlled viewport
- contact-edit-dpr2-dark: AssertionError [ERR_ASSERTION]: Modal bounds outside controlled viewport
- chat-language-dpr2-dark: AssertionError [ERR_ASSERTION]: Modal bounds outside controlled viewport
