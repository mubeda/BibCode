# Uploads and E2EE File Transfers Implementation Plan

> **For agentic workers:** Codex executes one task at a time under the lane manager, using `superpowers:executing-plans`. Steps use checkbox (`- [ ]`) syntax. Every task ends at the READY hand-off described below. The controller owns one commit per task; the implementer never stages or commits.

**Goal:** (C) Every allowed attachment set (8 × 10 MiB) reaches the server over any link that can hold a session, in acknowledged chunks that resume across reconnects, with progress and Cancel on the pending message. (B) On a pinned (E2EE) profile no file content, asset byte, token or workspace path leaves the Noise channel: Files downloads and uploads and image previews use in-channel RPC; HTML/PDF previews are disabled with a reason in phase 1; old servers are refused with Update copy.

**Architecture:** Two phases in dependency order.

- **Phase C, Tasks 1–5:** shared upload engine and chat target; transactional attachment binding and capability; upstream liveness harness; reconnecting client stager; pending-message progress and Cancel. Complete C end to end before B.
- **Phase B, Tasks 6–13:** workspace upload target and commit; download stream; asset stream and capability; route selection and transfer operations; asset cache; desktop disk sink; Files UI; image and preview routing. Task 11 has a disjoint implementation file set from Tasks 6–10 and can be assigned while a server task awaits review, only when the lane manager schedules it. Its live UI check still waits for Task 12.

**Tech Stack:** Rust, Axum, Tokio, SHA-256/base64, Tauri 2 raw IPC; TypeScript, Effect 4 beta Schema/RPC/Atom, `@effect/vitest`, `@noble/hashes/sha2.js`; React 19, Vite+; Playwright and the isolated Xvfb desktop for live validation. Keep the installed dependencies; no production Node runtime or new crypto protocol.

**Specs:** [Design C: upload liveness](../specs/2026-09-26-upload-liveness-design.md) and [Design B: E2EE file transfers](../specs/2026-09-26-e2ee-file-transfers-design.md), both approved 2026-09-26. Defaults to every open question apply. The lane manager's approved 2026-09-27 brief settles R1–R22 below; no further design approval is needed. Read both records before executing a phase.

**Evidence baseline:** `a3596ed13df7e4f2665fc9a5fb1346c119ef249e`, branch `lane/uploads`. Source anchors below were checked against this worktree. CodeGraph sync exited 1 during parsing, so the graph is unusable for this plan; verification used the four supplied maps, `rg`, source, manifests and existing tests. New paths and symbols are explicitly labelled proposed; they are not claims about existing code.

## Global Constraints

Every task includes these requirements. The following quotes the approved brief's design-constraint ledger, retaining the designs' values and copy.

> - C: inline up to 256 KiB encoded; 16 open chat uploads per session, 256 MiB staged per server,
>   10-minute expiry (idle, or finished but never bound); resume across reconnects; 8 × 10 MiB per turn
>   kept; chunks of base64 ≤ 1 MiB raw, two outstanding, size adapting toward ~1 s between 16 KiB and
>   1 MiB; attachments of one send stage one after another; an unknown or expired upload starts over
>   once, then fails; progress ("Uploading 2 attachments — 3.1 of 20 MiB") and Cancel on the pending
>   message; queued sends stage first, then enqueue; the methods require the operate scope.
> - B: one purpose-tagged `uploads.*` family (Q5); `projects.readDownload` (read scope, server
>   stream, `streamBufferSize: 2`), `assets.read` (read scope, server stream); every pinned profile,
>   https included (Q2); old servers refused with "Update <server> to transfer files over its
>   encrypted connection" and images show their names (Q3); HTML/PDF previews disabled on pinned
>   profiles, label says why and points to Download (Q4); 4 open workspace uploads per session, 1 GiB
>   each, 10-minute idle expiry, no new server-wide byte cap (Q6); browser downloads capped at 2 GiB,
>   no desktop cap (Q7); HTTP capabilities kept for old clients (Q8); progress and Cancel in a toast
>   ("Downloading report.zip — 120 of 900 MiB") (Q9); the client runs one file transfer at a time
>   per environment plus at most 2 asset reads; the server refuses a fifth download stream per session
>   with a typed `capacity` error; 64 MiB LRU asset cache; the selector
>   `fileContentRoute(prepared, config)` returns `http` / `in-channel` / `unavailable` and ignores the
>   URL scheme; no token is ever minted for a pinned profile.

Repository rules (from AGENTS.md and the lane contract):
- Implementers never commit, stage, stash, reset, restore, checkout -- or clean. Each task stops at
  the READY hand-off.
- **No contracts-only task is possible.** `packages/contracts/scripts/export-rust-rpc-fixtures.ts`
  (:905-931) and its test (:79-142) and `apps/server/tests/rpc_wire.rs` (:76-107) hard-assert the
  method, stream, stream-shape, typed-failure, fixture and fingerprint counts (133 / 20 / 71 / 24 /
  293 / 396 / 364 at HEAD), and `RpcRegistry::validate_complete` (session.rs:546-567) fails
  production start for a listed method without a handler. So every task that adds a method lands,
  together: `WS_METHODS` + `Rpc.make` + `WsRpcGroup` entry (rpc.ts), the Rust `ACTIVE_RPC_METHODS`
  entry (methods.rs, sorted; `uploads.*` sorts between `updater.status` and `vcs.cancelClone`),
  `required_scope` (auth/scope.rs), the handler, regenerated fixtures
  (`vp run check:contracts`), and the bumped constants in all three places. The task that adds the
  method bumps the counts; recompute them from the regenerated manifest, never guess.
- **Capability invariant:** `attachmentStaging: true` is advertised only by the task that also makes
  staged attachments bind at turn start (Task 2). `inChannelTransfers: true` is advertised only by
  the task in which workspace uploads with `uploads.commit`, `projects.readDownload` and
  `assets.read` all exist (Task 8). Both flags decode with default false
  (`Schema.withDecodingDefault(Effect.succeed(false))`), are added to the `json!` literals in
  `control.rs` `environment_descriptor` (:2312-2348) and `lifecycle.rs`
  `connect_environment_descriptor` (:48-69) next to `vcsCloneReattach`, and to their tests
  (control.rs :5933/:5965, lifecycle.rs :995). The typed HTTP descriptor struct (http.rs:357-364)
  is not extended (it omits `vcsCloneReattach` too).
