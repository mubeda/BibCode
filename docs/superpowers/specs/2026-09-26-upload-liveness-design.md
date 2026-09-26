# Large uploads on slow links: stage attachments in acknowledged chunks

Status: **Approved by the user on 2026-09-26** — option C with the default answers to every open question (inline ≤256 KiB; 16 open uploads per session, 256 MiB per server, 10-minute expiry; resume across reconnects; 8 × 10 MiB per turn kept; progress and Cancel on the pending message). Build after the connection-liveness commit.

Input: the residual at lines 302–303 of
[the connection-liveness record](./2026-09-24-connection-liveness-design.md). The liveness
implementation report and the controller's Phase C review repeat it as "Residual (not
regression)". Citations were checked on 2026-09-26 against HEAD `d87f854f` plus the uncommitted
liveness change.

Server liveness is cited against the implementer's recorded final tree `9e8ec8df`, which counts
every inbound frame. Fix round E1 is still in progress and also excludes WebSocket Pong frames
(`apps/server/src/rpc/session.rs:629`, `e2ee.rs:1290`). The recommendation holds under either
version.

## Problem and evidence

A client→server message that takes more than about 30 s to cross the link is killed. On plain
`/ws`, the server gives up at 45–50 s even when the client has not. Attachments are the main
case. The figures below are derived from constants; no upload was measured.

**How the upload dies.**

1. **The whole message is handed to the browser at once.** Effect's writer calls `ws.send()` and
   returns
   (`node_modules/.pnpm/effect@4.0.0-beta.107/node_modules/effect/src/unstable/socket/Socket.ts:749-764`),
   and nothing reads `bufferedAmount`. E2EE splits the message into 64 KiB records
   (`packages/client-runtime/src/e2ee/frame.ts:13-33`), but it queues all of them together,
   one whole message at a time (`e2ee/socket.ts:71, 84-91, 320-333`).
2. **The client cannot probe.** Its monitor counts only inbound messages (`rpc/session.ts:172`;
   `rpc/liveness.ts:20-24, 86-120`). The RPC Ping it sends after 10 s uses the same writer
   (`rpc/livenessProtocol.ts:151-154`), so the Ping waits behind the upload. The client closes
   the socket with 4408 27–33 s after the last inbound message.
3. **Everything else stalls with it.** A server stream waits for the client's Ack after every
   chunk, with a window of one (`session.rs:994-999, 1223-1236`). Acks, Stop (Interrupt) and
   terminal input all queue behind the upload. So even a busy connection goes quiet after one
   chunk per stream; "otherwise idle" is not a precondition.
4. **The server side depends on the transport.** The server records activity per complete
   inbound frame (`session.rs:628-633`; `e2ee.rs:1290-1292`). E2EE records are separate frames,
   so the server never reaps an uploading E2EE client. A plain message is delivered only once it
   is complete, so the heartbeat reaps the connection after 45 s of silence
   (`transport.rs:56-65, 119-158`). There is one possible exception: a WebView that fragments
   the message and answers the server's 15 s Pings between fragments. `9e8ec8df` counts those
   Pongs and E1 does not. No WebView has been observed doing this.
5. **It is not a regression.** The old Effect pinger failed on the first unanswered 5 s Ping
   (`node_modules/.pnpm/effect@4.0.0-beta.107/node_modules/effect/src/unstable/rpc/RpcClient.ts:1182-1203`;
   `.repos/effect-smol/packages/effect/src/unstable/rpc/RpcClient.ts:1168-1189`). It killed the
   same uploads after 5–10 s.

**Sizes.**

- **Inline turns.** A turn may carry 8 attachments of 10 MiB, each inline as a data URL of up
  to 14,000,000 characters (`packages/contracts/src/orchestration.ts:153-158, 199-232, 802-822`).
  `readFileAsDataUrl` builds them (`apps/web/src/components/ChatView.tsx:5158-5167`;
  `ChatView.logic.ts:295-308`). The client then sends the turn as one
  `orchestration.dispatchCommand` (`packages/client-runtime/src/operations/commands.ts:81-83, 192-202`).
- **One attachment.** A 10 MiB attachment becomes 13,981,016 characters (+33 %). Sending it
  within 30 s needs about 466 KB/s (3.7 Mbit/s) of uplink. It takes 213 s at 64 KiB/s and about
  14 minutes at 16 KiB/s.
