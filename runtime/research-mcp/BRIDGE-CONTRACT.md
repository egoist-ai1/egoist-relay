# Relay-owned account bridge, protocol 1

Implementation contract for the new `egoist_social` MCP. Source implementations and isolated checks exist; full application build and authenticated acceptance are separate evidence. Relay 1.3.3 does not supply this bridge.

## Ownership

The external daemon owns jobs, output paths and export/media writers. Relay owns its existing GramJS worker/client and social browser environments. Account credentials never appear in an MCP input, output, log or bridge metadata. No new user login or duplicate Telegram key is part of this route.

Native files are owned by the native bridge implementer: `tauri/src/research_bridge.rs`, `tauri/src/lib.rs`, `runtime/research/bridge-server.mjs`, `runtime/research/ensure-private-state.ps1`, and the research resource entries in `tauri/tauri.conf.json`. Telegram implementer owns `src/util/relayResearchBridge.ts`, `src/index.tsx`, `src/api/gramjs/methods/research.ts`, method-table registration, and narrowly necessary API cancellation types. Social implementer owns `tauri/src/research_social.rs`, its service data-directory accessor in `multi_app.rs`, and `runtime/research/social-read.js`. Root owns the external MCP project/configuration. Coordinate shared imports by message; never concurrently edit another owner's file.

## External transport

Relay starts its own bundled Node helper with hidden stdio, not a desktop browser controller. On Windows the helper serves an authenticated local named pipe. The name is `\\.\pipe\EgoistRelayAccountBridge-<first24 SHA256 lowercase canonical stateRoot>`; stateRoot is `%USERPROFILE%\.egoist-research`. Reject links/reparse/hardlinks and unexpected ACL. Private marker owner is the current user, allowed ACL identities current user and SYSTEM. Modify only owned DACL sections when normalizing; do not require SeSecurityPrivilege by writing an audit ACL.

Helper publishes `relay-bridge.json` with `{schemaVersion:1,protocolVersion:1,runtimeId,appPid,appStartedAt,executablePath,helperPid,pipePath,isolatedTest}`. Secret is separate `relay-bridge-token` (32 random bytes as 64 hex). External client validates actual PID/start/executable and helper ancestry before handshake and rechecks runtime/account epoch at settlement. Files are bounded, atomically published and removed only if still this runtime's own. Neither data-directory paths nor account identity secrets are exposed by MCP status.

The pipe name appends `-<runtimeId UUID>` to its state-root-derived base. `appStartedAt` is numeric Unix milliseconds from the actual app process creation time; external CIM verification permits at most 2 ms difference. The bundled Node helper must be a direct child of that process. Before passing a request, the client requires a server proof: hello `{id,challenge,method:'hello'}` uses a random UUID and a fresh 64-hex challenge. The server returns `{id,event:{kind:'hello',runtimeId,appPid,helperPid,challenge,nonce,proof}}`. `proof` is HMAC-SHA256 of `id + '\n' + challenge + '\n' + nonce + '\n' + runtimeId + '\n' + appPid + '\n' + helperPid`. The HMAC key is the ASCII 64-hex token string, never sent over the pipe. The client then sends `{id,challenge,method,params,mac}` where `mac` signs `id + '\n' + challenge + '\n' + nonce + '\n' + runtimeId + '\n' + method + '\n' + JSON.stringify(params)`. Each hello also creates a fresh server nonce of 32 random bytes as 64 hex, bound into both signatures. Each connection consumes its single challenge/request identity once; replaying a captured request on another connection fails because its server nonce differs.

UTF-8 newline JSON frames, maximum 262144 bytes. Requests accept only `status`, `capabilities`, `run`, `cancel`; `run` parameters `{provider,operation,input,jobId,expectedAccount}`; cancellation parameters contain only `{jobId}`. The broker privately pins `{accountRef,accountEpoch}` from trusted status at submission, compares it before execution, and native/frontend validate it before any source operation. This field is never an MCP input; callers cannot choose an account identity. No external path, script, headers, native/GramJS method or arbitrary browser target. One provider transport job at a time, at most 3 provider jobs and at most 16 connected peers. Closing a request cancels only its owned research job; its provider remains busy until actual owner terminal settlement or runtime teardown, including after the job deadline. Read-only bounded readiness probes wait for settlement; they never repeat the source operation. Closing MCP stdio does not close the daemon or Relay.

