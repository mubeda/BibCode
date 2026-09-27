# Slow-link session establishment

Status: **Approved by the user on 2026-09-26** — Phase 1 (A + S) first, Phase 2 (B) as its own change, compression (C) as a separate future design; default answers to the open questions (120 s configuring ceiling, the proposed slow-setup copy, 5-minute refresh TTL with change-only publishing, models kept inline, 8 KiB/s target). Build after the connection-liveness commit.

Follows the connection-liveness record
([`2026-09-24-connection-liveness-design.md`](./2026-09-24-connection-liveness-design.md)). Its
implementation report lists this residual: "At about 16 KiB/s no session can connect." Citations
were checked on 2026-09-26 against `d87f854f` plus the uncommitted liveness change.

## Problem and evidence

A client cannot connect to an environment when fewer than about 17 KB/s reach it from the server.
Every attempt downloads most of the config snapshot, hits a fixed 15 s deadline, discards what it
received and starts over from zero, forever. The server, by contrast, accepts writes down to 16 KiB/s.

- **A fixed deadline covers the whole attempt.** `CONNECTION_ESTABLISHMENT_TIMEOUT = "15 seconds"`
  (`packages/client-runtime/src/connection/supervisor.ts:39`) is raced against the complete attempt
  (`supervisor.ts:523-535`). That covers preparation, socket open, E2EE authentication, the first
  config snapshot and the identity check (`connection/driver.ts:55-67`). A session is ready once the
  socket is connected and the first `subscribeServerConfig` snapshot has arrived
  (`rpc/session.ts:227-231, 277-281`; `rpc/sharedServerConfig.ts:47-97`).
- **The other two 15 s constants are not the cause.** `SOCKET_OPEN_TIMEOUT` (`session.ts:28`) bounds
  only the open, and `CONNECTION_PROBE_TIMEOUT` (`supervisor.ts:40`) bounds the small probe after
  connect.
- **The loop was measured at 16 KiB/s** (liveness harness log `wslog-f2-ui.jsonl`, run
  `final-retry-light-dbg`):
  - The client closed sockets 5, 6 and 7 (`Interrupt`, then close 1000) 15.0 s after creating each.
  - By then they had received 131,038, 196,557 and 196,557 B of a 255,395 B snapshot, that is 2–3
    records of 65,519 B.
  - Each retry followed 1.7, 3.6 and 7.8 s later.

  This happens every time: 255,405 B at 16,384 B/s takes 15.6 s, before any preparation time.
- **Size and composition.** Measured on 2026-09-26 with an isolated `bibcode serve`: a debug build of
  the current tree, with its own `BIBCODE_HOME` and this host's provider installs. A script read
  `server.getConfig` and `subscribeServerConfig` over a raw WebSocket and kept sizes only. The
  providers carried 217 skills, 274 slash commands, 50 models and 17 agents.

  | Part | Bytes |
  | --- | --- |
  | Snapshot message (`Chunk`) | 255,405 |
  | `config.providers` (96.2 % of the config; Claude alone 185,739) | 245,568 |
  | – `skills` / `slashCommands` / `models` / `agents` | 107,273 / 95,364 / 29,608 / 10,755 |
  | Everything else (`environment`, `auth`, `settings`, keybindings 7,086, …) | 9,752 |
  | `providerStatuses` event, 2.9 s after subscribing | 245,675 |

  The harness logs agree. Across 94 connections the snapshot was 255,393–276,924 B. In 87 of them a
  245,672–267,193 B `providerStatuses` event followed 2.0–8.3 s later. The report's range of
  "245,675–255,397 B" mixes the two messages. The payload grows with installed skills and commands.