- **Size caps.** Plain `/ws` caps a frame at 16 MiB and a message at 64 MiB
  (`apps/server/src/http.rs:54-55`); E2EE caps a message at 64 MiB (`e2ee/frame.ts:7`).
  - A turn of 5–8 full-size attachments (70–112 MB) fails on every link.
  - Two full-size attachments (28 MB) may exceed the plain frame cap. That happens only if the
    WebView sends the message as one frame, which is unverified.
- **The rest of the class.** Other large client→server payloads stay near 1 MiB.
  `projects.writeFile` has no contract cap (`packages/contracts/src/project.ts:218-222`), but
  the editor reads at most 1 MiB (`apps/server/src/workspace/service.rs:15`). Prompts are
  capped at 120,000 characters (`orchestration.ts:153`). Both fit in 30 s at about 35 KiB/s,
  close to the ~17 KB/s link rate the liveness report gives as the minimum for establishing a
  session at all.

**For the user**, the send fails with the liveness copy and `ChatView` restores the draft
(`ChatView.tsx:5372-5420`). Every stream on the connection is cut. A retry fails the same way,
so on a slow uplink the attachment can never be sent.

## Goals and non-goals

**Goals.**

- **Delivery.** Every allowed attachment set (8 × 10 MiB) reaches the server over any link that
  can hold a session: plain or E2EE, direct, relay or SSH.
- **Liveness bounds.** A dead server is still detected within 33 s, and a dead client is still
  reaped within 50 s. The rule "accepted writes cannot move the evidence origin" (D2, R13) still
  holds.
- **Responsiveness.** During an upload, Acks, Stop, Pings and terminal input wait about two
  seconds of upload, not the whole upload.
- **Compatibility and privacy.** Old clients and servers keep today's path, and E2EE
  attachments stay inside Noise.
- **No lost work.** A real drop keeps the chunks already sent, and the draft is never lost.

**Non-goals.**

- Making every large request safe (the class).
- Links below the establishment floor (see
  [the slow-link establishment record](./2026-09-26-slow-link-establishment-design.md)) or below
  about 2 KiB/s.
- Changing attachment limits or server→client transfers, or reworking the Files panel upload,
  which already uses HTTP.

## Alternatives

### A. Count outbound progress as proof of life (brief option 1)

**Change.** The client monitor treats a fall in `bufferedAmount` as activity. On plain `/ws`,
the server must also see inbound byte progress. axum's `WebSocketUpgrade` yields only complete
messages and has no IO hook, so this needs a counting listener or an IO wrapper under
tungstenite. Without it, plain uploads still die at 45–50 s.

**Trade-offs.**

- **Cost.** This is the smallest change.
- **Weak evidence.** `bufferedAmount` falls when bytes enter the browser's network stack, not
  when the server reads them. So the first drain proves nothing: it is the same bufferbloat that
  D2 removed from the server. A sustained drain proves only that some hop is taking bytes, which
  could be a local `ssh`, a proxy, or a frozen server's kernel until its window fills.
- **WebKitGTK is unknown.** If its network process takes the whole message at once,
  `bufferedAmount` drops to zero immediately and the Linux desktop gets no signal. This is
  unmeasured, because only Chromium was available here.
- **Responsiveness.** Stop and every stream still wait for the whole upload. A visible failure
  becomes a silent freeze lasting minutes.

### B. Records in both directions, acknowledged by the server (options 2 and 3)

**Change.** The client sends messages over 64 KiB as records.

- **Plain `/ws`** needs a new subprotocol token such as `bibcode.rpc.chunked.v2`, because current
  servers select `chunked.v1` but decode inbound binary frames as JSON (`session.rs:723-724`).
- **E2EE** already sends records, but the server rejects client flags other than `0x00` and
  `0x01` (`e2ee.rs:724-729`). Client control records therefore need a new `features` entry.
- **Liveness** then needs either client pacing by `bufferedAmount` (browser-dependent, as in A)
  or server acknowledgements, as window updates or Pongs. Acknowledgement alone cannot work on
  today's plain framing, because the server sees nothing until the message is complete.

**Trade-offs.**

- **Coverage.** It covers every large request.
- **Cost.** It reopens a transport that took fix rounds A1 to E1 to settle. The work includes
  client write scheduling, plain inbound assembly and budgets, two negotiations, and wire
  fixtures and harness trials in both directions.
- **Responsiveness.** Without working pacing, Stop still waits for the whole upload.
- **What stays.** It keeps base64, whole-message memory and the 64 MiB turn cap, and it has no
  resume.

### C. Stage attachments in acknowledged chunks over RPC (option 3 at the application layer)

