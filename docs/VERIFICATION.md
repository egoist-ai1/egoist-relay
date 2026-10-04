# Verification scope 1.4.7

| Check | Result |
| --- | --- |
| TypeScript | 3/3 configurations passed |
| Vitest | 26 suites, 322 passed, 0 failed |
| Native Rust | 43 passed, 0 failed |
| Focused UI | 7/7 passed |
| UI edges | 7/7 passed |
| Social enhancer | 7/7 passed |
| Full UI matrix | 64 cases: 63 passed, 0 failed, 1 gated; ActiveWebsites requires authenticated service state |
| Release policy | 17 passed |
| ESLint | 0 errors, 1 existing warning |
| Stylelint | 0 errors, 509 warnings |
| Performance scenarios | 3/3 passed: 48 service switches, 24 modal cycles, zero open modals remaining; shared headless host, no frame-rate claim |
| Frontend build | Passed: 98948717 bytes / 11677 files; no source maps or obsolete diagnostic reports |
| Production preflight | 1.4.7, 40 runtime files verified, embedded UI, updater disabled |
| Optimized native build | Final Vite/native/NSIS build, package extraction and isolated packaging smoke passed |
| Isolated packaging smoke | Install exit 0; hidden launch alive for 10 seconds with zero user-facing windows; packed EXE and 40 resources verified; stop and uninstall exit 0 |
| Windows candidate | Version 1.4.7, unsigned local candidate; no independent-host or authenticated live-service acceptance |

The table records the final reported source validation status.

Current authenticated live-service acceptance was not performed. Synthetic UI, finite local checks and a local build do not certify every account, media source, server branch or network throughput. Immediate cancellation inside synchronous WinHTTP PAC is not guaranteed; the shared operation deadline is checked after it returns.

The isolated smoke preserved observed production EXE, registry, protocol and process identities, and left no owned residual process or outside test-profile directory. Profile contents were not read. Production profile metadata differed; a separate five-second interval without the owned test process still observed two metadata changes. Whole-profile byte preservation is therefore not claimed.

The Windows installer remains held by incomplete corresponding-source delivery for bundled third-party executables. No installer asset is included in this source publication.

Public adapted tests are preserved from the reviewed 1.4.6 branch. TLS-dependent tests require local synthetic fixtures and are skipped without them. The prior release is recorded in [verification-1.4.6.json](verification-1.4.6.json); its historical installer/live-service checks do not serve as current 1.4.7 acceptance.

Machine-readable status: [verification-1.4.7.json](verification-1.4.7.json).
