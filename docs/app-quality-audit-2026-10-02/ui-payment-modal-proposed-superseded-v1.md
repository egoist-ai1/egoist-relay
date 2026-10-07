SUPERSEDED HISTORICAL V1 — НЕ ПРИМЕНЯТЬ. Ошибочный first-match onEnter в provider-error branch. JSON metadata реконструирована, original diff SHA совпадает. Current authoritative draft v2: ui-payment-modal-proposed.diff.

# Relay payment keyboard change proposal

NOT APPLIED. Production source unchanged. Patched components were not executed. Exact diff: ui-payment-modal-proposed-superseded-v1.diff; SHA256 9284e56f8b1bb1a8e8ece2604de89ef6e4ebb8e495e29c97e99a43976ed37500.

## Two-file plan

### src/components/modals/stars/StarsPaymentModal.tsx

Local loading/closed/pending guard; native disabled while loading; synchronous pending latch and markLoading before local dispatch; reset latch on close.

Actual native keyboard during loading duplicates callback; two native synthetic activations in one task also duplicate before RAF.

### src/components/payment/PaymentModal.tsx

Remove own redundant global Enter listener; own Modal onEnter only open ConfirmPassword; local loading/closed guard; ConfirmPassword-only synchronous pending latch reset on existing result/step/error and close lifecycles.

Actual owned input Enter invokes validation0 while footer Enter/Space1; same-task footer synthetic clicks validate2. Preserve literal password, other steps and native Back/Confirm behavior.

## Actual before proof

Latest: ui-payment-modal-before-rapid.json SHA256 b57df1b85c0aa0c845264fec92cf506604762522d83f0253ea1ad99fd357ddc9. {"total":11,"pass":6,"fail":5,"prerequisiteGates":0,"errors":0,"unhandled":0,"externalRequestsSucceeded":0,"realAccountMutations":0}. Earlier8/9case and initial8harnessgate receipts preserved. Stars native loading Enter/Space each callback1→2. Regular owned input Enter0, native footerEnter/Space1. Both real focused footer buttons activate callbacks2 times for two synthetic native click calls in one task beforeRAF. These events are explicitly untrusted synthetic native clicks, not physical interaction or direct handlers.

Static regular global-capture duplicate remains unconfirmed in the checked password input path. The separate same-task footer duplicate is evidenced. No actual charges/server requests/account changes were made.

## Approval gate

Automatic approval review rejected production source modification: payment submission and keyboard behavior require explicit human permission; parent authorization was not accepted by the reviewer. No retry through another writer or indirect execution. Root will present exactly these two changes for human authorization. Draft is concrete review evidence, not a workaround.

## Pending acceptance

- Actual own password input Enter1; loading/repeat subsequent0; same-task validation1.
- Stars initial actual pointer/nativeEnter/nativeSpace1; loading subsequent0; same-task callback1; close0payment/1close; reopen resets latch.
- Back/Cancel Enter/Space0payment, native Confirm once, literal password unchanged.
- Scoped source+ownfixture TS/lint; root final src/scripts/test TSC/full ESLint once after final metadata ready.

Review choices for each exact source object: Yes/Confirm, No, Explain and comment; decision remains unreviewed. Root may render these neutral objects in the existing project review board.
