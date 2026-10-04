# Egoist Relay 1.4.7 — 2026-10-04

Modal state is shared across dialog implementations; nested windows keep the background inactive until the last visible dialog closes. Delayed opening is cancelled on close/unmount, reduced motion follows the platform preference, and dialog layouts are bounded by the viewport when text is enlarged.

Social share actions retain native counters, select an unambiguous post permalink, and use a shared existing-action index. Telegram bridge handoff validation and bounded retry/recovery, plus hidden-start behavior, are included from the current reviewed production source.

Node runtime probing is bounded per candidate; media work uses a shared deadline and cancellation before launching a worker. Synchronous WinHTTP PAC remains governed by Windows phase limits, with deadline validation after it returns.

The frontend build excludes two obsolete copied diagnostic reports totaling 100540813 raw bytes (about 95.9 MiB). This is a measured frontend payload reduction, separate from installer compression and other release changes.

See [VERIFICATION.md](VERIFICATION.md) for measured checks and their outstanding limits. Current real authenticated-service acceptance and independent-device release certification are not claimed. Binary corresponding-source delivery remains incomplete; the publication contains source and notices.