- Living docs change in the same task as the behaviour they describe (lane contract: "update the
  living docs your change affects, in the same change"). Do not batch docs into a late task.
  `docs/testing/` runbooks are reviewed per AGENTS.md "Testing Runbook Maintenance" in each task
  that changes a validated flow; state "reviewed and remain accurate" where unchanged.
- Hermetic tests: every test run puts logging fake CLIs first on PATH (`target/fakes/bin` in the
  worktree; never fake git). Tests that fail only in a sandbox (loopback, reaping) are listed as not
  run, never "fixed".
- Gates per task: `cargo fmt --all --check`; `cargo clippy -p bibcode-server --all-targets -- -D
  warnings` (and `-p bibcode-desktop` for desktop tasks); focused tests, then `cargo test -p
  bibcode-server --lib` and every affected integration binary for server tasks; `cargo test -p
  bibcode-desktop --lib` for desktop tasks; web `cd apps/web && vp test run --project unit <files>`
  then the whole unit project; client-runtime `node ../../scripts/run-local-vp.mjs test run <files>`
  from `packages/client-runtime` (see the contracts map); `vp run check:contracts` for contract
  tasks; `vp check` and `vp run typecheck` at the root.
- `apps/web` React changes are reviewed against `vercel-react-best-practices` and `UI.md` (both);
  user-visible copy against `UI.md`.
- Never touch port 3773 or the user's desktop app. Never print secrets (pairing tokens, keys):
  write `<REDACTED>`.


**Interpretation of gates:** No implementer may satisfy the final fixture-diff gate by staging, even in a temporary index. The precise fixture workflow below reports that final diff separately. This planning change itself runs no tests and starts no servers; its gate is `vp check` and a final two-file diff audit.

**Runtime boundaries:** contracts remain schemas only; server owns uploads, admission, digests, quotas and disk publication; client-runtime owns session-following, route policy, transfer scheduling and asset retention; web owns copy and user intent; desktop owns native disk handles. No provider, filesystem or token authority is transferred to the renderer beyond the existing DesktopBridge permission boundary.

**State and failures:** the registry is in memory and owner-keyed, with declared-byte reservation; attachment and workspace files are the byte source of truth, not a persisted upload index. Socket loss keeps uploads; Cancel/expiry removes them; restart wipes chat stages, while an orphan workspace `.part` after a process crash remains the documented residual. Never hold a workspace admission lease through a network transfer. Binding holds the existing attachment root transaction through durable acceptance.

## Review Focus

- Completed upload bound while expiry or Cancel races: one winner, no accepted turn missing its file (Tasks 1–2).
- Reconnect acknowledges an older outstanding boundary: restore the matching hasher clone and bytes, never hash twice (Task 4).
- Composer changed during upload: Cancel/failure preserves both the outgoing snapshot and the user's newer edits (Task 5).
- Destination folder replaced or removed between begin and commit: revalidate identity and contain cleanup to the owned partial (Task 6).
- Stream ends without `end`, with a gap, or with an archive writer error: never publish a successful download or retain a partial image (Tasks 7–10, 12).

## Coordination with concurrent work

Other lanes edit these hotspots at the same time; keep hunks minimal and self-contained, and each
READY lists exact line ranges:
- `apps/server/src/production/runtime.rs`: provider-misc refactors constructors; desktop adds a config
  seam. This plan's hunks there are limited to constructing the upload registry, spawning/stopping
  its sweep task beside `ProviderUpdateCheckTask` (:102, :206, :487, :634), wiping the staging
  directory at startup (near :240-249) and one registration call. Do NOT rewrite the HTTP asset
  route (:548-600).
- `packages/contracts/fixtures/rpc-wire/**` and the count constants: regenerate on conflict, never
  hand-merge.
- `docs/architecture/*`, `docs/testing/*`, `docs/user/workspace-ui.md`: targeted paragraphs only.


Re-read every hotspot immediately before editing. Do not move unrelated constructors or format a whole file. For Task 6 the existing HTTP upload callback is passed to the new upload services through the same shared callback implementation; the small callback extraction at `runtime.rs:150-161` is an additional necessary hunk. Task 8 moves the fallback SVG constant at `runtime.rs:1175` to the shared assets module with one import change. Both qualifications are documented below. The asset HTTP method stays untouched.

## Spec conflicts and plan decisions

Each Ruling records the approved choice, its reason, and the cost if it proves wrong. Full paths for shorthand source anchors: `attachments.rs` is `apps/server/src/provider/attachments.rs`; `session.rs`, `methods.rs`, `e2ee.rs` are under `apps/server/src/rpc/`; `control.rs`, `runtime.rs`, `orchestration_rpc.rs` are under `apps/server/src/production/`; `lifecycle.rs`, `http.rs` are under `apps/server/src/`; `state_files.rs` is under `apps/server/src/persistence/`; `bridge.rs` is `apps/desktop/src-tauri/src/bridge.rs`; `ChatView.tsx` is `apps/web/src/components/ChatView.tsx`. Other shorthand is qualified in the task file lists.

**R1. Ruling:** One `uploads.*` family: `uploads.begin { target, sizeBytes, sha256? } → { uploadId, exists }`,
`uploads.append { uploadId, offset, data, sha256? } → { receivedBytes }`, `uploads.get
{ uploadId } → { uploadId, sizeBytes, receivedBytes, complete }`, `uploads.cancel { uploadId } →
{}` (idempotent), `uploads.commit { uploadId, overwrite } → { relativePath }` (workspace target
only). `target` is a `_tag` union (kebab-case like `AssetResource`): `{ _tag: "chat-attachment",
type: "image" | "file", name, mimeType }` (Task 1) and `{ _tag: "workspace-file", cwd,
relativeDirectory, fileName }` (Task 6). Typed error `UploadError { reason, message,
receivedBytes? }` with snake_case reasons like `ProjectTransferError`: `quota`, `not_found`
(unknown, expired, or owned by another session: never distinguished), `offset` (carries
`receivedBytes`), `digest`, `size`, `invalid` (malformed base64, a missing digest at completion,
wrong target for the call); Task 6 adds `exists`. Path failures for the workspace target reuse
`ProjectTransferError`. `data` is base64 of ≤ 1 MiB raw (≤ 1,398,104 chars); sha256 is lowercase
hex. `begin`, `append`, `cancel` and `commit` are `mutation_unary`, `get` is `read_unary`; all
five require `orchestration:operate`. — B Q5 amends C's `attachments.*Upload` names.

— **Why:** one approved purpose-tagged protocol replaces C’s provisional names. — **Cost if wrong:** a second family would split policy and break compatibility negotiation.

**R2. Ruling:** Ownership is the authenticated session: `RpcSessionContext::current_session_id()`
(`principal.session_id`, session.rs:339-343), stable across reconnects that present the same
credential. When there is no principal (`unsafe_no_auth`, used by `rpc_wire.rs` and
`rpc_liveness.rs`), every connection shares one `Unauthenticated` owner. A desktop page reload
mints a new session (`supersede_desktop_bootstrap_sessions`), so its uploads simply expire; a
reload is not a reconnect and needs no resume. Upload handlers are registered with
`register_unary_with_context` (crate-private; the registration function is a `pub` fn of the
crate so the `rpc_liveness.rs` harness can register the real handlers).

— **Why:** credentials, not sockets, define resumable ownership. — **Cost if wrong:** connection-keyed entries would become inaccessible after a drop.

**R3. Ruling:** **Deviation from C:** chat-attachment partials live in a new directory
`StatePaths.attachment_uploads_dir = state_dir.join("attachment-uploads")` as `<uploadId>.upload`,
not as `.<uploadId>.upload` inside `attachments/`: the lazy `scavenge_stages` (attachments.rs
:616-649) runs on the first `prepare()` after startup and would delete a live staged upload, and
`reconcile_startup` owns that folder. The directory is created with the others
(`ensure_directories_without_database_side_effects`, state_files.rs:120-137) and emptied at
startup, which keeps C's behaviour "Server restart: partials are deleted; the client starts over
once."

— **Why:** attachment reconciliation and lazy scavenging own the old folder. — **Cost if wrong:** live uploads could be deleted before binding.

**R4. Ruling:** **Deviation from C:** binding does not rename the partial. The staged branch hard-links the
completed staging file to `attachments/<attachmentId>` (falling back to a copy when the
filesystem refuses hard links), as an owned final of `PreparedAttachmentBatch`, reusing the
existing publish helper (identical existing final adopted). The batch records the bound upload
ids; `PreparedAttachmentBatch::commit()` releases them (entry forgotten, staging file deleted);
`Drop` (rollback) removes only the final and keeps the upload. — A rename would destroy the
bytes on rollback and break C's "Turn start fails after staging: a retry binds the same uploads
until expiry, with no re-upload".

— **Why:** rollback must keep the source bytes available. — **Cost if wrong:** a failed turn would require another full upload.

**R5. Ruling:** `orchestration.dispatchCommand` moves from `register_unary` (orchestration_rpc.rs:124) to
`register_unary_with_context`, so the caller's owner reaches `prepare()`; queued turn starts use
the same path (`queued: true`).

— **Why:** both direct and queued turn admission need the authenticated owner. — **Cost if wrong:** an upload could be bound with the wrong authority.

**R6. Ruling:** `AttachmentInput` gains `upload_id: Option<String>`. The staged check (an `uploadId` key present)
comes BEFORE the by-id reuse branch, because today an attachment with `uploadId` and no `dataUrl`
lands in the reuse branch and fails `NotReusable`. `dataUrl` and `uploadId` together are
refused. The staged branch requires: the caller owns the upload, it is complete with a verified
digest, `sizeBytes`, `type` and `mimeType` equal the begin target (and `name`), then publishes.

— **Why:** the existing no-dataUrl branch means reuse of a previously attached id. — **Cost if wrong:** staged inputs would be misclassified or metadata could be substituted.

**R7. Ruling:** Digest: `sha256` may arrive at begin or on the completing append (B: "It may ride on the
completing append, so a 1 GiB file is read once"); one is required by completion, a completion
without one fails `invalid`, and a mismatch deletes the partial and forgets the upload
(`digest`). The client hashes incrementally with `@noble/hashes/sha2.js` (`sha256.create()`),
sends the digest on the last append, and keeps a hasher clone at every unacknowledged chunk
boundary so a resume from `receivedBytes` restores the exact state.

— **Why:** late digests allow a one-pass read and resumable incremental hashing. — **Cost if wrong:** large files would be read twice or completion would verify the wrong bytes.

**R8. Ruling:** Ordering: a per-upload async mutex serializes writes and a `watch` channel publishes
`receivedBytes`. An early chunk waits up to 10 s for its predecessor, then fails `offset`; a
duplicate (`offset + len ≤ receivedBytes`) returns `receivedBytes` without writing; an overlap or
a gap fails `offset`; each reply is sent after its write is flushed. A zero-byte upload completes
on an append with empty `data` at offset 0 (or at begin when the digest came with it).

— **Why:** two concurrent appends can arrive out of order. — **Cost if wrong:** out-of-order writes or waits holding the write lock would corrupt or deadlock an upload.

**R9. Ruling:** Quotas are keyed by target kind in one engine: chat (16 open per owner, ≤ 10 MiB each, 256 MiB of
declared bytes per server) and workspace (4 open per owner, ≤ 1 GiB each, no server cap). "Open"
means begun and not yet released, committed, cancelled, expired or forgotten. Idle expiry is
10 minutes for both, measured from the last begin/append/get (finished-but-unbound chat uploads
included). A sweep runs every minute, owned by `ProductionRuntime` on the
`ProviderUpdateCheckTask` pattern (control.rs:193-216; `MissedTickBehavior::Skip`; stopped in
`quiesce_for_update`), and also on each begin. The engine takes its limits and clock as inputs
(tokio `Instant`, so tests can `tokio::time::pause()`); tests use small limits instead of 256 MiB
files.

— **Why:** target kinds have different volumes and declared-byte budgets. — **Cost if wrong:** disk leaks or a workspace upload consuming the chat cap would follow.

**R10. Ruling:** Inline threshold is per turn: the client sends every attachment inline, as today, when the
carrying session lacks `attachmentStaging` or the turn's total encoded size (data-URL
characters) is ≤ 256 KiB; otherwise it stages every attachment of the turn, one after another. —
A per-attachment threshold would let 8 × 250 KiB build one 2 MiB inline message that dies below
~70 KiB/s.

— **Why:** one RPC carries the whole turn. — **Cost if wrong:** eight individually small attachments could still exceed the liveness budget.

**R11. Ruling:** Client chunking: two appends outstanding; the first chunk is 64 KiB raw; each reply's round-trip
time steers the next chunk toward ~1 s (`size × 1000 ms / rtt`, at most ×2 or ÷2 per step,
clamped to 16 KiB..1 MiB). (64 KiB raw is ~5 s at the ~17 KB/s establishment floor, inside the
E2EE inbound message deadline of write timeout + 1 s per 64 KiB, e2ee.rs:1481-1487.)

— **Why:** 64 KiB starts within the established slow-link budget. — **Cost if wrong:** a large initial chunk would block control traffic before adaptation.

**R12. Ruling:** Resume: `nextSession` moves out of `packages/client-runtime/src/state/vcsClone.ts` (:91-131,
private today) into a shared client-runtime module used by clone re-attach, the upload stager,
the download reader and the asset cache; clone behaviour is unchanged. On a transport loss (the
`isCloneTransportLoss` rule, vcsClone.ts:56-66) the stager reports `reconnecting`, waits for the
next session, re-reads the capability on that session, calls `uploads.get` and continues from
`receivedBytes`; `not_found` starts over once with a new `uploads.begin`, then fails. Cancel is an
interruption: the stager calls `uploads.cancel` best effort and the caller sees an interrupted
failure.

— **Why:** the supervisor is the single reconnect owner. — **Cost if wrong:** independent retry loops could race sessions or probe an old server.

**R13. Ruling:** `projects.readDownload { cwd, relativePath, offset?, expect? }` (read scope; server stream;
registered in `production/workspace_preview.rs` beside `subscribeProjectEntries` with
`register_stream_with_context` (or `register_stream`), using lossless `mpsc`; never
`register_latest_stream`, whose `watch` channel coalesces values (session.rs:500-541)): values
`{_tag:"start", fileName, kind: "file" | "archive", sizeBytes | null, version | null}`,
`{_tag:"bytes", offset, data}`, `{_tag:"end", totalBytes}`. One shared open-and-validate helper
in `transfer/` (path admission under a short lease, root normalization, canonicalization,
archive pre-scan) serves the HTTP route and the RPC; the lease covers only the checks.
`version` is the file's size and modification time; an `offset` > 0 requires `expect` equal to
the current version, else typed `changed`; an archive with `offset` > 0 is refused
(`not_resumable`) and the client restarts it once. A fifth concurrent download per owner is
refused with typed `capacity` (if `register_stream_with_context` lacks the session identity,
extend it to pass `RpcSessionContext`). Chunks adapt 16 KiB..1 MiB toward ~1 s from the time
between successive hand-offs (bounded channel of 1), starting at 64 KiB; a zip needs a
reader-returning variant of `archive_body` (archive.rs:117-128). Interrupt stops reading.
Errors: `ProjectTransferError` for path failures (archive limits as the mint reports them via
`archive_limit_wire`), plus `ProjectDownloadError { reason: "changed" | "capacity" |
"not_resumable", message }`.
Never send `Ok(vec![])`: both stream loops terminate the connection with
`connection_defect("RPC stream produced an empty Chunk")` (session.rs:1183,1285).
A zero-byte file sends `start` and `end` together in one Chunk, with no `bytes` value.

— **Why:** streaming and file versions allow bounded, authenticated downloads. — **Cost if wrong:** unbounded buffering, stale resumes or a long lease would break reliability.

**R14. Ruling:** `assets.read { resource }` (read scope; server stream): the same resolution and thread admission
as `assets.createUrl` through one shared helper (no token minted); values `{_tag:"start",
mimeType, sizeBytes}`, `{_tag:"bytes", offset, data}`, `{_tag:"end"}`; a small nonempty image's three
values travel in one `Chunk`. Register with lossless `register_stream_with_context` (or
`register_stream`), never the coalescing `register_latest_stream`. Never send `Ok(vec![])`:
both stream loops terminate the connection with `connection_defect("RPC stream produced an empty Chunk")`.
A zero-byte file sends `start` and `end` in one Chunk, with no `bytes` value.
Only exact resources are served (images, attachments, the project
favicon including the fallback SVG); HTML/PDF sibling-capability types are refused with the
existing unsupported-type error in phase 1; over 10 MiB is refused with a typed too-large error.
— The HTTP asset route (runtime.rs:548-600) stays as it is for old clients; B's "a stream also
ends the route's whole-file buffering" is satisfied because pinned profiles no longer use the
route, and runtime.rs is a hotspot.

— **Why:** pinned readers leave the legacy route entirely. — **Cost if wrong:** rewriting the HTTP hotspot adds conflict risk without improving pinned confidentiality.

**R15. Ruling:** `fileContentRoute(prepared, config)` lives in client-runtime: `http` when `prepared.e2ee ===
null`; `in-channel` when pinned and the carrying session's config advertises
`inChannelTransfers`; `unavailable` otherwise. The client never probes a method.

— **Why:** pinning, not TLS termination, defines the E2EE promise. — **Cost if wrong:** a pinned https profile could leak paths or tokens outside Noise.

**R16. Ruling:** `AssetByteCache` per environment in client-runtime: reference-counted `blob:` URLs, a 64 MiB LRU
of unreferenced entries, revocation of evicted unreferenced URLs, at most 2 concurrent reads,
and one re-issue of a transport-cut read on the next session; `useAssetUrl(s)` return its URLs
for `in-channel`, null (the name shows) for `unavailable`, and HTTP URLs for `http`.

— **Why:** image lifetimes and concurrency must be environment-owned. — **Cost if wrong:** blob leaks, premature revocation or an image fan-out could overload the session.

**R17. Ruling:** Desktop downloads: four bridge commands `beginDownloadFile { directory, fileName } → { handle }`,
`appendDownloadFile` (raw binary body through `tauri::ipc::Request`, the handle in a header),
`finishDownloadFile { handle } → { path }`, `abortDownloadFile { handle }`. They reuse
`download_file_name_for`, `partial_transfer_file_name` and `unique_destination`; a handle aborts
after 10 idle minutes, and on a main-webview page load (add a page-load hook with a generation
guard like preview/host.rs:777-810, since no reload observer exists today). The web widens its
local invoke types (`tauriInvokeRouting.ts:1`, `vite-env.d.ts:20-22`) to pass a `Uint8Array`
body with headers. Each command is added in the five places the web/desktop map lists.

— **Why:** privileged writes belong in the desktop bridge and must survive only the owning page. — **Cost if wrong:** reload races could leak partials or let stale work write a new handle.

**R18. Ruling:** Desktop uploads on pinned profiles use the panel's hidden `<input type="file">` instead of
`pickFiles` + `uploadFile`, so no new privileged file-read command exists.

— **Why:** the browser File object already supplies bytes without privileged reads. — **Cost if wrong:** a new native file-read bridge would unnecessarily enlarge authority.

**R19. Ruling:** Browser in-channel downloads collect chunks into a `Blob`; a file over 2 GiB is refused before
any bytes; the toast's **Save** starts the anchor download.

— **Why:** ordinary browser origins cannot rely on a streaming disk API. — **Cost if wrong:** renderer memory or a delayed automatic download could fail silently.

**R20. Ruling:** The pending message: a non-queued send's optimistic row shows the progress line and **Cancel**
while staging; a queued send (which has no optimistic row today) shows a local pending row with
the same progress and Cancel until the enqueue resolves. Cancel interrupts staging, the stager
calls `uploads.cancel`, and the send fails as interrupted, so `ChatView` restores the draft and
shows no error banner (`setThreadError` is skipped only for `isAtomCommandInterrupted`,
ChatView.tsx:5457-5463). Staging is decided before any `readFileAsDataUrl` runs, so a staged send
never builds data URLs.

— **Why:** the user must see and cancel staging before a durable message exists. — **Cost if wrong:** queued sends would look lost and cancellation could show a false error banner.

**R21. Ruling:** Ownership tests cannot live in `rpc_liveness.rs` (unauthenticated: one shared owner). Engine
unit tests take the owner as a parameter, and one authenticated integration case (modelled on
`tests/e2ee_ws.rs` or `tests/auth_http.rs`) proves another session's `uploadId` is refused.
`rpc_liveness.rs`'s `ThrottleProxy` paces server→client only (:116-198); Task 3 adds an upstream
rate, or the upload trials measure nothing.

— **Why:** the current harness has one unauthenticated owner and only downstream throttling. — **Cost if wrong:** ownership and upload liveness tests could pass without exercising their claims.

**R22. Ruling:** "Loss of the workspace deletes the partial" (B) is detected when the next append, get or commit
finds the target folder gone: the upload is forgotten and its partial removed.

— **Why:** there is no long-lived workspace lease or upload watcher. — **Cost if wrong:** workspace loss might leak a partial or incorrectly keep an upload usable.

### Verified drift and tree qualifications

| Historical citation / premise | Current evidence used by this plan |
| --- | --- |
| C startup cleanup `attachments.rs:310-313` | `apps/server/src/provider/attachments.rs:294-346`; stage deletion at 330–333; lazy scavenging at 616–649. |
| C provider encoding `attachments.rs:328-372` | `apps/server/src/provider/attachments.rs:348-391`, `STANDARD.encode` at 385. |
| C inline/reuse branches `attachments.rs:227-247` | `apps/server/src/provider/attachments.rs:229-273`; reuse begins at 247. |
| C durable dispatch `orchestration_rpc.rs:541-544,725-740` | `apps/server/src/production/orchestration_rpc.rs:504-710`, preparation 583–587 and commit 663–668; helper 792–809. |
| Both specs' unknown tag `session.rs:894-904` | `apps/server/src/rpc/session.rs:888-898`. |
| Both specs' capability literals `lifecycle.rs:64`, `control.rs:2172` | `apps/server/src/lifecycle.rs:66`; `apps/server/src/production/control.rs:2345`. |
| Both specs' clone capability read `vcsClone.ts:265` | `packages/client-runtime/src/state/vcsClone.ts:257`; next-session helper 91–131. |
| C ChatView reader `5158-5167`, restore `5372-5420` | `apps/web/src/components/ChatView.tsx:5190-5199`, failure/restoration 5404–5464. |
| B ChatView asset consumer `2688-2706`, timeline fallback `973-976` | `apps/web/src/components/ChatView.tsx:2729`; `apps/web/src/components/chat/MessagesTimeline.tsx:962-994`, fallback 986–990. |
| B HTTP asset buffering `runtime.rs:561-578` | `apps/server/src/production/runtime.rs:568-583`. |
| B desktop download `bridge.rs:1774-1843`, upload `1852-1880` | `apps/desktop/src-tauri/src/bridge.rs:1802-1871`, upload 1880–1906; name/uniquifying helpers 1657–1778. |
| Old host-key HTTP paragraphs/audit `remote.md:227-233,772-773` | `docs/architecture/remote.md:240-249,786-801`, relevant rows 797–798. |
| Old transfer invariant `rpc-and-orchestration.md:2042-2075` | `docs/architecture/rpc-and-orchestration.md:2103-2135`. |
| Old frame/stream line numbers in C/B | inbound hooks `apps/server/src/rpc/session.rs:627`, `apps/server/src/rpc/e2ee.rs:1261`; heartbeat `apps/server/src/rpc/transport.rs:123-176`; Ack wait `apps/server/src/rpc/session.rs:1209-1223`. |
| R13 condition: stream context might lack session identity | It already passes `RpcSessionContext` at `apps/server/src/rpc/session.rs:531-541`; use it as-is. No core signature change. |
| Specs' inherited `desiredSeen` workaround | Current `nextSession` documentation at `packages/client-runtime/src/state/vcsClone.ts:75-89` and `docs/architecture/connection-runtime.md:400-414` already describe registry-owned initial desire. Move the helper unchanged; do not reintroduce the workaround. |
| Task 5 asks to update a connection-runtime large-upload residual | No such paragraph currently exists; add a targeted paragraph under State and retry policy, retaining editor/prompt and legacy-inline limits. |

**Ruling qualification — shared upload callback:** R6 requires exactly the HTTP upload completion effects. Today the only callback body is a closure in `apps/server/src/production/runtime.rs:150-161`, created inside `transfer_upload_handler`; it cannot be handed to the registry constructor from there. Extract its body to `production/transfer_routes.rs::uploaded_callback(workspace, status_broadcaster)` and call that helper from the existing method and the Task 6 upload-services construction. This adds one small hunk to the otherwise restricted runtime file; keep the HTTP asset route unchanged. Duplicating the policy instead would violate the brief's shared-implementation requirement.

**Gate qualification:** `package.json` ends `check:contracts` with `git diff --exit-code --stat -- packages/contracts/fixtures`. Changed, uncommitted fixtures make that last check fail by design. The house-style plan's temporary-index staging exception does not apply here: no staging anywhere. Record the exact exit and successful preceding stages; the controller verifies the unchanged complete command after its commit. Never label the full gate green before then.

**Live qualification:** the positive cleartext control runs the baseline client against the baseline server. A new client against that old server must instead show Update and produce zero transfer/asset requests. These are separate trials, not contradictory success criteria.

### Second opinion (2026-09-27)

- S1: Task 11 uses main-labelled `tauri::Webview<DesktopRuntime>` command arguments, tests begin/append/cancel with a Preview child open, and carries that condition into the Task 12 desktop live check.
- S2: Tasks 4, 9 and 10 derive client failures from generated per-method RPC types; Task 6 owns any client-runtime type adjustments and verifies them with `vp run typecheck`.
- S3: Task 2 includes fixture-owned upload registries for both integration-test callers, updates registration unit tests, and runs both integration binaries.
- S4: Task 1's authenticated test exchanges the startup grant once, issues two distinct pairing grants, then mints the two E2EE sessions.
- S5: Task 11 requires `TauriCommandOptions.headers` inside the optional options argument and forwards that argument unchanged.
- S6: Tasks 5 and 12 use happy-dom focus/DOM-click assertions and Playwright keyboard activation; Task 13 checks disabled reasons in the DOM and their keyboard discoverability in Playwright.

## File structure

Proposed files below do not exist at the baseline. All other paths have been checked.

| Create (proposed) | Owner / responsibility | Tasks |
| --- | --- | --- |
| `packages/contracts/src/uploads.ts`, `packages/contracts/src/uploads.test.ts` | Upload wire schemas and error shapes | 1, 6 |
| `apps/server/src/transfer/staging.rs` | In-memory owner registry, disk chunks, hashes, expiry and bind guard | 1, 2, 6 |
| `apps/server/src/production/uploads_rpc.rs` | Context-aware unary upload handlers and workspace adapter | 1, 6 |
| `apps/server/src/transfer/download.rs` | Shared file/archive opener, versions and streaming pace | 7, 8 |
| `packages/client-runtime/src/connection/nextSession.ts` | Existing reconnect wait moved without policy changes | 4, 9, 10 |
| `packages/client-runtime/src/operations/uploadStager.ts`, `.test.ts` | Target-independent acknowledged upload engine | 4, 9 |
| `packages/client-runtime/src/operations/attachmentStaging.ts`, `.test.ts` | Per-turn inline decision and sequential staging | 4 |
| `packages/client-runtime/src/operations/fileContentRoute.ts`, `.test.ts` | Single route selector | 9 |
| `packages/client-runtime/src/operations/fileTransfers.ts`, `.test.ts` | Download sink protocol, resume and workspace upload/Replace | 9 |
| `packages/client-runtime/src/state/fileTransfers.ts`, `.test.ts` | One active Files operation per environment | 9 |
| `packages/client-runtime/src/state/assetByteCache.ts`, `.test.ts` | Reference-counted URLs, LRU and two-reader window | 10 |
| `apps/web/src/components/chat/AttachmentUploadNotice.tsx`, `.test.tsx` | Prop-driven pending-message progress and Cancel | 5 |
| `apps/web/src/lib/formatTransferBytes.ts`, `.test.ts` | Shared transfer progress byte formatting | 5, 12 |
| `apps/web/src/components/files/transferPresentation.ts`, `.test.ts` | Transfer copy and toast-state projection | 12 |
| `apps/web/src/state/fileTransfers.ts` | Bind transfer atoms to the application runtime | 12 |
| `apps/web/src/browser/openFileInPreview.test.ts` | Guard all imperative pinned preview calls | 13 |

The suffix-only test entries in this table mean the complete same stem with the displayed suffix; task lists give full paths.

| Modify existing files | Purpose / tasks |
| --- | --- |
| `packages/contracts/src/index.ts`, `rpc.ts`; `apps/server/src/rpc/methods.rs`, `auth/scope.rs` | Inventory, schema exports, registered methods and scopes (1, 6–8) |
| `packages/contracts/scripts/export-rust-rpc-fixtures.ts`, `export-rust-rpc-fixtures.test.ts`; `packages/contracts/fixtures/rpc-wire/`; `apps/server/tests/rpc_wire.rs` | Regenerated fixtures, measured counts and parity (1, 2, 6–8) |
| `apps/server/src/transfer/mod.rs`, `production/mod.rs`, `persistence/state_files.rs`, `production/runtime.rs` | Registry ownership, directory and sweep lifecycle (1, 6) |
| `apps/server/src/provider/attachments.rs`, `production/orchestration_rpc.rs` | Transactional staged binding (2) |
| `apps/server/tests/turn_delivery_recovery.rs`, `production_provider_runtime.rs` | Fixture-owned upload registries at changed registration calls (2) |
| `packages/contracts/src/orchestration.ts`, `orchestration.test.ts`, `environment.ts`, `environment.test.ts`; `packages/shared/src/testSupport.ts` | Staged variants and decode-default capabilities (2, 8) |
| `apps/server/src/lifecycle.rs`, `production/control.rs` | Capability JSON and tests (2, 8) |
| `apps/web/src/composerDraftStore.ts`, `composerDraftStore.test.ts` | Persist only inline drafts (2) |
| `apps/server/tests/e2ee_ws.rs`, `rpc_liveness.rs` | Authenticated ownership and genuine slow uplinks (1, 3, 8) |
| `packages/client-runtime/src/state/vcsClone.ts`, `threadCommands.ts`; `operations/index.ts` | Shared wait and interruptible staging commands (4) |
| `apps/web/src/components/ChatView.tsx`, `ChatView.logic.ts`, `ChatView.logic.test.ts`; `components/chat/MessagesTimeline.tsx`, `MessagesTimeline.test.tsx` | Staging before encoding, row state, retry and Cancel (5) |
| `apps/server/src/transfer/upload.rs`, `production/transfer_routes.rs`, `workspace/rpc.rs` | Shared publication, path admission and observable effects (6–8) |
| `apps/server/src/transfer/archive.rs`, `production/workspace_preview.rs` | Shared opener, cancellable streams and stream cap (7–8) |
| `apps/server/src/assets/mod.rs`; `packages/contracts/src/transfer.ts`, `transfer.test.ts`, `assets.ts`, `assets.test.ts` | Download/asset contracts and shared resource resolution (7–8) |
| `apps/server/tests/workspace_rpc.rs`, `production_http_routes.rs`, `production_workspace_preview_rpc.rs` | HTTP compatibility, RPC transfer and stream behavior (6–8) |
| `packages/client-runtime/src/rpc/client.ts`, `rpc/index.ts`, `state/assets.ts`, `state/assets.test.ts`, `package.json`; `e2ee/testSupport.ts`, `e2ee/serverInterop.test.ts` | Stream options, policy, cache wiring and real-server interop (9–10) |
| `apps/desktop/src-tauri/src/bridge.rs`, `src/lib.rs`, `permissions/desktop-bridge.toml`; `packages/contracts/src/ipc.ts` | Raw disk sink and permission inventory (11) |
| `apps/web/src/tauriDesktopBridge.ts`, `tauriDesktopBridge.test.ts`, `tauriInvokeRouting.ts`, `tauriInvokeRouting.test.ts`, `vite-env.d.ts` | Preserve raw bodies and headers through invoke (11) |
| `apps/web/src/components/files/useFileTransfers.ts`, `useFileTransfers.test.tsx`, `fileTransfers.ts`, `fileTransfers.test.ts`, `FileBrowserPanel.tsx`, `FileBrowserPanel.test.tsx`, `FileTreeContextMenu.logic.ts`, `FileTreeContextMenu.logic.test.ts` | Files routing, input, Replace, toast, disabled actions (12–13) |
| `apps/web/src/assets/assetUrls.ts`, `assetUrls.test.ts`; `components/ProjectFavicon.tsx`, `components/ChatMarkdown.tsx`, `components/ChatMarkdown.behavior.test.tsx`, `components/files/FilePreviewPanel.tsx`, `components/files/FilePreviewPanel.test.tsx`, `browser/openFileInPreview.ts` | Blob image ownership and pinned preview guard (13) |

Living document changes are listed in their owning task, never postponed to a documentation-only task. The implementation will also annotate the historical liveness residual as directed in Task 5; this planning run changes only this plan and the two C amendment notes.

## Working conventions

- Root: `/work/workspaces/orca/BibCode/lanes/uploads`; commands run there unless a subshell changes directory.
- Small text scratch: `S=/tmp/claude-1000/-work-workspaces-orca-BibCode-main-3/2c4f97f1-0ee1-4c37-b2bb-432255e2f351/scratchpad/lanes/uploads`.
- Large files, captures and browser profiles: `/work/workspaces/orca/BibCode/lanes/uploads-artifacts/`. Screenshots and redacted logs: `$S/live/`.
- Before a task: root-to-scope AGENTS files, status, current hotspots and task docs; repeat graph preflight per AGENTS. Never repair a broken graph. Inspect executable source over dated citations.
- Before Effect changes: read `.repos/effect-smol/LLMS.md` and the relevant vendored examples. Public web imports use client-runtime's existing explicit subpaths.
- Known host flakes: `provider_terminal_supervisor` at baseline; pipe-heavy tests when the per-user pipe budget is exhausted. Check `python3 -c 'import os,fcntl; r,w=os.pipe(); print(fcntl.fcntl(w,1032))'` for 65536. Classify, never chase unrelated failures.
- Every test process has logging fake CLIs first on PATH, even focused Vitest that might launch a server. Never fake git. Tests that need a provider install an explicit test-owned protocol fake, never fall through to a real CLI. The generic logging stub fails intentionally and alone cannot prove provider delivery.

Prepare fakes once for implementation (do not execute during this documentation task):

```sh
python3 - <<'PYFAKE'
from pathlib import Path
import re
root = Path('/work/workspaces/orca/BibCode/lanes/uploads')
source = Path('/tmp/claude-1000/-work-workspaces-orca-BibCode-main-3/2c4f97f1-0ee1-4c37-b2bb-432255e2f351/scratchpad/verify/fakes/fake-cli.sh')
bin_dir = root / 'target/fakes/bin'
calls = root / 'target/fakes/calls'
bin_dir.mkdir(parents=True, exist_ok=True)
calls.mkdir(parents=True, exist_ok=True)
body = re.sub(r'^f=.*$', 'f=' + str(calls) + '/$$', source.read_text(), flags=re.M)
for name in 'agent az brew bun claude codex cursor-agent gh glab grok jj npm npx opencode pnpm winget yarn'.split():
    target = bin_dir / name
    target.write_text(body)
    target.chmod(0o755)
PYFAKE
export PATH="$PWD/target/fakes/bin:$PATH"
```

### Contract fixture workflow (every schema task)

1. Write focused schema tests and run them red; implement schema, method, scope and real handler together.
2. Run `node packages/contracts/scripts/export-rust-rpc-fixtures.ts`. Its assertions precede emission. When a count fails, copy the actual observed count in its diagnostic into that one expected constant and rerun; never guess a derived fixture/fingerprint count. The exporter test remains red while counts are stale.
3. Read the regenerated manifest and print its counts:

```sh
node --input-type=module - <<'JS'
import fs from 'node:fs';
const m = JSON.parse(fs.readFileSync('packages/contracts/fixtures/rpc-wire/manifest.json', 'utf8'));
console.log({ methods: m.methods.length, streams: m.streamMethodCount,
  shapes: m.streamShapeFixtures.length, events: m.expectedOrchestrationEventShapes,
  failures: m.typedFailureFixtures.length, fixtures: m.fixtures.length,
  fingerprints: Object.keys(m.schemaFingerprints).length });
JS
```

4. Update exact expected constants in exporter, exporter test and Rust `rpc_wire`; rerun exporter, deterministic exporter test, parity test and Rust wire binary. All counters come from observed output/manifest. On conflicts regenerate.
5. Run `vp run check:contracts`. Record each stage and the final expected uncommitted-fixture diff separately. Do not stage to suppress it. READY includes the manifest counts and final diff for controller review; the post-commit full command must exit 0.

### Isolated live topology

The lane owns 4900–4999 only. Use process-scoped configuration, and terminate only PIDs created by the lane. Verify `target/debug/bibcode serve --help` / `pairing offer --help` before a live run; the former was checked while writing this plan and supports `--host`, `--port`, `--base-dir`, `--dev-url`, `--no-browser`.

```sh
S=/tmp/claude-1000/-work-workspaces-orca-BibCode-main-3/2c4f97f1-0ee1-4c37-b2bb-432255e2f351/scratchpad/lanes/uploads
UPLOAD_ARTIFACTS=/work/workspaces/orca/BibCode/lanes/uploads-artifacts
mkdir -p "$S/live" "$UPLOAD_ARTIFACTS"
for host in a b old; do
  mkdir -p "$S/live/$host"/{bibcode,claude,codex,config,data}
done
```

Run each command in its own supervised lane terminal:

```sh
(cd apps/web && env PORT=4901 HOST=localhost   VITE_DEV_SERVER_URL=http://localhost:4901   BIBCODE_PORT=4903 VITE_HTTP_URL=http://localhost:4903   VITE_WS_URL=ws://localhost:4903   BIBCODE_HOME="$S/live/a/bibcode" vp dev)
```

These mirror `scripts/dev-runner.ts:233-243`; `apps/web/vite.config.app.mjs:16-18` reads `PORT`, `HOST` and `VITE_WS_URL`. Use the proxy for both HTTP and WS to A. Remote B's saved endpoint is the proxy, never the direct port.

```sh
env PATH="$PWD/target/fakes/bin:$PATH" BIBCODE_HOME="$S/live/a/bibcode"   CLAUDE_CONFIG_DIR="$S/live/a/claude" CODEX_HOME="$S/live/a/codex"   XDG_CONFIG_HOME="$S/live/a/config" XDG_DATA_HOME="$S/live/a/data"   cargo run -p bibcode-server -- serve --host 127.0.0.1 --port 4902   --dev-url http://localhost:4901 --no-browser
node scripts/throttle-proxy.ts --listen 127.0.0.1:4903   --target 127.0.0.1:4902 --control 127.0.0.1:4904
```

```sh
env PATH="$PWD/target/fakes/bin:$PATH" BIBCODE_HOME="$S/live/b/bibcode"   CLAUDE_CONFIG_DIR="$S/live/b/claude" CODEX_HOME="$S/live/b/codex"   XDG_CONFIG_HOME="$S/live/b/config" XDG_DATA_HOME="$S/live/b/data"   cargo run -p bibcode-server -- serve --host 127.0.0.1 --port 4910   --dev-url http://localhost:4901 --no-browser
node scripts/throttle-proxy.ts --listen 127.0.0.1:4911   --target 127.0.0.1:4910 --control 127.0.0.1:4912
```

Create B's pairing offer with the same B configuration and `--dev-url` state selection; keep its code in a private scratch file and use it through the UI. Report `<REDACTED>`. Offer endpoint must be `http://localhost:4911`; verify exact `pairing offer --help` options before invoking. Plain comparison uses a separate unpinned authenticated profile to A. No authentication downgrade for B.

The pairing command was verified with the existing binary's help; execute it with the same isolated roots as B:

```sh
(umask 077
 env PATH="$PWD/target/fakes/bin:$PATH" BIBCODE_HOME="$S/live/b/bibcode" \
   CLAUDE_CONFIG_DIR="$S/live/b/claude" CODEX_HOME="$S/live/b/codex" \
   XDG_CONFIG_HOME="$S/live/b/config" XDG_DATA_HOME="$S/live/b/data" \
   target/debug/bibcode pairing offer --endpoint http://localhost:4911 \
   --reach this-computer --name Uploads-B --dev-url http://localhost:4901 --json \
   > "$S/live/b/pairing-private.json")
```

Read that private file only to enter the pairing flow; never print its token/code in evidence. For Task 12's isolated desktop, the current native port resolver reads `BIBCODE_PORT` (`apps/desktop/src-tauri/src/backend.rs:577-582`). The installed Tauri CLI's dev help confirms `--config` and `--no-watch`. Disable its default beforeDevCommand so it does not start the default-port graph:

```sh
mkdir -p "$S/live/desktop"/{bibcode,claude,codex,config,data}
(cd apps/desktop && env PATH="$PWD/../../target/fakes/bin:$PATH" BIBCODE_PORT=4930 \
  BIBCODE_HOME="$S/live/desktop/bibcode" CLAUDE_CONFIG_DIR="$S/live/desktop/claude" \
  CODEX_HOME="$S/live/desktop/codex" XDG_CONFIG_HOME="$S/live/desktop/config" \
  XDG_DATA_HOME="$S/live/desktop/data" \
  xvfb-run -a node node_modules/@tauri-apps/cli/tauri.js dev --no-watch \
  --config '{"build":{"beforeDevCommand":"","devUrl":"http://localhost:4901"}}' \
  -- -p bibcode-desktop)
```

The desktop uses its own in-process backend at 4930 and the already-running web frontend at 4901, then adds pinned B through 4911. Verify startup reports those ports before interacting. Keep this process's PID/display and use xdotool only on its window. A missing Xvfb/GTK/display is unavailable live evidence, not permission to use the user's desktop.

The lane manager provides a baseline server and matching baseline web build from `a3596ed1`. The baseline server binary already exists at `/work/workspaces/orca/BibCode/lanes/uploads-artifacts/old-server/bibcode`; the lane manager produces the baseline web build in a scratch worktree under `/work/workspaces/orca/BibCode/lanes/uploads-artifacts/` before the Task 12/13 live checks. Implementers do not change this worktree or stage to build it. Use 4920 for the old server, 4921 proxy, 4922 control and 4923 old web client, with the `old` isolated environment directories. No use of 3773 or the user's app.

Live scratch scripts are explicitly proposed, not existing repository tools. Create `$S/live/rpc-check.ts` as a mode-driven client using the repository's encrypted test socket pattern and authenticated credentials read from a private file. It must send a Request, inspect typed Exit, Ack each Chunk, and support Interrupt. Its `stage`, `bind`, `workspace`, `download`, and `asset` modes run the sequences in Tasks 1, 2, 6, 7, 8 and print only result counts/digests. Do not add it to the repository. Large payload fixtures go to `$UPLOAD_ARTIFACTS`.

### Live phase C acceptance (Task 5)

Use `--up 65536`, then `--up 16384`, for both plain and pinned E2EE profiles. Send a valid 10 MiB image; observe advancing progress, concurrent thread streaming, working Stop, and identical bytes at the protocol fake provider. Freeze mid-upload: client 4408 within 33 s, then resume on thaw. Cancel restores the draft with no banner. With `attachmentStaging` absent, retain the inline path. Take light/dark progress and Cancel screenshots. Probe Chromium `bufferedAmount`, whether Ping/Pong leave during an inline message, and whether queued data flushes after `close()`. Measure WebKitGTK only if available, otherwise record **not measured**.

### Live phase B acceptance (Tasks 12–13)

Replace B's proxy with a scratch throttle/capture proxy on 4911/4912, writing every forwarded byte to an artifact file. Canary text in a text file, an image's valid metadata, an HTML document and an uploaded file must never appear in the new-client/new-server capture; neither `/api/transfers` nor `/api/assets` request lines may appear. Baseline client/baseline server is the positive control: each relevant count is nonzero. Do not dump canaries mixed with credentials or token URLs into reports; report counts only. Use literal matching (`rg -a -F -c` or the design's `grep -c`) and interpret no matches as zero, not as a failed capture.

Measure 256 MiB and, where disk allows, 1 GiB uploads and downloads, renderer/server memory and duration in Chromium. Repeat with `--down 65536` then `--up 65536`, other thread streaming and Stop. Freeze/thaw must produce 4408 within 33 s and resume. Check old-server Update copy, disabled HTML/PDF previews, blob chat images/project icons, light/dark toasts and disabled states. Use an isolated WebKitGTK desktop under Xvfb with xdotool or computer use for disk saving. Record native Windows/macOS file-input checks separately when those hosts are unavailable.

### READY hand-off

Each task records: changed paths and exact current hunk line ranges; red then green focused commands; broader package/integration commands; static gates; docs/runbook updates (or **reviewed and remain accurate**); live evidence or explicit blocker; fixture count ledger where relevant; residual risks. Inspect `git diff --check`, the full diff and `git status --short`. The lane manager reviews, verifies and writes the READY file for the controller. Only the controller commits, one commit per task, with the subject supplied below.

---

## Phase C — Staged attachments

### Task 1: Upload engine and the chat-attachment target

**Commit subject:** `feat(server,contracts): stage chat uploads in acknowledged chunks`

**Files:**
- Create: `packages/contracts/src/uploads.ts`, `packages/contracts/src/uploads.test.ts`.
- Create: `apps/server/src/transfer/staging.rs`, `apps/server/src/production/uploads_rpc.rs` (tests inline).
- Modify: `packages/contracts/src/index.ts`, `packages/contracts/src/rpc.ts:377-540` and `WsRpcGroup`; `apps/server/src/rpc/methods.rs:167-168`, `apps/server/src/auth/scope.rs:74-133`.
- Modify: `apps/server/src/transfer/mod.rs`, `apps/server/src/production/mod.rs`, `apps/server/src/persistence/state_files.rs:24-79,120-137`.
- Modify: `apps/server/src/production/runtime.rs:102,206,240-249,487,634` (registry/sweeper and registration only).
- Test: `apps/server/tests/e2ee_ws.rs` (authenticated case); all three count sites and regenerated fixtures from the global workflow.
- Docs: `docs/architecture/rpc-and-orchestration.md`.

**Interfaces — consumes:** `RpcRegistry::register_unary_with_context`, `RpcSessionContext::current_session_id`, `StatePaths`, Tokio `Instant`, existing `sha2`/base64 dependencies. `RpcSessionContext` remains crate-private.

**Interfaces — produces (proposed schemas, in uploads.ts):**

```ts
import * as Schema from "effect/Schema";
import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const UploadId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
export type UploadId = typeof UploadId.Type;
export const UploadSha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));
export const UploadData = Schema.String.check(Schema.isMaxLength(1_398_104));
export const UploadTarget = Schema.Union([
  Schema.TaggedStruct("chat-attachment", {
    type: Schema.Literals(["image", "file"]),
    name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
    mimeType: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  }),
]);
export type UploadTarget = typeof UploadTarget.Type;
export const UploadBeginInput = Schema.Struct({
  target: UploadTarget,
  sizeBytes: NonNegativeInt,
  sha256: Schema.optional(UploadSha256),
});
export type UploadBeginInput = typeof UploadBeginInput.Type;
export const UploadBeginResult = Schema.Struct({ uploadId: UploadId, exists: Schema.Boolean });
export type UploadBeginResult = typeof UploadBeginResult.Type;
export const UploadAppendInput = Schema.Struct({
  uploadId: UploadId,
  offset: NonNegativeInt,
  data: UploadData,
  sha256: Schema.optional(UploadSha256),
});
export type UploadAppendInput = typeof UploadAppendInput.Type;
export const UploadAppendResult = Schema.Struct({ receivedBytes: NonNegativeInt });
export type UploadAppendResult = typeof UploadAppendResult.Type;
export const UploadGetInput = Schema.Struct({ uploadId: UploadId });
export type UploadGetInput = typeof UploadGetInput.Type;
export const UploadGetResult = Schema.Struct({
  uploadId: UploadId,
  sizeBytes: NonNegativeInt,
  receivedBytes: NonNegativeInt,
  complete: Schema.Boolean,
});
export type UploadGetResult = typeof UploadGetResult.Type;
export const UploadCancelInput = Schema.Struct({ uploadId: UploadId });
export type UploadCancelInput = typeof UploadCancelInput.Type;
export const UploadCancelResult = Schema.Struct({});
export type UploadCancelResult = typeof UploadCancelResult.Type;
export class UploadError extends Schema.TaggedError<UploadError>()("UploadError", {
  reason: Schema.Literals(["quota", "not_found", "offset", "digest", "size", "invalid"]),
  message: TrimmedNonEmptyString,
  receivedBytes: Schema.optional(NonNegativeInt),
}) {}
```

Empty `data` is legal for zero bytes; enforce actual decoded size and canonical base64 in Rust. `sizeBytes` is declared, not allocated memory. `exists` is always false for chat. Validate image/file MIME pairing with the existing attachment metadata rules.

In `rpc.ts`, add `uploadsBegin: "uploads.begin"`, `uploadsAppend: "uploads.append"`, `uploadsGet: "uploads.get"`, `uploadsCancel: "uploads.cancel"` to `WS_METHODS`, and these four entries to `WsRpcGroup`:

```ts
export const WsUploadsBeginRpc = Rpc.make(WS_METHODS.uploadsBegin, {
  payload: UploadBeginInput, success: UploadBeginResult,
  error: Schema.Union([UploadError, EnvironmentRpcError]),
});
export const WsUploadsAppendRpc = Rpc.make(WS_METHODS.uploadsAppend, {
  payload: UploadAppendInput, success: UploadAppendResult,
  error: Schema.Union([UploadError, EnvironmentRpcError]),
});
export const WsUploadsGetRpc = Rpc.make(WS_METHODS.uploadsGet, {
  payload: UploadGetInput, success: UploadGetResult,
  error: Schema.Union([UploadError, EnvironmentRpcError]),
});
export const WsUploadsCancelRpc = Rpc.make(WS_METHODS.uploadsCancel, {
  payload: UploadCancelInput, success: UploadCancelResult,
  error: Schema.Union([UploadError, EnvironmentRpcError]),
});
```

**Interfaces — produces (proposed Rust API in transfer/staging.rs):** The snippets specify public fields/signatures; opaque owner structs hide lock/storage details. All request/result fields serialize camelCase. `UploadTarget` uses `_tag`, kebab-case and `type` for `attachment_type`.

```rust
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub enum UploadOwner { Session(String), Unauthenticated }
impl UploadOwner {
    pub(crate) fn from_context(context: &RpcSessionContext) -> Self;
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "_tag")]
pub enum UploadTarget {
    #[serde(rename = "chat-attachment", rename_all = "camelCase")]
    ChatAttachment {
        #[serde(rename = "type")]
        attachment_type: String,
        name: String,
        mime_type: String,
    },
}
#[derive(Clone, Debug)]
pub struct UploadLimits {
    pub chat_per_owner: usize,
    pub chat_max_bytes: u64,
    pub chat_server_bytes: u64,
    pub idle: Duration,
    pub gap_wait: Duration,
}
impl Default for UploadLimits { fn default() -> Self; }
pub type UploadClock = Arc<dyn Fn() -> tokio::time::Instant + Send + Sync>;
#[derive(Clone, Debug)]
pub struct UploadRegistry { /* private shared state */ }
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadBeginInput {
    pub target: UploadTarget,
    pub size_bytes: u64,
    pub sha256: Option<String>,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadAppendInput {
    pub upload_id: String,
    pub offset: u64,
    pub data: String,
    pub sha256: Option<String>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadBeginResult { pub upload_id: String, pub exists: bool }
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadAppendResult { pub received_bytes: u64 }
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadGetResult {
    pub upload_id: String,
    pub size_bytes: u64,
    pub received_bytes: u64,
    pub complete: bool,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UploadErrorReason { Quota, NotFound, Offset, Digest, Size, Invalid }
#[derive(Debug, thiserror::Error, Serialize)]
#[error("{message}")]
#[serde(rename_all = "camelCase")]
pub struct UploadError {
    #[serde(rename = "_tag")]
    tag: &'static str, // constructor always supplies "UploadError"
    pub reason: UploadErrorReason,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub received_bytes: Option<u64>,
}
impl UploadRegistry {
    pub fn new(directory: PathBuf, limits: UploadLimits, now: UploadClock) -> Self;
    pub async fn begin(&self, owner: &UploadOwner, input: UploadBeginInput)
        -> Result<UploadBeginResult, UploadError>;
    pub async fn append(&self, owner: &UploadOwner, input: UploadAppendInput)
        -> Result<UploadAppendResult, UploadError>;
    pub async fn get(&self, owner: &UploadOwner, id: &str)
        -> Result<UploadGetResult, UploadError>;
    pub async fn cancel(&self, owner: &UploadOwner, id: &str) -> Result<(), UploadError>;
    pub async fn sweep(&self) -> Result<(), UploadError>;
    pub fn start_sweeper(&self) -> UploadSweepTask;
}
pub async fn wipe_chat_partials(directory: &Path) -> std::io::Result<()>;
pub struct UploadSweepTask { /* cancellation token and owned join handle */ }
impl UploadSweepTask { pub async fn shutdown(&self); }
impl Drop for UploadSweepTask { fn drop(&mut self); }
// production/uploads_rpc.rs, publicly callable by integration harnesses:
pub fn register_uploads_rpc(registry: &mut RpcRegistry, uploads: UploadRegistry);
```

Keep ID-only decoding private to the handlers. Shared registry metadata uses a short synchronous lock for reservation/removal; each entry has its own async write mutex and a watch sender. No global lock spans disk I/O. Tokio's clock is injected; production passes `Arc::new(tokio::time::Instant::now)`.

- [ ] **Step 1: Write failing engine and schema tests.** Put these complete test bodies in staging.rs with the following test-local helpers (all proposed). Add imports from the API above, `sha2::{Digest, Sha256}`, `base64::{Engine as _, engine::general_purpose::STANDARD}`, `tempfile::TempDir`, `std::{sync::Arc,time::Duration}`.

```rust
fn digest(bytes: &[u8]) -> String { format!("{:x}", Sha256::digest(bytes)) }
fn owner() -> UploadOwner { UploadOwner::Session("owner-a".into()) }
fn target() -> UploadTarget {
    UploadTarget::ChatAttachment {
        attachment_type: "file".into(), name: "notes.txt".into(), mime_type: "text/plain".into(),
    }
}
fn fixture(limits: UploadLimits) -> (TempDir, UploadRegistry) {
    let temp = tempfile::tempdir().unwrap();
    let registry = UploadRegistry::new(temp.path().join("attachment-uploads"), limits,
        Arc::new(tokio::time::Instant::now));
    (temp, registry)
}
async fn begin(r: &UploadRegistry, size: u64, hash: Option<String>) -> String {
    r.begin(&owner(), UploadBeginInput { target: target(), size_bytes: size, sha256: hash })
        .await.unwrap().upload_id
}
fn chunk(id: &str, offset: u64, bytes: &[u8], hash: Option<String>) -> UploadAppendInput {
    UploadAppendInput { upload_id: id.into(), offset, data: STANDARD.encode(bytes), sha256: hash }
}
fn partial(temp: &TempDir, id: &str) -> std::path::PathBuf {
    temp.path().join("attachment-uploads").join(format!("{id}.upload"))
}
#[tokio::test]
async fn acknowledged_bytes_are_flushed_and_completion_requires_digest() {
    let (temp, r) = fixture(UploadLimits::default());
    let id = begin(&r, 6, None).await;
    assert_eq!(r.append(&owner(), chunk(&id, 0, b"abc", None)).await.unwrap().received_bytes, 3);
    assert_eq!(tokio::fs::read(partial(&temp, &id)).await.unwrap(), b"abc");
    let error = r.append(&owner(), chunk(&id, 3, b"def", None)).await.unwrap_err();
    assert_eq!(error.reason, UploadErrorReason::Invalid);
    assert!(!r.get(&owner(), &id).await.unwrap().complete);
    r.append(&owner(), chunk(&id, 3, b"def", Some(digest(b"abcdef")))).await.unwrap();
    let status = r.get(&owner(), &id).await.unwrap();
    assert!(status.complete);
    assert_eq!(status.received_bytes, 6);
    assert_eq!(tokio::fs::read(partial(&temp, &id)).await.unwrap(), b"abcdef");
}
#[tokio::test]
async fn duplicate_does_not_write_and_overlap_reports_the_flushed_offset() {
    let (temp, r) = fixture(UploadLimits::default());
    let id = begin(&r, 6, Some(digest(b"abcdef"))).await;
    r.append(&owner(), chunk(&id, 0, b"abc", None)).await.unwrap();
    assert_eq!(r.append(&owner(), chunk(&id, 0, b"abc", None)).await.unwrap().received_bytes, 3);
    let error = r.append(&owner(), chunk(&id, 2, b"cd", None)).await.unwrap_err();
    assert_eq!(error.reason, UploadErrorReason::Offset);
    assert_eq!(error.received_bytes, Some(3));
    assert_eq!(tokio::fs::read(partial(&temp, &id)).await.unwrap(), b"abc");
}
#[tokio::test(start_paused = true)]
async fn early_chunk_waits_without_holding_its_predecessors_write_lock() {
    let (_temp, r) = fixture(UploadLimits::default());
    let id = begin(&r, 6, Some(digest(b"abcdef"))).await;
    let later_r = r.clone();
    let later_id = id.clone();
    let later = tokio::spawn(async move {
        later_r.append(&owner(), chunk(&later_id, 3, b"def", None)).await
    });
    tokio::task::yield_now().await;
    assert!(!later.is_finished());
    r.append(&owner(), chunk(&id, 0, b"abc", None)).await.unwrap();
    assert_eq!(later.await.unwrap().unwrap().received_bytes, 6);
    assert!(r.get(&owner(), &id).await.unwrap().complete);
}
#[tokio::test(start_paused = true)]
async fn a_gap_times_out_at_ten_seconds_with_the_actual_offset() {
    let (_temp, r) = fixture(UploadLimits::default());
    let id = begin(&r, 6, Some(digest(b"abcdef"))).await;
    let write = tokio::spawn(async move { r.append(&owner(), chunk(&id, 3, b"def", None)).await });
    tokio::task::yield_now().await;
    tokio::time::advance(Duration::from_secs(9)).await;
    assert!(!write.is_finished());
    tokio::time::advance(Duration::from_secs(1)).await;
    let error = write.await.unwrap().unwrap_err();
    assert_eq!(error.reason, UploadErrorReason::Offset);
    assert_eq!(error.received_bytes, Some(0));
}
#[tokio::test]
async fn digest_and_size_mismatches_forget_the_entry_and_remove_the_partial() {
    let (temp, r) = fixture(UploadLimits::default());
    for (size, bytes, expected) in [(3, b"bad".as_slice(), UploadErrorReason::Digest),
                                   (2, b"abc".as_slice(), UploadErrorReason::Size)] {
        let id = begin(&r, size, Some(digest(b"abc"))).await;
        assert_eq!(r.append(&owner(), chunk(&id, 0, bytes, None)).await.unwrap_err().reason, expected);
        assert!(!partial(&temp, &id).exists());
        assert_eq!(r.get(&owner(), &id).await.unwrap_err().reason, UploadErrorReason::NotFound);
    }
}
#[tokio::test]
async fn malformed_base64_and_oversized_chunks_are_typed_and_do_not_write() {
    let (temp, r) = fixture(UploadLimits::default());
    let id = begin(&r, 2 * 1024 * 1024, None).await;
    let mut bad = chunk(&id, 0, b"", None);
    bad.data = "%%%".into();
    assert_eq!(r.append(&owner(), bad).await.unwrap_err().reason, UploadErrorReason::Invalid);
    assert_eq!(tokio::fs::metadata(partial(&temp, &id)).await.unwrap().len(), 0);
    let too_big = vec![0; 1024 * 1024 + 1];
    assert!(r.append(&owner(), chunk(&id, 0, &too_big, None)).await.is_err());
}
#[tokio::test]
async fn declared_byte_and_owner_quotas_are_released_by_cancel() {
    let limits = UploadLimits { chat_per_owner: 2, chat_max_bytes: 4, chat_server_bytes: 6,
        ..UploadLimits::default() };
    let (_temp, r) = fixture(limits);
    let first = begin(&r, 3, None).await;
    let _second = begin(&r, 3, None).await;
    let input = UploadBeginInput { target: target(), size_bytes: 1, sha256: None };
    assert_eq!(r.begin(&owner(), input.clone()).await.unwrap_err().reason, UploadErrorReason::Quota);
    assert_eq!(r.begin(&UploadOwner::Session("b".into()), input.clone()).await.unwrap_err().reason,
        UploadErrorReason::Quota);
    r.cancel(&owner(), &first).await.unwrap();
    assert!(r.begin(&owner(), input).await.is_ok());
    let oversized = UploadBeginInput { target: target(), size_bytes: 5, sha256: None };
    assert_eq!(r.begin(&owner(), oversized).await.unwrap_err().reason, UploadErrorReason::Size);
}
#[tokio::test(start_paused = true)]
async fn idle_and_finished_unbound_uploads_expire_and_get_refreshes_activity() {
    let (temp, r) = fixture(UploadLimits::default());
    let idle = begin(&r, 3, None).await;
    let done = begin(&r, 0, Some(digest(b""))).await;
    let active = begin(&r, 1, None).await;
    tokio::time::advance(Duration::from_secs(599)).await;
    r.get(&owner(), &active).await.unwrap();
    tokio::time::advance(Duration::from_secs(1)).await;
    r.sweep().await.unwrap();
    for id in [idle, done] {
        assert_eq!(r.get(&owner(), &id).await.unwrap_err().reason, UploadErrorReason::NotFound);
        assert!(!partial(&temp, &id).exists());
    }
    assert!(r.get(&owner(), &active).await.is_ok());
}
#[tokio::test]
async fn empty_upload_completes_with_a_digest_at_begin_or_append() {
    let (_temp, r) = fixture(UploadLimits::default());
    let complete = begin(&r, 0, Some(digest(b""))).await;
    assert!(r.get(&owner(), &complete).await.unwrap().complete);
    let later = begin(&r, 0, None).await;
    assert!(!r.get(&owner(), &later).await.unwrap().complete);
    r.append(&owner(), chunk(&later, 0, b"", Some(digest(b"")))).await.unwrap();
    assert!(r.get(&owner(), &later).await.unwrap().complete);
}
#[tokio::test]
async fn another_owner_is_indistinguishable_from_an_unknown_id_and_cancel_is_idempotent() {
    let (temp, r) = fixture(UploadLimits::default());
    let id = begin(&r, 3, None).await;
    let other = UploadOwner::Session("other".into());
    assert_eq!(r.get(&other, &id).await.unwrap_err().reason, UploadErrorReason::NotFound);
    assert_eq!(r.append(&other, chunk(&id, 0, b"abc", Some(digest(b"abc")))).await.unwrap_err().reason,
        UploadErrorReason::NotFound);
    r.cancel(&other, &id).await.unwrap(); // same no-op success as an unknown id
    assert!(partial(&temp, &id).exists());
    r.cancel(&owner(), &id).await.unwrap();
    r.cancel(&owner(), &id).await.unwrap();
    assert!(!partial(&temp, &id).exists());
}
#[tokio::test]
async fn startup_wipe_removes_only_chat_partial_leaves() {
    let (temp, r) = fixture(UploadLimits::default());
    let id = begin(&r, 3, None).await;
    let attachment_dir = temp.path().join("attachments");
    tokio::fs::create_dir(&attachment_dir).await.unwrap();
    tokio::fs::write(attachment_dir.join("bound-id"), b"kept").await.unwrap();
    drop(r);
    wipe_chat_partials(&temp.path().join("attachment-uploads")).await.unwrap();
    assert!(!partial(&temp, &id).exists());
    assert_eq!(tokio::fs::read(attachment_dir.join("bound-id")).await.unwrap(), b"kept");
}
```

Full schema bodies in uploads.test.ts (existing `@effect/vitest` and Schema test style):

```ts
it("validates the chat target, digest and declared size", () => {
  const input = { target: { _tag: "chat-attachment", type: "file", name: "a.txt", mimeType: "text/plain" },
    sizeBytes: 3, sha256: "a".repeat(64) };
  expect(Schema.decodeUnknownSync(UploadBeginInput)(input)).toEqual(input);
  expect(Schema.is(UploadBeginInput)({ ...input, sha256: "A".repeat(64) })).toBe(false);
  expect(Schema.is(UploadBeginInput)({ ...input, sha256: "a".repeat(63) })).toBe(false);
  expect(Schema.is(UploadBeginInput)({ ...input, sizeBytes: -1 })).toBe(false);
  expect(Schema.is(UploadBeginInput)({ ...input, target: { ...input.target, _tag: "other" } })).toBe(false);
});
it("accepts empty chunks and enforces the encoded chunk boundary", () => {
  const input = { uploadId: "u-1", offset: 0, data: "" };
  expect(Schema.decodeUnknownSync(UploadAppendInput)(input)).toEqual(input);
  expect(Schema.is(UploadAppendInput)({ ...input, data: "A".repeat(1_398_104) })).toBe(true);
  expect(Schema.is(UploadAppendInput)({ ...input, data: "A".repeat(1_398_105) })).toBe(false);
  for (const offset of [-1, 0.5]) expect(Schema.is(UploadAppendInput)({ ...input, offset })).toBe(false);
});
it("decodes offset details and an idempotent cancel result", () => {
  const error = Schema.decodeUnknownSync(UploadError)({ _tag: "UploadError", reason: "offset",
    message: "Upload offset changed.", receivedBytes: 65536 });
  expect(error.receivedBytes).toBe(65536);
  expect(Schema.decodeUnknownSync(UploadCancelResult)({})).toEqual({});
});
```

Additional complete lifecycle/error bodies in staging.rs reuse the helpers above:

```rust
#[tokio::test(start_paused = true)]
async fn begin_sweeps_expired_reservations_before_checking_quota() {
    let (_temp, r) = fixture(UploadLimits { chat_per_owner: 1, ..UploadLimits::default() });
    let old = begin(&r, 1, None).await;
    tokio::time::advance(Duration::from_secs(600)).await;
    let fresh = begin(&r, 1, None).await;
    assert_ne!(old, fresh);
    assert_eq!(r.get(&owner(), &old).await.unwrap_err().reason, UploadErrorReason::NotFound);
}
#[tokio::test(start_paused = true)]
async fn sweep_task_releases_idle_files_and_shutdown_joins_it() {
    let (temp, r) = fixture(UploadLimits::default());
    let id = begin(&r, 1, None).await;
    let task = r.start_sweeper();
    tokio::task::yield_now().await;
    tokio::time::advance(Duration::from_secs(660)).await;
    tokio::time::resume(); // wait for real filesystem completion after advancing the idle clock
    tokio::time::timeout(Duration::from_secs(5), async {
        while partial(&temp, &id).exists() {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    }).await.unwrap();
    task.shutdown().await;
    assert!(!partial(&temp, &id).exists());
    task.shutdown().await; // idempotent cancellation/join
}
#[tokio::test]
async fn unknown_foreign_and_expired_errors_do_not_disclose_ownership() {
    let (_temp, r) = fixture(UploadLimits::default());
    let id = begin(&r, 1, None).await;
    let foreign = r.get(&UploadOwner::Session("foreign".into()), &id).await.unwrap_err();
    let unknown = r.get(&owner(), "missing").await.unwrap_err();
    r.cancel(&owner(), &id).await.unwrap();
    let gone = r.get(&owner(), &id).await.unwrap_err();
    assert_eq!(serde_json::to_value(&foreign).unwrap(), serde_json::to_value(&unknown).unwrap());
    assert_eq!(serde_json::to_value(&gone).unwrap(), serde_json::to_value(&unknown).unwrap());
}
```

- [ ] **Step 2: Write the authenticated wire test.** Append to `e2ee_ws.rs`, reusing its existing Noise/socket helpers. Follow `established_capacity_is_partitioned_by_principal_and_released_on_close`: exchange the single-use startup grant once for an admin token, issue two distinct pairing grants through `/api/auth/pairing-token`, then mint two E2EE sessions. Add this test-local helper and body; neither prints credentials.

```rust
async fn upload_call(socket: &mut TestSocket, transport: &mut TransportState,
    id: &str, tag: &str, payload: Value) -> Value {
    send_encrypted(socket, transport, json!({"_tag":"Request", "id":id, "tag":tag,
        "payload":payload, "headers":[]}).to_string().as_bytes()).await;
    loop {
        let value = recv_encrypted_json(socket, transport).await;
        if value["requestId"] == id { return value; }
    }
}
#[tokio::test]
async fn uploads_resume_for_the_same_credential_but_refuse_another_session() {
    let _permit = TEST_PERMIT.acquire().await.unwrap();
    let temp = TempDir::new().unwrap();
    let handle = start_server(&temp).await;
    let client = Client::new();
    let startup = handle.startup_access().unwrap();
    let admin = exchange_plain_token(&client, &handle, &startup.credential).await;
    let first_pairing = client.post(http_url(&handle, "/api/auth/pairing-token"))
        .bearer_auth(&admin).json(&json!({"label":"first principal"}))
        .send().await.unwrap().json::<Value>().await.unwrap()["credential"]
        .as_str().unwrap().to_owned();
    let second_pairing = client.post(http_url(&handle, "/api/auth/pairing-token"))
        .bearer_auth(&admin).json(&json!({"label":"second principal"}))
        .send().await.unwrap().json::<Value>().await.unwrap()["credential"]
        .as_str().unwrap().to_owned();
    let first = mint_e2ee_credential(&handle, temp.path(), &first_pairing).await;
    let second = mint_e2ee_credential(&handle, temp.path(), &second_pairing).await;
    let host = read_host_public_key(temp.path());
    let (mut a, mut ta, _) = open_authenticated_bearer_socket(&handle, &host, &first).await;
    let begun = upload_call(&mut a, &mut ta, "10", "uploads.begin", json!({
        "target":{"_tag":"chat-attachment","type":"file","name":"a.txt","mimeType":"text/plain"},
        "sizeBytes":3
    })).await;
    assert_eq!(begun["exit"]["_tag"], "Success");
    let id = begun["exit"]["value"]["uploadId"].as_str().unwrap().to_owned();
    a.close(None).await.unwrap();
    let (mut a, mut ta, _) = open_authenticated_bearer_socket(&handle, &host, &first).await;
    assert_eq!(upload_call(&mut a, &mut ta, "11", "uploads.get", json!({"uploadId":id})).await
        ["exit"]["_tag"], "Success");
    let (mut b, mut tb, _) = open_authenticated_bearer_socket(&handle, &host, &second).await;
    for (tag, payload) in [
        ("uploads.get", json!({"uploadId":id})),
        ("uploads.append", json!({"uploadId":id,"offset":0,"data":"YWJj"})),
    ] {
        let reply = upload_call(&mut b, &mut tb, "12", tag, payload).await;
        assert_eq!(reply["exit"]["cause"][0]["error"]["_tag"], "UploadError");
        assert_eq!(reply["exit"]["cause"][0]["error"]["reason"], "not_found");
    }
    a.close(None).await.unwrap();
    b.close(None).await.unwrap();
    handle.shutdown();
    handle.join().await.unwrap();
}
```

- [ ] **Step 3: Run red.** `cargo test -p bibcode-server --lib transfer::staging`; `cargo test -p bibcode-server --test e2ee_ws uploads_resume`; `node scripts/run-local-vp.mjs test run packages/contracts/src/uploads.test.ts`. Expected: missing module/schema/handler, then typed assertions fail until the engine is wired. Record the intended failure, not an unrelated tool error.
- [ ] **Step 4: Implement the engine.** Reserve quota atomically before creating a file; roll back reservations on I/O failure. Use cryptographically unpredictable UUID upload IDs, `create_new`, checked offset arithmetic and bounded base64 decoding. Validate claimed size and metadata before allocation. Decode at most one chunk per active write; do not keep decoded future chunks while waiting.
- [ ] **Step 5: Implement ordering/completion.** Subscribe to the watch channel before checking a future offset; drop the write mutex while waiting, recheck on wake, and enforce a 10 s total gap wait. Publish receivedBytes only after flush and hash update. Overlap fails immediately; a future gap that never fills fails offset. Terminal digest/declared-size mismatch forgets entry and deletes partial. Missing final digest is `invalid` before writing that completing chunk, permitting a corrected append. Zero-byte finalization precedes duplicate short-circuiting. Late conflicting digest is refused. Wake all waiters on cancel/expiry.
- [ ] **Step 6: Wire lifecycle and RPC.** Add the new StatePaths directory, wipe its owned partial leaves before accepting requests, and add the sweeper beside provider checks with Skip ticks and cancellation/join at quiesce. Do not follow symlinks or scan arbitrary workspace folders. Register real context handlers publicly; maps/identity stay private. `append/get` on foreign owner return `not_found`; `cancel` returns `{}` for already absent or inaccessible IDs without touching another owner's file. All four methods require operate; only get is read_unary. No capability is advertised yet.
- [ ] **Step 7: Run green and contract workflow.** Repeat Step 3; then `cargo test -p bibcode-server --lib`, `cargo test -p bibcode-server --test e2ee_ws`, `cargo test -p bibcode-server --test rpc_wire`, `cargo test -p bibcode-server --test server_runtime`; run the contract fixture workflow and `vp run check:contracts`. Add sweep-shutdown, begin-triggered expiry and concurrent quota-reservation assertions before declaring green.
- [ ] **Step 8: Update docs.** Add “Attachment staging”: method shapes, operate scope, session ownership, ordering, disk acknowledgement, chat quotas, sweep and restart cleanup. Say the capability remains off until binding exists. Review cross-platform and platform runbooks for this new non-UI seam; if their commands remain accurate, state **reviewed and remain accurate**.
- [ ] **Step 9: Gates.** `cargo fmt --all --check`; `cargo clippy -p bibcode-server --all-targets -- -D warnings`; `vp check`; `vp run typecheck`. Inspect fixture diffs/counts and the final status, without staging.
- [ ] **Step 10: Live.** With isolated A on 4902, run `node "$S/live/rpc-check.ts" stage --endpoint http://localhost:4903`. Begin, append two chunks, get exact bytes, cancel twice; then complete with a bad digest and verify not_found. Authentication comes from the private credential file, not command-line tokens. No visible feature exists yet, so screenshots are not applicable.
- [ ] **Step 11: Stop: READY hand-off to the controller; do not commit.**

### Task 2: Bind staged attachments at durable turn admission

**Commit subject:** `feat(server,contracts): bind staged attachments when a turn starts`

**Files:**
- Modify: `packages/contracts/src/orchestration.ts:199-233`, `packages/contracts/src/environment.ts:30-63`, their existing tests and RPC fixtures/counts.
- Modify: `apps/web/src/composerDraftStore.ts:83`, `apps/web/src/composerDraftStore.test.ts`; `packages/shared/src/testSupport.ts:27` and capability literals identified by typecheck.
- Modify: `apps/server/src/provider/attachments.rs:62-125,160-171,210-290,550-614`; `apps/server/src/production/orchestration_rpc.rs:84-124,504-710,792-809`.
- Modify: Task 1's `transfer/staging.rs`; `apps/server/src/production/runtime.rs` only the registration argument; `apps/server/src/lifecycle.rs:48-69,995-1006`, `apps/server/src/production/control.rs:2312-2348,5933-5977`.
- Modify: `apps/server/tests/turn_delivery_recovery.rs`, `apps/server/tests/production_provider_runtime.rs` (fixture-owned `UploadRegistry` values for every changed registration caller).
- Test: existing attachment and orchestration RPC unit modules; `packages/contracts/src/orchestration.test.ts`, `packages/contracts/src/environment.test.ts`.
- Docs: `docs/architecture/rpc-and-orchestration.md`, `docs/architecture/remote.md`.

**Interfaces — consumes:** Task 1 `UploadRegistry`, `UploadOwner`, complete chat stages; existing `PreparedAttachmentBatch`, durable command reservation and provider delivery.

**Interfaces — produces (proposed TypeScript changes):** Preserve existing inline export names. Add `uploadId: Schema.optional(Schema.Never)` to each inline schema so an ambiguous input cannot be silently accepted by union decoding. Use the existing metadata schemas' fields rather than copying validation.

```ts
export const InlineUploadChatAttachment = Schema.Union([
  UploadChatImageAttachment, UploadChatFileAttachment,
]);
export type InlineUploadChatAttachment = typeof InlineUploadChatAttachment.Type;
export const StagedUploadChatImageAttachment = Schema.Struct({
  ...ChatImageAttachment.fields,
  uploadId: UploadId,
  dataUrl: Schema.optional(Schema.Never),
});
export type StagedUploadChatImageAttachment = typeof StagedUploadChatImageAttachment.Type;
export const StagedUploadChatFileAttachment = Schema.Struct({
  ...ChatFileAttachment.fields,
  uploadId: UploadId,
  dataUrl: Schema.optional(Schema.Never),
});
export type StagedUploadChatFileAttachment = typeof StagedUploadChatFileAttachment.Type;
export const StagedUploadChatAttachment = Schema.Union([
  StagedUploadChatImageAttachment, StagedUploadChatFileAttachment,
]);
export type StagedUploadChatAttachment = typeof StagedUploadChatAttachment.Type;
export const UploadChatAttachment = Schema.Union([
  InlineUploadChatAttachment, StagedUploadChatAttachment,
]);
export type UploadChatAttachment = typeof UploadChatAttachment.Type;
// In ExecutionEnvironmentCapabilities:
attachmentStaging: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
// In composerDraftStore.ts, importing the inline-only union:
export const PersistedComposerAttachment = InlineUploadChatAttachment;
```

**Interfaces — produces (proposed Rust changes):**

```rust
// transfer/staging.rs: opaque guard owns the entry write lock until commit/drop.
pub(crate) struct UploadBinding { /* upload id, registry, locked complete entry */ }
impl UploadRegistry {
    pub(crate) async fn bind_chat(&self, owner: &UploadOwner, id: &str,
        metadata: &UploadTarget, size_bytes: u64) -> Result<UploadBinding, UploadError>;
}
impl UploadBinding {
    pub(crate) fn path(&self) -> &Path;
    pub(crate) fn digest(&self) -> &str;
    pub(crate) fn commit(self);
}
// provider/attachments.rs: add upload_id: Option<String> to AttachmentInput.
impl AttachmentMaterializer {
    pub(crate) async fn prepare(&self, attachments: Vec<Value>, reusable: &ReusableAttachments,
        owner: &UploadOwner, uploads: &UploadRegistry)
        -> Result<PreparedAttachmentBatch, AttachmentMaterializationError>;
}
// PreparedAttachmentBatch adds bound_uploads: Vec<UploadBinding>.
// Its existing synchronous commit(self) commits guards; Drop only unlocks them.
// ProviderRegistration adds uploads: UploadRegistry.
pub fn register_orchestration_rpc_with_delivery(
    registry: &mut RpcRegistry, engine: OrchestrationEngine,
    provider: Arc<ProviderRuntimeSupervisor>, settings_root: PathBuf,
    turn_delivery: Arc<TurnDeliveryService>, uploads: UploadRegistry,
);
pub fn register_orchestration_rpc_with_delivery_and_availability(
    registry: &mut RpcRegistry, engine: OrchestrationEngine,
    provider: Arc<ProviderRuntimeSupervisor>, settings_root: PathBuf,
    turn_delivery: Arc<TurnDeliveryService>, availability: WorkspaceAvailabilityRegistry,
    uploads: UploadRegistry,
);
```

Private `dispatch_turn_command`, `dispatch_reserved_turn_command`, `prepare_attachments` and the test helper `dispatch_turn_for_test` gain a final `owner: &UploadOwner` argument; clone an owned `UploadOwner` into async move handlers. `prepare_attachments` also receives `&UploadRegistry`. Non-provider registration is unchanged. Pass one registry shared with `uploads.*`, never create a second runtime registry for binding.

- [ ] **Step 1: Write schema/draft tests red.** Full bodies below go in their named existing files, with `Schema`, the relevant schema imports, `it` and `expect` from the existing test style.

```ts
// orchestration.test.ts
it("decodes staged image and file inputs and refuses two byte sources", () => {
  for (const [type, mimeType] of [["image", "image/png"], ["file", "text/plain"]]) {
    const staged = { type, id: "a-1", name: "a", mimeType, sizeBytes: 3, uploadId: "stage-1" };
    expect(Schema.decodeUnknownSync(UploadChatAttachment)(staged)).toEqual(staged);
    expect(Schema.is(UploadChatAttachment)({ ...staged, dataUrl: "data:text/plain;base64,YWJj" }))
      .toBe(false);
    const { uploadId: _, ...metadata } = staged;
    expect(Schema.is(InlineUploadChatAttachment)({ ...metadata, dataUrl: `data:${mimeType};base64,YWJj` }))
      .toBe(true);
  }
});
// composerDraftStore.test.ts
it("does not persist an upload id in an attachment draft", () => {
  const staged = { type: "file", id: "a-1", name: "a.txt", mimeType: "text/plain",
    sizeBytes: 3, uploadId: "stage-1" };
  expect(Schema.is(PersistedComposerAttachment)(staged)).toBe(false);
  expect(Schema.is(PersistedComposerAttachment)({ ...staged, dataUrl: "data:text/plain;base64,YWJj" }))
    .toBe(false);
  const { uploadId: _, ...metadata } = staged;
  expect(Schema.is(PersistedComposerAttachment)({ ...metadata, dataUrl: "data:text/plain;base64,YWJj" }))
    .toBe(true);
});
// environment.test.ts
it("defaults attachment staging off for an older descriptor", () => {
  expect(Schema.decodeUnknownSync(ExecutionEnvironmentCapabilities)({}).attachmentStaging).toBe(false);
  expect(Schema.decodeUnknownSync(ExecutionEnvironmentCapabilities)({ attachmentStaging: true })
    .attachmentStaging).toBe(true);
});
```

- [ ] **Step 2: Write materializer tests red.** Proposed helpers and complete bodies in attachments.rs; import Task 1's types. Existing `ReusableAttachments::new()` remains the reuse authority.

```rust
fn upload_fixture() -> (tempfile::TempDir, UploadRegistry, AttachmentMaterializer, UploadOwner) {
    let temp = tempfile::tempdir().unwrap();
    let uploads = UploadRegistry::new(temp.path().join("attachment-uploads"), UploadLimits::default(),
        Arc::new(tokio::time::Instant::now));
    let materializer = AttachmentMaterializer::new(temp.path().join("attachments"));
    (temp, uploads, materializer, UploadOwner::Session("a".into()))
}
async fn stage_notes(uploads: &UploadRegistry, owner: &UploadOwner, complete: bool) -> Value {
    let begun = uploads.begin(owner, UploadBeginInput {
        target: UploadTarget::ChatAttachment { attachment_type: "file".into(), name: "notes.txt".into(),
            mime_type: "text/plain".into() }, size_bytes: 5, sha256: None,
    }).await.unwrap();
    if complete {
        uploads.append(owner, UploadAppendInput { upload_id: begun.upload_id.clone(), offset: 0,
            data: STANDARD.encode(b"notes"), sha256: Some(crate::crypto::sha256_hex(b"notes")) })
            .await.unwrap();
    }
    json!({"type":"file", "id":"notes-1", "name":"notes.txt", "mimeType":"text/plain",
        "sizeBytes":5, "uploadId":begun.upload_id})
}
#[tokio::test]
async fn staged_binding_rolls_back_without_consuming_bytes_and_commit_releases_them() {
    let (temp, uploads, m, owner) = upload_fixture();
    let input = stage_notes(&uploads, &owner, true).await;
    let id = input["uploadId"].as_str().unwrap();
    let batch = m.prepare(vec![input.clone()], &ReusableAttachments::new(), &owner, &uploads)
        .await.unwrap();
    assert_eq!(tokio::fs::read(temp.path().join("attachments/notes-1")).await.unwrap(), b"notes");
    assert!(batch.attachments()[0].get("uploadId").is_none());
    assert!(batch.attachments()[0].get("dataUrl").is_none());
    drop(batch);
    assert!(!temp.path().join("attachments/notes-1").exists());
    assert!(uploads.get(&owner, id).await.unwrap().complete);
    let batch = m.prepare(vec![input.clone()], &ReusableAttachments::new(), &owner, &uploads)
        .await.unwrap();
    let prepared = batch.attachments().to_vec();
    batch.commit();
    assert_eq!(uploads.get(&owner, id).await.unwrap_err().reason, UploadErrorReason::NotFound);
    assert!(!temp.path().join("attachment-uploads").join(format!("{id}.upload")).exists());
    let delivered = m.materialize(prepared).await.unwrap();
    assert_eq!(STANDARD.decode(&delivered[0].base64_data).unwrap(), b"notes");
}
#[tokio::test]
async fn staged_binding_refuses_incomplete_foreign_and_changed_metadata() {
    let (_temp, uploads, m, owner) = upload_fixture();
    let unfinished = stage_notes(&uploads, &owner, false).await;
    assert!(m.prepare(vec![unfinished], &ReusableAttachments::new(), &owner, &uploads).await.is_err());
    let input = stage_notes(&uploads, &owner, true).await;
    let other = UploadOwner::Session("other".into());
    assert!(m.prepare(vec![input.clone()], &ReusableAttachments::new(), &other, &uploads).await.is_err());
    for (field, value) in [("sizeBytes", json!(4)), ("name", json!("other.txt")),
        ("mimeType", json!("application/octet-stream")), ("type", json!("image"))] {
        let mut changed = input.clone();
        changed[field] = value;
        assert!(m.prepare(vec![changed], &ReusableAttachments::new(), &owner, &uploads).await.is_err());
    }
    assert!(uploads.get(&owner, input["uploadId"].as_str().unwrap()).await.unwrap().complete);
}
#[tokio::test]
async fn staged_binding_refuses_null_or_two_sources_before_the_reuse_branch() {
    let (_temp, uploads, m, owner) = upload_fixture();
    let input = stage_notes(&uploads, &owner, true).await;
    for source in [json!(null), json!("data:text/plain;base64,bm90ZXM=")] {
        let mut ambiguous = input.clone();
        ambiguous["dataUrl"] = source;
        assert!(m.prepare(vec![ambiguous], &ReusableAttachments::new(), &owner, &uploads).await.is_err());
    }
    let mut invalid = input.clone();
    invalid["uploadId"] = Value::Null;
    assert!(m.prepare(vec![invalid], &ReusableAttachments::new(), &owner, &uploads).await.is_err());
    assert!(m.prepare(vec![input], &ReusableAttachments::new(), &owner, &uploads).await.is_ok());
}
```

- [ ] **Step 3: Pin durable rollback/retry with the same command ID.** In orchestration_rpc.rs, use existing `delivery_engine`, `provider_registration`, `decode_command`, `TestHooks`, `CREATED_AT`; extend `provider_registration` to accept the shared registry. Copy `stage_notes` above into this test module. The fake delivery router materializes the same stored bytes that a provider driver receives.

```rust
#[tokio::test]
async fn failed_staged_turn_retries_the_same_command_without_appending_again() {
    let hooks = TestHooks::default();
    let (database, engine, thread_id) = delivery_engine(hooks.clone()).await;
    let state = tempfile::tempdir().unwrap();
    let uploads = UploadRegistry::new(state.path().join("attachment-uploads"), UploadLimits::default(),
        Arc::new(tokio::time::Instant::now));
    let owner = UploadOwner::Session("sender".into());
    let input = stage_notes(&uploads, &owner, true).await;
    let upload_id = input["uploadId"].as_str().unwrap().to_owned();
    let (sent, mut received) = tokio::sync::mpsc::channel(1);
    let root = state.path().join("attachments");
    let delivery = Arc::new(TurnDeliveryService::start_with_router(engine.clone(), 1,
        Arc::new(move |command| {
            let sent = sent.clone();
            let root = root.clone();
            Box::pin(async move {
                let OrchestrationCommand::ThreadTurnStart { message, .. } = command else {
                    panic!("expected turn start");
                };
                let images = AttachmentMaterializer::new(root).materialize(message.attachments).await.unwrap();
                sent.send(images[0].base64_data.clone()).await.unwrap();
                Ok(())
            })
        })));
    let (registration, provider) = provider_registration(database, &engine,
        state.path().to_path_buf(), delivery.clone(), uploads.clone());
    let command = decode_command(json!({"type":"thread.turn.start", "commandId":"staged-retry",
        "threadId":thread_id, "message":{"messageId":"m-staged", "role":"user", "text":"review",
        "attachments":[input]}, "modelSelection":{"instanceId":"codex","model":"gpt-5"},
        "createdAt":CREATED_AT}));
    let digest = canonical_command_digest(&command).unwrap();
    hooks.fail_next_projector("projection.thread-messages", Some("thread.message-sent"));
    let failed = dispatch_turn_for_test(engine.clone(), registration.clone(), command.clone(),
        digest.clone(), "orchestration.dispatchCommand".into(), None, &owner).await;
    assert!(failed.is_err());
    assert!(uploads.get(&owner, &upload_id).await.unwrap().complete);
    assert!(!state.path().join("attachments/notes-1").exists());
    assert!(received.try_recv().is_err());
    dispatch_turn_for_test(engine.clone(), registration, command, digest,
        "orchestration.dispatchCommand".into(), None, &owner).await.unwrap();
    let encoded = tokio::time::timeout(Duration::from_secs(5), received.recv()).await.unwrap().unwrap();
    assert_eq!(STANDARD.decode(encoded).unwrap(), b"notes");
    assert_eq!(uploads.get(&owner, &upload_id).await.unwrap_err().reason, UploadErrorReason::NotFound);
    delivery.shutdown().await;
    provider.shutdown().await.unwrap();
    engine.shutdown().await;
}
```

Use this full queued-admission body beside that test; it follows the existing queued-admission setup. Promotion/provider delivery remains covered by the durable router test above and the existing queue suite.

```rust
#[tokio::test]
async fn queued_staged_turn_binds_before_enqueue_and_keeps_only_durable_metadata() {
    let (database, engine, thread_id) = delivery_engine(TestHooks::default()).await;
    engine.dispatch(decode_command(json!({"type":"thread.session.set", "commandId":"session",
        "threadId":thread_id, "session":{"threadId":thread_id,"status":"running",
        "providerName":"codex","activeTurnId":null,"lastError":null,"updatedAt":CREATED_AT},
        "createdAt":CREATED_AT}))).await.unwrap();
    let state = tempfile::tempdir().unwrap();
    let uploads = UploadRegistry::new(state.path().join("attachment-uploads"), UploadLimits::default(),
        Arc::new(tokio::time::Instant::now));
    let owner = UploadOwner::Session("sender".into());
    let input = stage_notes(&uploads, &owner, true).await;
    let id = input["uploadId"].as_str().unwrap().to_owned();
    let service = Arc::new(TurnDeliveryService::start_with_router(engine.clone(), 1,
        Arc::new(|_| Box::pin(async { Ok(()) }))));
    service.shutdown().await; // inspect durable admission before any delivery worker
    let (registration, provider) = provider_registration(database, &engine,
        state.path().to_path_buf(), service, uploads.clone());
    let command = decode_command(json!({"type":"thread.turn.start","commandId":"queued-stage",
        "threadId":thread_id,"queued":true,"message":{"messageId":"queued-stage-message",
        "role":"user","text":"later","attachments":[input]},"createdAt":CREATED_AT}));
    let digest = canonical_command_digest(&command).unwrap();
    dispatch_turn_for_test(engine.clone(), registration, command, digest,
        "orchestration.dispatchCommand".into(), None, &owner).await.unwrap();
    let row = engine.repositories().get_provider_turn_delivery("queued-stage".into())
        .await.unwrap().unwrap();
    assert_eq!(row.state, TurnDeliveryState::Queued);
    let attachments = row.payload["message"]["attachments"].as_array().unwrap();
    assert!(attachments[0].get("uploadId").is_none());
    assert!(attachments[0].get("dataUrl").is_none());
    assert_eq!(uploads.get(&owner, &id).await.unwrap_err().reason, UploadErrorReason::NotFound);
    let ready = AttachmentMaterializer::new(state.path().join("attachments"))
        .materialize(attachments.clone()).await.unwrap();
    assert_eq!(STANDARD.decode(&ready[0].base64_data).unwrap(), b"notes");
    provider.shutdown().await.unwrap();
    engine.shutdown().await;
}
```

Full publication/race bodies in attachments.rs use its new test-only
`fn with_forced_copy_for_test(self) -> Self` hook (route only the staged hard-link
attempt through an injected unsupported-filesystem error). Production retains no switch.

```rust
#[tokio::test]
async fn copy_fallback_and_adopted_finals_preserve_rollback_ownership() {
    let (temp, uploads, materializer, owner) = upload_fixture();
    let m = materializer.with_forced_copy_for_test();
    let first = stage_notes(&uploads, &owner, true).await;
    m.prepare(vec![first], &ReusableAttachments::new(), &owner, &uploads).await.unwrap().commit();
    let second = stage_notes(&uploads, &owner, true).await;
    let batch = m.prepare(vec![second.clone()], &ReusableAttachments::new(), &owner, &uploads).await.unwrap();
    drop(batch); // identical pre-existing final was adopted, not created by this batch
    assert_eq!(tokio::fs::read(temp.path().join("attachments/notes-1")).await.unwrap(), b"notes");
    assert!(uploads.get(&owner, second["uploadId"].as_str().unwrap()).await.unwrap().complete);
    tokio::fs::write(temp.path().join("attachments/notes-1"), b"other").await.unwrap();
    assert!(m.prepare(vec![second], &ReusableAttachments::new(), &owner, &uploads).await.is_err());
    assert_eq!(tokio::fs::read(temp.path().join("attachments/notes-1")).await.unwrap(), b"other");
}
#[tokio::test(start_paused = true)]
async fn a_bound_upload_cannot_expire_out_from_under_a_committing_batch() {
    let (temp, uploads, m, owner) = upload_fixture();
    let input = stage_notes(&uploads, &owner, true).await;
    let id = input["uploadId"].as_str().unwrap().to_owned();
    let batch = m.prepare(vec![input], &ReusableAttachments::new(), &owner, &uploads).await.unwrap();
    tokio::time::advance(Duration::from_secs(601)).await;
    let sweep_registry = uploads.clone();
    let sweep = tokio::spawn(async move { sweep_registry.sweep().await });
    tokio::task::yield_now().await;
    batch.commit(); // sweep may skip a locked binding or wait; it cannot delete its final
    sweep.await.unwrap().unwrap();
    assert_eq!(tokio::fs::read(temp.path().join("attachments/notes-1")).await.unwrap(), b"notes");
    assert_eq!(uploads.get(&owner, &id).await.unwrap_err().reason, UploadErrorReason::NotFound);
}
```

Parameterize accepted delivery for image/file; reuse the same fixture with image/png
metadata and exact bytes. For the Cancel race replace sweep with owner cancel and
assert the same final-file invariant if commit wins, or retained upload on rollback
until cancel acquires the guard. Both races operate on the same per-entry lock.

- [ ] **Step 4: Run red.** `cargo test -p bibcode-server --lib staged`; `node scripts/run-local-vp.mjs test run packages/contracts/src/orchestration.test.ts packages/contracts/src/environment.test.ts`; `(cd apps/web && vp test run --project unit src/composerDraftStore.test.ts)`. Expected: missing staged schemas/API, then missing transactional semantics. The capability JSON assertions must initially fail.
- [ ] **Step 5: Implement binding.** Test raw presence of `uploadId` before decoding/reuse; reject `dataUrl` and `uploadId` together even when either is null. Under the root transaction acquire a completed owner-bound guard, verify all metadata and digest, publish by hard link or bounded copy. Refactor the publication helper so identical existing finals are adopted without ownership; remove only a final this batch created. Preserve the upload's stage during every rollback. Batch commit forgets the entry and deletes its stage, synchronously as the existing commit callback requires; log a cleanup failure and keep it sweepable rather than undo a durable turn. Never await disk work under the global registry map lock.
- [ ] **Step 6: Carry owner and advertise.** Switch dispatch to context registration, derive session owner once, pass through both direct/queued paths. Update every `register_orchestration_rpc_with_delivery*` caller, including the registration unit tests and both listed integration fixtures, to pass a fixture-owned `UploadRegistry`; production shares Task 1's registry. Accepted replays still bypass preparation. Add `attachmentStaging: true` beside `vcsCloneReattach` to both JSON descriptor producers and their tests. Leave HTTP's typed descriptor unchanged. Fix typechecked capability literals with false unless the fixture explicitly advertises the behavior. No `inChannelTransfers` yet.
- [ ] **Step 7: Green and gates.** Repeat red commands; run `cargo test -p bibcode-server --lib`, `cargo test -p bibcode-server --test rpc_wire`, `cargo test -p bibcode-server --test server_runtime`, `cargo test -p bibcode-server --test turn_delivery_recovery`, `cargo test -p bibcode-server --test production_provider_runtime`; the full web unit project for the draft schema change. Regenerate fixtures and run `vp run check:contracts` under the documented diff qualification. Run `cargo fmt --all --check`, server Clippy with warnings denied, `vp check`, `vp run typecheck`.
- [ ] **Step 8: Docs.** Complete “Attachment staging”: binding, rollback, capability and legacy inline fallback. At rpc-and-orchestration's wire paragraph distinguish unchanged transport request framing from attachments carried by several acknowledged RPCs; add staged admission beside its by-id rules. Add remote.md's statement that staging stays within E2EE and adds no HTTP audit exception. Review the runbooks; no new UI flow here, so record **reviewed and remain accurate** if unchanged.
- [ ] **Step 9: Live.** Run `node "$S/live/rpc-check.ts" bind --endpoint http://localhost:4903` with a valid 3 MiB image and protocol fake provider. Verify durable attachment metadata has no dataUrl/uploadId, the fake sees matching bytes, and get returns not_found after acceptance. No progress UI yet; screenshots are not applicable.
- [ ] **Step 10: Stop: READY hand-off to the controller; do not commit.**

### Task 3: Prove staged uploads stay live over a throttled uplink

**Commit subject:** `test(server): cover staged uploads over slow uplinks`

**Files:** Modify/test `apps/server/tests/rpc_liveness.rs:80-98,116-198`; no production source or docs changes.

**Interfaces — consumes:** Task 1's public `register_uploads_rpc` and `UploadRegistry`; existing `Mode::{PlainSplit, Encrypted}`, Noise and plain helpers, observed liveness state.

**Interfaces — produces (test-local Rust signatures):**

```rust
impl ThrottleProxy {
    async fn start(target: SocketAddr, down_bytes_per_second: u64) -> Self;
    async fn start_duplex(target: SocketAddr, down_bytes_per_second: u64,
        up_bytes_per_second: u64) -> Self;
}
async fn staged_upload_trial(mode: Mode, up_bytes_per_second: u64);
async fn inline_upload_trial(mode: Mode, up_bytes_per_second: u64) -> InlineTrialOutcome;
struct InlineTrialOutcome {
    client_liveness_close: Option<u16>,
    server_reaped: bool,
    elapsed: Duration,
}
```

`start` delegates with unlimited upstream so existing tests keep their rates. Each direction owns its timer and bounded buffer; zero means unlimited, and thaw resets the deadline. No ownership assertion belongs in this unauthenticated harness.

- [ ] **Step 1: Add tests and their key assertions.**

```rust
#[tokio::test]
async fn staged_three_mib_uploads_survive_plain_and_encrypted_slow_uplinks() {
    for mode in [Mode::PlainSplit, Mode::Encrypted] {
        staged_upload_trial(mode, 64 * 1024).await;
    }
}
#[tokio::test]
async fn inline_three_mib_upload_records_the_existing_residual() {
    let plain = inline_upload_trial(Mode::PlainSplit, 64 * 1024).await;
    assert!(plain.server_reaped);
    let encrypted = inline_upload_trial(Mode::Encrypted, 64 * 1024).await;
    // Persist the observed result in the task report; do not assume plain-frame behavior.
    assert!(encrypted.elapsed > Duration::from_secs(30));
}
```

The staged trial uses 3 MiB of deterministic bytes; begins with its SHA-256; sends chunks with at most two requests in flight; accounts raw progress only from replies; calls get for complete/size; independently checks the stage's final digest. Measure end-to-end time >45 s (base64 at 64 KiB/s is about 64 s), no 4408 from the same client monitor used by existing observed trials, and no server reap. Send a Ping after the first acknowledgement, while appends remain pending; bound Pong latency by the two queued chunks' measured wire time plus a small documented scheduler allowance. Do not accidentally measure a pre-queued Pong.

For the inline trial use an already registered method accepting the large body, not an unknown tag. Let the raw plain peer keep the socket open long enough to observe server reap independently of the optional client monitor; separately record what the client monitor decides. E2EE may remain server-live on records while the client times out. Do not alter production liveness to force either result. Add `proxy_upstream_rate_is_enforced` to prove the proxy paced the sender direction rather than just delayed replies.

- [ ] **Step 2: Run red.** `cargo test -p bibcode-server --test rpc_liveness staged_three_mib`; expected missing helper/upstream pacing or elapsed bound failure. A socket denial is not a red product test.
- [ ] **Step 3: Implement only test plumbing.** Register real uploads against the temporary StatePaths; run the production begin/append/get/cancel handlers. Keep one continuously reading response demultiplexer so unary exits, heartbeat frames and RPC Pong are not lost while sending the second append. Drain/cancel trial-owned tasks on every exit. Use generous whole-test watchdogs; the measured liveness bounds remain strict.
- [ ] **Step 4: Green.** Run each new focused filter, then `cargo test -p bibcode-server --test rpc_liveness`, `cargo test -p bibcode-server --lib`. No new contract surface or fixture counts.
- [ ] **Step 5: Gates.** `cargo fmt --all --check`; `cargo clippy -p bibcode-server --all-targets -- -D warnings`; `vp check`; `vp run typecheck`.
- [ ] **Step 6: Docs/live.** No documentation behavior changes, and no live check beyond the real-socket harness. Runbook commands were reviewed and remain accurate. Store timings and the E2EE inline outcome in READY, not living docs. No screenshots.
- [ ] **Step 7: Stop: READY hand-off to the controller; do not commit.**

### Task 4: Client staging, adaptive chunks and reconnect resume

**Commit subject:** `feat(client-runtime): stage attachments with progress and resume`

**Files:**
- Create: `packages/client-runtime/src/connection/nextSession.ts`.
- Create: `packages/client-runtime/src/operations/uploadStager.ts`, `packages/client-runtime/src/operations/uploadStager.test.ts`, `packages/client-runtime/src/operations/attachmentStaging.ts`, `packages/client-runtime/src/operations/attachmentStaging.test.ts`.
- Modify: `packages/client-runtime/src/state/vcsClone.ts:56-131`, `packages/client-runtime/src/state/vcsClone.test.ts`, `packages/client-runtime/src/state/vcsClone.registry.test.ts`; `packages/client-runtime/src/state/threadCommands.ts`, `packages/client-runtime/src/operations/index.ts`.
- Docs: `docs/architecture/connection-runtime.md`.

**Interfaces — consumes:** Tasks 1–2 upload schemas/capability; `EnvironmentRegistry`, `EnvironmentSupervisor`, `RpcSession.initialConfig`, `requestInSession`; `createEnvironmentCommand` and per-invocation `AtomCommandRunOptions.signal` (`state/runtime.ts:86-96,903-918`). No new supervisor policy.

**Interfaces — produces (proposed TypeScript):**

```ts
// connection/nextSession.ts: move the existing implementation and its result type.
export type NextSession =
  | { readonly _tag: "Session"; readonly session: RpcSession;
      readonly supervisor: EnvironmentSupervisor["Service"] }
  | { readonly _tag: "Stopped"; readonly label: string };
export declare function nextSession(registry: EnvironmentRegistry["Service"],
  known: EnvironmentSupervisor["Service"], lost: RpcSession | null): Effect.Effect<NextSession>;
export declare function isSessionTransportLoss(cause: Cause.Cause<unknown>): boolean;
// uploadStager.ts
export interface UploadProgress {
  readonly sentBytes: number; // acknowledged raw bytes, never speculative encoded bytes
  readonly totalBytes: number;
  readonly phase: "uploading" | "reconnecting";
}
export class UploadClientError extends Schema.TaggedError<UploadClientError>()("UploadClientError", {
  fileName: Schema.String,
  reason: Schema.Literals(["unavailable", "read", "resume", "protocol"]),
  message: Schema.String,
}) {}
export type UploadFailure = EnvironmentRpcFailure<
  typeof WS_METHODS.uploadsBegin | typeof WS_METHODS.uploadsAppend
  | typeof WS_METHODS.uploadsGet | typeof WS_METHODS.uploadsCancel
> | UploadClientError | EnvironmentRpcUnavailableError;
export interface UploadSession {
  readonly identity: object;
  readonly capable: boolean;
  readonly begin: (input: UploadBeginInput) => Effect.Effect<UploadBeginResult, UploadFailure>;
  readonly append: (input: UploadAppendInput) => Effect.Effect<UploadAppendResult, UploadFailure>;
  readonly get: (input: UploadGetInput) => Effect.Effect<UploadGetResult, UploadFailure>;
  readonly cancel: (input: UploadCancelInput) => Effect.Effect<UploadCancelResult, UploadFailure>;
}
export interface UploadPort {
  readonly initial: Effect.Effect<UploadSession, UploadFailure>;
  readonly next: (lost: UploadSession) => Effect.Effect<UploadSession, UploadFailure>;
}
export interface StageUploadInput {
  readonly target: UploadTarget;
  readonly file: Blob;
  readonly fileName: string;
  readonly onProgress?: (progress: UploadProgress) => void;
  readonly beforeBytes?: (begun: UploadBeginResult) => Effect.Effect<void, UploadFailure>;
}
export interface StagedUpload { readonly uploadId: string; readonly sizeBytes: number }
export type UploadCapability = "attachmentStaging"; // Task 9 adds "inChannelTransfers".
export declare function createUploadPort(capability: UploadCapability): Effect.Effect<UploadPort,
  UploadFailure, EnvironmentRegistry | EnvironmentSupervisor>;
export declare function stageUpload(input: StageUploadInput, port: UploadPort):
  Effect.Effect<StagedUpload, UploadFailure>;
export declare function nextUploadChunkBytes(size: number, rttMs: number): number;
// attachmentStaging.ts
export interface AttachmentSource {
  readonly type: "image" | "file";
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly file: Blob;
}
export interface AttachmentStagingInput {
  readonly attachments: ReadonlyArray<AttachmentSource>;
  readonly onProgress?: (progress: UploadProgress) => void;
}
export type AttachmentStagingResult = { readonly _tag: "inline" }
  | { readonly _tag: "staged"; readonly attachments: ReadonlyArray<StagedUploadChatAttachment> };
export declare function encodedAttachmentCharacters(source: AttachmentSource): number;
export declare function shouldStageAttachments(capable: boolean,
  sources: ReadonlyArray<AttachmentSource>): boolean;
export declare function stageAttachmentsWithPort(input: AttachmentStagingInput, port: UploadPort):
  Effect.Effect<AttachmentStagingResult, UploadFailure>;
export declare function stageAttachments(input: AttachmentStagingInput):
  Effect.Effect<AttachmentStagingResult, UploadFailure, EnvironmentRegistry | EnvironmentSupervisor>;
```

`createUploadPort` binds every session method to that exact session. It maps `NextSession.Stopped` to a named unavailable error and derives capability from `session.initialConfig`, never `prepared.descriptor`. The port is an implementation/testing seam; only operations needed by web are exported from `operations/index.ts`. `threadCommands.ts` adds `stageAttachments` through `createEnvironmentCommand`; it uses the existing runtime and takes an AbortSignal at invocation, without a staging-wide 30 s timeout.

Import `EnvironmentRpcFailure` from `packages/client-runtime/src/rpc/client.ts:80-83`; it preserves the generated per-method failure inferred by `requestInSession`, including `RpcClientError` and the `RpcResponseTooLargeError` added by `RpcTransportErrors` (`rpc/transportErrors.ts:9-12`). Tasks 9–10 use the corresponding `EnvironmentRpcStreamFailure` (`rpc/client.ts:90-93`). Add only client-side error classes to these derived types, never hand-written unions of RPC schema values. If a manual schema union is necessary, use `typeof X.Type` (in particular `typeof EnvironmentRpcError.Type`, since `packages/contracts/src/auth.ts:321-324` exports only the schema value) and include `RpcResponseTooLargeError`.

`encodedAttachmentCharacters` predicts the actual FileReader data URL length without reading bytes: `4 * ceil(file.size / 3)` plus the `data:<effective MIME>;base64,` prefix. Use `file.type` or FileReader's `application/octet-stream` default for that prefix. Sum across the turn. Inline result carries no bytes; the web performs its existing FileReader step only after this result. Staged result never constructs a data URL.

- [ ] **Step 1: Add test fakes and full test bodies.** The following test-local harness supplies actual Effect methods. Import the new API, contracts, Effect, Cause, Exit, Fiber, Deferred, TestClock, `it/expect/vi`, and `sha256`.

```ts
const fileTarget = { _tag: "chat-attachment", type: "file", name: "a.txt", mimeType: "text/plain" } as const;
const hex = (bytes: Uint8Array) => Buffer.from(sha256(bytes)).toString("hex");
const body = (size: number) => new Blob([new Uint8Array(size).map((_, i) => i % 251)]);
const lost = new RpcClientError.RpcClientError({
  reason: new RpcClientError.RpcClientDefect({ message: "socket closed", cause: new Error("closed") }),
});
function harness(capable = true) {
  let ids = 0;
  const begin = vi.fn((_input: UploadBeginInput) => Effect.sync(() => ({ uploadId: `u-${++ids}`, exists: false })));
  const append = vi.fn((input: UploadAppendInput) => Effect.succeed({
    receivedBytes: input.offset + Buffer.from(input.data, "base64").length,
  }));
  const get = vi.fn((_input: UploadGetInput) => Effect.succeed({
    uploadId: "u-1", sizeBytes: 256 * 1024, receivedBytes: 0, complete: false,
  }));
  const cancel = vi.fn((_input: UploadCancelInput) => Effect.succeed({}));
  const session: UploadSession = { identity: {}, capable, begin, append, get, cancel };
  const next = vi.fn((_lost: UploadSession) => Effect.succeed({ ...session, identity: {} }));
  const port: UploadPort = { initial: Effect.succeed(session), next };
  return { session, port, begin, append, get, cancel, next };
}
const waitFor = (predicate: () => boolean) => Effect.gen(function* () {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    yield* Effect.yieldNow;
  }
  throw new Error("test event did not arrive");
});
it.effect("has no more than two appends outstanding and hashes bytes once", () => Effect.gen(function* () {
  const h = harness();
  const gate = yield* Deferred.make<void>();
  let active = 0;
  let maximum = 0;
  const sent: UploadAppendInput[] = [];
  h.append.mockImplementation((input) => Effect.gen(function* () {
    sent.push(input);
    maximum = Math.max(maximum, ++active);
    yield* Deferred.await(gate);
    active--;
    return { receivedBytes: input.offset + Buffer.from(input.data, "base64").length };
  }));
  const file = body(256 * 1024);
  const fiber = yield* stageUpload({ target: fileTarget, file, fileName: "a.txt" }, h.port).pipe(Effect.forkChild);
  yield* waitFor(() => active === 2);
  expect(sent).toHaveLength(2);
  expect(Buffer.from(sent[0]!.data, "base64")).toHaveLength(64 * 1024);
  yield* Deferred.succeed(gate, undefined);
  const result = yield* Fiber.join(fiber);
  expect(result.sizeBytes).toBe(256 * 1024);
  expect(maximum).toBe(2);
  const raw = new Uint8Array(yield* Effect.promise(() => file.arrayBuffer()));
  expect(sent.at(-1)!.sha256).toBe(hex(raw));
}));
it("adapts toward one second with bounded steps and absolute limits", () => {
  expect(nextUploadChunkBytes(64 * 1024, 500)).toBe(128 * 1024);
  expect(nextUploadChunkBytes(64 * 1024, 4000)).toBe(32 * 1024);
  expect(nextUploadChunkBytes(16 * 1024, 8000)).toBe(16 * 1024);
  expect(nextUploadChunkBytes(1024 * 1024, 1)).toBe(1024 * 1024);
});
it.effect("restores an older unacknowledged boundary after reconnect", () => Effect.gen(function* () {
  const h = harness();
  const sent: UploadAppendInput[] = [];
  let cut = true;
  h.append.mockImplementation((input) => Effect.suspend(() => {
    sent.push(input);
    if (cut) { cut = false; return Effect.fail(lost); }
    return Effect.succeed({ receivedBytes: input.offset + Buffer.from(input.data, "base64").length });
  }));
  h.get.mockReturnValue(Effect.succeed({ uploadId: "u-1", sizeBytes: 256 * 1024,
    receivedBytes: 0, complete: false }));
  const progress: UploadProgress[] = [];
  const file = body(256 * 1024);
  yield* stageUpload({ target: fileTarget, file, fileName: "a.txt", onProgress: (p) => progress.push(p) }, h.port);
  expect(h.begin).toHaveBeenCalledTimes(1);
  expect(h.get).toHaveBeenCalledWith({ uploadId: "u-1" });
  expect(h.next).toHaveBeenCalledTimes(1);
  expect(sent.filter((c) => c.offset === 0).length).toBeGreaterThan(1);
  expect(progress.some((p) => p.phase === "reconnecting")).toBe(true);
  const bytes = new Uint8Array(yield* Effect.promise(() => file.arrayBuffer()));
  expect(sent.at(-1)!.sha256).toBe(hex(bytes));
}));
it.effect("restarts not_found once and fails the next disappearance", () => Effect.gen(function* () {
  const h = harness();
  h.append.mockImplementation(() => Effect.fail(lost));
  h.get.mockImplementation(() => Effect.fail(new UploadError({ reason: "not_found", message: "Upload expired." })));
  const result = yield* Effect.exit(stageUpload({ target: fileTarget, file: body(100), fileName: "a.txt" }, h.port));
  expect(Exit.isFailure(result)).toBe(true);
  expect(h.begin).toHaveBeenCalledTimes(2);
  expect(h.get).toHaveBeenCalledTimes(2);
}));
it.effect("cancel interrupts and sends best-effort uploads.cancel", () => Effect.gen(function* () {
  const h = harness();
  h.append.mockImplementation(() => Effect.never);
  const fiber = yield* stageUpload({ target: fileTarget, file: body(100), fileName: "a.txt" }, h.port)
    .pipe(Effect.forkChild);
  yield* waitFor(() => h.append.mock.calls.length > 0);
  yield* Fiber.interrupt(fiber);
  expect(h.cancel).toHaveBeenCalledWith({ uploadId: "u-1" });
}));
```

Widen fake function return annotations to `UploadSession`'s method types when setting failing implementations; do not defeat the production method types with `any`. Add these full boundary/lifecycle bodies:

```ts
it.effect("resumes from a nonzero acknowledged checkpoint without rehashing it", () => Effect.gen(function* () {
  const h = harness();
  let cut = false;
  const offsetsAfterCut: number[] = [];
  let completingDigest: string | undefined;
  h.append.mockImplementation((input) => Effect.suspend(() => {
    if (!cut && input.offset > 0) { cut = true; return Effect.fail(lost); }
    if (cut) offsetsAfterCut.push(input.offset);
    if (input.sha256 !== undefined) completingDigest = input.sha256;
    return Effect.succeed({ receivedBytes: input.offset + Buffer.from(input.data, "base64").length });
  }));
  h.get.mockReturnValue(Effect.succeed({ uploadId: "u-1", sizeBytes: 256 * 1024,
    receivedBytes: 64 * 1024, complete: false }));
  const file = body(256 * 1024);
  yield* stageUpload({ target: fileTarget, file, fileName: "a.txt" }, h.port);
  expect(offsetsAfterCut[0]).toBe(64 * 1024);
  const raw = new Uint8Array(yield* Effect.promise(() => file.arrayBuffer()));
  expect(completingDigest).toBe(hex(raw));
}));
it.effect("a lost completion reply uses get without uploading again", () => Effect.gen(function* () {
  const h = harness();
  h.append.mockReturnValue(Effect.fail(lost));
  h.get.mockReturnValue(Effect.succeed({ uploadId: "u-1", sizeBytes: 3, receivedBytes: 3, complete: true }));
  const result = yield* stageUpload({ target: fileTarget, file: body(3), fileName: "a.txt" }, h.port);
  expect(result.uploadId).toBe("u-1");
  expect(h.begin).toHaveBeenCalledTimes(1);
  expect(h.append).toHaveBeenCalledTimes(1);
}));
it.effect("rechecks capability before asking the replacement session to resume", () => Effect.gen(function* () {
  const h = harness();
  h.append.mockReturnValue(Effect.fail(lost));
  h.next.mockReturnValue(Effect.succeed({ ...h.session, identity: {}, capable: false }));
  const result = yield* Effect.exit(stageUpload({ target: fileTarget, file: body(3), fileName: "a.txt" }, h.port));
  expect(Exit.isFailure(result)).toBe(true);
  expect(h.get).not.toHaveBeenCalled();
  expect(h.begin).toHaveBeenCalledTimes(1);
}));
it.effect("the scheduler adapts from measured reply times", () => Effect.gen(function* () {
  const h = harness();
  const sizes: number[] = [];
  h.append.mockImplementation((input) => Effect.gen(function* () {
    const size = Buffer.from(input.data, "base64").length;
    sizes.push(size);
    yield* Effect.sleep("4 seconds");
    return { receivedBytes: input.offset + size };
  }));
  const fiber = yield* stageUpload({ target: fileTarget, file: body(256 * 1024), fileName: "a.txt" }, h.port)
    .pipe(Effect.forkChild);
  yield* waitFor(() => sizes.length === 2);
  yield* TestClock.adjust("4 seconds");
  yield* waitFor(() => sizes.length >= 3);
  expect(sizes[0]).toBe(64 * 1024);
  expect(sizes[1]).toBe(64 * 1024);
  expect(sizes[2]).toBeLessThanOrEqual(32 * 1024);
  expect(sizes[2]).toBeGreaterThanOrEqual(16 * 1024);
  yield* Fiber.interrupt(fiber);
}));
```

Full inline/sequential tests, in attachmentStaging.test.ts:

```ts
function source(size: number, id: string): AttachmentSource {
  const file = new Blob([new Uint8Array(size)], { type: "text/plain" });
  return { type: "file", id, name: `${id}.txt`, mimeType: "text/plain", sizeBytes: size, file };
}
it("uses the total encoded turn size and the carrying session capability", () => {
  // Two individually inline attachments cross the total threshold.
  const a = source(120_000, "a");
  expect(shouldStageAttachments(true, [a])).toBe(false);
  expect(shouldStageAttachments(true, [a, source(120_000, "b")])).toBe(true);
  expect(shouldStageAttachments(false, [source(10 * 1024 * 1024, "large")])).toBe(false);
  const prefix = "data:text/plain;base64,".length;
  const size = 3 * Math.floor((256 * 1024 - prefix) / 4);
  expect(encodedAttachmentCharacters(source(size, "edge"))).toBeLessThanOrEqual(256 * 1024);
  expect(shouldStageAttachments(true, [source(size, "edge")])).toBe(false);
  expect(shouldStageAttachments(true, [source(size + 3, "over")])).toBe(true);
});
it.effect("stages a turn sequentially and totals acknowledged progress", () => Effect.gen(function* () {
  const h = harness();
  const order: string[] = [];
  h.begin.mockImplementation(() => Effect.sync(() => {
    const id = `u-${order.filter((event) => event === "begin").length}`;
    order.push("begin"); return { uploadId: id, exists: false };
  }));
  h.append.mockImplementation((input) => Effect.sync(() => {
    if (input.sha256 !== undefined) order.push("complete");
    return { receivedBytes: input.offset + Buffer.from(input.data, "base64").length };
  }));
  const progress: UploadProgress[] = [];
  const result = yield* stageAttachmentsWithPort({ attachments: [source(120_000, "a"), source(120_000, "b")],
    onProgress: (p) => progress.push(p) }, h.port);
  expect(order).toEqual(["begin", "complete", "begin", "complete"]);
  expect(result._tag).toBe("staged");
  expect(progress.at(-1)).toMatchObject({ sentBytes: 240_000, totalBytes: 240_000, phase: "uploading" });
}));
```

- [ ] **Step 2: Run red.** `(cd packages/client-runtime && node ../../scripts/run-local-vp.mjs test run src/operations/uploadStager.test.ts src/operations/attachmentStaging.test.ts)`. Expected: imports/functions missing, then window/resume assertions fail. Retain a TestClock-driven RTT test with two consecutive simulated delays to prove the live loop uses the sizing function.
- [ ] **Step 3: Move reconnect policy.** Move `nextSession`/`NextSession` and the transport-loss predicate to connection/nextSession.ts, rename the predicate `isSessionTransportLoss`, update clone imports/tests without behavioral changes. Preserve registry replacement, explicit disconnect, removal and current label semantics. Run both existing clone suites immediately.
- [ ] **Step 4: Implement chunk scheduling and hashing.** Start 64 KiB; never have more than two outstanding appends. Use incremental `sha256.create()` and its `.clone()` at every unacknowledged chunk boundary, plus the last acknowledged checkpoint. A completing append supplies lowercase digest. On a cut, stop/join both old append fibers before get/replay. Restore the checkpoint for `receivedBytes`; reject an impossible offset rather than guessing. Keep memory bounded to two source slices, encoded requests and a few tiny hasher states. RTT uses Effect's clock and at most ×2/÷2 adaptation, clamped 16 KiB–1 MiB.
- [ ] **Step 5: Implement resume/cancellation.** Re-read capability from every new carrying session before get/begin; a lost capability fails unavailable and never probes. Unknown/expired upload permits one fresh begin per file, resets hasher and progress, then fails. Explicit AbortSignal interruption is not mistaken for a transport cut; bounded best-effort cancel runs without delaying UI restoration. Track already completed stages in a turn so Cancel/failure cancels all its unbound uploads; successful staging leaves them available for binding. Preserve staged references in an in-memory send attempt for a turn-start retry until accepted/expired; never persist upload IDs in drafts.
- [ ] **Step 6: Green and gates.** Repeat focused commands; run `(cd packages/client-runtime && node ../../scripts/run-local-vp.mjs test run)`; `vp check`; `vp run typecheck`; `cargo fmt --all --check`; `cargo clippy -p bibcode-server --all-targets -- -D warnings`. No Rust behavior changed; the Rust static gates are still required by the lane convention.
- [ ] **Step 7: Docs/live.** Explain next-session staged resume, one restart and capability-from-carrying-session in connection-runtime.md. Review runbooks and record **reviewed and remain accurate**; no UI or live check yet.
- [ ] **Step 8: Stop: READY hand-off to the controller; do not commit.**

### Task 5: Pending messages show upload progress and Cancel

**Commit subject:** `feat(web): show staged attachment progress on pending messages`

**Files:**
- Modify: `apps/web/src/components/ChatView.tsx:5156-5268,5320,5404-5464`; `apps/web/src/components/ChatView.logic.ts`, `apps/web/src/components/ChatView.logic.test.ts`.
- Modify: `apps/web/src/components/chat/MessagesTimeline.tsx:129-153,922-1070`, `apps/web/src/components/chat/MessagesTimeline.test.tsx`.
- Create: `apps/web/src/components/chat/AttachmentUploadNotice.tsx`, `apps/web/src/components/chat/AttachmentUploadNotice.test.tsx`.
- Create: `apps/web/src/lib/formatTransferBytes.ts`, `apps/web/src/lib/formatTransferBytes.test.ts` (shared by Tasks 5 and 12).
- Docs: `docs/user/workspace-ui.md`, `docs/architecture/connection-runtime.md`, `docs/superpowers/specs/2026-09-24-connection-liveness-design.md:302-303`, `docs/testing/cross-platform-validation.md:1222`, `docs/testing/execution-report-template.md:230`; review platform runbooks and `docs/reference/scripts.md`.

**Interfaces — consumes:** Task 4's `threadEnvironment.stageAttachments`, `AttachmentStagingResult`, `UploadProgress`, AbortSignal invocation control; existing optimistic rows, queued-message cache and draft-restoration functions.

**Interfaces — produces (proposed web-only TypeScript):**

```ts
export interface PendingAttachmentUpload extends UploadProgress {
  readonly attachmentCount: number;
  readonly fileName: string;
}
export interface AttachmentUploadNoticeProps {
  readonly progress: PendingAttachmentUpload;
  readonly onCancel: () => void;
}
export declare function attachmentUploadCopy(progress: PendingAttachmentUpload): string;
export declare function attachmentUploadFailureCopy(fileName: string, cause: string | null): string;
// lib/formatTransferBytes.ts: used by attachmentUploadCopy and Task 12 transferProgressCopy.
export declare function formatTransferBytes(sentBytes: number, totalBytes: number | null): string;
// Add to TimelineRowSharedState and its caller props:
attachmentUploads: Readonly<Record<string, PendingAttachmentUpload>>;
onCancelAttachmentUpload: (messageId: MessageId) => void;
```

Use these exact strings: “Uploading 2 attachments — 3.1 of 20 MiB”; singular “Uploading 1 attachment — …”; “Reconnecting…”; button **Cancel**; failure with a cause `Couldn't upload "${fileName}": ${cause}. Your message is back in the composer.`; without a cause `Couldn't upload "${fileName}". Your message is back in the composer. Try sending it again.` Pass the message only from a typed `UploadError`, `UploadClientError` or environment-unavailable failure (`EnvironmentRpcUnavailableError`); every other error passes null. Server and client messages for these failures must be short user phrases safe after a colon, with a lowercase first word where appropriate and no trailing full stop, such as “the upload expired” or “<environment> is disconnected”. No technical stage IDs or encoded-byte counts. Progress is an always-visible status line, not hover-only bubble controls.

Both progress-copy functions call the shared web `formatTransferBytes` above. Existing `formatBytes` uses in ChatComposer.tsx and MessagesTimeline.tsx alias `formatMemoryBytes` from `apps/web/src/components/status-bar/statusBarFormat.ts:65-77`, which uses B/KB/MB/GB and does not fit this rule. For a known total, both numbers use the total's unit: KiB below 1 MiB, MiB below 1 GiB, GiB from 1 GiB. Each number has one decimal below 10 in that unit and whole numbers from 10, never a trailing “.0”: “3.1 of 20 MiB”, “120 of 900 MiB”, “0.5 of 1.2 GiB”, “120 of 300 KiB”. For an unknown total, show only the sent amount in its own unit with the same thresholds/precision, e.g. “Downloading src.zip — 120 MiB”.

- [ ] **Step 1: Add focused failing tests.**

```ts
it("formats singular, plural and reconnecting upload copy", () => {
  expect(attachmentUploadCopy({ attachmentCount: 2, fileName: "a.png", sentBytes: 3.1 * 1024 ** 2,
    totalBytes: 20 * 1024 ** 2, phase: "uploading" })).toBe("Uploading 2 attachments — 3.1 of 20 MiB");
  expect(attachmentUploadCopy({ attachmentCount: 1, fileName: "a.png", sentBytes: 0,
    totalBytes: 1024 ** 2, phase: "reconnecting" })).toBe("Reconnecting…");
  expect(attachmentUploadFailureCopy("photo.png", "the upload expired"))
    .toBe('Couldn\'t upload "photo.png": the upload expired. Your message is back in the composer.');
  expect(attachmentUploadFailureCopy("photo.png", null))
    .toBe('Couldn\'t upload "photo.png". Your message is back in the composer. Try sending it again.');
});
// lib/formatTransferBytes.test.ts
it("uses the total unit and shared transfer precision", () => {
  expect(formatTransferBytes(3.1 * 1024 ** 2, 20 * 1024 ** 2)).toBe("3.1 of 20 MiB");
  expect(formatTransferBytes(120 * 1024 ** 2, 900 * 1024 ** 2)).toBe("120 of 900 MiB");
  expect(formatTransferBytes(0.5 * 1024 ** 3, 1.2 * 1024 ** 3)).toBe("0.5 of 1.2 GiB");
  expect(formatTransferBytes(120 * 1024, 300 * 1024)).toBe("120 of 300 KiB");
  expect(formatTransferBytes(3 * 1024 ** 2, 10 * 1024 ** 2)).toBe("3 of 10 MiB");
  expect(formatTransferBytes(120 * 1024 ** 2, null)).toBe("120 MiB");
});
```

Add `staged_send_does_not_call_readFileAsDataUrl`, `inline_fallback_reads_data_urls`, `queued_staging_has_a_local_row_before_enqueue`, `cancel_restores_without_error_banner`, `failure_preserves_new_composer_edits`, `stale_progress_cannot_update_another_thread`, `pending_row_disappears_once_after_enqueue`, and `retry_reuses_completed_stages_until_expiry`. Render notice tests with explicit props; pre-setting a Zustand store does not establish SSR/static-render state. In a happy-dom interaction test assert Cancel is focusable, then a DOM click causes exactly one abort and draft content and attachment previews remain usable. Native Enter/Space activation belongs in the Step 8 Playwright check: happy-dom does not synthesize that click.

- [ ] **Step 2: Run red.** `(cd apps/web && vp test run --project unit src/lib/formatTransferBytes.test.ts src/components/ChatView.logic.test.ts src/components/chat/AttachmentUploadNotice.test.tsx src/components/chat/MessagesTimeline.test.tsx)`. Expected: missing formatter/notice/copy, then absent row/cancel behavior. Put send-flow seam tests beside ChatView.logic rather than requiring a running provider.
- [ ] **Step 3: Integrate before encoding.** Snapshot attachments and create per-message AbortController/progress before the existing reader at 5190. Replace eager `turnAttachmentsPromise` with the interruptible staging command; only `_tag: inline` calls FileReader. Await it at the existing attachment join near 5320, then dispatch the same turn command with staged values. Preserve start-order and metadata failure handling; cancel staged work if earlier preparation failed.
- [ ] **Step 4: Render all pending sends.** Nonqueued optimistic row shows the prop-driven notice. Queued sends add a local-only pending row until enqueue resolves, then remove it when server delivery appears; never fabricate `delivery.state="queued"` before server acceptance or mark the provider as working. Thread/message IDs fence progress updates and cleanup. Use an in-memory attempt cache to retry the exact staged payload after turn-start failure; a changed file or expired upload starts staging afresh under Task 4's budget.
- [ ] **Step 5: Restore safely.** Cancel aborts the command and retains interrupted failure all the way to `isAtomCommandInterrupted`, so no banner appears. Restore the outgoing snapshot including contexts/annotations and previews while preserving newer composer work; do not overwrite fresh edits. Release unbound stages on an abandoned attempt. Clear notice/controllers on success, terminal failure, or route disposal; stale completions cannot mutate the new thread. Keep existing provider Stop available for the running thread while a queued send uploads.
- [ ] **Step 6: Green and review.** Repeat focused tests; `(cd apps/web && vp test run --project unit)`; `vp check`; `vp run typecheck`; global Cargo fmt/server Clippy. Review changed components/hooks against **vercel-react-best-practices** and **UI.md**, including per-chunk rerender scope, stable per-row props, keyboard focus, 12px minimum text and truthful restoration copy.
- [ ] **Step 7: Update docs now.** Document progress/Cancel in workspace-ui. Add the scoped large-upload residual paragraph to connection-runtime. Add an amendment link at the liveness record's Residuals without rewriting its historic evidence. Extend slow-link validation with the C attachment procedure and report fields for rate, acknowledgement, provider bytes, pause/resume, Stop, Cancel, screenshots and browser probe. Review the Linux/macOS/Windows links and scripts.md's existing `--up`; where unchanged, report **reviewed and remain accurate**.
- [ ] **Step 8: Live C.** Run the full Working conventions phase C matrix on 4901–4912. Example control: `curl 'http://127.0.0.1:4912/set?up=65536&down=0'`, then `up=16384`; freeze with `freeze=1`, thaw with `freeze=0`. Capture valid 10 MiB-image progress and Cancel in light/dark, matching provider bytes, concurrent streaming/Stop, 4408 ≤33 s, resume, and old-server inline fallback. In Playwright, Tab to Cancel and activate it with Enter and Space on separate uploads; assert exactly one abort per activation, no error banner, and usable restored draft/previews. Chromium probe additionally records queued-data behavior after close; unavailable WebKitGTK is **not measured**. Keep logs/screenshots under `$S/live` and large files outside the worktree.
- [ ] **Step 9: Stop: READY hand-off to the controller; do not commit.**

---

## Phase B — Transfers and assets inside Noise

### Task 6: Workspace uploads and atomic commit

**Commit subject:** `feat(server,contracts): commit staged workspace uploads`

**Files:**
- Modify: `packages/contracts/src/uploads.ts`, `packages/contracts/src/uploads.test.ts`, `packages/contracts/src/rpc.ts`; inventory/scope and fixture/count files from Task 1.
- Modify if required by widened RPC failures: `packages/client-runtime/src/operations/uploadStager.ts` and any affected client-runtime type consumers. Task 4's derived `UploadFailure` should inherit the new failures without edits; any compile fix belongs here, not deferred to Task 9.
- Modify: `apps/server/src/transfer/staging.rs`, `apps/server/src/production/uploads_rpc.rs`, `apps/server/src/transfer/upload.rs:160-236,268-281`, `apps/server/src/workspace/rpc.rs:1045-1091`.
- Modify: `apps/server/src/production/transfer_routes.rs:125-196`, `apps/server/src/production/runtime.rs:150-161` and registry-services construction only (qualified hotspot hunk).
- Test: existing upload/staging unit modules; `apps/server/tests/workspace_rpc.rs`, `apps/server/tests/production_http_routes.rs`; add completion-callback tests in transfer_routes.rs.
- Docs: `docs/architecture/rpc-and-orchestration.md`.

**Interfaces — consumes:** Task 1 shared quota/ordering engine, `WorkspaceRpc` admission, existing upload name/directory/reservation policy, `UploadedCallback`, `StatusBroadcaster`.

**Interfaces — produces (proposed schemas):** Append the second variant to the Task 1 union; do not replace the chat target or add another RPC family.

```ts
// Additional UploadTarget member, importing PROJECT_ENTRY_PATH_MAX_LENGTH:
Schema.TaggedStruct("workspace-file", {
  cwd: TrimmedNonEmptyString,
  relativeDirectory: Schema.String.check(Schema.isMaxLength(PROJECT_ENTRY_PATH_MAX_LENGTH)),
  fileName: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
}),
// UploadError.reason adds "exists" to the existing literal list.
export const UploadCommitInput = Schema.Struct({ uploadId: UploadId, overwrite: Schema.Boolean });
export type UploadCommitInput = typeof UploadCommitInput.Type;
export const UploadCommitResult = Schema.Struct({ relativePath: TrimmedNonEmptyString });
export type UploadCommitResult = typeof UploadCommitResult.Type;
export const WsUploadsCommitRpc = Rpc.make(WS_METHODS.uploadsCommit, {
  payload: UploadCommitInput, success: UploadCommitResult,
  error: Schema.Union([UploadError, ProjectTransferError,
    WorkspaceUnavailableError, WorkspaceIdentityError, EnvironmentRpcError]),
});
```

`WS_METHODS.uploadsCommit = "uploads.commit"`; sorted Rust `mutation_unary`, operate scope. Begin/get/append now declare `ProjectTransferError` where workspace path loss can fail; begin/commit additionally declare existing workspace admission errors. Cancel keeps its idempotent no-path-check result. Regenerate all affected typed-failure fixtures. `inChannelTransfers` remains absent/false until Task 8. Task 6 must also update the Task 3 harness call site for the new optional workspace-services argument; its production changes remain confined to this task.

**Interfaces — produces (proposed Rust additions):**

```rust
// Add to UploadTarget (serde rename_all="camelCase"):
WorkspaceFile { cwd: String, relative_directory: String, file_name: String },
// Wire tag on that variant is "workspace-file". UploadErrorReason adds Exists.
// UploadLimits adds workspace_per_owner: usize (=4), workspace_max_bytes: u64 (=1 GiB).
// There is deliberately no workspace_server_bytes field.
#[derive(Clone, Debug)]
pub(crate) struct WorkspaceUploadDestination {
    pub root: PathBuf,
    pub directory: PathBuf,
    pub file_name: String,
    pub relative_directory: String,
}
pub(crate) struct AdmittedUploadDestination {
    pub destination: WorkspaceUploadDestination,
    /* private optional WorkspaceAdmissionLease; dropped after begin or atomic commit */
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadCommitInput { pub upload_id: String, pub overwrite: bool }
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadCommitResult { pub relative_path: String }
#[derive(Debug, thiserror::Error)]
pub(crate) enum UploadCommitError {
    #[error(transparent)] Upload(#[from] UploadError),
    #[error(transparent)] Transfer(#[from] TransferError),
}
impl UploadRegistry {
    pub(crate) async fn begin_workspace(&self, owner: &UploadOwner, input: UploadBeginInput,
        destination: WorkspaceUploadDestination) -> Result<UploadBeginResult, UploadError>;
    pub(crate) async fn workspace_target(&self, owner: &UploadOwner, id: &str)
        -> Result<UploadTarget, UploadError>;
    pub(crate) async fn commit_workspace(&self, owner: &UploadOwner, input: UploadCommitInput,
        destination: WorkspaceUploadDestination) -> Result<PathBuf, UploadCommitError>;
}
impl WorkspaceRpc {
    pub(crate) async fn admit_upload_destination(&self, cwd: &str, relative_directory: &str,
        file_name: &str) -> Result<AdmittedUploadDestination, Value>;
}
// transfer/upload.rs: one publication policy, different reservation timing.
pub struct UploadReservation { /* owned target/reservation, cleanup on failure */ }
pub async fn reserve_upload_destination(directory: &Path, name: &str, overwrite: bool)
    -> Result<UploadReservation, TransferError>;
pub async fn publish_upload_partial(reservation: UploadReservation, partial: &Path)
    -> Result<PathBuf, TransferError>;
// production/transfer_routes.rs:
pub fn uploaded_callback(workspace: WorkspaceRpc, status: StatusBroadcaster) -> UploadedCallback;
// production/uploads_rpc.rs:
#[derive(Clone)]
pub struct WorkspaceUploadServices { /* private workspace and callback */ }
impl WorkspaceUploadServices {
    pub fn new(workspace: WorkspaceRpc, on_uploaded: UploadedCallback) -> Self;
    pub(crate) async fn begin(&self, uploads: &UploadRegistry, owner: &UploadOwner,
        input: UploadBeginInput) -> RpcResult;
    pub(crate) async fn commit(&self, uploads: &UploadRegistry, owner: &UploadOwner,
        input: UploadCommitInput) -> RpcResult;
}
pub fn register_uploads_rpc(registry: &mut RpcRegistry, uploads: UploadRegistry,
    workspace: Option<WorkspaceUploadServices>);
```

Task 3's harness passes `None` until Task 8 adds a workspace fixture. With no workspace services, chat still works; workspace requests return typed not_configured. The engine stays below production: it never imports a production service, WorkspaceRpc or Git. `begin_workspace` resolves a target already admitted by its caller, then delegates the same private entry creator as chat. `append/get` check the saved folder/partial exists; their RPC adapter maps workspace path loss to ProjectTransferError after removing/forgetting the entry.

- [ ] **Step 1: Write full workspace tests.** Put the following tests in uploads_rpc.rs so crate-private admission types remain private. Proposed local fixture `workspace_fixture` is defined below; Task 1's base64/digest helpers may be copied into this module.

```rust
struct WorkspaceFixture {
    temp: tempfile::TempDir,
    root: PathBuf,
    registry: UploadRegistry,
    services: WorkspaceUploadServices,
    completed: Arc<std::sync::Mutex<Vec<PathBuf>>>,
}
fn workspace_fixture() -> WorkspaceFixture {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("repo");
    std::fs::create_dir(&root).unwrap();
    let registry = UploadRegistry::new(temp.path().join("attachment-uploads"), UploadLimits::default(),
        Arc::new(tokio::time::Instant::now));
    let completed = Arc::new(std::sync::Mutex::new(Vec::new()));
    let recorded = completed.clone();
    let callback: UploadedCallback = Arc::new(move |root| {
        let recorded = recorded.clone();
        Box::pin(async move { recorded.lock().unwrap().push(root); })
    });
    let workspace = WorkspaceRpc::new(WorkspaceService::default());
    let services = WorkspaceUploadServices::new(workspace, callback);
    WorkspaceFixture { temp, root, registry, services, completed }
}
impl WorkspaceFixture {
    fn input(&self, name: &str, bytes: u64) -> UploadBeginInput {
        UploadBeginInput { target: UploadTarget::WorkspaceFile {
            cwd: self.root.to_string_lossy().into_owned(), relative_directory: "".into(), file_name: name.into(),
        }, size_bytes: bytes, sha256: None }
    }
    async fn begin(&self, name: &str, bytes: u64) -> Value {
        self.services.begin(&self.registry, &UploadOwner::Session("a".into()), self.input(name, bytes))
            .await.unwrap()
    }
    async fn fill(&self, id: &str, bytes: &[u8]) {
        self.registry.append(&UploadOwner::Session("a".into()), UploadAppendInput {
            upload_id: id.into(), offset: 0, data: STANDARD.encode(bytes),
            sha256: Some(crate::crypto::sha256_hex(bytes)),
        }).await.unwrap();
    }
    async fn commit(&self, id: &str, overwrite: bool) -> RpcResult {
        self.services.commit(&self.registry, &UploadOwner::Session("a".into()),
            UploadCommitInput { upload_id: id.into(), overwrite }).await
    }
    fn partials(&self) -> Vec<PathBuf> {
        std::fs::read_dir(&self.root).unwrap().map(|e| e.unwrap().path())
            .filter(|p| p.to_string_lossy().ends_with(".bibcode-upload.part")).collect()
    }
}
#[tokio::test]
async fn exists_then_replace_keeps_staged_bytes_and_does_not_send_them_again() {
    let f = workspace_fixture();
    tokio::fs::write(f.root.join("a.txt"), b"old").await.unwrap();
    let begun = f.begin("a.txt", 3).await;
    assert_eq!(begun["exists"], true);
    let id = begun["uploadId"].as_str().unwrap();
    f.fill(id, b"new").await;
    let partial = f.partials().pop().unwrap();
    let error = f.commit(id, false).await.unwrap_err();
    assert_eq!(error["reason"], "exists");
    assert_eq!(tokio::fs::read(&partial).await.unwrap(), b"new");
    assert_eq!(tokio::fs::read(f.root.join("a.txt")).await.unwrap(), b"old");
    assert!(f.completed.lock().unwrap().is_empty());
    assert_eq!(f.commit(id, true).await.unwrap()["relativePath"], "a.txt");
    assert_eq!(tokio::fs::read(f.root.join("a.txt")).await.unwrap(), b"new");
    assert!(!partial.exists());
    assert_eq!(f.completed.lock().unwrap().len(), 1);
}
#[tokio::test]
async fn begin_creates_no_placeholder_and_commit_refuses_a_directory_even_with_overwrite() {
    let f = workspace_fixture();
    let begun = f.begin("a.txt", 3).await;
    assert!(!f.root.join("a.txt").exists());
    let id = begun["uploadId"].as_str().unwrap();
    f.fill(id, b"new").await;
    tokio::fs::create_dir(f.root.join("a.txt")).await.unwrap();
    assert_eq!(f.commit(id, true).await.unwrap_err()["reason"], "exists");
    assert!(f.root.join("a.txt").is_dir());
    assert_eq!(f.partials().len(), 1);
}
#[tokio::test]
async fn workspace_has_four_slots_a_one_gib_limit_and_no_chat_server_cap() {
    let f = workspace_fixture();
    for i in 0..4 { f.begin(&format!("{i}.bin"), 1024 * 1024 * 1024).await; }
    let owner = UploadOwner::Session("a".into());
    let error = f.services.begin(&f.registry, &owner, f.input("fifth.bin", 1)).await.unwrap_err();
    assert_eq!(error["reason"], "quota");
    let error = f.services.begin(&f.registry, &UploadOwner::Session("b".into()),
        f.input("large.bin", 1024 * 1024 * 1024 + 1)).await.unwrap_err();
    assert_eq!(error["reason"], "size");
    // The tests declared sizes only; partials remain empty, not sparse 1 GiB fixtures.
    assert!(f.partials().iter().all(|p| std::fs::metadata(p).unwrap().len() == 0));
}
#[tokio::test(start_paused = true)]
async fn workspace_expiry_and_cancel_delete_the_partial() {
    let f = workspace_fixture();
    let owner = UploadOwner::Session("a".into());
    let a = f.begin("a.txt", 3).await;
    let b = f.begin("b.txt", 3).await;
    f.registry.cancel(&owner, a["uploadId"].as_str().unwrap()).await.unwrap();
    assert_eq!(f.partials().len(), 1);
    tokio::time::advance(Duration::from_secs(600)).await;
    f.registry.sweep().await.unwrap();
    assert!(f.partials().is_empty());
    assert_eq!(f.registry.get(&owner, b["uploadId"].as_str().unwrap()).await.unwrap_err().reason,
        UploadErrorReason::NotFound);
}
#[tokio::test]
async fn next_get_append_or_commit_forgets_an_upload_whose_folder_is_gone() {
    for operation in ["get", "append", "commit"] {
        let f = workspace_fixture();
        let begun = f.begin("a.txt", 3).await;
        let id = begun["uploadId"].as_str().unwrap();
        let owner = UploadOwner::Session("a".into());
        tokio::fs::remove_dir_all(&f.root).await.unwrap(); // only this test's disposable directory
        match operation {
            "get" => { assert!(f.registry.get(&owner, id).await.is_err()); }
            "append" => { assert!(f.registry.append(&owner, UploadAppendInput { upload_id: id.into(),
                offset: 0, data: "bmV3".into(), sha256: Some(crate::crypto::sha256_hex(b"new")) }).await.is_err()); }
            _ => { assert!(f.commit(id, false).await.is_err()); }
        }
        assert_eq!(f.registry.get(&owner, id).await.unwrap_err().reason, UploadErrorReason::NotFound);
    }
}
#[tokio::test]
async fn workspace_file_names_follow_the_receiving_servers_platform() {
    let f = workspace_fixture();
    let result = f.services.begin(&f.registry, &UploadOwner::Session("a".into()), f.input("report:v2.txt", 0)).await;
    if cfg!(windows) { assert!(result.is_err()); } else { assert!(result.is_ok()); }
    for name in ["../escape", "nested/a.txt", "nested\\a.txt", "", "a\nb"] {
        assert!(f.services.begin(&f.registry, &UploadOwner::Session("a".into()), f.input(name, 0)).await.is_err());
    }
}
```

Full workspace schema bodies in uploads.test.ts:

```ts
it("accepts either purpose-tagged target without changing chat wire values", () => {
  const workspace = { target: { _tag: "workspace-file", cwd: "/repo", relativeDirectory: "", fileName: "a.bin" },
    sizeBytes: 1024 ** 3 };
  expect(Schema.decodeUnknownSync(UploadBeginInput)(workspace)).toEqual(workspace);
  expect(Schema.is(UploadBeginInput)({ ...workspace, target: { ...workspace.target, cwd: "" } })).toBe(false);
  expect(Schema.is(UploadBeginInput)({ ...workspace, target: { ...workspace.target, fileName: "a".repeat(256) } }))
    .toBe(false);
  const chat = { target: { _tag: "chat-attachment", type: "file", name: "a.txt", mimeType: "text/plain" }, sizeBytes: 3 };
  expect(Schema.decodeUnknownSync(UploadBeginInput)(chat)).toEqual(chat);
});
it("requires an explicit overwrite choice and decodes an exists refusal", () => {
  expect(Schema.is(UploadCommitInput)({ uploadId: "u-1" })).toBe(false);
  expect(Schema.decodeUnknownSync(UploadCommitInput)({ uploadId: "u-1", overwrite: false }))
    .toEqual({ uploadId: "u-1", overwrite: false });
  expect(Schema.decodeUnknownSync(UploadCommitResult)({ relativePath: "src/a.txt" }).relativePath).toBe("src/a.txt");
  expect(Schema.decodeUnknownSync(UploadError)({ _tag: "UploadError", reason: "exists", message: "File exists." })
    .reason).toBe("exists");
});
```

Full workspace race/owner bodies use the fixture above:

```rust
#[tokio::test]
async fn a_name_created_after_begin_requires_replace_without_losing_the_stage() {
    let f = workspace_fixture();
    let begun = f.begin("a.txt", 3).await;
    assert_eq!(begun["exists"], false);
    let id = begun["uploadId"].as_str().unwrap();
    f.fill(id, b"new").await;
    tokio::fs::write(f.root.join("a.txt"), b"concurrent").await.unwrap();
    assert_eq!(f.commit(id, false).await.unwrap_err()["reason"], "exists");
    assert_eq!(tokio::fs::read(f.root.join("a.txt")).await.unwrap(), b"concurrent");
    assert_eq!(f.partials().len(), 1);
    f.commit(id, true).await.unwrap();
    assert_eq!(tokio::fs::read(f.root.join("a.txt")).await.unwrap(), b"new");
}
#[tokio::test]
async fn a_foreign_owner_cannot_commit_or_learn_the_target() {
    let f = workspace_fixture();
    let begun = f.begin("a.txt", 3).await;
    let id = begun["uploadId"].as_str().unwrap();
    f.fill(id, b"new").await;
    let foreign = UploadOwner::Session("b".into());
    assert_eq!(f.registry.workspace_target(&foreign, id).await.unwrap_err().reason, UploadErrorReason::NotFound);
    let error = f.services.commit(&f.registry, &foreign,
        UploadCommitInput { upload_id: id.into(), overwrite: true }).await.unwrap_err();
    assert_eq!(error["reason"], "not_found");
    assert!(!f.root.join("a.txt").exists());
    assert_eq!(f.partials().len(), 1);
    assert!(f.completed.lock().unwrap().is_empty());
}
```

Run Task 1's complete ordering/digest/size/zero-byte/ownership test bodies against the workspace target too: factor only the target/location factory, returning a WorkspaceUploadDestination admitted through WorkspaceRpc, and call the same append/get/cancel API. Use the same tiny limits for chat-only server-cap coverage and default workspace limits for the declared 1 GiB test. Force rename failure and verify an old overwritten file survives and only a reservation owned by this invocation is removed.

- [ ] **Step 2: Pin index and Git effects.** Add the following complete body in workspace/rpc.rs's test module, where `ImmediateStatusGitRunner` already exists at 2114–2164. Import the proposed upload services/types and existing `production::transfer_routes`, `RouteContext`, `axum::body::Body`, `TransferAccess`. It exercises the shared production callback through both carriers, not just a callback spy.

```rust
#[tokio::test]
async fn rpc_commit_and_http_upload_share_uploaded_callback() {
    for via_rpc in [false, true] {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("repo");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("tracked.txt"), b"base\n").unwrap();
        let (local_started, mut starts) = tokio::sync::mpsc::unbounded_channel();
        let repository = Arc::new(GitRepository::with_runner_for_test(Arc::new(
            ImmediateStatusGitRunner { local_started })));
        let status = StatusBroadcaster::new(repository, Duration::from_secs(3600), 4);
        let mut subscription = status.subscribe(root.clone(), CancellationToken::new()).await.unwrap();
        subscription.recv().await.unwrap();
        starts.recv().await.unwrap(); // discard the initial status read
        let workspace = WorkspaceRpc::new(WorkspaceService::default());
        workspace.handle("projects.listEntries", json!({"cwd":root})).await.unwrap();
        let scans = workspace.index_scans();
        let callback = transfer_routes::uploaded_callback(workspace.clone(), status.clone());
        if via_rpc {
            let uploads = UploadRegistry::new(temp.path().join("attachment-uploads"), UploadLimits::default(),
                Arc::new(tokio::time::Instant::now));
            let services = WorkspaceUploadServices::new(workspace.clone(), callback);
            let owner = UploadOwner::Session("sender".into());
            let begun = services.begin(&uploads, &owner, UploadBeginInput {
                target: UploadTarget::WorkspaceFile { cwd: root.to_string_lossy().into_owned(),
                    relative_directory: "".into(), file_name: "tracked.txt".into() },
                size_bytes: 8, sha256: None,
            }).await.unwrap();
            let id = begun["uploadId"].as_str().unwrap().to_owned();
            uploads.append(&owner, UploadAppendInput { upload_id: id.clone(), offset: 0,
                data: base64::engine::general_purpose::STANDARD.encode(b"changed\n"),
                sha256: Some(crate::crypto::sha256_hex(b"changed\n")) }).await.unwrap();
            services.commit(&uploads, &owner, UploadCommitInput { upload_id: id, overwrite: true })
                .await.unwrap();
        } else {
            let access = TransferAccess::new(b"test-secret".to_vec());
            let url = access.issue_upload(&root, "", "tracked.txt").unwrap().relative_url;
            let token = url.strip_prefix("/api/transfers/").unwrap().to_owned();
            let handler = transfer_routes::upload_handler(access, callback);
            let context = RouteContext { headers: Default::default(), uri: "/".parse().unwrap(),
                cancellation: CancellationToken::new() };
            handler(token, None, true, Body::from("changed\n"), context).await.unwrap();
        }
        let list = workspace.handle("projects.listEntries", json!({"cwd":root})).await.unwrap();
        assert_eq!(workspace.index_scans(), scans + 1);
        assert!(list["entries"].as_array().unwrap().iter().any(|e| e["path"] == "tracked.txt"));
        tokio::time::timeout(Duration::from_secs(5), starts.recv()).await.unwrap().unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if let Some(VcsStatusStreamEvent::Snapshot { local, .. }) = subscription.recv().await {
                    if local.has_working_tree_changes { break; }
                }
            }
        }).await.unwrap();
        assert_eq!(tokio::fs::read(root.join("tracked.txt")).await.unwrap(), b"changed\n");
        workspace.shutdown().await;
        status.shutdown().await;
    }
}
```

The listing uses ProjectEntry.path (`packages/contracts/src/project.ts:18-23`). Existing index behavior and watcher timing remain unchanged. The earlier callback spy proves zero callbacks for exists/error and one for success; this test proves the production index invalidation and Git notification effects.

- [ ] **Step 3: Run red.** `cargo test -p bibcode-server --lib workspace_upload`; `cargo test -p bibcode-server --lib production::uploads_rpc`; `node scripts/run-local-vp.mjs test run packages/contracts/src/uploads.test.ts`. Expected: missing workspace target/commit and new policy helpers, then collision/notification failures.
- [ ] **Step 4: Share path and publication policy.** Extract name/directory admission from `handle_create_upload_url` (name validation before lease); both callers use it. Registry entry stores normalized original target, canonical directory, declared size and owned partial path. `exists` is advisory only. Use `partial_transfer_file_name` in the workspace directory with create_new. A shared reservation/publication helper preserves HTTP's current reserve-before-stream behavior while RPC reserves only at commit. Do not add runtime business logic to contracts.
- [ ] **Step 5: Implement commit and cleanup.** Resolve owner before revealing path/exists data; acquire the short lease, verify current destination and complete digest/size, then reserve and rename. The entry write lock serializes commit/append/cancel. Do not hold a lease while uploading or waiting for Replace. Exists keeps the partial; successful rename releases quota and calls the shared callback. Recheck folder on append/get/commit and forget/remove on loss. If the folder path is replaced or escapes the canonical root, do not follow it to delete an unrelated file. Add no workspace-wide byte cap or restart scan of arbitrary repositories.
- [ ] **Step 6: Green and regression.** Repeat red commands, `cargo test -p bibcode-server --lib`, `cargo test -p bibcode-server --test workspace_rpc`, `cargo test -p bibcode-server --test production_http_routes`, `cargo test -p bibcode-server --test rpc_wire`; preserve all existing HTTP upload test expectations unchanged. Regenerate measured fixtures/counts; run `vp run check:contracts` and report its final uncommitted diff honestly.
- [ ] **Step 7: Docs/gates.** Start “In-channel transfers” in rpc-and-orchestration with workspace uploads, quotas, digest, same-directory partials and commit/Replace; extend its transfer invariant with the shared publication/callback rule. Review runbooks (**reviewed and remain accurate** if unchanged). Run `cargo fmt --all --check`, server Clippy, `vp check`, `vp run typecheck`; the typecheck must prove the widened `uploads.*` failures compile through client-runtime in this task.
- [ ] **Step 8: Live.** `node "$S/live/rpc-check.ts" workspace --endpoint http://localhost:4903`: upload+commit, confirm downloaded disk bytes, then exists refusal and overwrite with no append between commits. Verify entries refresh and Git dirty status. No user-facing progress UI yet; screenshots are not applicable.
- [ ] **Step 9: Stop: READY hand-off to the controller; do not commit.**

### Task 7: Stream files and archives with projects.readDownload

**Commit subject:** `feat(server,contracts): stream workspace downloads over RPC`

**Files:**
- Create: `apps/server/src/transfer/download.rs` (unit tests inline).
- Modify: `apps/server/src/transfer/mod.rs`, `apps/server/src/transfer/archive.rs:117-161`, `apps/server/src/production/transfer_routes.rs:40-116`, `apps/server/src/workspace/rpc.rs:994-1039`.
- Modify: `apps/server/src/production/workspace_preview.rs:93-124`; `packages/contracts/src/transfer.ts`, `packages/contracts/src/transfer.test.ts`, `packages/contracts/src/rpc.ts`; method/scope/fixture/count files.
- Test: `apps/server/tests/production_workspace_preview_rpc.rs`, `apps/server/tests/workspace_rpc.rs`, `apps/server/tests/production_http_routes.rs`, `apps/server/tests/rpc_wire.rs`.
- Docs: `docs/architecture/rpc-and-orchestration.md`.

**Interfaces — consumes:** `ArchiveLimits`, `ArchivePlan`, path normalization/canonicalization, short WorkspaceRpc admission, existing full `RpcSessionContext` in stream registration (no core changes), Task 1 `UploadOwner` for the same authenticated owner key.

**Interfaces — produces (proposed schemas in transfer.ts):**

```ts
export const ProjectFileVersion = Schema.Struct({
  sizeBytes: NonNegativeInt,
  modifiedAtNs: Schema.String.check(Schema.isPattern(/^-?[0-9]+$/)),
});
export type ProjectFileVersion = typeof ProjectFileVersion.Type;
export const ProjectReadDownloadInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePath: TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_ENTRY_PATH_MAX_LENGTH)),
  offset: Schema.optional(NonNegativeInt),
  expect: Schema.optional(ProjectFileVersion),
});
export type ProjectReadDownloadInput = typeof ProjectReadDownloadInput.Type;
export const ProjectDownloadEvent = Schema.Union([
  Schema.TaggedStruct("start", {
    fileName: TrimmedNonEmptyString,
    kind: Schema.Literals(["file", "archive"]),
    sizeBytes: Schema.NullOr(NonNegativeInt),
    version: Schema.NullOr(ProjectFileVersion),
  }),
  Schema.TaggedStruct("bytes", { offset: NonNegativeInt, data: UploadData }),
  Schema.TaggedStruct("end", { totalBytes: NonNegativeInt }),
]);
export type ProjectDownloadEvent = typeof ProjectDownloadEvent.Type;
export class ProjectDownloadError extends Schema.TaggedError<ProjectDownloadError>()("ProjectDownloadError", {
  reason: Schema.Literals(["changed", "capacity", "not_resumable"]),
  message: TrimmedNonEmptyString,
}) {}
export const WsProjectsReadDownloadRpc = Rpc.make(WS_METHODS.projectsReadDownload, {
  payload: ProjectReadDownloadInput, success: ProjectDownloadEvent, stream: true,
  error: Schema.Union([ProjectTransferError, ProjectDownloadError,
    WorkspaceUnavailableError, WorkspaceIdentityError, EnvironmentRpcError]),
});
```

Import `NonNegativeInt` and `UploadData` (no dependency cycle: uploads.ts must not import transfer.ts). `WS_METHODS.projectsReadDownload = "projects.readDownload"`; Rust read_stream; `orchestration:read`. `modifiedAtNs` is the exact signed decimal Unix nanosecond value, avoiding floating-point timestamp rounding; file equality is size plus modification time, not a content hash. A file start always has size/version; archive start has both null.

**Interfaces — produces (proposed Rust API):**

```rust
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFileVersion { pub size_bytes: u64, pub modified_at_ns: String }
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectReadDownloadInput {
    pub cwd: String,
    pub relative_path: String,
    pub offset: Option<u64>,
    pub expect: Option<ProjectFileVersion>,
}
#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DownloadKind { File, Archive }
#[derive(Debug, Serialize)]
#[serde(tag = "_tag", rename_all = "lowercase")]
pub enum ProjectDownloadEvent {
    #[serde(rename_all = "camelCase")]
    Start { file_name: String, kind: DownloadKind, size_bytes: Option<u64>, version: Option<ProjectFileVersion> },
    Bytes { offset: u64, data: String },
    #[serde(rename_all = "camelCase")]
    End { total_bytes: u64 },
}
#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectDownloadReason { Changed, Capacity, NotResumable }
// Wire failure carries _tag="ProjectDownloadError", reason and message.
pub fn project_download_error(reason: ProjectDownloadReason, message: &str) -> Value;
pub struct PreparedDownload { /* opened file+metadata or canonical archive root+ArchivePlan */ }
impl PreparedDownload {
    pub fn file_name(&self) -> &str;
    pub fn kind(&self) -> DownloadKind;
    pub fn size_bytes(&self) -> Option<u64>;
    pub fn version(&self) -> Option<&ProjectFileVersion>;
    pub async fn reader(self, offset: u64, expect: Option<&ProjectFileVersion>)
        -> Result<DownloadReader, Value>;
}
pub struct DownloadReader {
    pub reader: Pin<Box<dyn tokio::io::AsyncRead + Send>>,
    pub completion: Option<tokio::task::JoinHandle<std::io::Result<()>>>,
    /* private file metadata handle for final version verification */
}
pub async fn prepare_download(root: &Path, relative: &str, limits: ArchiveLimits)
    -> Result<PreparedDownload, TransferError>;
// archive.rs: archive_body becomes a wrapper around this shared reader.
pub fn archive_reader(plan: ArchivePlan, root: PathBuf)
    -> (tokio::io::DuplexStream, tokio::task::JoinHandle<std::io::Result<()>>);
// workspace/rpc.rs:
impl WorkspaceRpc {
    pub(crate) async fn prepare_rpc_download(&self, input: &ProjectReadDownloadInput)
        -> Result<PreparedDownload, Value>;
}
// transfer/download.rs, owner-local stream permits; acquisition has no wait queue.
#[derive(Clone, Default)]
pub struct DownloadSlots { /* short mutex over per-owner counts */ }
pub struct DownloadPermit { /* RAII release */ }
impl DownloadSlots {
    pub fn acquire(&self, owner: &UploadOwner) -> Result<DownloadPermit, Value>;
}
pub(crate) fn download_stream(workspace: WorkspaceRpc, slots: DownloadSlots,
    owner: UploadOwner, request: RpcRequest, cancellation: CancellationToken)
    -> tokio::sync::mpsc::Receiver<RpcStreamChunk>;
```

The helper opens regular files once and records metadata from the opened handle; archive planning does not start a writer until `reader`. The HTTP mint, HTTP redeem and RPC share normalization, admission-independent filesystem validation and archive limits. The RPC wrapper alone acquires/drops a short lease; HTTP continues to authorize by its signed token. Keep current HTTP status/header behavior. Move existing transfer error mappers to shared crate-private functions if needed, without changing their wire shape.

- [ ] **Step 1: Add named failing tests with these assertions.**

```rust
#[tokio::test]
async fn download_from_zero_and_resume_return_exact_contiguous_bytes() {
    // Fixture: "abcdef"; collect start/bytes/end from 0, ack each Chunk.
    // Reopen at 3 with start.version: bytes begin at 3 and decode to "def"; end.totalBytes is 6.
}
#[tokio::test]
async fn zero_byte_file_sends_start_and_end_in_one_chunk() {
    // Empty regular file: the first Chunk has exactly start/end, no bytes value.
    // start.sizeBytes and end.totalBytes are 0; Ack the Chunk, then require Exit Success.
    // No Ok(vec![]) is emitted and the connection remains usable.
}
#[tokio::test]
async fn changed_version_and_missing_expect_refuse_nonzero_offsets() {
    // Change file size or mtime after first start; resume => typed changed, no bytes/end.
    // offset > size and offset > 0 without expect are likewise refused as changed.
}
#[tokio::test]
async fn archive_is_streamed_and_cannot_resume_at_a_nonzero_offset() {
    // Start has kind archive, sizeBytes/version null; decoded zip entries equal originals.
    // offset 1 => not_resumable before a zip worker starts.
}
```

Also implement `oversized_archive_fails_before_start` (tiny ArchiveLimits, existing archive_limit_wire copy), `interrupt_stops_reader_and_releases_owner_slot`, `fifth_download_for_one_owner_is_capacity_even_on_another_socket`, `another_owner_has_its_own_four_slots`, `parent_or_symlink_escape_fails_before_start`, `archive_writer_error_never_emits_end`, and `slow_sink_keeps_at_most_three_server_chunks`. Use actual authenticated owner coverage for cross-socket limits; unauthenticated harnesses intentionally share one owner. Schema tests cover every event/error and version string.

- [ ] **Step 2: Run red.** `cargo test -p bibcode-server --lib transfer::download`; `cargo test -p bibcode-server --test production_workspace_preview_rpc download`; `node scripts/run-local-vp.mjs test run packages/contracts/src/transfer.test.ts`. Expected: missing RPC/helper/schema; subsequent failure should be the targeted behavioral assertion.
- [ ] **Step 3: Implement shared checks/reader.** Normalize and canonicalize within root, preserve the ban on downloading root via empty/dot relative path, pre-scan archives and report the same limits as URL minting. Reject nonregular files. Drop admission after checks. Validate file offset/version before seeking, and verify file length/version again before end so truncation/change cannot be reported successful. A zero-byte file sends `start` and `end` together in one Chunk, with no `bytes` value; never represent EOF as `Ok(vec![])`, which makes the stream loop terminate the connection with `connection_defect("RPC stream produced an empty Chunk")`. Archive offsets >0 always fail not_resumable. Convert archive writer errors through ProjectTransferError into a failed stream, never an apparently successful short zip. End is emitted only after the zip worker joins successfully; cancellation drops the reader before awaiting the writer.
- [ ] **Step 4: Implement bounded streaming.** Register `projects.readDownload` beside subscribeProjectEntries with lossless `register_stream_with_context`, owner from `current_session_id`; never use `register_latest_stream`, whose `watch` channel coalesces byte chunks. Acquire a four-slot RAII permit before opening; refuse immediately on the fifth. Use channel capacity 1, first data chunk 64 KiB, adaptation toward 1 s from successive data hand-offs, at most ×2/÷2 and 16 KiB–1 MiB. Every Chunk contains at least one value; zero-byte files pack only `start` and `end` together, never `Ok(vec![])` (the connection defect above). One in-flight, one queued, one being read is the memory bound. Select cancellation during read/send; on receiver drop stop reading, drop duplex to unblock the zip writer and join its completion. No mutex/lease spans backpressure waits.
- [ ] **Step 5: Green/fixtures/gates.** Run focused tests then `cargo test -p bibcode-server --lib`; integration binaries `production_workspace_preview_rpc`, `workspace_rpc`, `production_http_routes`, `rpc_wire`. Follow the contract workflow; `vp run check:contracts`, `cargo fmt --all --check`, server Clippy, `vp check`, `vp run typecheck`. Record the final fixture-diff qualification.
- [ ] **Step 6: Docs/live.** Extend “In-channel transfers” with read scope, start/bytes/end, pacing, stream cap, short admission, file version resume and zip restart. Review runbooks (**reviewed and remain accurate** if unchanged). Run `node "$S/live/rpc-check.ts" download --endpoint http://localhost:4903`, sending Acks for a file, zip and matching-offset resume, then Interrupt mid-stream. Confirm no file token is minted. No UI screenshots yet.
- [ ] **Step 7: Stop: READY hand-off to the controller; do not commit.**

### Task 8: Stream exact assets and advertise in-channel transfers

**Commit subject:** `feat(server,contracts): serve assets inside encrypted RPC sessions`

**Files:**
- Modify: `packages/contracts/src/assets.ts`, `packages/contracts/src/assets.test.ts`, `packages/contracts/src/environment.ts`, `packages/contracts/src/environment.test.ts`, `packages/contracts/src/rpc.ts`, fixture/count/inventory/scope files.
- Modify: `apps/server/src/assets/mod.rs:97-220`, `apps/server/src/workspace/rpc.rs:1105-1165`, `apps/server/src/production/workspace_preview.rs`; tests in these modules and `apps/server/tests/production_workspace_preview_rpc.rs`.
- Modify: `apps/server/src/lifecycle.rs:66`, `apps/server/src/production/control.rs:2345`, their capability tests and typed fixture literals.
- Modify/test: `apps/server/tests/rpc_liveness.rs`; `apps/server/src/production/runtime.rs:1175` only to relocate the fallback constant/import, not its HTTP asset method.
- Docs: `docs/architecture/rpc-and-orchestration.md`.

**Interfaces — consumes:** Existing `AssetResource`, thread/path admission and `AssetAccess`; Task 7 stream pacing/reader pattern; Task 6 workspace uploads.

**Interfaces — produces (proposed contracts):**

```ts
export const AssetReadInput = Schema.Struct({ resource: AssetResource });
export type AssetReadInput = typeof AssetReadInput.Type;
export const AssetReadEvent = Schema.Union([
  Schema.TaggedStruct("start", { mimeType: TrimmedNonEmptyString, sizeBytes: NonNegativeInt }),
  Schema.TaggedStruct("bytes", { offset: NonNegativeInt, data: UploadData }),
  Schema.TaggedStruct("end", {}),
]);
export type AssetReadEvent = typeof AssetReadEvent.Type;
export class AssetTooLargeError extends Schema.TaggedError<AssetTooLargeError>()("AssetTooLargeError", {
  resource: AssetResource, limitBytes: NonNegativeInt, message: TrimmedNonEmptyString,
}) {}
export const WsAssetsReadRpc = Rpc.make(WS_METHODS.assetsRead, {
  payload: AssetReadInput, success: AssetReadEvent, stream: true,
  error: Schema.Union([AssetAccessError, AssetTooLargeError,
    WorkspaceUnavailableError, WorkspaceIdentityError, EnvironmentRpcError]),
});
// In ExecutionEnvironmentCapabilities:
inChannelTransfers: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
```

`WS_METHODS.assetsRead = "assets.read"`; Rust read_stream; read scope. Add `inChannelTransfers: true` to both JSON producers only in this task: uploads.commit, projects.readDownload and assets.read now all exist. Typed HTTP descriptor stays unchanged.

**Interfaces — produces (proposed Rust additions):**

```rust
// assets/mod.rs: shared internally with issue(), no token signing on this path.
impl AssetAccess {
    pub async fn read_exact(&self, request: AssetIssueRequest) -> Result<ResolvedAsset, AssetError>;
}
pub const FALLBACK_FAVICON: &str = /* existing runtime.rs SVG, moved verbatim */;
#[derive(Clone, Debug, Deserialize)]
pub struct AssetReadInput { pub resource: AssetResource }
#[derive(Debug, Serialize)]
#[serde(tag = "_tag", rename_all = "lowercase")]
pub enum AssetReadEvent {
    #[serde(rename_all = "camelCase")]
    Start { mime_type: String, size_bytes: u64 },
    Bytes { offset: u64, data: String },
    End,
}
// workspace/rpc.rs:
impl WorkspaceRpc {
    pub(crate) async fn resolve_exact_asset(&self, resource: AssetResource)
        -> Result<ResolvedAsset, Value>;
}
// production/workspace_preview.rs:
pub(crate) fn asset_read_stream(workspace: WorkspaceRpc, request: RpcRequest,
    cancellation: CancellationToken) -> tokio::sync::mpsc::Receiver<RpcStreamChunk>;
```

**Tree qualification:** The fallback SVG exists only as a private constant at runtime.rs:1175. Move it verbatim to assets/mod.rs and import it in runtime.rs, keeping the HTTP method body at 548–600 unchanged. This is one extra import/constant hunk beyond the runtime restriction; duplicating the SVG would create two sources of truth. List it explicitly in READY.

- [ ] **Step 1: Add failing tests.** `asset_read_attachment_bytes_match`, `asset_read_workspace_image_uses_thread_admission`, `asset_read_favicon_falls_back_to_svg`, `asset_read_refuses_html_and_pdf_sibling_resources`, `asset_read_refuses_more_than_ten_mib_before_bytes`, `small_asset_start_bytes_end_share_one_chunk`, `asset_read_interrupt_stops_io`, `in_channel_capability_is_true_in_both_rpc_descriptors`, and contract default-false/shape tests. Key skeleton:

```rust
#[tokio::test]
async fn small_asset_start_bytes_end_share_one_chunk() {
    // Read the fallback icon via production handler; first recv is Ok(Vec) of length 3.
    // Assert tags start/bytes/end, image/svg+xml, byte length and exact fallback bytes.
    // Next recv closes; no asset token or /api/assets URL was created.
}
```

- [ ] **Step 2: Run red.** `cargo test -p bibcode-server --lib asset_read`; `cargo test -p bibcode-server --test production_workspace_preview_rpc asset`; contract assets/environment focused tests. Expected: missing stream/capability or small-image packing failure.
- [ ] **Step 3: Implement exact resolution.** Register `assets.read` with lossless `register_stream_with_context` (or `register_stream`), never `register_latest_stream`, whose `watch` channel coalesces byte chunks. Factor resource resolution from `AssetAccess::issue`; keep its existing HTML/PDF sibling claims for old clients. `read_exact` refuses that sibling-capability class with AssetPreviewTypeValidationError and never signs anything. Attachment and icon resources remain exact; workspace image must be admitted via its thread and canonical root. Resolve fallback without disk buffering. Check opened file size ≤10 MiB, also cap cumulative reads if it grows; typed AssetTooLargeError carries limit 10 * 1024 * 1024. Small means ≤the initial 64 KiB data chunk, including fallback; pack a nonempty file's three values in one Chunk. A zero-byte file sends only `start` and `end` together in one Chunk, no `bytes` value. Never send `Ok(vec![])`: both stream loops terminate the connection with `connection_defect("RPC stream produced an empty Chunk")`. Larger images use bounded adaptive streaming.
- [ ] **Step 4: Add E2EE liveness trials.** At 64 KiB/s, real `projects.readDownload` of 3 MiB and workspace begin/append/commit of 3 MiB finish exactly with no client 4408 and no server reap. Ping while active and assert Pong within one measured chunk. For upload inject Ping immediately after an append reply, before replacing that freed slot, so one append can precede it; C's general two-outstanding bound remains two chunks. Do not claim the one-chunk controlled trial changes that general bound. Verify upstream rate is enabled, and the download helper Acks every Chunk.
- [ ] **Step 5: Green/gates.** Focused tests, server lib; `production_workspace_preview_rpc`, `workspace_rpc`, `rpc_liveness`, `rpc_wire`, `server_runtime` integrations. Regenerate fixtures/counts; `vp run check:contracts`; Cargo fmt/server Clippy; `vp check`; `vp run typecheck`. Assert production registry is complete and both flags are true only now.
- [ ] **Step 6: Docs/live.** Complete the in-channel section: all method names/scopes, stream shapes/pacing, quotas, disk staging, cancellation and capability. Review runbooks and report **reviewed and remain accurate** if unchanged. Run `node "$S/live/rpc-check.ts" asset --endpoint http://localhost:4911`: read an image and fallback, refuse workspace HTML/PDF, confirm no token URL. No UI screenshots yet.
- [ ] **Step 7: Stop: READY hand-off to the controller; do not commit.**

### Task 9: Route policy, resumable downloads and workspace upload operations

**Commit subject:** `feat(client-runtime): transfer workspace files through encrypted sessions`

**Files:**
- Create: `packages/client-runtime/src/operations/fileContentRoute.ts`, `packages/client-runtime/src/operations/fileContentRoute.test.ts`, `packages/client-runtime/src/operations/fileTransfers.ts`, `packages/client-runtime/src/operations/fileTransfers.test.ts`.
- Create: `packages/client-runtime/src/state/fileTransfers.ts`, `packages/client-runtime/src/state/fileTransfers.test.ts`.
- Modify: `packages/client-runtime/src/rpc/client.ts:42-70,120-179`, `packages/client-runtime/src/operations/uploadStager.ts`, `packages/client-runtime/src/operations/index.ts`, `packages/client-runtime/package.json` (one explicit state subpath).
- Modify/test: `packages/client-runtime/src/e2ee/testSupport.ts:120-145`, `packages/client-runtime/src/e2ee/serverInterop.test.ts`.
- Docs: `docs/architecture/connection-runtime.md`.

**Interfaces — consumes:** Tasks 6–8 methods and `inChannelTransfers`; Task 4 stager and shared nextSession. Existing config/prepared publications belong to the carrying session; descriptor capability alone never permits transfer.

**Interfaces — produces (proposed TypeScript):**

```ts
// operations/fileContentRoute.ts
export type FileContentRoute = "http" | "in-channel" | "unavailable";
export function fileContentRoute(prepared: PreparedConnection, config: ServerConfig): FileContentRoute {
  if (prepared.e2ee === null) return "http";
  return config.environment.capabilities.inChannelTransfers ? "in-channel" : "unavailable";
}
// rpc/client.ts, preserving the existing subscription retry options separately:
export interface EnvironmentStreamCallOptions { readonly streamBufferSize?: number }
export declare function runStreamInSession<TTag extends EnvironmentStreamCommandRpcTag>(
  session: RpcSession, environmentId: string, tag: TTag, input: EnvironmentRpcInput<TTag>,
  options?: EnvironmentStreamCallOptions,
): Stream.Stream<EnvironmentRpcStreamValue<TTag>, EnvironmentRpcStreamFailure<TTag>>;
// runStream(tag, input, options?) delegates to this; subscribeInSession gets a separate
// final callOptions argument after its existing options argument.
// requestInSession gains a final callOptions parameter matching the generated unary
// method options; forward the second argument instead of dropping it in the cast.
export type EnvironmentUnaryCallOptions = {
  readonly headers?: import("effect/unstable/http/Headers").Input;
  readonly context?: Context.Context<never>;
};
// operations/fileTransfers.ts
export type DownloadStart = Extract<ProjectDownloadEvent, { readonly _tag: "start" }>;
export interface FileTransferProgress {
  readonly direction: "download" | "upload";
  readonly fileName: string;
  readonly sentBytes: number;
  readonly totalBytes: number | null;
  readonly phase: "transferring" | "reconnecting";
}
export class FileTransferClientError extends Schema.TaggedError<FileTransferClientError>()("FileTransferClientError", {
  reason: Schema.Literals(["unavailable", "protocol", "browser_limit", "busy", "save"]),
  message: Schema.String,
}) {}
export interface DownloadSink<A> {
  readonly start: (start: DownloadStart) => Effect.Effect<void, FileTransferClientError>;
  readonly write: (offset: number, bytes: Uint8Array) => Effect.Effect<void, FileTransferClientError>;
  readonly reset: (start: DownloadStart) => Effect.Effect<void, FileTransferClientError>;
  readonly finish: () => Effect.Effect<A, FileTransferClientError>;
  readonly abort: () => Effect.Effect<void>;
}
export interface DownloadFileInput<A> {
  readonly cwd: string;
  readonly relativePath: string;
  readonly sink: DownloadSink<A>;
  readonly onProgress?: (progress: FileTransferProgress) => void;
}
export interface UploadWorkspaceFileInput {
  readonly cwd: string;
  readonly relativeDirectory: string;
  readonly fileName: string;
  readonly file: Blob;
  readonly confirmReplace: (fileName: string) => Effect.Effect<boolean>;
  readonly onProgress?: (progress: FileTransferProgress) => void;
}
export type DownloadFailure = EnvironmentRpcStreamFailure<typeof WS_METHODS.projectsReadDownload>
  | FileTransferClientError | EnvironmentRpcUnavailableError;
export declare function downloadFile<A>(input: DownloadFileInput<A>):
  Effect.Effect<A, DownloadFailure, EnvironmentRegistry | EnvironmentSupervisor>;
export declare function uploadWorkspaceFile(input: UploadWorkspaceFileInput):
  Effect.Effect<UploadCommitResult, UploadFailure | FileTransferClientError,
    EnvironmentRegistry | EnvironmentSupervisor>;
// state/fileTransfers.ts: concrete sink result at the application command boundary.
export type DownloadResult =
  | { readonly fileName: string; readonly blob: Blob }
  | { readonly path: string };
export function createFileTransferEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  const concurrency = { mode: "serial" as const,
    key: ({ environmentId }: { readonly environmentId: string }) => environmentId };
  return {
    download: createEnvironmentCommand(runtime, {
      label: "environment-data:transfers:download",
      execute: (input: DownloadFileInput<DownloadResult>) => downloadFile(input),
      scheduler, concurrency,
    }),
    upload: createEnvironmentCommand(runtime, {
      label: "environment-data:transfers:upload",
      execute: (input: UploadWorkspaceFileInput) => uploadWorkspaceFile(input),
      scheduler, concurrency,
    }),
  };
}
```

These exact factories infer the full Atom command success/failure types from the operations, including registry/runtime errors; do not erase results to unknown. The shared scheduler is keyed only by environmentId and shared by both directions. Add the active-operation/progress Atom family in the same state module, with an invocation-owned AbortController and completion state; the web reads that family across panels. Closing the Files panel must not silently discard a running save. The invocation/progress/abort owner survives through completion, and a browser-ready Blob stays owned until Save/dismissal.

Expand Task 4 `UploadCapability` with `inChannelTransfers` and add `typeof WS_METHODS.uploadsCommit` to `UploadFailure`'s `EnvironmentRpcFailure` tag union. Task 6's widened begin/append/get failures are already inherited from the generated RPC types; `DownloadFailure` likewise derives from `rpc/client.ts` and includes transport middleware failures. Avoid copying stager logic into workspace transfer code.

Add projectsReadDownload and assetsRead to **EnvironmentStreamCommandRpcTag**, hence the combined stream exclusion used by EnvironmentUnaryRpcTag; do not make them durable subscriptions. Audit both hand-kept unions. Pass `streamBufferSize: 2` to each transfer/asset call. `subscribeServerConfig` retains its special no-options signature and single-stream behavior. Existing inputAdmission already forwards remaining arguments.

- [ ] **Step 1: Write failing policy/stream tests.**

```ts
it.each([null, { hostKey: "test", auth: { type: "test" } }])("ignores the endpoint scheme", (e2ee) => {
  for (const scheme of ["http", "https"]) for (const capable of [false, true]) {
    const prepared = { e2ee, httpBaseUrl: `${scheme}://example.invalid` } as PreparedConnection;
    const config = { environment: { capabilities: { inChannelTransfers: capable } } } as ServerConfig;
    expect(fileContentRoute(prepared, config)).toBe(e2ee === null ? "http" : capable ? "in-channel" : "unavailable");
  }
});
```

Add `stream_call_forwards_buffer_size_two`, `download_rejects_gap_overlap_or_missing_end`, `download_resumes_at_sink_committed_offset_with_version`, `changed_file_never_finishes_sink`, `archive_resets_sink_once_then_fails_next_cut`, `interrupt_aborts_sink_once`, `pinned_transfer_never_calls_create_url_or_fetch`, `workspace_exists_asks_before_first_slice`, `commit_exists_retries_same_upload_without_appends`, `cancel_replace_cancels_upload`, `one_files_operation_per_environment_across_panels`, and `different_environments_progress_independently`. Fake session replacement uses shared nextSession/clone registry patterns; keep cancellation tests scoped with TestClock and fibers.

- [ ] **Step 2: Run red.** `(cd packages/client-runtime && node ../../scripts/run-local-vp.mjs test run src/operations/fileContentRoute.test.ts src/operations/fileTransfers.test.ts src/state/fileTransfers.test.ts)`. Expected: missing selector/operations, then buffer-size, offset or single-flight assertion failures.
- [ ] **Step 3: Implement download.** Select with prepared/config from the same acquired session and re-evaluate on replacement. Pinned unavailable fails before any RPC mint. Stream start precedes bytes; verify type/name/version on resume; decode bounded base64 and exact offset; advance offset only after sink.write completes. Require end.totalBytes to equal the sink's total and file size when known. No success on bare stream completion. On transport loss retain the sink, wait nextSession, request with offset/expect; archive resets once to 0, dropping previous bytes/disk partial. Preserve typed changed/capacity/path failures. Explicit Cancel interrupts the stream and awaits bounded sink cleanup.
- [ ] **Step 4: Implement upload/Replace.** Use the stager's beforeBytes hook to inspect begin.exists and await Replace; refusing interrupts and cancels. After completion call uploads.commit with the user's overwrite choice. A late exists refusal asks again and retries that same uploadId without reading bytes again. On commit response loss, do not silently report success or blindly overwrite a potentially changed destination: report that completion could not be confirmed and preserve recoverability. No new HTTP fallback. Reconnecting without the capability is terminal and actionable.
- [ ] **Step 5: Extend interop.** New test-local `streamTestRpc(channel, id, tag, payload, onValue): Promise<void>` in e2ee/testSupport sends Request, dispatches every value, Acks every Chunk including one containing end, then requires Exit Success. On a value error sends Interrupt. The existing `requestTestRpc` is unary-only. Real Rust server cases download an exact file, inspect zip entries, upload then commit and verify bytes by download. Use test-owned settings with all providers disabled and isolated HOME-style roots; do not expose credentials in failed assertion dumps.

```sh
cargo build -p bibcode-server
(cd packages/client-runtime && BIBCODE_E2EE_SERVER_BIN="$PWD/../../target/debug/bibcode" \
  node ../../scripts/run-local-vp.mjs test run src/e2ee/serverInterop.test.ts)
