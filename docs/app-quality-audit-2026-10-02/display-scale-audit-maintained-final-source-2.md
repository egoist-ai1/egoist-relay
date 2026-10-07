# Проверка масштаба дисплея

4/8 actual-component cases passed; failures 4; pageErrors 0. Источники неизменны: true.

Модель физических 1920×1080: DPR1 с CSS1920×1080 и DPR2 с CSS960×540; две настоящие темы. Это контролируемая headless-проверка responsive layout, а не native Windows DPI или browser text-only zoom.

- maintained-final-source-2-chat-language-dpr1-light: TimeoutError: locator.waitFor: Timeout 5000ms exceeded.
Call log:
[2m  - waiting for locator('dialog[open], .Modal.open:not(dialog) .modal-dialog').last() to be visible[22m

- maintained-final-source-2-chat-language-dpr1-dark: TimeoutError: locator.waitFor: Timeout 5000ms exceeded.
Call log:
[2m  - waiting for locator('dialog[open], .Modal.open:not(dialog) .modal-dialog').last() to be visible[22m

- maintained-final-source-2-chat-language-dpr2-light: TimeoutError: locator.waitFor: Timeout 5000ms exceeded.
Call log:
[2m  - waiting for locator('dialog[open], .Modal.open:not(dialog) .modal-dialog').last() to be visible[22m

- maintained-final-source-2-chat-language-dpr2-dark: TimeoutError: locator.waitFor: Timeout 5000ms exceeded.
Call log:
[2m  - waiting for locator('dialog[open], .Modal.open:not(dialog) .modal-dialog').last() to be visible[22m

