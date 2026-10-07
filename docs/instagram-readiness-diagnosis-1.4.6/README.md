# Instagram MCP proof boundary, Relay 1.4.6

Recorded diagnosis uses frozen native aa29637b67013239bfa735962a1656e55f7ac035f8d61f073607ecd7750028f7 and helper b4f0c13143c7aeffe93508e3166ef78a9757a13a5b369a9a343d51ecd25e368e. Root official measurements resolved the readiness observation: **Instagram becomes ready within the same warmup. Persistent native failure is not supported.** No production source, installed files, network configuration, services, account contents or canonical release receipts were changed.

The offline Node VM executes actual social-read.js and the dispatch expression extracted verbatim from research_social.rs. It makes zero network/bridge calls. Seven characterization scenarios pass: valid proof, absent helper at dispatch, missing invoke, rejected invoke, missing inbox, content-only profile, ambiguous account profile. The native callback/COM and duplicate gate are not executed by this fixture. Green scenarios document the observed failure boundary; they are not proof that production readiness is fixed.

Run the published .mjs with the existing Node executable and EGOIST_RESEARCH_TEST_WORK set to the calling task's own absolute work directory. Output goes only to that work directory. The test pins the exact frozen 1.4.6 helper/native hashes; it is an immutable reproducer for this diagnosis rather than a general future-source verifier. No dependencies or downloads are needed.

## Exact source boundaries

- runtime/research/social-read.js:103-166: Instagram returns concrete inbox/profile/ambiguity reasons after its 15-second DOM proof wait; generic DOM_ACCOUNT_PROOF_PENDING is not its Instagram reply.
- runtime/research/social-read.js:168-177: reply requires __TAURI_INTERNALS__.invoke.
- runtime/research/social-read.js:616-648: start awaits auth reply; failed terminal error reply is swallowed. Missing/rejected invoke can therefore emit no native event while start resolves.
- tauri/src/research_social.rs:1003-1020 and 1025-1070: DOMContentLoaded starts proof, NavigationCompleted can start collection.
- tauri/src/research_social.rs:1240-1255: duplicate DocumentDispatch is suppressed and marked before eval.
- tauri/src/research_social.rs:1259-1287: optional __egoistSocialResearch?.start expression is sent with eval; accepted eval is not a script/transport ACK. In a missing-helper fixture it silently returns undefined. A late helper alone does not restart the missed probe.
- tauri/src/research_social.rs:1564-1658: deadline settlement closes an owned hidden view on the main loop and waits for disappearance; diagnostics should distinguish pending active from closing settlement.
- tauri/src/research_social.rs:1749-1796: every status after last_probe age >15 seconds starts a fresh 20-second warmup and immediately reports pending. Repeated polls 15+ seconds apart can therefore repeatedly observe pending without proving the same probe hung.
- tauri/capabilities/research-social.json: both Instagram origins and the exact hidden label are allowed.
- tauri/src/research_social.rs:1112 and tauri/src/multi_app.rs:1407: research and UI use the same per-service data directory. This proves configuration intent, not current auth/session readiness.
- Egoist Social MCP src/research/bridge-provider.mjs:34-44: native initializing maps to unavailable while retaining normalized pending reason.

## Resolved live observation

Root measured official MCP status from 15:11:39 to 15:12:07 UTC: Instagram pending at 0.492 seconds, ready at 3.461/7.487/12.494 seconds, periodic refresh pending for both X and Instagram at 18.479 seconds, then ready at 24.699/28.499 seconds. Queued/running counts were 0 and daemon PID 32796/source dc80e54e remained unchanged. Root owns the authoritative instagram-status-window-1.4.6.json publication; this subagent received these measurements from root and did not call the live API or read root runtime.

This supports sparse polling at warmup boundaries as the explanation for previously observed pending status. The seven VM cases describe a dispatch/transport blindspot under synthetic missing-helper/transport conditions; they do **not** demonstrate a production fault. No production source change, restart, or diagnostic field implementation is proposed.

## Diagnostic contract for a future verified failure only

Current same-warmup observation is ready, so no further diagnostics are needed for this issue. If a future same-owned-probe failure is verified, possible nonprivate fields are nonprivate native lifecycle data through the official diagnostic boundary: active probe phase/age/deadline remaining, observer ready, view/navigation/document generations, owner-matches boolean, dispatched flag/epoch, DOMContentLoaded/Completed counters, eval accepted/error, helper-present/transport-present booleans or ACK. Do not expose identities, account refs, nonces, page URL, DOM text, cookie/session storage or raw private commands. Existing safe probe-unavailable log reason could discriminate timeout and settled DOM failure; no such instrumentation is implemented or promised here.

Existing native initialized_probe_starts_once_despite_delayed_finished_and_restarts_only_new_document at research_social.rs:2730 checks dispatch deduplication but does not prove that JS started or delivered auth. A future fix needs a combined regression: a missed/rejected initial dispatch must yield an explicit bounded unavailable reason or retry the same owned request/document when the helper becomes available, while retaining origin/nonce/account-epoch/source guards and no duplicate collection.

This is narrow supporting evidence for the root audit, with no independent UI/release approval implied and no changes to the existing review board.