The external daemon settles only explicit `dom_account_proof_pending` / `app_initializing` transients before pinning the trusted account; other settled authorization/challenge/rate/transport failures are returned before a new job is accepted. Submission wait, including its serialized tail, is bounded to 20 seconds (daemon socket 30 seconds; default client 35 seconds). An authenticated submitting peer disconnect aborts only pre-commit waiting, not accepted work. The atomic job save is the irreversible commit handoff: disconnect or failure during that save can leave unknown durable completion; read the exact idempotency/job state instead of blindly resubmitting. No neighboring outputs are deleted; an aborted pre-save allocation may leave its owned empty output directory. Each FIFO dequeue starts one absolute job deadline shared by current proof/busy settlement, source execution, checkpoints and completion persistence; queue residence precedes that execution budget. A settled ready account must exactly match the pinned accountRef/epoch before source dispatch; no pending identity or stale ready snapshot is accepted.

External stream `{id,event}`. Events are:

- `{kind:'status',providers:[{provider,state,reason,operations,accountRef?,accountEpoch?}],runtimeId}`. State `ready`, `initializing`, `auth_required`, `challenge_required`, `rate_limited`, `unavailable` or `unsupported`. Opaque accountRef and epoch come from the trusted app owner, not an ambient active window.
- A run first emits trusted `status` with the runtime ID and selected ready account, then `{kind:'scope',accountRef,accountEpoch}` before records, media or done. Scope changes fail `STALE_ACCOUNT`. `{kind:'records',records:[...],coverage,partial?,nextCursor?,accountRef?,accountEpoch?}`. Coverage is an object with bounded scope, accessibility, extraction/completeness and observed gaps; the artifact preserves the rich object while job metadata has a compact scope. Frames <= 64 KiB where practical; preserve all observed fields in schema-versioned records, distinguish missing fields, preserve source links and per-field evidence. Long text uses sequential `{id,type?,textPart:{index,text,final}}` records, at most 4 MiB per completed text. The writer persists fragments and counts the reassembled record once.
- `{kind:'media_open',mediaId,fileName,mimeType,declaredBytes,sourceUrl}`; `{kind:'media_chunk',mediaId,sequence,base64}` (decoded <=49152 bytes); `{kind:'media_close',mediaId,totalBytes}`. App performs browser-managed requests or existing account client reads. External writer validates bytes/hash/disk reserve and never accepts arbitrary filenames/URLs from a page as a write target.
- `{kind:'done',outcome,count,nextCursor?,coverage,partial?,reason?}` or `{kind:'error',code,reason,retryAfterMs?,completionUncertain?}`. Errors contain stable bounded codes, no raw exception/page text or credentials. Dispatched cancellation/deadline can return `completionUncertain:true`; no automatic retry follows. `empty` requires an actual accessible source read.

## Helper/native/frontend transport

Native starts helper using existing `runtime::find_node_binary` and `hide_command_window`; startup init on stdin `{type:'init',protocolVersion:1,runtimeId,appPid,appStartedAt,executablePath,stateRoot,isolatedTest}`. Helper stdout only request JSON `{type:'request',requestId,nonce,method,provider?,operation?,input?,jobId?,deadlineMs}` or cancellation `{type:'cancel',requestId,nonce}`. Native replies on helper stdin `{type:'event',requestId,nonce,event}`. Stdout never carries app logs.

Native emits addressed event `relay-research-request` to trusted `main` for Telegram/status; cancellation `relay-research-cancel`. Frontend replies through `relay_research_reply` with `{requestId,nonce,event}`. Native verifies trusted local main label/origin, pending request, nonce, account epoch, deadline, finite frame and ordered media sequence. Remote social pages cannot call this main reply command. Social native module supplies its own reply command, verifying an owned research WebView label and pending job nonce.

Rust API exposed by native bridge: `start(app: &AppHandle)`, `shutdown()`, Tauri command `relay_research_reply(webview: Webview, request_id: String, nonce: String, event: serde_json::Value) -> Result<(),String>`, and `pub(crate) fn publish(request_id:&str,nonce:&str,event:serde_json::Value)->Result<(),String>` for the social module. Native dispatches social requests to `research_social::dispatch(app,request_id,nonce,provider,operation,input,job_id,deadline_ms)` and cancels with `research_social::cancel(request_id,nonce)`; coordinate exact Rust signature before compiling. Status requests aggregate trusted Telegram/main status and social module status, returning no account contents.