- **Every connection triggers a refresh and a broadcast.**
  - Each `subscribeServerConfig` starts a full provider refresh
    (`apps/server/src/production/control.rs:1412-1420`).
  - On this host that refresh runs the Claude CLI (`initialize`, `reload_skills`), `codex
    app-server` and a short-lived `opencode serve` (`provider_inventory.rs:1041-1097, 1182-1214,
    1358-1420`).
  - The result goes to every subscriber (`control.rs:1156-1180, 1231-1237`) with no check for an
    unchanged result. `checkedAt` is regenerated on every probe (`provider_inventory.rs:454`), so the
    content always differs.
  - So at 16 KiB/s a freshly connected link stays busy for another 15 s, and the FIFO data writer
    holds the shell and thread snapshots behind the broadcast.
  - While one client loops, every other client receives 245 KB per cycle.
- **The two sides disagree on the floor.** The server's writer requires progress on every record
  within 20 s, and each whole message within 30 s + size ÷ 16 KiB/s
  (`apps/server/src/rpc/transport.rs:48-50, 251-258`). It would therefore deliver this snapshot
  within 45.6 s, at any rate down to about 5.5 KiB/s. The client needs about 16.6 KiB/s.

## Goals and non-goals

Goals:

1. On current servers, a link at the server's 16 KiB/s floor connects on its first attempt, and so
   does 8 KiB/s (a twofold margin).
2. An attempt that is still making progress is never discarded. Dead links are still detected
   within the liveness bound of 30 s ±10 %.
3. A connect neither broadcasts about 245 KB to every client nor re-downloads provider inventories
   that have not changed.
4. Readiness guarantees stay: the identity is verified before `synchronizing`, and `connected`
   still means the first snapshot arrived.
5. Old clients keep working with new servers, and new clients with old servers.

Non-goals:

- Large messages below about 5 KiB/s: that is the server's write floor, set by the approved liveness
  design.
- Uploads (see `2026-09-26-upload-liveness-design.md`).
- Replay paging (see `2026-09-26-replay-events-byte-cap-design.md`).
- Compression of all traffic.
- The 15 s `application-active` probe.

## Alternatives

Floors are calculated from the measured sizes.

### A. Progress-bounded establishment (client only)

Keep the 15 s deadline up to a connected socket (for E2EE, an authenticated one), where every message
is tiny.

- **After that point**, wait for the first snapshot as long as the session's liveness monitor keeps
  the socket alive, up to an absolute ceiling of 120 s. The monitor already starts with the socket
  (`rpc/livenessProtocol.ts:156-158`) and closes it with 4408 after 30 s ±10 % of inbound silence.
- **The seam.** `RpcSession` exposes its existing `connected` deferred. `driver.ts` then reports a new
  attempt stage, `configuring`. The supervisor already owns the attempt deadline: when it sees that
  stage, it swaps the 15 s timer for the ceiling.
- **`synchronizing` keeps its meaning** (after the identity check), and `state/shell.ts:69` treats
  `configuring` like `opening`.
- **Backoff.** A failed attempt still advances the 1/2/4/8/16 s ladder, and `BACKOFF_RESET_AFTER_MS`
  still counts from `connected` (`supervisor.ts:41, 621`).
- **UI.** The status reads "Connecting…" for longer. UI.md asks that long waits show progress, so the
  copy is open question 3.

Floors:

- **Current servers.** They send large messages as records, on plain `bibcode.rpc.chunked.v1` and on
  E2EE, so the client sees progress record by record. The floor depends on where the bytes wait:
  - When the path buffers the snapshot, the server's writes finish at once and its deadline never
    fires. This is the usual case: 0.3–0.9 MB sat in send queues in the liveness measurements. The
    120 s ceiling and the liveness rule then set the floor at about 2.1–2.4 KiB/s.
  - When the server's writes block, its own message deadline sets the floor at about 5.5 KiB/s. A
    snapshot twice this host's size raises that to about 8.1 KiB/s.
  - Either way, at 16 KiB/s the environment connects in 15.6 s, and at 8 KiB/s in 31 s.
- **Pre-liveness servers.** They send one whole text frame and queue the Pong behind it. The frame
  must arrive within the 27–33 s silence limit, which gives a floor of about 7.6–9.2 KiB/s.

