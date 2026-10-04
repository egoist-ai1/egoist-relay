# Building Egoist Relay 1.4.7

Target: Windows x64, Windows 10 version 1903 or newer. Required tools: Node.js 24, npm 11, Rust 1.97 or newer with MSVC, Windows SDK, NSIS and WebView2. Lockfiles are included. The reviewed host currently uses Rust 1.98.1; this package does not certify a clean independent rebuild on a new machine.

1. Run npm ci in the repository root.
2. Copy .env.example to .env and provide your own TELEGRAM_API_ID and TELEGRAM_API_HASH from https://my.telegram.org. Never include TEST_SESSION in a production build.
3. Provide the exact runtime files in scripts/release-runtime-manifest.json. Their executables and models are excluded from this Git/source ZIP; public helper source and license notices remain included.
4. If you have a separately verified runtime archive, set RELAY_PUBLIC_RUNTIME_URL and RELAY_PUBLIC_RUNTIME_SHA256 and run node scripts/release-fetch-runtime.mjs. No arbitrary runtime download is provided.
5. Run npm run release:preflight, npm run release:test, npm run check, npm test and cargo test --locked --manifest-path tauri/Cargo.toml.
6. Run npm run tauri:build -- --ci --no-sign -- --locked. The updater remains disabled until a reviewed signed update channel exists.

The full UI harness may require exact local media runtime and synthetic TLS fixtures. Public adaptations of existing tests are preserved; skipped or gated checks remain distinct from successful checks.

The Egoist Social MCP supplemental source remains under scripts/integrations/egoist-social-mcp. It uses Node.js 24 and built-in libraries; consult its README and BRIDGE-CONTRACT before connecting your own installed Relay and private local state.

Binary publication remains held by the incomplete exact FFmpeg dependency sources/build recipe and undelivered npm/Cargo/standalone yt-dlp dependency archives. See THIRD-PARTY.md.