Frontend entrypoint `startRelayResearchBridge()` imported by `src/index.tsx` only in Tauri. It registers fixed request/cancel handlers once, uses existing account routing and `callApi('relayResearch', typedArgs)`, and replies with events through typed native invoke. It does not use generic external `{method,args}`. Session switch/logout/worker restart invalidates account epoch and all affected research requests. `relayResearch` stays in the same existing worker/client. Cancellation belongs to a new per-job scope and never aborts UI/chat/call requests.

## Operation matrix

Telegram operations: `discover`, `chat_info`, `read`, `search`, `channel_history`, `chat_export`, `download`, `join_chat`. Discover public groups/channels with server-supported account search; list available dialogs without assuming all groups are indexed. Chat/post/history/export support exact accessible handles, message links, private peer IDs and topic/thread IDs. `join_chat` is a distinct mutation for a human-selected exact public handle or invite; no automatic join during discovery, no payments. Read back membership after uncertain join before retry.

X: `discover`, `profile`, `read`, `search`, `channel_history`, `chat_export`, `download`, `article`, `read_thread` (exact requested DM thread only). Instagram: `discover`, `profile`, `read`, `search` only supported profile/tag mode, `channel_history`, `chat_export`, `download`, `read_thread` (exact requested thread). Unsupported platform modes return explicit `UNSUPPORTED`, with supported alternatives; do not fake universal keyword search.

Social research uses dedicated hidden views owned by Relay and its existing service browser environment/session. Never navigate the user's visible social view. Validate actual shared authorization without copying cookies/profile; if environment sharing is incompatible, report the precise state. Route only allowlisted first-party HTTPS paths; browser-managed credentials stay inside the view. Do not bypass CAPTCHA/challenge, inaccessible/private material, anti-abuse or platform rate limits. Opening a requested conversation may change its normal read status; general public research must not enumerate private threads.

## Limits and acceptance

The external daemon uses its own challenge/proof/MAC handshake before accepting local job requests; its token is never sent to an unproved predictable pipe. Verified installs may activate an absent app owner with the fixed `--research-headless` flag. The install proof binds version >=1.4, protocol 1 and actual executable SHA256. Current ordinary owners are never restarted/activated by this route; native single-instance exclusion and UI-only focus guards also apply to startup races. Manual normal app opening can reveal a headless owner. Closing MCP stdio has no app-lifetime effect.

`transcribe` is an external composite operation: native account bridge collects `download`, then a fixed local FFmpeg/Whisper adapter processes completed writer-owned media. No account keys or arbitrary external file/runtime paths reach this adapter. Up to20 selected audio/video per job, at most600 seconds of each media within the remaining300-second job deadline; unprocessed media and approximate timestamp/accuracy limitations remain explicit. Source post count and transcript media/segment counts remain separate.

Page <=100 records, job <=1000 records, deadline <=300 seconds; large exports continue with checked provider/source/query/account-epoch-bound cursors. 64 queued/running jobs/provider. Source JSONL/Markdown/HTML exports and media manifests carry schemaVersion, source, extraction time, coverage/completeness, observed fields and unresolved gaps. Limits: 32 MiB source JSONL, 1 GiB/media, 2 GiB/job, 1 GiB disk reserve, at most 8 concurrently open media streams and 500 media IDs/job. Completed media has an exclusive final filename and verified SHA256; incomplete `.part` files and text fragments remain listed in a partial manifest after cancellation, EOF or provider failure. HTML exports escape source content and disallow scripts/network requests. Unsupported HLS/blob/DRM remains explicit until supported downloader is verified. No universal throughput promise.

Readiness requires: source contracts and failure fixtures; built native/renderer app; isolated actual helper/MCP transport; then actual read/search/cursor/media through existing authorized accounts. Verify no repeated login, no main-session duplication, foreground/cursor/clipboard and visible-navigation invariance, per-provider parallelism, cancellation isolation, stale runtime/account rejection, membership semantics and partial/recovery. Current running ordinary Relay is never force-closed. A newly built bridge activates on a later normal launch; old compiled binaries cannot hot-load new native commands.

