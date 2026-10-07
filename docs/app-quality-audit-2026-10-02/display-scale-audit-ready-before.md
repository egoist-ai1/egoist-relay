# Проверка масштаба дисплея

64/68 actual-component cases passed; failures 4; pageErrors 0. Источники неизменны: true.

Модель физических 1920×1080: DPR1 с CSS1920×1080 и DPR2 с CSS960×540; две настоящие темы. Это контролируемая headless-проверка responsive layout, а не native Windows DPI или browser text-only zoom.

- ready-before-contact-edit-dpr2-light: AssertionError [ERR_ASSERTION]: Modal bounds outside controlled viewport
- ready-before-chat-language-dpr2-light: AssertionError [ERR_ASSERTION]: Modal bounds outside controlled viewport
- ready-before-contact-edit-dpr2-dark: AssertionError [ERR_ASSERTION]: Modal bounds outside controlled viewport
- ready-before-chat-language-dpr2-dark: AssertionError [ERR_ASSERTION]: Modal bounds outside controlled viewport
