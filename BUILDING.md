# Береста — подготовка сборки из исходников

Windows x64 10 version 1903 or newer; Node.js 24, npm 11; Rust 1.97 MSVC; Windows SDK and NSIS.

The installed application directory is limited to 196 UTF-16 units by bundled notice paths and classic Win32 limits. The installer rejects longer paths before dependency/payload installation; it does not change the system long-path policy.

Run npm ci, provide your own TELEGRAM_API_ID and TELEGRAM_API_HASH in a local .env, and place the exact public runtime files described in scripts/release-runtime-manifest.json into runtime/. Run npm run release:preflight, npm run check, and npm run tauri:build. Build the branded stub from installer/ and run node scripts/build-installer.mjs --final to generate Beresta-Setup.exe. TEST_SESSION and personal profile files must never be included. The application uses Windows network configuration.

Standalone unit tests and fixtures are excluded from this source preparation archive. The full test commands and CI require the original reviewed repository; npm test is not a verification gate for this partial archive. The archive extraction was typechecked with the existing locked dependencies, not independently rebuilt on a clean host.

This archive prepares project source and notices. It does not claim complete corresponding source delivery for every bundled executable. See dependency-sources.json for blocking missing inputs. The original GPL license is in LICENSE. No user accounts, DNS/tunnel enrollment, private keys, build logs or installed profiles are included.