## Orchestrator consumer (additive; protocol 1 is unchanged)

Since daemon 1.1.0 the external daemon also drives this bridge as the step source of its orchestration core (`docs/ORCHESTRATION.md`). No request, event, field or limit above changed. What the daemon relies on:

- One `run` is one slice: `channel_history` (Telegram, X, Instagram), `chat_info` (Telegram) or `profile` (X, Instagram) with `limit` <= 200, `pageSize` <= 100, optional `cursor`, `after`/`before`, `topicId`. `records` events carry at most 100 records; `done.count` must equal the accepted unique records; `nextCursor` stays bound to source and account epoch.
- `error` with `RATE_LIMITED` (`seconds`, `waitKind`, `retryAfterMs`) and `done.floodWait` are the only sources of waiting. The daemon never repeats a rate-limited step earlier than the stated delay (it waits at least 1.1 times as long) and applies the pause to the whole account.
- Other stable `error` codes the orchestration core interprets (any code matching `[A-Z_]{1,64}` passes through unchanged): `PLATFORM_ERROR` (a platform-side failure of one step) is retried with backoff 5 s up to 5 min and the source fails after 6 attempts; `ACCOUNT_RESTRICTED` (also `PEER_FLOOD`, `USER_DEACTIVATED`, `SESSION_REVOKED`) is a restriction of the account: the daemon does not retry, opens the account breaker until the owner decides, puts jobs into `waiting`/`awaiting_owner` and writes `awaiting_owner` to the audit log; a point read (`lookup`) answers `ACCOUNT_RESTRICTED` (not retryable) and opens the same breaker. Any other unknown code is a transient failure with the same backoff. Legacy broker jobs (`social_submit`) report both as `ADAPTER_FAILED`.
- The account checks above are unchanged (`status` -> `scope` -> records -> `done`). On `STALE_ACCOUNT`, `CURSOR_SOURCE_MISMATCH`, `INVALID_CURSOR` or `CURSOR_ANCHOR_NOT_FOUND` the daemon re-reads status, drops the cursor and re-reads the source; duplicates are rejected by its store.
- Legacy broker jobs and orchestrator steps share one in-daemon gate per provider whose capacity is the number of runs Relay advertises (`maxConcurrent`, capped by the owner policy `limits.telegramParallel`, default 2), so Relay's `PROVIDER_BUSY` is not hit in normal work; `PROVIDER_BUSY` is treated as transient and a busy status is never read as a bridge outage.
- The client caches the Relay process identity check (PID, start time, helper PID, runtime ID, executable) for 45 seconds and the ready provider status for 2 seconds; the HMAC handshake still runs on every connection. Any identity or transport failure drops the cache.
- Without the `peer_cache` feature the daemon counts only the first step of a source against the `resolve` budget; with it, pages cost no resolve budget at all.
- Stage 2 fields (`offsetDate`, `minId`, `partialOnFlood`, `mediaSink`, `mediaKey`, `resumeOffset`) and the operations `probe`, `comments`, `topics`, `similar_channels`, `invite_preview` are sent only after the status advertises the matching feature. The daemon uses `minId` for `refresh`, `probe` for plan estimates, `partialOnFlood` for every Telegram history step, and the media fields for single-file `download` jobs. `comments`, `topics`, `similar_channels` and `invite_preview` have no orchestrator stage yet.

## Stage 2 additive extensions (protocol 1 unchanged, Telegram only)

Every item below is optional. A Relay without it ignores nothing silently: it rejects unknown input fields with `INVALID_INPUT`, so a daemon sends a new field only after the provider status advertises the matching feature. A daemon without it keeps the stage 1 behaviour byte for byte. The requirement list is the contract the Relay worker (`src/api/gramjs/methods/research.ts`), Rust (`tauri/src/research_bridge.rs`) and the helper (`runtime/research/bridge-server.mjs`) implement.

### Feature advertisement

The Telegram entry of the `status` event may carry two more fields (Rust keeps them, after validation):

