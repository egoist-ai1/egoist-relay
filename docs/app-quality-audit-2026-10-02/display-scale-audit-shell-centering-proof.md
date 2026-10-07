# Проверка масштаба дисплея

60/68 actual-component cases passed; failures 8; pageErrors 0. Источники неизменны: true.

Модель физических 1920×1080: DPR1 с CSS1920×1080 и DPR2 с CSS960×540; две настоящие темы. Это контролируемая headless-проверка responsive layout, а не native Windows DPI или browser text-only zoom.

- shell-centering-proof-contact-dpr1-light: AssertionError [ERR_ASSERTION]: Actual footer scroll and hit-test reachability
- shell-centering-proof-password-dpr1-light: AssertionError [ERR_ASSERTION]: Actual footer scroll and hit-test reachability
- shell-centering-proof-contact-dpr1-dark: AssertionError [ERR_ASSERTION]: Actual footer scroll and hit-test reachability
- shell-centering-proof-password-dpr1-dark: AssertionError [ERR_ASSERTION]: Actual footer scroll and hit-test reachability
- shell-centering-proof-contact-dpr2-light: AssertionError [ERR_ASSERTION]: Actual footer scroll and hit-test reachability
- shell-centering-proof-password-dpr2-light: AssertionError [ERR_ASSERTION]: Actual footer scroll and hit-test reachability
- shell-centering-proof-contact-dpr2-dark: AssertionError [ERR_ASSERTION]: Actual footer scroll and hit-test reachability
- shell-centering-proof-password-dpr2-dark: AssertionError [ERR_ASSERTION]: Actual footer scroll and hit-test reachability
