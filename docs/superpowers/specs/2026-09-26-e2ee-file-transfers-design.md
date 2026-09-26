# E2EE file transfers and previews: carry the bytes inside the Noise channel

Status: **Approved by the user on 2026-09-26** — option B with the recommended default for every open question (all pinned profiles, https included; old servers refused with Update copy; HTML/PDF previews disabled on pinned profiles in phase 1; C's upload methods folded into one `uploads.*` family; 4 open uploads per session, 1 GiB each, 10-minute idle expiry; browser downloads capped at 2 GiB; HTTP capabilities kept for old clients and revisited one release after B; progress and Cancel in a toast). Build after the connection-liveness commit.

Input: the first "Separate finding" of
[the upload-liveness record](./2026-09-26-upload-liveness-design.md) (lines 378-380): for a
pinned E2EE environment, transfer and asset bytes travel outside the Noise channel, and
`remote.md` documents only the authorization exception. Citations were checked on 2026-09-26
against HEAD `d87f854f` plus the uncommitted connection-liveness change; line numbers in
`rpc/session.rs`, `remote.md`, `connection-runtime.md` and `rpc-and-orchestration.md` may move
when it lands. Build after that commit: `FileBrowserPanel.tsx`, `production/runtime.rs`,
`tests/rpc_liveness.rs`, the rpc-wire fixture manifest and all three architecture docs are on its
list. Nothing was measured; figures come from constants.

## Problem and evidence

**What leaves the channel.** A pinned profile (non-null `hostKey`) always carries RPC over
`/ws-e2ee` (`remote.md:748-751`). Three features then move bytes over plain HTTP to the same
endpoint, authorized only by a capability in the URL (`remote.md:227-233, 772-773`):

- **Downloads.** `projects.createDownloadUrl` mints `/api/transfers/<token>`
  (`apps/server/src/workspace/rpc.rs:994-1040`). A browser hands it to an anchor
  (`apps/web/src/components/files/fileTransfers.ts:32-64`); the desktop host fetches it with
  `reqwest` (`apps/desktop/src-tauri/src/bridge.rs:1774-1843`).
- **Uploads.** `projects.createUploadUrl` mints a token for one file name
  (`workspace/rpc.rs:1045-1091`). A browser POSTs the `File` (`fileTransfers.ts:117-124`); the
  desktop host streams the picked path (`bridge.rs:1852-1880`).
- **Asset previews.** `assets.createUrl` mints `/api/assets/<capability>/<name>`
  (`apps/server/src/assets/mod.rs:97-173`), resolved against `httpBaseUrl`
  (`packages/client-runtime/src/state/assets.ts:38-44`; `apps/web/src/assets/assetUrls.ts:12-24`).
  Consumers:
  - chat image attachments as `<img src>` (`ChatView.tsx:2688-2706`;
    `chat/MessagesTimeline.tsx:956-976`) and project icons (`ProjectFavicon.tsx:13-22`);
  - HTML and PDF files opened in the integrated browser from the file viewer, the tree menu or a
    chat link (`apps/web/src/browser/openFileInPreview.ts:55-97`). A Tauri child webview
    navigates to the URL (`apps/desktop/src-tauri/src/preview/host.rs:773-776`) and loads sibling
    images, styles and scripts through the same capability (`assets/mod.rs:119-128, 190-201`).

**What an on-path host gets on an `http://` endpoint** (LAN, Wi-Fi, any hop in between):

- **Contents.** Every body is cleartext, and nothing protects integrity: an active attacker can
  alter a download, an upload or an image in flight.
- **Paths.** Tokens are signed, not encrypted: base64url JSON claims plus an HMAC
  (`apps/server/src/signed_token.rs:19-35`). Transfer claims carry the absolute workspace root and
  the relative path or file name (`apps/server/src/transfer/mod.rs:100-116`); asset claims carry
  the root too (`assets/mod.rs:236-256`). Every project-icon request therefore publishes an
  absolute path, which the descriptor deliberately never does (`remote.md:943-944`).
- **Replayable capabilities.** Tokens are bearer tokens with no single-use record
  (`transfer/mod.rs:190-194`), valid for five minutes (transfers, `transfer/mod.rs:14`) or one hour
  (assets, `assets/mod.rs:84-86`). A captured upload URL can write its file again, and replace it
  with `overwrite=1`, a query parameter rather than a claim
  (`apps/server/src/production/http_routes.rs:549-551`). An HTML preview capability reads every
  preview-type file under its folder for that hour (`assets/mod.rs:18-23, 190-201`).

A tailnet's WireGuard protects the hop between devices, but the E2EE promise should hold without
it. Plain `/ws`, relay and SSH targets are not affected. Remote Servers still labels a pinned
profile "End-to-end encrypted"
(`apps/web/src/components/settings/remote-servers/connectPresentation.ts:69`), and no living doc
states the cleartext consequence.

**How it happened.** The Files transfer plan chose signed-token HTTP routes because pinned
profiles have no HTTP authorization, and rejected chunked RPC on performance
(`docs/superpowers/plans/2026-09-15-files-panel-download-upload.md:20-24`). It never weighed
confidentiality, and two of its objections have weakened since. E2EE no longer has the "16 KiB/64
KiB frame limits" it cites: logical messages reach 64 MiB in 65,518-byte records
(`remote.md:160-172`). And the approved staging design (C) builds acknowledged, resumable RPC
chunking anyway, so reusing it costs less.

## Goals and non-goals

**Goals.**

- **Confidentiality and integrity.** For a pinned profile, no file content, asset byte, token or
  workspace path leaves the Noise channel. This covers downloads (files and zips), uploads, chat
  images and project icons; HTML and PDF previews get an explicit phase-1 rule.
- **Liveness.** A dead server is still detected within 33 s and a dead client reaped within 50 s;
  D2 and R13 are unchanged; other traffic waits about one chunk during a transfer.
- **Bounded memory.** The server and the desktop host never buffer a whole payload; browser mode
  is capped (Q7).
- **Compatibility.** Old clients and servers keep working, and a new client never silently falls
  back to HTTP for a pinned profile. Plain `/ws`, relay, SSH, primary and desktop-local targets
  keep today's routes.

**Non-goals.** Legacy plain-HTTP profiles, whose RPC is cleartext too and which already show
re-pair guidance (`connection-runtime.md:195-199`). The integrated browser's visits to dev servers
or typed URLs. A binary RPC message kind: base64 stays, as in C
(`2026-09-26-upload-liveness-design.md:155, 354-355`). Changes to the limits (1 GiB per upload,
2 GiB or 200,000 entries per zip, 10 MiB per asset).

## Alternatives

### A. Disclose and gate

**Change.** Keep HTTP. For a pinned `http://` profile, refuse transfers and previews or allow each
after a warning, and add the `remote.md` sentence.

**Trade-offs.** The smallest change: a policy check and copy. But pinned users lose Files
transfers and chat images or learn to click through warnings, and nothing gets encrypted.

### B. Carry the bytes inside Noise over RPC

**Change.** New RPC methods do what the mint plus the HTTP route do today, in one authenticated
call with no token: streams for downloads and assets, C's acknowledged chunks for uploads. The
client saves through new desktop-bridge commands or a browser `Blob`, and shows `blob:` images.

**Trade-offs.**

- **Gains.** One transport and one audited cipher for pinned profiles, plus resume and progress.
- **Costs.** 1.33× bytes (base64), JavaScript decryption and decoding, one socket shared with
  other traffic, new server state for uploads, and new bridge commands.
- **Gap.** HTML and PDF previews run in a separate webview that cannot read RPC bytes.
- **Rejected variant.** A generic HTTP-over-RPC tunnel that replays the routes inside Noise needs
  request-body streaming and a second request model: speculative generalization.

### C. Seal the HTTP bodies with a key delivered inside Noise

**Change.** The mint RPC also returns a fresh key; bodies travel as AEAD records
(ChaCha20-Poly1305, counter nonces, a final flag); URLs become opaque handles.

**Trade-offs.**

- **Gains.** 1× wire cost, streaming, its own TCP connection, and host-to-host desktop streaming
  once the key crosses the bridge.
- **New crypto.** A second protocol to design, review and keep identical in the server, the
  desktop host and TypeScript: per-response keys, nonces, truncation, and headers such as
  `Content-Disposition` and `Content-Length`.
- **Previews.** `<img>` cannot decrypt, so images still need fetch, decryption and `blob:`; HTML
  previews still need a decrypting scheme handler.
- **Uploads.** Only Chromium streams request bodies, so browser uploads seal into a `Blob` first,
  with no progress or resume, the gaps for which the user rejected HTTP uploads in C
  (`2026-09-26-upload-liveness-design.md:158-174, 198-199`).

### Comparison

|                                 | A                    | B                        | C                               |
| ------------------------------- | -------------------- | ------------------------ | ------------------------------- |
| Contents and paths on `http://` | exposed (or refused) | inside Noise             | sealed; size and timing visible |
| Integrity                       | none                 | Noise AEAD               | new AEAD framing                |
| Wire bytes                      | 1×                   | 1.33×                    | about 1×                        |
| Other traffic during a transfer | unaffected           | waits ≤ 1 chunk (~1 s)   | unaffected                      |
| Resume and progress             | no                   | yes                      | not without more work           |
| Chat images                     | exposed or hidden    | `blob:` from RPC         | fetch, decrypt, `blob:`         |
| HTML and PDF previews           | exposed or refused   | phase 2 (scheme handler) | phase 2 (scheme handler)        |
| New cryptography                | none                 | none                     | one protocol, three codebases   |
| New compatibility surface       | none                 | one capability flag      | one flag plus sealed routes     |

## Recommendation: B

**Why B.** It is the only option that closes the gap without new cryptography, it reuses the
machinery the user approved for C, and it matches the rule that a pinned profile always selects
`/ws-e2ee`. Its cost is throughput and CPU on large transfers, which the live plan measures; C
stays open as a later optimization for desktop downloads.

**Selection rule.** One client-runtime selector, `fileContentRoute(prepared, config)`, returns
`http` when `prepared.e2ee === null`, `in-channel` when the profile is pinned and the session
advertises `inChannelTransfers`, and `unavailable` when it is pinned without the capability (Q3).
It ignores the URL scheme, so pinned `https://` profiles use the channel too (Q2). Like the
worktree catalog policy, it reads the capability from the session that carries the request
(`connection-runtime.md:468-472`). No token is ever minted for a pinned profile.

**Downloads: `projects.readDownload`** (server stream, read scope,
`{ cwd, relativePath, offset?, expect? }`).

- **Checks.** The same path admission, root normalization, canonicalization and archive
  pre-scan (with its typed error) as the mint and the route (`workspace/rpc.rs:994-1040`;
  `apps/server/src/production/transfer_routes.rs:45-116`), in one helper in `transfer/` that
  serves both carriers. The admission lease covers only these checks, because leases are
  short-lived by design (`overview.md:1194-1196`) and the route holds none while streaming.
- **Values.** `start { fileName, kind, sizeBytes | null, version }` (a file's size and
  modification time), `bytes { offset, data }` (base64 of at most 1 MiB), `end { totalBytes }`.
- **Pacing.** The server waits for the client's Ack after every chunk
  (`session.rs:993-999, 1142-1200`). The Effect client acks once a chunk is queued, into a
  16-chunk queue by default
  (`node_modules/.pnpm/effect@4.0.0-beta.107/node_modules/effect/src/unstable/rpc/RpcClient.ts:341,
  465, 566-572`), so the client passes the per-call option `streamBufferSize: 2`
  (`RpcClient.ts:88-89, 308-341`). The server sizes chunks toward about
  1 s, between 16 KiB and 1 MiB, from the time between hand-off and the next pull: C's rule,
  applied server side.
- **Resume.** After a cut-off the client waits for the next session, as clone re-attach does,
  then reopens with `offset` and the `version` from `start`; a changed file fails with a typed
  `changed` error. A zip is not byte-reproducible, so it restarts once, then fails. Cancel is
  Interrupt.

**Uploads: C's engine with a workspace target.** C's session ownership, strict offset ordering,
acknowledged chunks with two outstanding, adaptive size, 10-minute expiry and resume apply
unchanged (`2026-09-26-upload-liveness-design.md:227-260`). Where C does not fit, B deviates:

- **Wire.** One purpose-tagged family (Q5): `uploads.begin { target, sizeBytes, sha256? } →
  { uploadId, exists }`, `uploads.append { uploadId, offset, data, sha256? }`, `uploads.get`,
  `uploads.cancel`, and `uploads.commit { uploadId, overwrite }` for the workspace target. That
  target, `{ cwd, relativeDirectory, fileName }`, is validated exactly as `createUploadUrl` does
  (`workspace/rpc.rs:1045-1091`). `exists` is advisory, so "Replace?" can come before any bytes.
- **Digest.** It may ride on the completing append, so a 1 GiB file is read once.
- **Staging.** Workspace uploads reach 1 GiB (`transfer/mod.rs:16`), far above C's 256 MiB server
  quota and its attachments-folder staging file. They stage as today's per-call `.part` beside the
  target (`apps/server/src/transfer/upload.rs:199, 268`), so disk use lands on the workspace
  volume and the final rename stays in one folder.
- **Commit.** Under a short path admission it checks size and digest, applies the directory
  guard, reserves the name with `create_new` unless `overwrite` is set (`upload.rs:171-196`),
  renames the partial into place, invalidates the entries index and notifies Git status
  (`transfer_routes.rs:162-180`).
- **Name clashes.** An exists refusal keeps the staged bytes until expiry, so a confirmed Replace
  commits again without re-sending. Today the name is reserved before streaming
  (`upload.rs:182-196`); reserving at commit keeps "no silent loss" and leaves no empty
  placeholder file in the folder for minutes.
- **Quotas.** 4 open workspace uploads per session, 1 GiB each, 10-minute idle expiry (Q6).
  Expiry, cancel or loss of the workspace deletes the partial.

**Asset previews: `assets.read { resource }`** (server stream, read scope).

- **Authority.** The same resource union and thread admission as `assets.createUrl`
  (`workspace/rpc.rs:1105-1150`), sharing `AssetAccess` resolution (`assets/mod.rs:97-173`), with
  no token. Values: `start { mimeType, sizeBytes }`, `bytes`, `end`; a small image is one `Chunk`.
- **Why a stream.** A unary `{ mimeType, contentBase64 }` read is simpler (precedent:
  `apps/server/src/production/git_manager_rpc.rs:1515-1524`), but a 10 MiB image would be one
  13.4 MB message holding the downstream for minutes on a slow link. A stream also ends the
  route's whole-file buffering (`production/runtime.rs:561-578`).
- **Client.** A client-runtime `AssetByteCache` per environment turns bytes into `blob:` URLs that
  `useAssetUrl(s)` return instead of HTTP URLs, so `<img>` consumers do not change. It counts
  references, keeps a 64 MiB LRU budget, revokes evicted, unreferenced URLs (precedent:
  `ChatView.logic.ts:258-287`) and runs at most 2 reads per environment. A read cut off by a
  transport failure is re-issued once on the next session (`connection-runtime.md:434-440`);
  otherwise the timeline shows the image's name (`MessagesTimeline.tsx:973-976`). The desktop CSP
  already admits `blob:` in `img-src` (`apps/desktop/src-tauri/tauri.conf.json:26`).
- **HTML and PDF previews, phase 1.** A preview webview navigates to a URL and loads siblings
  relatively. RPC bytes could reach it only through a custom URI scheme in the Rust host (tauri
  2.11.5 `register_asynchronous_uri_scheme_protocol`, `src/app.rs:2198`) that asks the WebView,
  the only holder of the Noise keys, to read each file in-channel. That needs its own design.
  Until then, "Open in Preview" and "Open in browser" are disabled for pinned profiles
  (`FileTreeContextMenu.logic.ts:95-97`; `FilePreviewPanel.tsx:697-698`), with a label that says
  why and points to Download (Q4).

**Saving and reading files on the client.**

- **Desktop download.** After `pickFolder`: `beginDownloadFile { directory, fileName } → handle`,
  `appendDownloadFile` with a raw binary body (tauri 2.11.5 `ipc::InvokeBody::Raw`,
  `src/ipc/mod.rs:55-59`; `Cargo.lock:5525-5526`), `finishDownloadFile → path`, and
  `abortDownloadFile`. They reuse the host's name rules, `.part` naming and collision-free rename
  (`bridge.rs:1611-1745, 1797-1843`), so their authority equals today's `downloadToFolder`: a
  folder the renderer names, with a uniquified file name. A handle aborts after 10 idle minutes or
  on webview reload. Privileged writes cross the `DesktopBridge`, as AGENTS.md requires.
- **Desktop upload.** For pinned profiles, the panel's existing hidden `<input type="file">`
  (`useFileTransfers.ts:300-324`) replaces `pickFiles` and `uploadFile`, so no new privileged
  file-read command is needed.
- **Browser download.** Chunks are appended to a `Blob`. A browser may block a download that
  starts long after the click, so the toast's Save button starts it. The File System Access API
  would stream to disk but needs a secure context, which a plain-`http://` page lacks: hence the
  cap (Q7).
- **Progress.** In-channel transfers show a toast with progress and Cancel ("Downloading
  report.zip — 120 of 900 MiB"), because the browser's download manager no longer does. The copy
  is reviewed against `UI.md`.

**Capability and compatibility.** Add `ExecutionEnvironmentCapabilities.inChannelTransfers`,
default false, following `vcsCloneReattach` (`packages/contracts/src/environment.ts:30-63`;
advertised at `lifecycle.rs:64` and `production/control.rs:2172`; read at
`state/vcsClone.ts:265`). The client never probes, because an unknown tag is a connection-wide
defect (`session.rs:894-904`). Other targets use HTTP in every pairing. For a pinned profile:

- **New client, new server:** in-channel.
- **New client, old server:** `unavailable`. Transfers are disabled with "Update <server> to
  transfer files over its encrypted connection", and images show their names (Q3).
- **Old client, new server:** the HTTP routes are still served, still in cleartext (Q8).

**Performance, memory and backpressure** (derived, not measured).

- **Wire.** A 1 MiB chunk is 1,398,104 base64 characters in about 22 records, 1.33× today.
  Link-bound, 1 GiB takes about 12 s on gigabit Ethernet (9 s over HTTP) and 122 s at 100 Mbit/s
  (92 s), plus a round trip per chunk. Whether the WebView's Noise decryption, JSON parsing and
  base64 decoding keep up is unmeasured; the live plan measures it.
- **Memory.** A download holds at most three chunks on the server (read, queued, in flight), about
  4 MB; an upload holds one chunk and a hasher (C); an asset is no longer buffered whole. Chunks
  pass the E2EE outbound admission of 64 MiB per connection and 128 MiB per process
  (`remote.md:306-348`). The client holds at most two decoded chunks; the desktop writes each
  through IPC, while a browser's `Blob` holds the whole file (Q7).
- **Concurrency.** A connection allows 64 requests in flight and treats the 65th as a connection
  defect (`session.rs:40, 885-893`). The client runs one file transfer at a time per environment,
  as the panel's uploads already do (`useFileTransfers.ts:283-289`), plus 2 asset reads; the
  server refuses a fifth download stream per session with a typed `capacity` error.
- **Responsiveness.** The directions are independent, so a download never delays Stop or
  keystrokes. Other downstream data waits at most one chunk per active stream; upstream data
  waits at most two appends, as in C.

**Liveness.** No new evidence is introduced. The client counts every record before reassembly
(`connection-runtime.md:405-408`), so each chunk and append reply is inbound traffic; the server
counts Acks and appends as inbound frames (`rpc-and-orchestration.md:54-64`). A 1.4 MB chunk sits
far inside the writer's limit of 30 s plus its size at 16 KiB/s (`rpc-and-orchestration.md:49-52`),
and chunks shrink toward 16 KiB at the establishment floor. A frozen link gives 4408 within 33 s
and a reap within 50 s; the transfer resumes on the next session.

**Plain, HTTPS, relay and SSH.** Plain `/ws` profiles are unchanged: all their RPC is cleartext and
they show re-pair guidance. Relay is unchanged: HTTPS to the managed endpoint, as protected as its
RPC. SSH is unchanged: HTTP through the loopback tunnel, inside SSH. Primary and desktop-local
targets are unchanged: loopback, with host-to-host desktop streaming. Pinned `https://` profiles
go in-channel (Q2), so a TLS-terminating proxy no longer sees transfers, at the price of
encrypting twice.

## Affected packages and files

- **`packages/contracts`:** `transfer.ts`, `assets.ts`, `rpc.ts`, `environment.ts`, `ipc.ts`, and
  the rpc-wire fixtures and manifest.
- **`apps/server`:** `transfer/` (shared open-and-stream helper; staging engine shared with C's
  `provider/attachments.rs`), `assets/mod.rs`, `workspace/rpc.rs`, `rpc/methods.rs`,
  `production/workspace_preview.rs`, `auth/scope.rs`, `production/runtime.rs` (asset route),
  `lifecycle.rs` and `production/control.rs` (capability), and tests including `rpc_liveness.rs`.
- **`packages/client-runtime`:** the route selector, `state/assets.ts`, a download reader, and the
  upload stager shared with C.
- **`apps/desktop`:** `bridge.rs` (four commands, registration, permissions) and `lib.rs`.
- **`apps/web`:** `files/useFileTransfers.ts`, `fileTransfers.ts`, `FileTreeContextMenu.logic.ts`,
  `FileBrowserPanel.tsx`, `FilePreviewPanel.tsx`, `ChatMarkdown.tsx`, `assets/assetUrls.ts`,
  `browser/openFileInPreview.ts`, `tauriDesktopBridge.ts`, and the transfer toast.

## Test and live-validation plan

- **Server (Rust) and contracts.**
  - Downloads: from 0; resume with a matching and a changed `version`; a zip; an oversized folder;
    Interrupt; the per-session stream cap. Assets: attachment, icon fallback, workspace image,
    refused preview type, over 10 MiB.
  - Uploads: C's cases (gap, duplicate, early chunk, digest, size, quota, expiry, another
    session's `uploadId`), plus exists-then-overwrite without re-sending, the directory guard,
    the Windows name rules and index invalidation.
  - Capability advertisement; schema tests, then `vp run check:contracts`.
- **Client runtime (vitest).** The selector matrix (pinned or not, capability or not, `http` or
  `https`); offset contiguity, resume, one zip restart, cancel; the asset cache (references,
  budget, revocation, 2 reads at a time, one re-issue); a pinned profile never calls `create*Url`
  or fetches `/api/`.
- **Interop and harness.** `serverInterop.test.ts` downloads, uploads and reads an image against
  the real Rust server. `rpc_liveness.rs` throttles E2EE to 64 KiB/s: a 3 MiB download and upload
  finish with no 4408 and no reap, and a mid-transfer Ping is answered within one chunk.
- **Desktop and web.** Bridge commands (unique names, abort removes the partial, raw body); a file
  input picking files on Windows, macOS and Linux; the in-channel flows and disabled states; the
  `vercel-react-best-practices` and `UI.md` reviews.
- **Live.** An isolated dev server plus a second `bibcode serve`, paired over `http://` with
  `bibcode pairing offer`, each on its own offset.
  - **Proof.** A capture proxy in `$S` between client and remote (tcpdump in the cross-container
    gate also works), with a canary string planted in a text file, an image, an HTML page and an
    upload. `grep -c` of captured `/api/transfers` and `/api/assets` request lines and of canary
    hits must be zero on the new build, and nonzero against an old server (the positive control).
  - **Cost.** 256 MiB and 1 GiB downloads and uploads, with renderer and server memory, in
    Chromium and the Linux desktop (WebKitGTK).
  - **Slow links.** `--down 65536`, then `--up 65536`: other threads keep streaming and Stop
    works; freezing the proxy gives 4408 within 33 s, and the transfer resumes after the thaw.
  - **Copy.** The old-server copy, the disabled HTML preview, and a desktop chat image before and
    after (Related finding 1), with light and dark screenshots of the toast and disabled states.
- **Gates.** `cargo fmt --all --check`, Clippy with `-D warnings` for the server and desktop, the
  server tests, `vp check`, `vp run typecheck` and `vp test`.

## Docs and runbooks to update

The three architecture docs and both runbooks below are on the liveness list: edit them after it.

- **`docs/architecture/remote.md`.** Now: the sentence below, added by the controller after the
  liveness commit. With B: rewrite `:227-233` (pinned profiles carry transfers and previews
  in-channel; token URLs serve the other targets), make rows `:772-773` say pinned profiles never
  mint or redeem those URLs, and narrow the sentence to old clients and servers.
- **`rpc-and-orchestration.md` and `connection-runtime.md`.** An "In-channel transfers" section
  (methods, scopes, pacing, staging, quotas, capability) plus a line in the transfer invariant
  (`:2042-2075`); the route selector, its capability gating, and resume on the next session.
- **User docs.** `docs/user/workspace-ui.md` (progress, Cancel, the disabled preview, the browser
  cap) and `docs/user/remote-access.md` (what the encrypted connection covers).
- **Testing.** A canary-capture step in the cross-container gate and a throttled transfer in the
  slow-link scenario of `docs/testing/cross-platform-validation.md`, with rows in
  `execution-report-template.md`; review the platform runbooks.
- **The upload-liveness record.** Amend its method names if Q5 is approved.

**Sentence for `remote.md` now.** Append it to the paragraph ending at `:233`; it also stands
alone as a "Current limitations" bullet:

> On a pinned (E2EE) profile whose endpoint is plain `http://`, Files panel downloads and uploads
> (`/api/transfers/<token>`) and asset previews (`/api/assets/<capability>/<path>`: chat images,
> project icons, and HTML or PDF files opened in the integrated browser) travel outside the Noise
> channel, and only the RPC that issues their URLs is encrypted, so anyone on the network path
> can read and alter their contents, read the workspace paths encoded in those URLs, and reuse a
> captured URL until it expires (five minutes for transfers, one hour for previews).

## Risks

- **Throughput and CPU.** Large transfers run slower than over HTTP, load the WebView, and delay
  other downstream data by about one chunk; C remains the fallback for desktop downloads.
- **Browser memory.** Outside Chromium, a `Blob` of up to 2 GiB may sit in memory (unverified).
- **New server state.** A crash leaves a hidden `.part`, as today's route does; during a resumable
  upload it shows in the tree and Git status for longer than today. Expiry and cancel clean up.
- **Resume.** It relies on the file `version` check; zips restart. It inherits the `desiredSeen`
  workaround until
  [the supervisor initial-desire record](./2026-09-26-supervisor-initial-desire-design.md) lands.
- **Feature gaps.** HTML and PDF previews regress for pinned profiles until phase 2, and the strict
  old-server rule hides transfers and images until the server is updated.
- **Old clients.** They keep sending cleartext until updated, so the sentence stays true for them.
- **Unverified.** File inputs in all three WebViews, browser `Blob` limits, and the desktop CSP
  inference below.

## Open questions for the user

1. **Approach.** Adopt B over A and C? *Default: yes.*
2. **Scheme.** Apply B to every pinned profile, including `https://`? *Default: yes, one rule.*
3. **Old servers.** For a pinned profile, refuse with Update copy, or allow HTTP after an explicit
   per-environment confirmation? *Default: refuse.*
4. **HTML and PDF previews, phase 1.** Disable them with a reason and offer Download, or allow
   them after a confirmation? *Default: disable; the custom-scheme bridge gets its own design.*
5. **Upload methods.** Fold C's `attachments.*Upload` methods into one purpose-tagged `uploads.*`
   family before C is built? *Default: yes.*
6. **Upload quotas.** 4 open per session, 1 GiB each, 10-minute idle expiry, no new server-wide
   byte cap? *Default: as listed.*
7. **Browser cap.** Cap in-channel browser downloads at 2 GiB, with no cap on the desktop?
   *Default: 2 GiB.*
8. **Old clients.** Keep minting HTTP capabilities on E2EE sessions for old clients, and revisit
   refusing them one release after B? *Default: keep, then revisit.*
9. **Progress UI.** Show progress and Cancel in a toast, with copy reviewed against `UI.md`?
   *Default: yes.*

## Related findings (not in scope)

1. **The desktop CSP excludes remote images (unverified).** `img-src` allows
   `'self' asset: … 127.0.0.1 localhost data: blob:` but not `http:` or `https:`
   (`tauri.conf.json:26`). If so, remote `<img>` previews over LAN and relay are already blocked
   in the desktop app. B fixes pinned profiles; relay and legacy profiles need their own decision.
2. **The badge over-claims until B ships.** "End-to-end encrypted" (`connectPresentation.ts:69`).
   *Default: leave the copy; the docs sentence is enough.*
3. **Paths leak on every cleartext path.** Tokens embed absolute paths, including on legacy plain
   profiles. Opaque server-side handles would fix it.
4. **Upload tokens are reusable, and `overwrite` is unbound.** A captured upload URL can overwrite
   its file for five minutes. Bind `overwrite` into the claims and make upload tokens single-use.
