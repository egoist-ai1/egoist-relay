# Third-party notices and source status

Project license: GPL-3.0-or-later; see LICENSE. Original copyright/license notices remain in source files. Vendored modified Tauri 2.12.0 source is in tauri/vendor/tauri; its provenance and original license files are included. npm/Cargo versions and source integrity are pinned in lockfiles.

Public notices for Node.js, FFmpeg, yt-dlp, whisper.cpp, models and Microsoft runtime are kept under runtime/ as text; their binaries are not Git assets. Removed/internal network runtime is not part of this public source snapshot.

The existing binary source preparation gate records correspondingSourceComplete=false. Missing inputs: exact FFmpeg build/dependency sources and build recipe; delivered dependency source archives for npm/Cargo and standalone yt-dlp. This source publication does not clear that gate or claim complete corresponding source delivery for bundled executables.

The locally verified installer is therefore not uploaded in this source publication. Its version and hashes identify the tested local build only.