**Change.** Before the turn starts, the client uploads each large attachment as small unary
RPCs. Each reply acknowledges one chunk on disk. The turn start then names the staged uploads
instead of carrying data URLs.

**Why liveness holds.** Each chunk is a complete inbound message for the server, and each
acknowledgement is an inbound message for the client. Both monitors see real end-to-end
traffic, with no assumption about browser buffering or Pongs. With two chunks outstanding, at
most two chunks of about 1 s each sit ahead of any Ack, Stop or keystroke.

**Trade-offs.** It covers attachments only. Base64 still costs 1.33×, each send gains one round
trip, and the server gains new state.

### D. Upload attachments over HTTP (brief option 4)

**Change.** An RPC mints a short-lived upload capability and the client POSTs the bytes. This is
the Files panel's `projects.createUploadUrl` plus `POST /api/transfers/{token}` pattern
(`docs/architecture/rpc-and-orchestration.md:2042-2075`;
`apps/web/src/components/files/fileTransfers.ts:117-124`). The turn start then names the staged
upload.

**Trade-offs.**

- **Efficiency.** It is the most efficient: a binary, streamed body on its own connection.
- **Leaves Noise.** E2EE pairings are plain-HTTP endpoints on a LAN or tailnet
  (`docs/architecture/remote.md:132-140`). Screenshots and pasted files that travel encrypted
  today would cross the LAN in cleartext. The transfer route's exception covers authorization,
  not confidentiality (`remote.md:232-233, 773`).
- **Gaps.** The route has no body-read deadline (`apps/server/src/transfer/upload.rs:205`),
  `fetch` reports no upload progress, and there is no resume.

### Comparison

|                                 | A                          | B                             | C                   | D                   |
| ------------------------------- | -------------------------- | ----------------------------- | ------------------- | ------------------- |
| Client 30 s limit               | only if the WebView drains | yes                           | yes                 | yes (own socket)    |
| Plain server 45 s limit         | needs byte counting        | yes                           | yes                 | yes                 |
| Acks, Stop, input during upload | wait for the whole upload  | only with working pacing      | wait ≤ 2 chunks     | unaffected          |
| Covers                          | all requests               | all requests                  | attachments         | attachments         |
| Turn of 8 × 10 MiB              | no                         | no                            | yes                 | yes                 |
| Bytes on the wire; resume       | 1.33×; no                  | 1.33×; no                     | 1.33×; yes          | 1×; no              |
| E2EE confidentiality            | kept                       | kept                          | kept                | lost on `http://`   |
| New compatibility surface       | none                       | subprotocol v2 + E2EE feature | one capability flag | one capability flag |

## Recommendation: C

**Why C.** C is the only option that fixes both limits and keeps the connection usable. It
does not rely on unmeasured WebView behaviour, changes no transport, and keeps attachments
inside Noise. It also removes other defects of the inline path: the 64 MiB turn cap, the memory
spike in transit, and the missing progress and resume. Handing a turn to the provider still
base64-encodes each attachment in memory (`attachments.rs:328-372`). It covers attachments only. That is acceptable
because the rest of the class stays near 1 MiB, and B can be added beside C if that changes.

**Why not the others.** A turns a visible failure into a silent freeze and weakens the evidence
rule. D puts attachments in cleartext on E2EE LAN pairings and adds a second transport.

**Capability and fallback.**

- **New flag.** Add `ExecutionEnvironmentCapabilities.attachmentStaging`, defaulting to false.
  It follows the `vcsCloneReattach` pattern: `packages/contracts/src/environment.ts:30-63`,
  advertised at `apps/server/src/lifecycle.rs:64` and `production/control.rs:2172`, and read at
  `packages/client-runtime/src/state/vcsClone.ts:265`.
- **No probing.** An unknown RPC tag is a connection-wide defect (`session.rs:894-904`), so the
  client must not probe for the method.
- **Inline fallback.** Without the flag, or for payloads of at most 256 KiB encoded (about 15 s
  at 17 KB/s), the client keeps inline data URLs.
- **Old clients.** They keep the server's `dataUrl` branch
  (`apps/server/src/provider/attachments.rs:227-237`).

**Wire.** The methods require the operate scope, like `orchestration.dispatchCommand` and
`projects.createUploadUrl` (`apps/server/src/auth/scope.rs:87-125`).

- **Methods.**
  - `attachments.beginUpload { type, name, mimeType, sizeBytes, sha256 } → { uploadId }`.
  - `attachments.appendUpload { uploadId, offset, data } → { receivedBytes }`, where `data`
    is base64 of at most 1 MiB.
  - `attachments.getUpload` and `attachments.cancelUpload`.