Rejected variant: raising the fixed deadline, say to 60 s. The cliff still moves with inventory size,
and a dead endpoint takes 60 s to report.

### B. Lean readiness snapshot, provider inventory fetched separately (negotiated)

The readiness snapshot omits each provider's `slashCommands`, `skills` and `agents`, and each
provider row gains an `inventoryRevision`.

- **Fetching.** After readiness the client calls a new unary
  `server.getProviderInventory({ instanceId, knownRevision })`. The server answers `unchanged` when
  the cached revision is current.
- **Updates.** Lean subscribers get `providerStatuses` with rows and revisions only. A changed
  revision triggers one fetch.
- **Size.** The snapshot drops from 255,405 to 42,043 B (−84 %). Readiness then takes 2.6 s at
  16 KiB/s and 5.1 s at 8 KiB/s, with a floor of about 1.5 KiB/s.
- **Claude's inventory.** At about 171 KB it arrives after readiness. The server deadline cuts it
  off only below about 4.1 KiB/s, and it then follows the liveness Task 15 rule: one automatic
  re-issue, then Retry.
- **`models` stay inline.** When the selected model is missing, model resolution falls back to the
  first listed model (`apps/web/src/modelSelection.ts:249-255, 294-297`). Deferring models would need
  a pending state in selection, or a thread could switch models silently. Models are 29,608 B here;
  deferring them too gives 12,445 B.
- **Negotiation** follows existing precedent:
  - The capability is `providerInventoryFetch` in the environment descriptor. It decodes to false
    when absent, like `vcsCloneReattach` (`packages/contracts/src/environment.ts:62`), and the
    client reads it from `PreparedConnection.descriptor` (`connection/model.ts:193`) before the
    socket opens.
  - An optional `subscribeServerConfig` payload field, `providerInventory: "separate"`, selects the
    lean snapshot. Today's servers ignore that payload
    (`apps/server/src/production/server_terminal.rs:362`).

  | Client \ Server | Without the capability | With the capability |
  | --- | --- | --- |
  | Old client (payload `{}`) | full snapshot (today) | full snapshot (inline path kept) |
  | New client | full snapshot, with option A's floors | lean snapshot, then inventory by revision |

- **Client-runtime merges fetched inventories** into the providers projection (`state/server.ts`),
  so web consumers keep reading `provider.skills`.
- **An in-memory cache** keyed by environment, instance and revision survives reconnects.
- **Until the inventory arrives**, the composer's `/` and `$` menus and the skill chips show a
  pending state.

Rejected variant: a two-phase snapshot on the same stream. It still moves 245 KB per reconnect ahead
of shell and thread data on the FIFO writer, and still broadcasts it to every client.

### C. Compress large messages