```

Run this only with logging fakes first on PATH. An unset binary skips the interop tests and is not evidence. A sandbox loopback denial is reported not run; never patch the product around it.

- [ ] **Step 6: Green/gates.** Repeat focused tests, all client-runtime tests, opt-in interop; `cargo fmt --all --check`, server Clippy, `vp check`, `vp run typecheck`. Check exported package subpaths and no new dependency/runtime.
- [ ] **Step 7: Docs/live.** Add route selector, capability gating, one-transfer scheduling, sink acknowledgements, download resume and zip restart to connection-runtime. Review runbooks and record **reviewed and remain accurate** where unchanged. No separate live UI check beyond interop in this task.
- [ ] **Step 8: Stop: READY hand-off to the controller; do not commit.**

### Task 10: Environment-owned asset byte cache

**Commit subject:** `feat(client-runtime): cache in-channel assets as blob URLs`

**Files:**
- Create: `packages/client-runtime/src/state/assetByteCache.ts`, `packages/client-runtime/src/state/assetByteCache.test.ts`.
- Modify: `packages/client-runtime/src/state/assets.ts:46-80`, `packages/client-runtime/src/state/assets.test.ts`; `packages/client-runtime/src/e2ee/serverInterop.test.ts`.
- Docs: `docs/architecture/connection-runtime.md`.

**Interfaces — consumes:** `assets.read`, Task 9 route selector/stream options, shared nextSession, environment Atom lifetime. No web/desktop imports.

**Interfaces — produces (proposed TypeScript):**

```ts
export interface AssetUrlLease {
  readonly url: string;
  readonly sizeBytes: number;
  readonly release: () => void; // idempotent, synchronous reference decrement
}
export interface AssetUrlFactory {
  readonly create: (blob: Blob) => string;
  readonly revoke: (url: string) => void;
}
export interface AssetByteCache {
  readonly acquire: (resource: AssetResource) => Effect.Effect<AssetUrlLease, AssetReadFailure>;
  readonly dispose: () => Effect.Effect<void>;
}
export type AssetReadFailure = EnvironmentRpcStreamFailure<typeof WS_METHODS.assetsRead>
  | FileTransferClientError | EnvironmentRpcUnavailableError;