- **Staged attachment.** `UploadChatAttachment` gains a staged variant
  `{ type, id, name, mimeType, sizeBytes, uploadId }` without `dataUrl`.
- **Errors.** Typed errors cover quota, expiry, offset (with `receivedBytes`), digest and
  size.

**Server (owner `provider/attachments.rs`).**

- **Registry.** An in-memory registry keeps each upload's session, metadata, byte count,
  running SHA-256 and last activity.
- **Staging file.** Bytes go to `.<uploadId>.upload`, which startup reconciliation already
  deletes (`attachments.rs:310-313`).
- **Ownership.** An upload belongs to the session that began it; no other session can append to
  it or bind it.
- **Ordering.** Appends apply strictly in offset order, because request tasks run concurrently.
  - An early chunk waits, bounded, for its predecessor.
  - A duplicate returns `receivedBytes` without writing.
  - A gap returns an offset error.
- **Replies and completion.** Each reply is sent after its write. On the last byte the server
  checks size and digest.
- **Binding.** `prepare()` gains a staged branch. Under the root transaction it checks session,
  completion, size and digest, then renames the partial to `<attachmentId>`. Durable delivery
  is unchanged (`attachments.rs:201-272`; `production/orchestration_rpc.rs:541-544, 725-740`).
  The existing by-id branch (`attachments.rs:238-247`) keeps serving redelivery and is not
  exposed further.
- **Quotas.**
  - At most 16 open uploads per session and 256 MiB staged per server.
  - An upload that sits idle, or finishes but is never bound, expires after 10 minutes. A sweep
    runs every minute and on each begin.
  - Memory per upload is one chunk plus a hasher.

**Client runtime (new `packages/client-runtime/src/operations/attachmentStaging.ts`).**

- **Sending.** The client hashes the file with `@noble/hashes`, the library the Noise code
  already uses (`e2ee/noise.ts:4`), because WebCrypto is unavailable on plain-HTTP origins. It
  then sends `Blob.slice` chunks with two outstanding. Chunk size adapts toward about 1 s per chunk, between 16 KiB and 1 MiB.
  Attachments of one send stage one after another.
- **After a cut-off.** It waits for the next session, as clone re-attach does. It then calls
  `getUpload` and continues from `receivedBytes`. An unknown or expired upload starts over
  once, then fails.

**Web (`ChatView.tsx` send path).**

- **Where.** Staging replaces the data-URL step (`ChatView.tsx:5158-5167`) when the capability
  is on and the payload is above the threshold.
- **Progress.** The pending message shows progress ("Uploading 2 attachments — 3.1 of 20 MiB")
  and a Cancel button.
- **Failure.** The draft is restored as today, and the copy says what failed and what to do next
  (`UI.md`).
- **Queued sends.** They stage first, then enqueue.

| Situation                      | Outcome                                                         |
| ------------------------------ | --------------------------------------------------------------- |
| Real drop mid-upload           | The upload resumes; staged bytes are kept until expiry.         |
| Server restart                 | Partials are deleted; the client starts over once.              |
| Cancel or close                | `cancelUpload` runs, or the upload expires.                     |
| Turn start fails after staging | A retry binds the same uploads until expiry, with no re-upload. |

## Affected packages and files

- **`packages/contracts`:** `src/orchestration.ts` (staged variant and errors), `src/rpc.ts`
  (methods), `src/environment.ts` (capability), and the rpc-wire fixtures and manifest.
- **`apps/server`:** `src/provider/attachments.rs`; handlers in
  `src/production/orchestration_rpc.rs` or a new module; `src/auth/scope.rs`;
  `src/lifecycle.rs` and `src/production/control.rs` (capability); and
  `tests/rpc_liveness.rs`.
- **`packages/client-runtime`:** `attachmentStaging.ts` and its tests.
- **`apps/web`:** `ChatView.tsx`, `ChatView.logic.ts`, and the attachment chip and message UI.

Implement after the liveness commit, because `ChatView.tsx`, `session.rs` and `rpc_liveness.rs`
are on that change's file list.

## Test and live-validation plan

- **Server (Rust).**
  - Begin, append and completion.
  - A gap, a duplicate and an early chunk.
  - Digest and size mismatches, which remove the partial file.
  - Quota and expiry.
  - Refusal of another session's upload.
  - The staged `prepare()` branch through durable delivery.
  - Startup cleanup.