tungstenite 0.29/0.30 (axum's WebSocket stack) has no permessage-deflate. Compression would need an
app-level codec:

- a compressed record type, negotiated through a new subprotocol version and an E2EE feature (like
  `interleave-v1`);
- decompression in the client with `DecompressionStream("deflate-raw")`, whose support on WebKitGTK
  builds, WKWebView and WebView2 must first be verified, or with a bundled inflater.

Measured on this snapshot:

- Level-6 deflate: 3.8× smaller (67,080 B).
- Brotli quality 5: 6.5× smaller (39,248 B), but a native Brotli decoder cannot be assumed in every
  WebView.

Compression is the only option that also speeds up History, diffs and replay. Its costs:

- a codec on both sides;
- unmeasured server CPU for each large message;
- a security review, because compressing before encrypting on E2EE leaks information through
  message lengths when attacker-influenced text and secrets share a message;
- a snapshot that still grows with installed skills.

### Trade-offs

| | A | B | C |
| --- | --- | --- | --- |
| Establishment floor | ~2.1–2.4 KiB/s buffered, ~5.5 if writes block (old servers ~8–9) | ~1.5 KiB/s | ~4.4 KiB/s, still 15 s |
| Bytes per reconnect | unchanged (~255 KB + 245 KB) | ~42 KB; inventory only if changed | ~67 KB + event |
| Old peers | any server; no wire change | full snapshot both ways | negotiated; unchanged |
| Reliability, security | a server that answers Pings but never sends the snapshot holds "Connecting…" ≤ 135 s | no new data; same read scope | review needed for E2EE |
| Complexity | small, client-runtime only | medium-high: contracts, server, runtime, web | high: codec on both sides, WebView matrix |

## Recommendation

**Phase 1: A plus S.** The two pieces are independent, small and wire-compatible.

- **A** moves the floor from about 16.6 KiB/s to about 2.1–2.4 KiB/s where the path buffers the
  snapshot, or about 5.5 KiB/s where the server's writes block. It needs no server change.
- **S** is server refresh hygiene in `control.rs`:
  - A subscription starts a full refresh only when the last one completed more than a TTL ago; 5
    minutes is proposed. `server.refreshProviders` and settings changes are unchanged.
  - `providerStatuses` is published only when the merged array changed. The comparison ignores
    `checkedAt` and `versionAdvisory.checkedAt`, which are still stored for later snapshots.

  Together these remove the 245 KB event after every connect, the cross-client amplification and the
  process churn on the host.

**Phase 2: B.** Readiness then no longer depends on installed skills, and reconnects stop
re-downloading unchanged inventories. B needs a contract change and a UI pending state, so it comes
second.

**Defer C** to its own record, as a general throughput improvement with a security review.

Phase 1 touches files on the liveness change list, so implementation starts after that change is
committed.

## Affected packages and files

- **Phase 1, A:** under `packages/client-runtime/src/`:
  - `connection/supervisor.ts`: deadline split, ceiling and copy;
  - `connection/driver.ts`;
  - `connection/model.ts`: the stage;
  - `rpc/session.ts`: `connected`;
  - `connection/presentation.ts`, only for the slow-setup copy;
  - `state/shell.ts`, if needed;
  - their tests.
- **Phase 1, S:** `apps/server/src/production/control.rs` and its tests.
- **Phase 2, contracts:** `packages/contracts/src/server.ts`, `rpc.ts`, `environment.ts` and the
  rpc-wire fixtures.
- **Phase 2, server:** under `apps/server/src/`:
  - `rpc/methods.rs`;
  - `auth/scope.rs`: the read scope, as for `subscribeServerConfig`;
  - `production/control.rs`: the lean path, per-refresh revisions and the method;
  - `production/server_terminal.rs`: passing the payload on;
  - `lifecycle.rs`: the capability.
- **Phase 2, client:** `packages/client-runtime/src/rpc/session.ts`, `state/server.ts`, and a new
  inventory state module.
- **Phase 2, web:** under `apps/web/src/components/chat/`: `composerCapabilities.ts`,
  `composerCommandItems.ts`, `ChatComposer.tsx` and `SkillInlineText.tsx`.

## Test and live-validation plan

Focused tests are written red-first. "Pin" marks a test that passes today and must keep passing.

**Phase 1.**

- **Supervisor**, with `TestClock`:
  - pin: an attempt stuck before `configuring` fails at 15 s with "did not respond during connection
    setup." (`registry.test.ts:1199` hangs before the session connects);
  - red today: a snapshot that arrives 40 s into `configuring` connects;
  - red today: `configuring` past 120 s fails with the ceiling copy and schedules the next ladder
    step;
  - red today: a liveness close during `configuring` publishes the labelled "No data from …" copy;
  - pin: Disconnect, Retry and offline still interrupt the attempt.
- **Driver:** `configuring` only after `connected`, and `synchronizing` only after the identity check.
- **Server S:**
  - no refresh for a subscription within the TTL, and one after it;
  - no publication when only `checkedAt` changed, and exactly one when a model or skill changed.
- **Harness** (`apps/server/tests/rpc_liveness.rs`), pin: a raw client throttled to 8 KiB/s receives
  a snapshot of at least 250 KB before the writer's deadline. This guards Phase 1's server-side
  assumption. It adds about 31 s to a binary that already runs for about 131 s.

**Phase 2.**

- **Contracts:** schemas and the rpc-wire fixtures (`check:contracts`).
- **Server:**
  - the lean shape;
  - `unchanged` when the revision matches;
  - the revision changes with the content;
  - the `required_scope` test covers the new method.
- **Client-runtime:**
  - without the capability, no payload field and no fetch;
  - fetched inventories merge into the projection;
  - no re-fetch across a reconnect at the same revision;
  - the Task 15 latch applies.
- **Web:**
  - the pending and failure-with-Retry menu states;
  - model selection unchanged.

**Live checks** use an isolated dev server with `scripts/throttle-proxy.ts`, plain and E2EE, light
and dark.

- **Phase 1:**
  - At 16 and 8 KiB/s the environment connects on its first attempt (expect about 16 and 31 s, plus
    preparation).
  - At 4 KiB/s, record which bound decides the attempt. When the path buffers the snapshot, expect
    a connect after about 62 s. When the server's writes block, expect the server to close the
    session at its deadline.
  - At 2 KiB/s the attempt ends at the liveness rule or the ceiling, shows the labelled copy and backs
    off.
  - A freeze during `configuring` closes with 4408 within 33 s.
  - Within the TTL, the WebSocket log shows no `providerStatuses` after a connect.
- **Phase 2:**
  - At 8 KiB/s the environment is ready within about 6 s.
  - A reconnect with an unchanged inventory transfers none of it.
  - Two version-skew runs: a new client against a server without the capability, and an old client
    against the new server.

## Docs and runbooks to update

- `docs/architecture/connection-runtime.md`: the stages and establishment rule under "State and
  retry policy", the config-once paragraph, and "Data boundary".
- `docs/architecture/rpc-and-orchestration.md`: "Session establishment".
- `docs/architecture/providers.md`: the refresh TTL and publish-on-change rule, and inventory
  delivery.
- `docs/testing/cross-platform-validation.md`: establishment steps at 16, 8 and 4 KiB/s in the
  slow-link scenario.
- `docs/testing/execution-report-template.md`: time to connected.
- The platform runbooks that link the scenario: review them.

Everything above except `providers.md` is on the liveness change list, so the landing order goes
through the controller.

## Risks

- A server that answers Pings but never sends the snapshot holds "Connecting…" for up to 135 s,
  instead of 15 s. Only a server-side lock is known to cause this.
- Pre-liveness servers keep a floor of about 8–9 KiB/s, because a whole frame shows no progress.
- With A alone, readiness time still grows with the inventory. A 500 KB snapshot takes 61 s at
  8 KiB/s, and needs at least 8.1 KiB/s when the server's writes block. Phase 2 removes that
  dependence.
- With the TTL, provider status can be up to 5 minutes old at connect; Settings → Refresh still
  refreshes immediately.
- Ignoring the `checkedAt` fields leaves the timestamps that the update pill and launch notification
  compare slightly older.
- Phase 2:
  - Typing a skill before its inventory arrives gets no completion.
  - Large OpenCode or Cursor model catalogs grow the lean snapshot.
- The composition comes from one host. The shares move with installed plugins; the structure does
  not.

## Open questions for the user

1. Phasing: A and S first, then B, with C deferred to its own record?
2. Is 120 s the right `configuring` ceiling, or should it be shorter (for example 90 s)?
3. Slow-setup copy:
   - after 5 s in `configuring`: "Receiving settings from <label> over a slow connection…";
   - at the ceiling: "<label> took more than 2 minutes to send its settings. Reconnecting…".
4. A 5-minute refresh TTL on connect, or refresh on every connect but publish only changes?
5. Phase 2: keep `models` inline (recommended), or defer them too? Deferring gives a 12 KB snapshot
   but needs a pending state in model selection.
6. Is 8 KiB/s the right supported target, half the server's 16 KiB/s write floor?
