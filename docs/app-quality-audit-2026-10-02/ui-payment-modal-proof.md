# Relay actual Payment/Stars keyboard callback proof

Candidate1.4.4. This is an isolated synthetic callback proof using actual published components; no real payments, password validation service, account session or external request. Product source unchanged.

| Receipt | Exact result | SHA256 |
|---|---|---|
| before | 8 total; 0 pass; 0 assertion fail; 8 prerequisite gate; 0 page errors | e26bb41312e96e372950ddd35d70c141834bd3b7366f980fbacc6f9a40826f3d |
| before-focused | 8 total; 5 pass; 3 assertion fail; 0 prerequisite gate; 0 page errors | 1ca1a45f64fc14501f929fcd8b4c7958b974e64414912b04a25f8b8fd17907d5 |
| before-focused-loading | 9 total; 6 pass; 3 assertion fail; 0 prerequisite gate; 0 page errors | 3d7177fb8beb4881f1f8138a7a66b24fad60d13f0feb2877dbd3d4561f6245cb |

The first receipt was a harness prerequisite: the outer Modal has zero height while its inner fixed dialog is visible. Later versions wait on inner .modal-dialog and confirm genuine focused targets owned by the specific actual Modal. Original receipts remain available.

## Findings

### Stars loading button re-dispatches through native keyboard

actual_synthetic_callback_defect.
Pointer invokes local captured sendStarPaymentForm once. Loading button remains native-enabled, pointer-events:none. Genuine owned focused Enter and Space each increase count from1 to2.


Source: src/components/modals/stars/StarsPaymentModal.tsx; SHA256 d9b11a6006c4574eeb23684ddbe3663eec0353bc18fc3e1b437c530db0e15b85; lines 147, 160, 161, 201.
Cases: stars-loading-enter, stars-loading-space.
Narrow proposed action: Local handler isLoading guard plus disabled={isLoading} on this Button; shared Button unchanged.

### Regular ConfirmPassword input Enter does not submit

actual_synthetic_callback_functional_defect.
Actual password input is focused and owned; first and second Enter call validation0 times and footer staysenabled. Actual footer Enter and Space each call same captured validation once, demonstrating populated state and action interception.

Payment registers global Enter while its Modal has no onEnter. Current Modal163-180 returns ALLOW_KEYBOARD_EVENT_PROPAGATION when onEnter absent; captureKeyboardListeners91-95 breaks captured chain on that sentinel. This specific initial render path therefore never reaches old Payment listener.
Source: src/components/payment/PaymentModal.tsx; SHA256 f113fd7697f376307510e20ff7364adced019401eddcf2fb8be6db82281155e9; lines 465, 467, 556.
Cases: regular-input-loading-enter, regular-footer-confirm-enter-once, regular-footer-confirm-space-once.
Narrow proposed action: Local Payment Modal onEnter only for ConfirmPassword, remove redundant global Enter registration, guard loading in local submit handler. Native Back/Confirm controls continue through Modal target delegation.

### Regular static duplicate/loading candidate remains unconfirmed

static_risk_not_reproduced_in_checked_render_path.
Actual footer pointer invokes validation1 and becomes disabled. Subsequent actual owned input Enter leaves count1; the initial Enter0 functional defect prevents testing the suspected direct capture bypass here.


Source: src/components/payment/PaymentModal.tsx; SHA256 f113fd7697f376307510e20ff7364adced019401eddcf2fb8be6db82281155e9; lines 381, 396, 401, 465.
Cases: regular-pointer-loading-input-enter.
Narrow proposed action: Do not claim duplicate defect from static source alone.

## Scope and remaining gates

Regular initial input Enter0 is a functional failure; it is not proof of the original suspected duplicate request. Footer Enter/Space each1, Back Enter/Space0 validation with correct step change, loading pointer1→input Enter1, Stars Close Enter0 payment/1close are checked controls. Actual server payment, account, invoice correctness and balances are outside this synthetic proof.

Own browser and localhost server settled; external successful requests0; real account mutations0. No source fix by this agent. Neutral review objects are in the JSON, each with Yes/No/Explain choices and a comment to be rendered by root review board; no response preselected.