- **Contracts.** Test the staged schema, then run `vp run check:contracts`.
- **Client runtime (vitest).**
  - A window of at most two chunks.
  - Chunk-size adaptation.
  - Resume from `receivedBytes`.
  - One restart of an unknown upload.
  - The inline fallback and cancel.
- **Harness (`rpc_liveness.rs`).** Throttle the upstream to 64 KiB/s behind the proxy, in plain
  and E2EE modes.
  - A staged 3 MiB upload takes about 64 s, which passes both the 30 s and the 45 s limit. It
    must complete exactly, with no 4408 and no reap, and a Ping sent mid-upload must be answered
    within two chunks.
  - An inline 3 MiB send pins today's residual.
- **Live checks.** Run an isolated dev server behind `scripts/throttle-proxy.ts`, first with
  `--up 65536` and then with `--up 16384`, against plain and E2EE remotes. Send a 10 MiB image
  and check:
  - progress advances;
  - other threads keep streaming, and Stop works;
  - the provider receives the image;
  - freezing the proxy mid-upload gives 4408 within 33 s, and the upload resumes after the
    thaw;
  - with the capability off, the image is sent inline as today;
  - light and dark screenshots are taken.
- **Browser probe.** In Chromium and WebKitGTK, record `bufferedAmount`, whether Ping and Pong
  leave mid-message, and whether data queued before `close()` still flushes. The results decide
  the inline residual and any later B.
- **Gates.** `cargo fmt --all --check`, Clippy with `-D warnings`, the server tests, `vp check`,
  `vp run typecheck` and `vp test`, plus the `vercel-react-best-practices` and `UI.md` reviews.

## Docs and runbooks to update

- **`docs/architecture/rpc-and-orchestration.md`.** Add a new "Attachment staging" section
  covering methods, ownership, ordering, quotas, expiry and the capability. Correct its note that
  requests are not split.
- **`docs/architecture/connection-runtime.md`.** Update the large-upload residual.
- **`docs/architecture/remote.md`.** Say that staging stays inside E2EE, so the host-key HTTP
  audit gains no row.
- **`docs/user/workspace-ui.md`.** Describe upload progress and Cancel.
- **Testing runbooks.**
  - Add a `--up` attachment step to the slow-link scenario in
    `docs/testing/cross-platform-validation.md`, with its rows in
    `docs/testing/execution-report-template.md`.
  - Review the three platform runbooks' links.
  - Review `docs/reference/scripts.md`, which already covers `--up`.
- **The liveness record's Residuals.** Point them here after the liveness commit, since that
  record is on its protected list.

## Risks

- **New server state.** Ordering or expiry bugs could leak disk space or bind the wrong bytes.
  The digest, session ownership, quotas and tests bound this.
- **Throughput.** Base64 stays, so uploads take 1.33× the raw time; D would be about 25 %
  faster. Each staged send also adds a round trip before the turn starts.
- **The class residual.** Editor saves and prompts near 1 MiB still hit the 30 s limit below
  about 35 KiB/s.
- **Resume.** It waits for the supervisor's next session, so it inherits the `desiredSeen`
  workaround until
  [the supervisor initial-desire record](./2026-09-26-supervisor-initial-desire-design.md)
  lands.
- **The inline path.** Unmeasured WebView behaviour, including the 16 MiB frame question, still
  affects inline sends, though it no longer affects C.

## Rulings requested

1. Adopt C over A, B and D (recommended).
2. Set the inline threshold at 256 KiB encoded.
3. Quotas: 16 open uploads per session, 256 MiB per server, and a 10-minute expiry.
4. Resume across reconnects until expiry, rather than failing and asking for a resend
   (recommended).
5. Accept the bounded class residual, and keep B for later.
6. Keep 8 × 10 MiB per turn, which now becomes reachable.
7. Show progress and Cancel on the pending message, with the copy reviewed against `UI.md`.

## Separate findings (not in scope)

1. **Transfer and asset bytes leave Noise.** For a pinned E2EE environment, these bytes travel
   outside the Noise channel, so on a plain-HTTP LAN endpoint they are cleartext. `remote.md`
   documents the authorization exception (`:232-233, 773`) but not this consequence.
2. **`prepare()`'s by-id branch accepts any attachment id.** Any operate-scoped client can use
   it with any existing id (`attachments.rs:238-247`), although the TypeScript contract never
   sends that shape. The severity is low: C binds staged uploads to their session instead of
   widening this branch.
