# Composer / media NEXT audit

32/32 local actual-implementation scenarios PASS; 0 page errors and 0 unhandled rejections. Production TypeScript, actual fixture TypeScript, targeted source ESLint, full SCSS and both new JS syntax checks PASS. Full SCSS has 509 existing warnings and 0 errors.

The actual App boot, file chooser, Composer, full AttachmentModal, MediaEditor, Document/File and reader are used with owned File/Blob inputs and protected mock action callbacks. No actual uploads/downloads/messages/deletes/payments, account/network changes or shared-process stops occur.

| Change | Verified behavior |
|---|---|
| caption-ungrouped | Preserve UI-requested inverted caption for single/multiple ungrouped compressed media, while retaining empty-caption and file-mode guards |
| setting-isolation | Synchronize local grouping and quality by their primitive fields; unrelated caption/compression changes preserve the selected grouping |
| editor-focus-escape | Mount MediaEditor beside parent Modal, release parent focus/keyboard capture while editing, and give editor the existing focus-stack owner |
| editor-caption-inset | Respect Windows desktop caption inset in both fixed editor and landingGhost manual-popover sizing |
| malformed-selection | Handle each initial-file decode failure, revoke its created object URLs, retain valid siblings, notify through existing localization, and preserve prior selection when all files fail |

Original 3000×2000 photo bytes remain intact in file mode. Standard selected image is1280×853 and HQ2560×1706; real owned1280×720 MP4 and1-second WAV decode and retain selected bytes. Real pointer crop, rotate, Undo/Redo, Save/Cancel; keyboard CtrlZ/CtrlShiftZ, Tab, Space/Escape; caption preservation; quality/compression/group independence; append/delete/cancel; reader loading/error/retry; synthetic actual Document progress/cancel are covered.

Source receipts and valid combined diff: composer-media-final-source-shas.json and composer-media-final-candidate.patch. Before and final after receipts: composer-media-before-results.json and composer-media-after-results.json. The before receipt includes harness limitations and Escape cascade, so nine failures are not nine independent product defects.

The initial combined action was rejected by automatic review; child applied only four accepted files. Root separately reviewed and applied the exact initial-selection hook branch. Its other branches are byte unchanged. Rejection and proposal remain historical receipts in composer-hook-review-rejection.json and composer-hook-selection-proposal.*.

Coverage limits:

- Live provider/server acceptance, authenticated media transfer speed and upload throughput remain unverified: all sends/cancel/download callbacks are protected mock recorders.
- Document/File transfer progress uses synthetic props on actual components; there are no real uploads, downloads, messages, deletes or payments.
- Malformed media rejection paths in edited-message replacement, appending files, and quality rebuild remain outside the narrowly reviewed initial-selection hook branch.
- LandingGhost manual-popover geometry uses an explicit hidden synthetic viewer-host sentinel to trigger actual MediaEditor behavior; complete actual MediaViewer-to-editor lifecycle is not proved.
- Viewport tests are headless Windows emulations at 1920×1080, 640×900 and 390×844; physical monitor DPI, touch hardware and GPU performance remain unverified.
- Source remains NEXT working tree; canonical 1.4.4 package/runtime/proofs and installed user Relay remain untouched by this child.

No throughput claim is made. Own browser context/server closed; process and port1253 readback found none. Neutral review objects are in composer-media-review-objects.json for the parent aggregate companion board.