export interface AssetReadPort {
  readonly read: (resource: AssetResource) => Stream.Stream<AssetReadEvent, AssetReadFailure>;
}
export declare function makeAssetByteCache(input: {
  readonly port: AssetReadPort;
  readonly urls: AssetUrlFactory;
  readonly budgetBytes?: number; // production 64 MiB, tests use small images
}): AssetByteCache;
```

`AssetReadFailure` uses the inferred per-method stream failure from `rpc/client.ts`, including `RpcResponseTooLargeError`, plus the client-side classes shown above. The production AssetReadPort performs a single transport-cut re-issue on nextSession and reads capability again. Use a per-environment cache, and a cache epoch tied to accepted persistent-store identity/connection target so profile retargeting never reuses bytes from another server. A normal reconnect preserves complete entries for that same identity. Reference counts protect visible images; the **64 MiB budget applies to unreferenced entries**, not to revoking a displayed URL. Each file remains capped at 10 MiB. Dispose revokes all URLs and interrupts pending reads when the environment is removed.

`createAssetEnvironmentAtoms` exposes resolved URLs in addition to the old raw mint commands: `url({ environmentId, resource })` and `urls({ environmentId, resources })`, returning Atom values of `string | null` / readonly arrays. In-channel atoms acquire a lease and release it in their finalizer. HTTP branch alone observes createUrl/createUrls; unavailable observes neither. Keys are serialized AssetResource plus environment identity, not just a file name.

- [ ] **Step 1: Add named tests/skeleton.**

```ts
it.effect("shares bytes and retains a visible URL until the final release", () => Effect.gen(function* () {
  // Fake read emits start, one bytes event, end; URL factory records create/revoke.
  // Concurrent acquire(same resource) => one read, same URL, two leases.
  // release(first) => no revoke; release(second) => eligible for LRU.
}));
```

Add `unreferenced_lru_enforces_sixty_four_mib_budget`, `budget_eviction_revokes_exactly_once`, `referenced_assets_are_never_evicted`, `at_most_two_reads_per_environment`, `cancelled_waiter_does_not_cancel_another_reference`, `one_transport_cut_reissues_next_session_once`, `second_cut_does_not_loop`, `missing_end_or_wrong_offset_does_not_cache`, `environment_dispose_revokes_and_interrupts`, `profile_retarget_does_not_reuse_previous_blobs`, and `unavailable_never_mints_a_token`. Use tiny injected cache budgets and deterministic URL strings; no 64 MiB fixture allocation is needed.

- [ ] **Step 2: Run red.** `(cd packages/client-runtime && node ../../scripts/run-local-vp.mjs test run src/state/assetByteCache.test.ts src/state/assets.test.ts)`. Expected: missing cache/resolved atoms or incorrect lifetime.
- [ ] **Step 3: Implement cache/lifetimes.** Two-reader semaphore covers the whole attempt including reconnect; duplicate requests coalesce. Releasing the last waiter can interrupt a still-running read; releasing one of several cannot. Validate start/contiguous bytes/end and exact announced length before creating a Blob URL; never retain a partial. Reissue starts at zero, once, with no asset resume protocol. Evict oldest unreferenced entries until under budget; use monotonic recency, not wall-clock timers. LRU bookkeeping never retains a released closure that keeps the Blob alive after revoke.
- [ ] **Step 4: Integrate route-aware atoms.** Use the shared selector on the active carrying session and scope finalizers; unavailable returns null for the existing name fallback. Do not instantiate both old mint and new read queries then select a result: the unused branch could leak a token. Keep cache lifetime in environment state so separate consumers share references without a global URL bag.
- [ ] **Step 5: Interop/green/gates.** Add a real-server image read to serverInterop: MIME, exact bytes, all stream Acks and end. Run focused tests, full client-runtime suite, opt-in interop with BIBCODE_E2EE_SERVER_BIN; Cargo fmt/server Clippy, `vp check`, `vp run typecheck`.
- [ ] **Step 6: Docs/live.** Explain reference ownership, unreferenced LRU, two reads and one re-issue in connection-runtime. Runbooks reviewed and remain accurate; no separate live check or screenshots until Task 13.
- [ ] **Step 7: Stop: READY hand-off to the controller; do not commit.**

### Task 11: Desktop streaming disk sink through raw IPC

**Commit subject:** `feat(desktop): save in-channel downloads through the desktop bridge`

**Files:**
- Modify: `apps/desktop/src-tauri/src/bridge.rs:1657-1778,1802-1871,998-1017,4000-4020` (new commands adjacent to existing downloads).
- Modify: `apps/desktop/src-tauri/src/lib.rs:7-59,94-111,168-242,365-498`; `apps/desktop/src-tauri/permissions/desktop-bridge.toml:1-52`.
- Modify: `packages/contracts/src/ipc.ts:1320-1328`; `apps/web/src/tauriDesktopBridge.ts:81-99,152-158,573-591`, `apps/web/src/tauriInvokeRouting.ts:1-22`, `apps/web/src/vite-env.d.ts:20-22`.
- Test: existing Rust bridge/lib test modules, `apps/web/src/tauriDesktopBridge.test.ts`, `apps/web/src/tauriInvokeRouting.test.ts`.
- Docs: `docs/architecture/overview.md:40-43` (desktop adapter ownership; no existing exhaustive transfer-command list was found), affected native runbooks if launch/evidence procedure changes.

**Interfaces — consumes:** Host name rules and `unique_destination`; shared `partial_transfer_file_name`; raw Tauri Request; main-webview load generation pattern from `apps/desktop/src-tauri/src/preview/host.rs:777-810`. No privileged read command and no host network request.

**Interfaces — produces (proposed TypeScript IPC contracts):**

```ts
export const DownloadFileHandle = TrimmedNonEmptyString;
export type DownloadFileHandle = typeof DownloadFileHandle.Type;
export const BeginDownloadFileInput = Schema.Struct({
  directory: TrimmedNonEmptyString, fileName: TrimmedNonEmptyString,
});
export type BeginDownloadFileInput = typeof BeginDownloadFileInput.Type;
export const BeginDownloadFileResult = Schema.Struct({ handle: DownloadFileHandle });
export type BeginDownloadFileResult = typeof BeginDownloadFileResult.Type;
export const DownloadFileHandleInput = Schema.Struct({ handle: DownloadFileHandle });
export type DownloadFileHandleInput = typeof DownloadFileHandleInput.Type;
export const FinishDownloadFileResult = Schema.Struct({ path: TrimmedNonEmptyString });
export type FinishDownloadFileResult = typeof FinishDownloadFileResult.Type;
export interface AppendDownloadFileInput { readonly handle: DownloadFileHandle; readonly bytes: Uint8Array }
// DesktopBridge optional members for compatibility with older hosts:
beginDownloadFile?: (input: BeginDownloadFileInput) => Promise<BeginDownloadFileResult>;
appendDownloadFile?: (input: AppendDownloadFileInput) => Promise<void>;
finishDownloadFile?: (input: DownloadFileHandleInput) => Promise<FinishDownloadFileResult>;
abortDownloadFile?: (input: DownloadFileHandleInput) => Promise<void>;
// tauriInvokeRouting.ts and vite-env.d.ts:
export type TauriCommandArguments = Record<string, unknown> | ArrayBuffer | Uint8Array | undefined;
export interface TauriCommandOptions { readonly headers: Record<string, string> }
export type TauriCommandInvoker = (command: string, args: TauriCommandArguments,
  options?: TauriCommandOptions) => Promise<unknown>;