- `maxConcurrent`: integer 1..3, the number of simultaneous `run` requests this provider accepts. Absent = 1.
- `features`: array of at most 16 identifiers `[a-z0-9_]{1,32}`. Defined: `offset_date`, `min_id`, `probe`, `flood_wait`, `peer_cache`, `media_resume`, `media_spool`, `comments`, `topics`, `similar_channels`, `invite_preview`.

While `pending runs < maxConcurrent` the provider is reported by its real state; `PROVIDER_BUSY` (state `unavailable`) is reported only when all slots are taken. The daemon must never treat a busy status as an outage of the bridge.

### History inputs

- `offsetDate` (integer, Unix seconds >= 1, feature `offset_date`): the first page starts with messages older than this date instead of the newest. It is used only when no `cursor` is passed; a cursor always wins. When `before` is set, no `cursor` and no `offsetDate` are passed, the worker derives `offsetDate = before + 1` on its own, so a deep date range is reached without scanning newer messages.
- `minId` (integer >= 1, feature `min_id`): only messages with an identifier greater than `minId` are returned (refresh mode). It applies to `channel_history`, `chat_export`, `search` with `channel`, and `comments`. A result shorter than the page ends the walk exactly as for an ordinary history end.
- Both fields are part of the cursor scope hash only when present, so every cursor issued before stage 2 stays valid.
- The artificial per-job scan limit of 1000 inspected messages is gone. A job ends by `limit`, by the end of history, by `after`, by `deadlineMs`, or by a backstop of 20000 inspected messages (`done.reason = SCAN_LIMIT`, `partial`, with `nextCursor`).
- `partialOnFlood` (boolean, feature `flood_wait`): if a `FLOOD_WAIT` comes after at least one page of this run was delivered, the run ends with `done {outcome:'partial', partial:true, reason:'FLOOD_WAIT', nextCursor, floodWait:{seconds, waitKind}}` instead of an `error`, so the delivered page is not thrown away. Without the flag, or with no delivered record, the run ends with the error below.

### Rate-limit error (first class)

An `error` event for a platform or Relay-side wait keeps `code: 'RATE_LIMITED'` (older daemons depend on it) and adds:

- `seconds`: integer 0..86400, the exact wait the platform demanded.
- `waitKind`: `FLOOD_WAIT`, `PREMIUM_FLOOD_WAIT`, `SLOWMODE_WAIT`, `RESOLVE_BUDGET`, `REQUEST_BUDGET` or `EMERGENCY_CAP` (the last three are Relay's own safety nets, not Telegram's).
- `retryAfterMs`: `seconds * 1000` (unchanged field). The worker never sleeps on a research request: GramJS throws the flood error immediately (`TelegramClient.invoke` and `downloadFile` rethrow research requests); the wait is the daemon's decision. Rust adds `EMERGENCY_CAP` when a provider receives more than 90 `run` starts in a sliding minute.
- The daemon waits at least `seconds` (the stage 1 governor waits 1.1 times as long). `seconds` takes precedence over `retryAfterMs`.

### New operations (Telegram)

`operation_allowed` for `telegram` additionally accepts the names below; `status.operations` lists those the worker implements.

| Operation | Input | Result records |
|---|---|---|
| `probe` | `channel` | one `telegram.probe` record, `id = probe:<peerId>`: `counts` (`messages`, `participants`, `online`, `admins`, `kicked`, `banned`, `photo`, `video`, `document`; a count that Telegram did not return is absent, never 0), `inexact` (names of counts Telegram marks approximate), `newest {messageId, date}`, `isForum`, `hasComments`. Reads no messages. Costs: resolve (cached) + `GetFullChannel` + `GetHistory(limit=1)` + three `messages.Search(limit=1)` for the media counts (the layer has no counter request). If the media counts fail with a non-wait error the record is still delivered and `done` is `partial` with `reason: COUNTERS_UNAVAILABLE`. |
| `comments` | `url` (a post link), `limit`, `pageSize`, `cursor`, `minId` | `telegram.message` records of the discussion group, each with `commentOn {peerId, messageId}` |
| `topics` | `channel` (a forum), `limit`, `pageSize`, `cursor`, `query` | `telegram.topic` records: `id = <peerId>:topic:<topicId>`, title, icon, top message, flags |
| `similar_channels` | `channel` | `telegram.chat` records (recommendations the account is allowed to see) |
| `invite_preview` | `channel` or `url` holding an invite link | one `telegram.invite_preview` record; never joins, never imports the invite |

