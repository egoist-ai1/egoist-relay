# Egoist Relay 1.4.7 - network audit

Focused fixes are implemented and the existing local checks pass. This report does not certify live network availability or final release packaging.

## Fixed defects

| ID | Priority | Evidence and final change |
| --- | --- | --- |
| network.mediaDeadline | P2 | `social_share.rs:370,425,494,517` creates deadlines before the blocking executor queue. `:521-607` checks cancellation and the same deadline throughout setup and completion. `:562,583,591,598` terminates the owned Job before reap/reader joins. The previous timer began only after bootstrap. |
| network.nodeProbe | P2 | `runtime.rs:7-49` replaces unbounded `command.status()` with a two-second probe, bounded polling and own-process kill/reap on timeout/error; exact duplicate candidate paths are skipped. |

## Checks

- `runtime/node.exe --test scripts/media-proxy.test.mjs scripts/social-media-fetch.test.mjs`: **51 passed, 0 failed, 0 skipped**, exit 0. Scratch fixtures used the current audit task work directory.
- `cargo test --manifest-path tauri/Cargo.toml --lib social_share::tests --offline`: **2 passed, 0 failed, 41 filtered**, exit 0. Both modified Rust modules compiled. Duration: 3m 13s; debug profile, default `tauri/target`.
- No new tests were added. Owned worker setup, stdin failure, poll failure, timeout and normal exit branches were reviewed. Error/timeout branches terminate and reap the owned process; Job termination occurs before reader joins.

## Limitations

- WinHTTP PAC resolution remains synchronous. Its phase timeouts are not a total wall-clock deadline; cancellation is observed after the call returns, not during it.
- The two-second Node deadline bounds polling after process creation. OS process creation, termination and reap calls are not themselves interruptible by this helper.
- Original-file save through the existing inline_media::save_public_media fallback retains its existing worker-local timeout. The direct CDN save path now includes spawn_blocking queue time.
- Existing native tests validate cancellation latching and URL boundaries. They do not simulate stalled runtime probes or delayed PAC calls; those new paths were checked by source review and successful compilation.
- Local fixtures exercise media/proxy paths without real account data. Live authenticated Telegram, X, Instagram and Lagom network behavior was not exercised by this audit.
- Native verification used the debug test profile and default tauri/target. Release build, packaging, signing and publication belong to the parent release task and are not certified by this receipt.

## Source snapshot

Exact SHA-256 values and sanitized check summaries are in [network-audit.json](network-audit.json). Audited read-only files are listed separately from the two edited files.

Authoritative snapshot SHA-256: `836016ec2bf1e22d98ac6783935a38054c1f91b6ce9f56c7e656de712c5a8a2c`.

## Review objects

The parent release companion board should present the three exact IDs and version `1.4.7` from `reviewObjects`, with neutral initial responses. Approval accepts the already implemented change or acknowledges the stated scope limits; it does not certify publication.

| ID | Confirmation action | Initial response |
| --- | --- | --- |
| network.mediaDeadline | Accept the implemented deadline, cancellation and worker cleanup change. | unreviewed |
| network.nodeProbe | Accept the implemented runtime probe change. | unreviewed |
| network.scopeLimitations | Acknowledge the documented limits when assessing release readiness. | unreviewed |

Each object needs Yes / No / Explain and a comment; the companion board also needs a general comment and Apply. User responses are stored separately from this snapshot.