// TauriCommandMock also receives optional options; InvokeTauriCommandInput adds options?.
// TauriCoreApi.invoke<T>(command, args?, options?): Promise<T> uses these same shapes.
```

Web append calls `desktop_bridge_append_download_file` with the Uint8Array as its body and header `x-bibcode-download-handle`. The options argument is optional, but its `headers` field is required when supplied, matching Tauri's `InvokeOptions`; forward it unchanged through imported invoke, window.__TAURI__ invoke and the E2E mock path, preserving the raw body too. Do not convert to Array.from, JSON/base64 or a string. Feature metadata adds `streamingDownloads: true`; the web installs all four optional methods only when advertised. An older desktop host never forces a pinned transfer onto HTTP: missing disk-sink commands fail with “Update this app to save encrypted downloads.” The Blob sink is browser-only, so desktop downloads have no introduced size cap.

**Interfaces — produces (proposed Rust in bridge.rs):**

```rust
#[derive(Clone, Debug, serde::Serialize)]
pub struct BeginDownloadFileResult { pub handle: String }
#[derive(Clone, Debug, serde::Serialize)]
pub struct FinishDownloadFileResult { pub path: String }
#[derive(Clone)]
pub(crate) struct DownloadFileManager { /* shared map, page generation, clock and sweep owner */ }
impl DownloadFileManager {
    pub(crate) fn new() -> Self;
    pub(crate) fn start_sweeper(&self);
    pub(crate) async fn begin(&self, directory: PathBuf, file_name: String)
        -> Result<BeginDownloadFileResult, String>;
    pub(crate) async fn append(&self, handle: &str, bytes: Vec<u8>) -> Result<(), String>;
    pub(crate) async fn finish(&self, handle: &str) -> Result<FinishDownloadFileResult, String>;
    pub(crate) async fn abort(&self, handle: &str) -> Result<(), String>;
    pub(crate) fn advance_page_generation(&self) -> u64;
    pub(crate) async fn abort_before_generation(&self, generation: u64);
    pub(crate) async fn shutdown(&self);
}
#[tauri::command]
pub(crate) async fn desktop_bridge_begin_download_file(
    webview: tauri::Webview<DesktopRuntime>, state: tauri::State<'_, DownloadFileManager>,
    directory: String, file_name: String,
) -> Result<BeginDownloadFileResult, String>;
#[tauri::command]
pub(crate) async fn desktop_bridge_append_download_file(
    webview: tauri::Webview<DesktopRuntime>, state: tauri::State<'_, DownloadFileManager>,
    request: tauri::ipc::Request<'_>,
) -> Result<(), String>;
#[tauri::command]
pub(crate) async fn desktop_bridge_finish_download_file(
    webview: tauri::Webview<DesktopRuntime>, state: tauri::State<'_, DownloadFileManager>, handle: String,
) -> Result<FinishDownloadFileResult, String>;
#[tauri::command]
pub(crate) async fn desktop_bridge_abort_download_file(
    webview: tauri::Webview<DesktopRuntime>, state: tauri::State<'_, DownloadFileManager>, handle: String,
) -> Result<(), String>;
```

Tauri registration is the public boundary; the command functions and manager use crate-visible Rust visibility. All four commands validate `webview.label() == "main"` before accessing the manager. Preview creates child webviews in that same window (`apps/desktop/src-tauri/src/preview/host.rs:830-840`); Tauri 2.11.5's `WebviewWindow` command extractor then rejects even the main caller with “current webview is not a WebviewWindow”, so use `tauri::Webview<DesktopRuntime>`. Inputs are renderer-authorized folder/name as today, with no arbitrary byte-source path.

- [ ] **Step 1: Add failing tests/key assertions.**

```rust
#[tokio::test]
async fn streamed_download_preserves_order_and_uniquifies_the_final_name() {
    // Existing report.zip contains "old"; begin a new report.zip.
    // append raw b"abc" then b"def"; finish returns report (2).zip with abcdef.
    // Old report.zip is unchanged; no .part or reservation remains.
}
#[tokio::test(start_paused = true)]
async fn idle_and_page_load_abort_remove_only_old_handles() {
    // Advance to 599 s: handle exists; append refreshes activity; 600 idle seconds abort.
    // Begin old, advance generation, begin new, run old abort task: only old disappears.
}
```

Add `abort_removes_partial_and_is_idempotent`, `finish_failure_preserves_existing_destination`, `raw_body_requires_handle_header_and_rejects_json`, `foreign_webview_cannot_write_main_download`, `download_commands_work_with_a_preview_child_open` (invoke begin, raw append and cancel/abort from main with a child webview present; verify exact partial bytes then cleanup), `append_after_reload_is_refused`, `raw_appends_are_serialized`, `shutdown_joins_sweeper_and_removes_partials`; macro/permission inventory tests; web `raw_download_bytes_and_headers_reach_both_invoke_routes`, `string_rejection_remains_actionable`. No test writes into an actual Downloads folder.

- [ ] **Step 2: Run red.** `cargo test -p bibcode-desktop --lib streamed_download`; `cargo test -p bibcode-desktop --lib download_commands_work_with_a_preview_child_open`; `cargo test -p bibcode-desktop --lib desktop_bridge`; `(cd apps/web && vp test run --project unit src/tauriDesktopBridge.test.ts src/tauriInvokeRouting.test.ts)`. Expected: missing commands/raw argument types then failed lifetime/inventory assertions.
- [ ] **Step 3: Implement manager.** Manage one state instance in lib.rs. Begin validates folder/name and creates only an unpredictable handle plus a unique `.part`; finish flushes/closes then reuses atomic unique_destination and rename. Per-handle writes are serialized; command bytes are bounded to the protocol chunk size, copied at most once from Request before await. Idle expiry is 10 minutes since begin/append, swept at bounded intervals; cleanup closes handles before deleting so Windows works. Abort interrupts pending writes and removes only owned files. No whole-file buffer and no total desktop cap.
- [ ] **Step 4: Add reload lifecycle.** Register a main-webview `PageLoadEvent::Started` observer; increment generation synchronously, then abort only handles from earlier generations. Ignore Finished/preview-webview events. Delayed old cleanup cannot abort a handle begun by the new page. Join/cancel the sweeper and abort remaining handles at desktop exit. Keep the existing preview incarnation mechanism separate.
- [ ] **Step 5: Register in all five audited locations.** Production `generate_handler!`; `desktop_bridge_commands!` test list; permission commands.allow; bridge.rs mock `generate_handler!`; bridge metadata feature. Existing default capability JSON and build.rs require no change. Wire the optional DesktopBridge methods using normal error normalization, with raw append options preserved.
- [ ] **Step 6: Green/gates.** Focused tests, `cargo test -p bibcode-desktop --lib`, full web unit project; `cargo fmt --all --check`; `cargo clippy -p bibcode-desktop --all-targets -- -D warnings`; server Clippy for the shared crate dependency; `vp check`; `vp run typecheck`. Review bridge-facing copy against UI.md; there are no new React components in this task.
- [ ] **Step 7: Docs/live.** Add the four disk-sink commands and reload/idle lifetime to overview's desktop adapter paragraph. Review platform runbooks and mark **reviewed and remain accurate** if unchanged. Rust-level scripted check is the streamed_download unit test over a temp directory; no UI uses the commands yet. The Xvfb/WebKitGTK live download with Preview open and screenshots explicitly wait for Task 12.
- [ ] **Step 8: Stop: READY hand-off to the controller; do not commit.**

### Task 12: Files transfers use in-channel operations and a progress toast

**Commit subject:** `feat(web): show encrypted file transfer progress and cancellation`

**Files:**
- Create: `apps/web/src/state/fileTransfers.ts`, `apps/web/src/components/files/transferPresentation.ts`, `apps/web/src/components/files/transferPresentation.test.ts`.
- Modify: `apps/web/src/components/files/useFileTransfers.ts:122-324`, `apps/web/src/components/files/fileTransfers.ts:13-19,32-64,117-168`, and their existing tests.
- Modify: `apps/web/src/components/files/FileBrowserPanel.tsx:283-314,753-796,917-949`, `apps/web/src/components/files/FileBrowserPanel.test.tsx`, `apps/web/src/components/files/FileTreeContextMenu.logic.ts:95-104`, its existing test.
- Docs: `docs/user/workspace-ui.md`, `docs/user/remote-access.md`, `docs/testing/cross-platform-validation.md:714,1222`, `docs/testing/execution-report-template.md`; review platform runbooks.

**Interfaces — consumes:** Task 9 environment transfer commands/selector/sink, Task 11 optional bridge, Task 5's shared `formatTransferBytes` from `apps/web/src/lib/formatTransferBytes.ts`, existing hidden multiple-file input, existing Replace dialog and toastManager.

**Interfaces — produces (proposed web-only types):**

```ts
export type BrowserDownloadReady = { readonly fileName: string; readonly blob: Blob };
export type DesktopDownloadSaved = { readonly path: string };
export declare function browserDownloadSink(): DownloadSink<BrowserDownloadReady>;
export declare function desktopDownloadSink(bridge: Required<Pick<DesktopBridge,
  "beginDownloadFile" | "appendDownloadFile" | "finishDownloadFile" | "abortDownloadFile">>,
  directory: string): DownloadSink<DesktopDownloadSaved>;
