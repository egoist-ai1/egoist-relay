# Remaining modal audit — isolated batch

127 actual cases: **126 PASS, 1 reproduced layout FAIL, 0 pageErrors/unhandled**. Twelve exact source paths/17 synthetic branches; this is not twelve independent-window certificates. Production sources/config/old harness and receipts stay unchanged. Whole application audit remains active.

85 body geometry cases:84PASS1FAIL. Forty functional control cases:40PASS. Two additional diagnostics/proofs:2PASS. Actual App opens AutoDelete/Birthday/EditRank through ModalContainer and PrivacyNotice through MiddleColumn; other bodies are actual imported components beside real App, not replica JSX.

| Source | Renderer | Body PASS/FAIL | Control PASS |
|---|---|---:|---:|
| `src/components/common/PrivacySettingsNoticeModal.tsx` | Real App MiddleColumn async body via openPrivacySettingsNoticeModal | 10/0 | 4 |
| `src/components/common/ReportAvatarModal.tsx` | Actual imported body / Actual imported body in task-owned Teact root beside real App | 4/1 | 5 |
| `src/components/common/SensitiveContentConfirmModal.tsx` | Actual imported body in task-owned Teact root beside real App | 5/0 | 3 |
| `src/components/common/UnpinAllMessagesModal.tsx` | Actual imported body in task-owned Teact root beside real App | 5/0 | 3 |
| `src/components/left/settings/BlockUserModal.tsx` | Actual imported body in task-owned Teact root beside real App | 10/0 | 2 |
| `src/components/main/BotTrustModal.tsx` | Actual imported body in task-owned Teact root beside real App | 5/0 | 3 |
| `src/components/main/DeleteFolderDialog.tsx` | Actual imported body in task-owned Teact root beside real App | 10/0 | 6 |
| `src/components/modals/autoDeleteTimer/AutoDeleteTimerModal.tsx` | Real App ModalContainer wrapped body via openAutoDeleteTimerModal | 5/0 | 4 |
| `src/components/modals/birthday/BirthdaySetupModal.tsx` | Real App ModalContainer legacy body via openBirthdaySetupModal | 10/0 | 3 |
| `src/components/modals/prompt/PromptDialog.tsx` | Actual imported body in task-owned Teact root beside real App | 5/0 | 3 |
| `src/components/modals/rank/EditRankModal.tsx` | Real App ModalContainer legacy body via openEditRankModal | 10/0 | 4 |
| `src/components/right/management/RemoveGroupUserModal.tsx` | Actual imported body in task-owned Teact root beside real App | 5/0 | 2 |

## Reproduced finding and bounded proof

ReportAvatar source SHA `612450d1a1f0b4a704c3717fb18746681c9224c892a0f76e5f722b66ca7939c2` at root32px rem emulation: dialog y−7.796875/h1095.59375/bottom1087.796875; title y35.203125 lies partially behind80px task app titlebar. Initial footer bottom1108.390625; scrollIntoView yields1086.390625. **Actual mouse wheel maxscroll59 makes both footer controls accessible**; it does not repair outer/header height. Normal FullHD dark/light/narrow16px/RTL16px body checks pass.

Scoped browser CSS injection `.Modal:has(input[name="report-message"]) .modal-dialog{max-height:calc(100vh - 4rem);max-height:calc(100dvh - 4rem)}` plus its `.modal-content{min-height:0}` gives y64/h952/bottom1016. Actual wheel+Cancel Enter has protected action0; reopened pointer confirm calls localmock1. No product CSS or source patch is applied here. Parent owns proposed ordinary-dialog height changes and specialized-window exclusions.

![Scoped CSS proof](ui-remaining-modal-settled-before-and-css-proof-report-avatar-root32-css-proof.png)

## What is measured

Dark/light shared setting and actual html theme classes are read back. Geometry covers1920×1080,640×900, root16→32px, RTL/reduced-motion emulation. Root32 is **not uniform200% text**: sampled Radio labels remain16px/23.2lineheight. No claim of real DPI, all locales, native Tab containment or animation timing. Localized fixture keys, mixed copy, missing synthetic photos/assets remain known fixture limits.

Functional checks use actual activeElement and real Enter/Space/pointer: Cancel protected0, checkbox/radio choices, unchanged/denied/empty disabled0, one callback, folder-shared branch, bot write checkboxfalse, eligible-user filtering, leap-day clamp29, prompt max16, rank edited/disabled. Every account action is intercepted before opening; public network is blocked. No protected actions charge/send/delete/block/trust/update an account.

## Receipts, checks and preservation

Authoritative `ui-remaining-modal-settled-before-and-css-proof.json` SHA `7bb4207b139b6db67a36268784398b37643483733584c98791e4998b4e495053`. Earlier first/second/targeted/scroll/final-before receipts are preserved with their raw failures; no silently promoted historical result. Fixture precondition changes use actual visible labels, real typing and2 RAF Teact settlement.

Whole production+new fixture TSC0. New2JS scoped ESLint0errors0warnings and2syntax checks0. Existing config excludes typed scriptsTSX lint, explicitly a lint gate. Actual release selection remains3307 and excludes all3new `.fixture./.test.` files; all3307frozen inputs and24owned hashes match. Own browser/server/checks are closed; port1251 has no listener.

New files: `scripts/relay-ui-remaining-modals.fixture.tsx`, `scripts/relay-ui-remaining-modals.server.fixture.mjs`, `scripts/relay-ui-remaining-modals.test.mjs`. Exact hashes in `ui-remaining-modal-source-freeze.json`; neutral review objects in `ui-remaining-modal-review-objects.json`. Parent aggregate board provides ✓/✕/? plus comments; absence stays neutral.

Backend acceptance, nativeTab host, full localization/assets, gallery bodies, remaining roster and complete app coverage remain open. No new production changes/build/install are authorized by this batch.
