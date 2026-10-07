# Account research coverage and acceptance gates

Candidate: Relay 1.4.2. This report distinguishes operation registration, source implementation, local verification and actual account/source acceptance. Network/device DNS/proxy/routes, existing profiles and Lagom settings are outside these changes.

## Current evidence

The previous public X OpenAI profile job `607fd162-2bd1-4ebe-98e6-6250ac8760c5` produced partial 0. Readback of its safe partial manifest reports `DOM_SOURCE_UNSUPPORTED`; the previous broker exposed only generic `ADAPTER_FAILED`. Fixed profile extraction completed after its first empty DOM snapshot. The source now waits up to 15 seconds, stops immediately once supported records or a real empty proof appear, and retains explicit deny/rate-limit failures.

Instagram's original account proof searched semantic nav/header containers only. The added path accepts an explicitly marked Profile/Профиль link outside main/article/dialog/feed, requires a first-party inbox link and exactly one valid identity, and rejects source-profile links and ambiguity. Pending inbox/profile/ambiguity diagnostics use a fixed native whitelist. Existing nonce, origin, source, document epoch and account-boundary validation is unchanged.

A slow-reader defect was reproduced using actual task-owned Windows named pipes and the unchanged helper output function. A 500ms paused reader caused a 200-frame synthetic media producer to lose its peer after 15 frames. Await-drain delivery transferred all 200 frames in order, with peak socket writable bytes 65,637. Close and deadline settled in 108ms and 109ms. Frame and 1MiB output bounds remain unchanged. Both validated native reply bodies now run through async spawn_blocking wrappers so pipe backpressure does not block the main UI thread. Native compilation and a real account-backed large-media pilot remain separate acceptance gates.

## Operation matrix

| Provider | Operations | Implemented route | Actual evidence | Remaining acceptance gate |
|---|---|---|---|---|
| telegram | `discover`, `chat_info`, `read`, `search`, `channel_history`, `chat_export` | Relay GramJS account client; selected accessible dialogs/chats/posts, topic and date filters | Release owner completed public info, read 1, search 2, export 3 and cursor resume 3 with 0 duplicate records using prior installed native | New-package async native transport acceptance; selected private/topic/date cases not exercised |
| telegram | `download`, `transcribe` | Observed account-client media; composite local transcription for supported completed audio/video | Release owner completed one observed public MP4, 10,837,502 bytes; transcription not exercised | Release owner media SHA256 readback and new-package async native transport; optional transcript acceptance pending |
| telegram | `join_chat` | Separate exact human-selected membership operation | Registered; not executed | Requires a separately selected join; not part of read-only pilots |
| x | `profile` | Bounded hidden first-party DOM with confirmed account | Prior OpenAI job 607fd162-2bd1-4ebe-98e6-6250ac8760c5 partial 0; safe artifact failure DOM_SOURCE_UNSUPPORTED | Delayed-source fix passed synthetic public DOM fixture; new-package live profile pilot pending |
| x | `discover`, `search`, `read`, `channel_history`, `chat_export`, `article` | Supported first-party search/profile/post/article routes; visible DOM records and checked source/account cursor | Registered; working UI and prior account-ready evidence do not establish source-operation acceptance | Public selected profile/posts/search/export plus cursor-resume pilots pending |
| x | `download`, `transcribe` | Observed allowed CDN media; direct supported MIME/known size; local transcription depends on capability | No completed video download pilot in this iteration; current capability did not advertise transcribe | Actual post media descriptor, MP4/WebM transfer/hash; blob/HLS/DASH/DRM remain explicit unsupported |
| instagram | `profile`, `discover`, `search`, `read`, `channel_history`, `chat_export` | Exact profiles/tags and posts/reels via hidden first-party DOM; no global keyword post search | Working user UI; prior research proof unavailable; current pre-install probe pending | Strict marked profile+inbox proof fixture passes; actual proof and public profile/post/reel/search/export/cursor pilots pending |
| instagram | `download`, `transcribe` | Observed allowed CDN direct media and supported completed local transcription | No completed reel/video download pilot; current capability did not advertise transcribe | Actual authorized DOM/CDN/CORS/size/MIME and media SHA256 pilot; unsupported formats remain explicit |
| x/instagram | `read_thread` | One exact requested first-party DM conversation URL; bounded visible message DOM | Registered; private thread pilot intentionally not run | Needs exact human-selected conversation; no private inbox enumeration or universal access claim |