export type TransferToastState =
  | { readonly phase: "running"; readonly progress: FileTransferProgress; readonly cancel: () => void }
  | { readonly phase: "ready"; readonly fileName: string; readonly save: () => void; readonly discard: () => void }
  | { readonly phase: "saved"; readonly path: string }
  | { readonly phase: "failed"; readonly fileName: string; readonly message: string };
export declare function transferProgressCopy(progress: FileTransferProgress): string;
export declare function transferUnavailableCopy(serverName: string): string;
export declare function transferErrorMessage(error: unknown, fallback: string): string;
```

Keep public sink result types aligned with the Task 9 Atom command result (infer a shared structural union, not a cast from unknown). Runtime scheduling belongs to client-runtime; the web keeps only display/picker/Save behavior. `TransferToastState` projects into the existing toastManager API with `timeout: 0`; it does not introduce a second toast framework.

Exact user copy:

- `transferProgressCopy` calls Task 5's shared `formatTransferBytes`; both numbers use the total's unit (KiB below 1 MiB, MiB below 1 GiB, GiB from 1 GiB), one decimal below 10 in that unit and whole numbers from 10, never trailing “.0”. Unknown totals show only the sent amount in its own unit using the same rule.
- “Downloading report.zip — 120 of 900 MiB”; “Uploading photo.png — 3 of 10 MiB”; action **Cancel**.
- Unknown archive total: “Downloading src.zip — 120 MiB”; never invent a percentage.
- Waiting: “Reconnecting…” while retaining file name in the toast title.
- Browser ready: “report.zip is ready”; action **Save**.
- Unavailable: “Update <server> to transfer files over its encrypted connection”.
- Browser cap: “This download exceeds the 2 GiB browser limit. Use the desktop app.”
- Busy action reason: “Finish or cancel the current transfer.”
- Replacement: existing `Replace "<file>"?`, **Replace**, **Cancel**. Never replace silently.

- [ ] **Step 1: Write failing tests/key assertions.**

```ts
it("uses the approved transfer copy", () => {
  expect(transferProgressCopy({ direction: "download", fileName: "report.zip", sentBytes: 120 * 1024 ** 2,
    totalBytes: 900 * 1024 ** 2, phase: "transferring" }))
    .toBe("Downloading report.zip — 120 of 900 MiB");
  expect(transferProgressCopy({ direction: "download", fileName: "src.zip", sentBytes: 120 * 1024 ** 2,
    totalBytes: null, phase: "transferring" })).toBe("Downloading src.zip — 120 MiB");
  expect(transferProgressCopy({ direction: "upload", fileName: "photo.png", sentBytes: 3 * 1024 ** 2,
    totalBytes: 10 * 1024 ** 2, phase: "transferring" })).toBe("Uploading photo.png — 3 of 10 MiB");
  expect(transferUnavailableCopy("Studio")).toBe("Update Studio to transfer files over its encrypted connection");
  expect(transferErrorMessage("Disk is full.", "Failed.")).toBe("Disk is full.");
});
```

Add `pinned_download_never_mints_url`, `https_pinned_download_uses_same_route`, `unpinned_keeps_http_bridge_flow`, `old_server_disables_all_download_upload_entry_points_with_reason`, `desktop_picks_folder_before_streaming`, `picker_cancel_starts_no_transfer`, `known_size_over_two_gib_rejected_before_sink_write`, `unknown_archive_aborts_before_crossing_browser_budget`, `save_click_creates_and_revokes_anchor_url`, `pinned_desktop_upload_uses_hidden_file_input`, `exists_replace_before_bytes_and_commit_race_prompt`, `toast_cancel_aborts_and_cleans_sink`, and `second_panel_cannot_start_concurrent_transfer`. Render/accessibility tests use explicit props; happy-dom asserts toast Cancel/Save focusability and DOM clicks causing exactly one abort/save. Native Tab/Enter/Space activation is verified in the Step 8 Playwright live check.

- [ ] **Step 2: Run red.** `(cd apps/web && vp test run --project unit src/components/files/transferPresentation.test.ts src/components/files/fileTransfers.test.ts src/components/files/useFileTransfers.test.tsx src/components/files/FileBrowserPanel.test.tsx src/components/files/FileTreeContextMenu.logic.test.ts)`. Expected: missing sink/copy/route logic, then token-mint or disabled-state assertions fail.
- [ ] **Step 3: Route once per operation.** Read prepared and session config via the environment runtime, and use fileContentRoute. `http` preserves the current mint/HTTP flow. `unavailable` disables row, folder and background Download/Upload actions with the Update reason and never calls create*Url. `in-channel` uses transfer commands; desktop chooses a folder first, then streams through bridge. Pinned desktop upload clicks the existing file input; unpinned desktop keeps pickFiles/uploadFile. File lists run sequentially through the environment scheduler.
- [ ] **Step 4: Implement sinks.** Browser refuses known size >2 GiB at start before storing any bytes; for unknown archive size checks the cumulative total before adding each chunk. Build one Blob only after validated end; clear parts on abort/reset. The Save click owns anchor creation/download and URL revocation; retain Blob until Save or dismissal, then release. Desktop start obtains handle, sequential writes await raw IPC, reset aborts old handle before beginning a zip restart, finish returns path; abort removes partial. No HTTP request is added by either pinned sink.
- [ ] **Step 5: Implement toast/Replace state.** Progress updates one sticky toast per environment operation, never one per chunk. Cancel remains keyboard reachable and interrupts the owning command; closing a running toast must either cancel through its onClose or keep the visible active operation available, never hide an uncancellable transfer. Await Replace before reading if begin.exists; a commit collision asks again using the same uploadId. Surface nonblank bridge string errors as well as Error.message. State updates are fenced to the active operation; old finalizers cannot close a newer toast.
- [ ] **Step 6: Green/reviews/gates.** Repeat focused tests; full web unit project; `vp check`; `vp run typecheck`; Cargo fmt, server Clippy and desktop Clippy because the end-to-end bridge path is validated. Review components/hooks against vercel-react-best-practices and UI.md: readable progress, explicit disabled reasons, safe Replace defaults, no token or workspace path in copy, bounded rerenders, and no lost Blob while Save is visible.
- [ ] **Step 7: Docs.** workspace-ui documents progress, Cancel, browser Save/cap and old-server rule. remote-access explains the encrypted file-transfer scope and retained old-client exception. Add throttled transfer and canary-capture steps to cross-platform-validation and matching report rows for capture controls, peak memory, rate, resume, desktop save and UI screenshots. Review all three platform links and native input behavior; state **reviewed and remain accurate** for unchanged sections.
- [ ] **Step 8: Live B transfers.** Use 4901 web, B at 4910 only via 4911 capture/throttle and 4912 control. Run 256 MiB and optional 1 GiB upload/download and record renderer/server memory. `curl 'http://127.0.0.1:4912/set?down=65536&up=0'`, then down=0/up=65536; stream another thread and Stop it; freeze→4408 ≤33 s→thaw→resume. Check old-server refusal with new client. Positive capture control uses old client/server on 4920–4923. In Playwright, Tab to toast Cancel and Save; activate each with Enter and Space on separate transfers, verifying one abort/cleanup or one browser download per activation. Take light/dark progress, Replace, Cancel, ready/Save and disabled screenshots.
- [ ] **Step 9: Complete Task 11 desktop live check.** Launch only the lane's isolated desktop build under Xvfb with separate state and frontend/backend ports in 4900–4999, using xdotool or computer use; do not invoke a runner that silently chooses 3773. With Preview open, verify actual disk bytes, collision naming, cancellation cleanup and reload cleanup via new commands. Browser fallback alone does not count. Record WebKitGTK/Windows/macOS availability and native file-input outcomes; unavailable hosts are not run, not implied green.
- [ ] **Step 10: Stop: READY hand-off to the controller; do not commit.**

### Task 13: In-channel images and explicit pinned-preview restrictions

**Commit subject:** `feat(web): keep pinned image previews inside the encrypted channel`

**Files:**
- Modify: `apps/web/src/assets/assetUrls.ts:12-48`, `apps/web/src/assets/assetUrls.test.ts`, `apps/web/src/components/ProjectFavicon.tsx:13-22`, `apps/web/src/components/ChatView.tsx:2729` (only if consumer wiring requires it).
- Modify: `apps/web/src/components/files/FileTreeContextMenu.logic.ts:95-97`, `apps/web/src/components/files/FilePreviewPanel.tsx:697-698,795-812`, `apps/web/src/components/files/FileBrowserPanel.tsx:589-605,886-889` and their existing tests.
- Modify: `apps/web/src/components/ChatMarkdown.tsx:1291-1313,1482-1487`, `apps/web/src/components/ChatMarkdown.behavior.test.tsx`, `apps/web/src/browser/openFileInPreview.ts:55-98`.
- Create: `apps/web/src/browser/openFileInPreview.test.ts`.
- Docs: `docs/architecture/remote.md:240-249,797-798`, `docs/user/workspace-ui.md`; review cross-platform/report/platform runbooks after final flow is complete.

**Interfaces — consumes:** Task 10 route-aware asset atoms/cache, Task 9 fileContentRoute, existing name fallback at MessagesTimeline.tsx:986-990, Task 12 download action/copy.

**Interfaces — produces (proposed web policy interface):**

```ts
export type FilePreviewAvailability =
  | { readonly enabled: true }
  | { readonly enabled: false; readonly reason: string };