`probe` is a resolve-class operation for budgeting. Comment, topic, similar-channel and invite requests are `history`/`resolve` class as before.

### Peer cache and Relay-side budgets

The worker keeps an in-memory cache of resolved peers (username and numeric id, up to 5000 entries, 6 hours, dropped when the account epoch changes) and counts real name resolutions (`contacts.ResolveUsername`) in a sliding window: at most 12 per minute and 500 per day, over that the run fails with `RATE_LIMITED`, `waitKind: 'RESOLVE_BUDGET'`, `seconds`. Cached peers cost nothing, so the daemon counts a source against its `resolve` budget only when the status advertises no `peer_cache`. The worker also caps real MTProto requests of research jobs (media part fetches excluded) at 240 per sliding minute (`waitKind: 'REQUEST_BUDGET'`). Nothing is persisted: a restart of Relay empties the cache and the counters.

### Parallel steps

When `maxConcurrent` is 2 or 3 the daemon may keep that many `run` requests in flight for the same provider; every `run` still has its own connection, `jobId` and `expectedAccount`. Each `jobId` still belongs to exactly one run. `PROVIDER_BUSY` stays a transient answer.

### Media: resume and direct file transfer

Stage 1 transfers media as `media_chunk` events with base64 through the helper pipe. Two optional paths exist on top of it.

Resume (feature `media_resume`): a `download` run with exactly one URL (or `read` with `includeMedia`) accepts `resumeOffset` (integer, a multiple of 1048576, below the declared size). The worker starts the file at that offset; `media_open` then carries `resumeFrom` (equal to `resumeOffset`) and keeps `declaredBytes` = the full file size, `media_chunk.sequence` restarts at 0, `media_close.totalBytes` is the full size. The daemon must hold the first `resumeFrom` bytes of that file already. The offset is always aligned down to 1 MiB by the daemon.

Spool (feature `media_spool`): the input carries `mediaSink: 'spool'`, `mediaKey` (32 lowercase hex characters chosen by the daemon, stable for one source URL) and optionally `resumeOffset`. The file bytes never enter JSON, base64, the helper pipe or the daemon socket:

1. The worker sends `media_open` as usual plus `sink: 'spool'`, `fingerprint` (16 hex characters identifying the exact remote file) and `resumeFrom`.
2. Each chunk is delivered to Rust as a raw binary Tauri command (`relay_research_media_chunk`, headers `x-request-id`, `x-nonce`, `x-media-id`, `x-sequence`; body = bytes, at most 4 MiB). No `media_chunk` event exists in this mode.
3. Rust appends to `<stateRoot>\spool\<mediaKey>.<fingerprint>.part` (stateRoot = `%USERPROFILE%\.egoist-research`; the name is built by Rust from validated hex only), refuses a write if the free disk space is below `declaredBytes + 1 GiB`, hashes the bytes with SHA-256 while writing, and for `resumeFrom > 0` requires the same `.part` to exist with at least `resumeFrom` bytes, truncates it to `resumeFrom` and hashes that prefix again. Otherwise it fails with `RESUME_MISMATCH` (the daemon deletes the spool files of that key and restarts from 0).
4. `media_close` leaves Rust as `{kind:'media_close', mediaId, totalBytes, sink:'spool', spool:{name, bytes, sha256}}` after `sync_all` and the rename `.part` -> `.done`; `name` is `<mediaKey>.<fingerprint>.done`.
5. The daemon opens `<stateRoot>\spool\<name>` itself (plain file, one link, no reparse point, size equal to `bytes`), computes SHA-256 and compares it with `spool.sha256`, then moves the file into the job directory (rename on one volume, copy + `fsync` + delete otherwise) and records the verified hash in `media-manifest.json`. A mismatch is `SPOOL_HASH_MISMATCH`; the spool file stays for inspection.
6. Spool files older than 14 days are removed by Rust when the next spooled download opens.

Limits are unchanged (1 GiB per file, 2 GiB per job, 8 open streams, 500 media IDs, 1 GiB disk reserve). The path is chosen by Relay inside its fixed spool directory; neither the page nor the daemon can pick a write target for Rust, so no file-path field appears in any input.