## Media transfer efficiency

Social downloads now issue one bounded GET. Its exact response URL, successful status, supported MIME and known declared length are validated before `media_open` or body reads; rejected bodies are cancelled. This removes the mandatory HEAD round trip and supports a CDN that permits GET while rejecting HEAD. Ordered chunk, actual-size, CDN, account, cancellation, memory, queue and disk checks remain. Seven task-local cases verified the single GET, exact SHA256, rejected headers/redirects, short bodies and cancellation.

The writer reuses the final directory stat already returned by `assertSafeDirectory` instead of issuing a second `lstat` on each chunk. Every ancestor, junction, realpath and original inode/device check still runs. The social 100-file-only threshold is aligned with the existing writer/Telegram 500-ID task bound; a fixture transfers 500 observed files, blocks the 501st before fetch, and never redownloads a duplicate.

The 1 GiB/file, 2 GiB/job, free-disk reserve and finite deadline are local task budgets, not platform account limits. Larger source collections use checked cursors; larger selected media sets can be split into jobs. An individual file above the current per-file budget requires a supported disk-streaming budget change. The inline resolver can handle canonical selected-post HLS/DASH, but its current 64 MiB whole-buffer response cannot be substituted into this MCP writer for large media. Transcription's 600-second processing window also bounds whole-buffer PCM memory and needs a segment/disk route before expansion. No new quality or duration limit was introduced for the observed direct-media downloader.

## Transfer cancellation ownership

A task-local reproduction using the actual sender, RequestState and PendingState classes showed an already sent, aborted media RPC retaining its promise and 512 KiB buffer until a later transport reply/reconnect. The sender now installs exact-state cleanup only for signaled `upload.GetFile`, `upload.SaveFilePart` and `upload.SaveBigFilePart`. It removes that state from queues, pending and recent/container references, settles its promise and removes listeners. An already sent request remains marked completion-uncertain; an application cancellation cannot recall bytes already received by the server. No shared connection is disconnected and unrelated signaled RPC behavior is unchanged.

Eight isolated fixture groups passed, including all three queued operations, pre-abort, sent-state cleanup, same-container sibling success, late responses, normal Bool completion, original timeout preservation and queue order. ESLint and whitespace checks passed. The release owner also added a cancellation recheck after sender borrowing and requires successful Bool acknowledgement before upload progress. This improves normal Relay transfers; it adds no MCP send or account-mutation interface.

## Bounds and completeness

Page <=100 records, job <=1000 records and 300 seconds. Larger exports resume through checked provider/source/query/account-epoch-bound cursors; idempotency prevents replay of the same normalized request. Each provider remains serial with independent provider queues. DOM history can remain partial due to virtualization, unavailable fields and finite scrolling; a missing source is never confirmed empty.

Source JSONL <=32MiB; media <=1GiB per file and 2GiB per job; preserve 1GiB free disk. The social native adapter and generic writer both permit 500 media IDs per job; the writer separately permits 8 open streams. Text/media fragments survive interruption in partial artifacts. CDN/CORS/GET-header size restrictions, blob/HLS/DASH/DRM and platform challenges remain explicit. No universal access, unlimited throughput or guaranteed complete history is claimed.

## Verification

- Existing broker/provider/client checks: 47 passed, 0 failed after the changes.
- Task-local single-GET media fixtures: 7 passed; 500-ID and duplicate checks passed.
- Actual-class media sender abort fixtures: 8 groups passed; scoped ESLint passed.
- Task-local public DOM fixtures: 5 passed, covering delayed hydration, explicit rate limit, div account navigation, ambiguous identity and source-link exclusion.
- Actual named-pipe fixtures: slow reader, finite close and deadline passed.
- Node syntax and git diff whitespace checks passed; both native files parsed with rustfmt.
- Entire validated native handler bodies were compared to their preimages without changes. The first candidate native Cargo build passed. The latest media-count-only native patch requires rebuild; installed-package activation, daemon source restart and X/Instagram public source/media/cursor pilots remain with the release owner. The worker did not restart the live Relay process or change production installation.

## Review snapshot

The authoritative objects for the common release review board are in [account-research-review.json](account-research-review.json). Confirming an object accepts its stated change/coverage definition; missing responses remain neutral and do not certify live acceptance. The release owner will attach the common companion review board.

Snapshot SHA256: `04e8dbdfe3da9f28c61ef5b9e254de7f1d11126b17b37bceb6effef5910df071`.