export declare function filePreviewAvailability(prepared: PreparedConnection | null,
  filePath: string): FilePreviewAvailability;
// Existing useAssetUrl / useAssetUrls signatures remain unchanged.
// openFileInPreview gains prepared: PreparedConnection | null on its existing input.
```

Place the policy beside `isBrowserPreviewFile` in browser/openFileInPreview.ts and use it in all entry points. On a pinned profile for HTML/PDF, the exact reason is “Preview isn't available over encrypted connections yet. Download this file to open it.” Keep **Open in Preview** / **Open in browser** present and disabled with that visible reason. The imperative URL-opening helper must refuse every pinned file-resource request before minting, even if called directly with an image path; pinned images use the renderer's asset cache. Missing prepared connection also refuses rather than guessing HTTP. When server transfers are unavailable, the adjacent Download action has its own Update reason. The integrated browser's typed URLs/dev-server navigation remains outside this file-preview rule.

- [ ] **Step 1: Add failing tests/skeleton.**

```ts
it("refuses a pinned HTML preview before any asset URL is minted", async () => {
  // prepared.e2ee is non-null, filePath="report.html", createAssetUrl and preview.open are spies.
  // Invoke the shared imperative entry point; expect the disabled reason and both spies untouched.
});
```

Add `asset_hooks_use_blob_urls_only_for_in_channel`, `old_pinned_server_shows_attachment_name_without_mint`, `unpinned_asset_hooks_keep_http_urls`, `two_image_consumers_share_then_release_cache_reference`, `project_icon_retarget_does_not_display_stale_blob`, `all_html_pdf_entry_points_disable_with_download_reason`, `markdown_preview_handler_is_guarded_even_if_called_directly`, `https_pinned_preview_is_also_disabled`, `typed_preview_url_and_dev_server_navigation_still_work`. Test menu, preview toolbar, file browser row and Markdown link independently; guarding only menu visibility is insufficient. In happy-dom assert disabled state, visible/associated reason text and that DOM clicks cannot mint or open a preview. Keyboard discovery of disabled-control reasons belongs in the Step 7 Playwright live check, without relying on happy-dom to synthesize native activation.

- [ ] **Step 2: Run red.** `(cd apps/web && vp test run --project unit src/assets/assetUrls.test.ts src/browser/openFileInPreview.test.ts src/components/files/FileTreeContextMenu.logic.test.ts src/components/files/FilePreviewPanel.test.tsx src/components/files/FileBrowserPanel.test.tsx src/components/ChatMarkdown.behavior.test.tsx)`. Expected: HTTP URL/mint spies still fire on pinned input or missing disabled explanation.
- [ ] **Step 3: Wire asset lifetimes.** Hooks consume route-aware resolved URL atoms; in-channel returns blob:, unavailable returns null, HTTP returns existing URL. Never subscribe to an HTTP mint atom while rendering a pinned branch. Release cache leases on resource/environment changes and unmount; preload and optimistic attachment-preview handoff must not revoke shared cache URLs. The existing chat image-name fallback displays while loading/failing/unavailable. ProjectFavicon must not retain a process-global set of every historical blob URL; bound/remove blob-specific loaded-state entries when references expire.
- [ ] **Step 4: Enforce preview rule everywhere.** Use the shared policy for FileTreeContextMenu, FileBrowserPanel row/background handlers, FilePreviewPanel's Open in browser toolbar, Markdown file links, and the imperative openFileInPreview function before minting. Show reason beside the disabled control with a clear Download action where the surrounding UI supports it; keyboard users can discover the reason. Do not create an external browser URL as a substitute for a disabled pinned preview. Do not change the preview host's normal typed URL/dev-server behavior.
- [ ] **Step 5: Green/reviews/gates.** Repeat focused tests and full web unit project; `vp check`; `vp run typecheck`; Cargo fmt/server Clippy and desktop Clippy for final integrated verification. Review all changed hooks/components against vercel-react-best-practices, and all copy/flows against UI.md. Specifically check no conditional hooks, no render-time URL side effects, reference cleanup, only affected rows rerender, and disabled copy remains legible in both themes.
- [ ] **Step 6: Docs.** Rewrite remote.md's transfer paragraph: new pinned clients carry file transfers/images in Noise on http and https; HTML/PDF are disabled in phase 1; token URLs remain for other targets and old clients. Narrow the cleartext limitation to old clients/old server combinations; new client+old server refuses. Rewrite audit rows 797–798 to say a pinned profile never mints or redeems these URLs. Document disabled previews and Download in workspace-ui. Review the final platform/cross-platform/report runbooks; report **reviewed and remain accurate** wherever no further change is necessary.
- [ ] **Step 7: Live final feature pass.** Complete Working conventions B canary matrix with text, image metadata, HTML and upload; record zero request-line/canary counts for new/new and nonzero baseline positive control. Include pinned https policy in tests and pinned http on the real capture path. Verify desktop chat images and project icons before/after reconnect, HTML/PDF disabled copy, old-server names/Update actions, and no /api/assets traffic. In Playwright use keyboard navigation at every preview entry point to discover its disabled reason and reach any available Download action; verify native activation cannot mint or open the disabled preview. Take light/dark screenshots of progress rows, transfer toasts/Save, disabled states and image-name fallbacks. Repeat desktop save through the bridge; retain native-host limitations explicitly.
- [ ] **Step 8: Final task audit.** Compare all changed files with the scoped list, run `git diff --check` and `git status --short`, inspect for debug logging, credentials, generated junk, dependency drift and missing living docs. Run the final interop and appropriate integrated gates only if new changes or unresolved concerns require them; do not repeat unrelated suites for ceremony. List any environmental blocker and remaining follow-up finding.
- [ ] **Step 9: Stop: READY hand-off to the controller; do not commit.**

## Self-review

### Spec coverage

| Design section / requirement | Owning tasks and evidence |
| --- | --- |
| C Problem and evidence: inline frame/message size and liveness residual | 3 pins inline behavior; 4 stages the total turn; 5 browser probe |
| C Goals: 8 × 10 MiB, delivery, responsiveness, no lost work | 1 quotas/bytes; 2 binding; 3 liveness; 4 window/resume; 5 restoration |
| C Non-goals and rejected alternatives | Global constraints; no transport rewrite, HTTP chat upload or outbound liveness signal |
| C Capability and fallback | 2 advertises only after binding; 4 total encoded ≤256 KiB/old session; 5 inline UI path |
| C Wire, amended by B Q5 | 1 unified four-method family; 2 staged attachment variants |
| C Server registry/ordering/replies/ownership | 1 full engine tests and authenticated integration |
| C Binding, root transaction and durable delivery | 2 rollback/retry/provider-byte tests, no rename of source stage |
| C Quota, 10-minute expiry and startup | 1 sweep/cancel/startup; 2 finished-unbound race |
| C Client hash/chunk/adaptive/resume | 4 hasher snapshots, two appends, one restart, cancellation |
| C Web progress, queued sends, failure/draft | 5 local row and prop-driven notice for both send types |
| C Situations table: drop/restart/Cancel/failed turn | 1, 2, 4, 5 |
| C Tests and live plan, Chromium/WebKit probe | 1–5; full live matrix at 5; WebKit absence reported |
| C Docs/runbooks, including remote and historical residual | 1, 2, 4, 5 (same task as behavior) |
| C Risks: throughput, large-request class and inline behavior | Global/Working conventions; 3 and 5 measurements; residuals below |
| C Rulings 1–7 | R1–R12/R20; Tasks 1–5 |
| C Separate findings | **Out of scope as separate fixes**: broad by-id hardening; transfer confidentiality finding is the input to B and is addressed only through B's approved scope (6–13), not an extra C change |
| B Problem: transfer bytes, asset bytes, paths and bearer URLs leave Noise | 9 selector; 12–13 no mint/no redeem tests and capture proof |
| B Goals/non-goals/alternatives | Global constraints; existing Noise only, base64 retained, HTML/PDF phase 2 deferred |
| B Selection rule and all pinned profiles (Q2/Q3) | 9 matrix/current-session capability; 12–13 unavailable UI, no downgrade |
| B Downloads checks/values/pacing/resume | 7 server stream/versions/limits; 9 sink-aware resume; 12 storage/Cancel |
| B Upload family/target/digest/staging/commit/Replace/quotas (Q5/Q6) | 1 engine; 6 workspace target and shared publication; 9/12 Replace UX |
| B Asset authority/exact resources/small one-Chunk/10 MiB | 8 shared resolution and tests |
| B Asset cache/refcounts/64 MiB/two reads/re-issue | 10 lifetime tests; 13 hook integration |
| B HTML/PDF phase-1 rule (Q4) | 13 all five UI/imperative entry points, reason and Download |
| B Saving/reading on desktop | 11 raw IPC/idle/reload; 12 folder choice and File input |
| B Browser Blob cap/Save (Q7) | 9 sink contract; 12 known/unknown total cap and Save lifecycle |
| B Capability and compatibility/old clients (Q8) | 8 capability; 9 no probe; 12–13 refusal and old/new controls; HTTP routes retained |
| B Progress toast (Q9) | 12 progress/reconnect/Cancel/Save |
| B Backpressure, concurrency and memory | 7 capacity 1/four server streams; 9 buffer 2/one operation; 10 two asset reads; 11 raw disk writes |
| B Liveness | 8 64 KiB/s E2EE trials; 12 freeze/thaw/Stop live checks |
| B Plain/HTTPS/relay/SSH/primary/local matrix | 9 selector, 12 HTTP regression tests; pinned https in-channel |
| B Rust/contracts/client/interop/desktop/UI tests | 6–13, exact gates in each task |
| B Live proof/cost/copy and docs/runbooks | 12–13, same-task updates and platform review |
| B Related findings 1–4 | **Out of scope follow-ups**: non-pinned remote-image CSP, pre-shipping badge wording, opaque legacy tokens, single-use/overwrite-bound HTTP capabilities |

### Type consistency

| Shared type/interface | Producer | Consumers |
| --- | --- | --- |
| `UploadTarget` / `UploadError` | 1; workspace/exists extension 6 | 2, 4, 6, 9, 12 |
| `UploadOwner` / `UploadRegistry` | 1 | 2 binding, 3 harness, 6 workspace, 7 download ownership, 8 harness |
| `UploadBinding` | 2 | PreparedAttachmentBatch only; rollback unlocks, commit releases |
| `InlineUploadChatAttachment` / `StagedUploadChatAttachment` | 2 | PersistedComposerAttachment inline only; 4/5 staged send |
| `UploadProgress` | 4 | turn aggregation 4; pending-message display 5; workspace progress adapter 9 |
| `NextSession` / `isSessionTransportLoss` | 4 | existing clone, stager, download reader, asset re-issue |
| `ProjectFileVersion` / `ProjectDownloadEvent` | 7 | 8 pacing pattern; 9 download; 12 sinks |
| `AssetReadEvent` | 8 | 10 cache and interop |
| `FileContentRoute` | 9 | 10 asset atoms; 12 transfers; 13 images/preview policy |
| `DownloadSink<A>` / `FileTransferProgress` | 9 | 11 bridge adapter consumed in 12; 12 toast/browser sink |
| `AssetByteCache` / `AssetUrlLease` | 10 | state/assets atoms and 13 hooks |
| IPC handle/begin/finish shapes | 11 | web bridge and 12 desktop sink |

### Review checks

- All 13 tasks include Files, Interfaces, red/green steps, docs, gates, live disposition and READY stop; controller commit subjects are present, with no implementer Git write commands.
- Tasks 1, 2, 4 and 6 include complete core behavioral test bodies. Additional seam tests are explicitly named and assigned to the owning task; no production-only fake is used as delivery proof.
- All new RPC methods land with handler/scope/inventory/fixtures/counts; capability timing is Task 2 and Task 8. No handlerless contract-only task exists.
- Wire fields are consistently camelCase; tags kebab-case; error reasons snake_case. New TypeScript runtime behavior remains outside contracts.
- Queued staging is local until durable enqueue; staged attachment IDs are never persisted as composer drafts. Accepted turn replay still precedes preparation.
- File and asset sinks require an explicit successful end; streams, hashes and partial files are canceled/cleaned at their owners' lifecycle boundaries.
- Review Focus cases are assigned to tests; existing source anchors are orientation and must be reread after concurrent edits. Fixture conflicts require regeneration.
- `docs/testing` evidence is updated with behavior, not collected in a late documentation task. Execution-specific versions, counts, machine paths and screenshots stay in reports.

## Residual risks for the lane manager

- Base64 still adds one third on the wire; JavaScript crypto/JSON/Blob cost is measured, not inferred. Browser memory up to 2 GiB, and native file inputs on all three platforms, require host evidence.
- HTTP capabilities intentionally remain for old clients; new pinned clients never fall back. Revisit old-client mint refusal one release after B as Q8 directs.
- Workspace process crashes can leave a hidden `.part`; idle/cancel/live-folder-loss cleanup is covered, but a new global startup scan is not authorized.
- File resume uses size/mtime, not a content fingerprint; archive resume restarts once. An unconfirmed commit response is not proof of either success or failure at the destination.
- Inline sends on old servers and nonattachment large requests retain their existing slow-link limits. Browser message fragmentation/close-buffer behavior requires the measured probe.
- HTML/PDF pinned previews await a separate custom-scheme design. Legacy by-id hardening, non-pinned CSP and token redesign remain separate follow-ups.
- Static checks can report unrelated concurrent edits; record them without broad cleanup. `check:contracts`' last diff cannot be green before the controller commits regenerated fixtures.
- The necessary runtime callback extraction and fallback-constant relocation are narrow exceptions recorded with evidence; all other hotspot limits remain in force.

## Open questions

None. The approved yolo rulings R1–R22 settle the product and implementation choices. The source qualifications above describe how to execute them against this tree; unavailable native/sandbox live evidence must be reported, never silently treated as approval or success.
