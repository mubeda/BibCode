# Connection liveness: a slow link is not a dead link

Status: **Approved by the user on 2026-09-24** (the recommended option on every ruling listed below).

Inputs: items 1, 3, 4 and 6 of
[`orca-fixes-since-port-research.md`](../../plans/remote-servers/orca-fixes-since-port-research.md)
and the s2-liveness measurement spike (2026-09-24). Items 2, 5 and 8 (SSH) belong to
[the SSH record](./2026-09-24-ssh-environment-connect-design.md). Citations were checked against
the working tree on 2026-09-24 (`fd5effbb` plus uncommitted work that does not touch the
transport).

## Problem and evidence

BiBCode drops a healthy connection whenever one response takes more than about 5–10 s to arrive.
The drop cancels in-flight work, including a running clone, and the view then asks for the same
payload again, so on a slow link the cycle repeats. Separately, the server never notices a client
that has silently gone away.

### Measurements

A throttling TCP proxy sat on the real browser RPC socket of an isolated dev server (headless
Chromium; one serial link per direction; 20 ms one-way delay). It carried Git Manager History
pages (`gitManager.getCommits`) of 1.10–15.70 MB in two modes: backpressure, where the server's
writes block, and bufferbloat, where they finish at once. E2EE used a second server paired with
`bibcode pairing offer`. In the table, "drop x" means the browser itself closed the socket x s
after the request, exactly 5.0 s after the first Ping that got no Pong.

| Plain `/ws` | 1.10 MB  | 2.13 MB                                                     | 4.30 MB  | 8.64 MB  | 15.70 MB |
| ----------- | -------- | ----------------------------------------------------------- | -------- | -------- | -------- |
| 64 KiB/s    | drop 6.4 | drop 6.4                                                    | drop 6.3 | drop 6.4 (bufferbloat 8.1) | drop 6.5 |
| 128 KiB/s   | drop 6.3 | drop 6.4                                                    | drop 6.3 | drop 6.4 | drop 6.3 |
| 256 KiB/s   | ok 4.5 s | backpressure: arrived, then dropped; bufferbloat: drop 6.4 | drop 6.5 | drop 6.3 | drop 6.0 |
| 512 KiB/s   | ok 2.3 s | ok 4.4 s                                                    | drop 6.4 | drop 6.4 | drop 6.4 |

- **Plain `/ws`.** 33 of 40 trials never completed, and one dropped right after completing. The
  unthrottled baseline moved 8.64 MB in 0.19 s. Transfers under 5 s always survived and those
  over 10 s never did. Between the two, survival depended on the Ping phase: 3 of 7 survived at
  8.6 s.
- **E2EE and Pong.** 10 of 12 throttled E2EE trials dropped, 6.8–7.0 s after the click, even
  though 64 KiB records kept arriving no more than 2.1 s apart. On plain `/ws` the page saw no
  message event during any drop, even with 0.4–3.1 MB already received. A Pong waits for the
  whole message ahead of it.
- **Damage.** Views re-requested the same page 3–4 times per 45 s. Each reconnect downloads
  about 0.5 MB of config (item 8), which delayed the first Pong by 3.3 s at 64 KiB/s. A clone
  that had run for 15 s was stopped, and its folder deleted, 42 ms after a liveness close.
- **Server write deadline** (a raw client that never pings): messages up to about 5 s × rate +
  0.6–0.9 MB of buffering survive; up to about 10 s × rate plus that buffering they arrive and
  then the session closes; beyond that they are cut off (39% of 8.64 MB at 256 KiB/s) with no Close frame,
  leaving an open, silent socket.

### Code evidence

- **Client pinger.** `RpcClient.makeProtocolSocket`
  (`packages/client-runtime/src/rpc/session.ts:165-170`) pings every 5 s, fails when the
  previous Ping got no Pong, and resets only on `Pong`
  (`node_modules/.pnpm/effect@4.0.0-beta.107/node_modules/effect/src/unstable/rpc/RpcClient.ts:1050, 1079-1081, 1109-1119, 1182-1203`;
  `.repos/effect-smol/…/RpcClient.ts:1168-1189`). It closes with code 1000
  (`…/unstable/socket/Socket.ts:603`) and reports "<label> disconnected." (`session.ts:125`).
  E2EE hands it only reassembled messages (`packages/client-runtime/src/e2ee/socket.ts:197-203`)
  and rejects unknown record flags (`e2ee/frame.ts:68-70`).
- **Server Pong.** Pong waits in the ordinary queue with a 5 s admission deadline, and a failed
  send ends the read loop (`apps/server/src/rpc/session.rs:835-837, 1390-1423, 771-783`).
  `try_send_control_message` (`:1451-1466`) uses the same queue, and E2EE writes whole messages
  in order (`apps/server/src/rpc/e2ee.rs:1244-1266`).
- **Server writes.** Plain writes get a flat 5 s per message and keep the session running after
  a failure (`session.rs:39-40, 690-712`). E2EE gets 5 s + 1 s per 64 KiB and then ends the
  session (`e2ee.rs:51, 1132-1162, 1266`).
- **Server reads and budget.** Reads have no deadline and skip WebSocket Ping and Pong
  (`session.rs:741, 753`; `e2ee.rs:1110, 1251`). A response over the budget cancels the whole
  session (`session.rs:150-167`; test at `:2120`).
- **Retries.** A fixed 1–16 s ladder repeats forever, with no jitter
  (`packages/client-runtime/src/connection/supervisor.ts:31, 101-103, 639-658`).

### Minimal repro

1. Create a repository with 100 commits of about 83 KiB each, which gives an 8.6 MB History
   page. Add it to an isolated dev server (`BIBCODE_PORT_OFFSET`, `BIBCODE_HOME`).
2. Run `vp run dev:server` and `vp run dev:web` with different offsets. Put a 256 KiB/s
   throttling TCP proxy on the server port that `dev:web` targets.
3. Open Git Manager. The socket drops about 6.4 s after the request ("Git Manager Unavailable /
   Local disconnected."), and every reconnect repeats the request.

## Decisions and alternatives

**Landing order.** First item 1 with item 9's close code: client-only, it works with every server
and removes the E2EE drops and every plain drop under 30 s. Then items 2, 3 and 4 together,
since they rewrite the same writer loops (`session.rs:690-712`, `e2ee.rs:1244-1266`); item 4's
"end the session when the writer gives up" can land earlier as a small fix. Then item 5, which
needs item 2. Items 6, 7, 8 and the copy follow in any order.

[The clone-reconnect record](./2026-09-24-clone-reconnect-design.md) is independent and
complementary: this record makes spurious drops rare, and that one makes the remaining drops
harmless to a clone.

### 1. Client liveness counts every inbound message

**Decision.** Replace Effect's pinger with a local protocol in
`packages/client-runtime/src/rpc/`. It is a copy of `makeProtocolSocket` that uses only public
exports: `RpcClient.Protocol.make` (`RpcClient.ts:862-880`), `RpcSerialization`,
`ConnectionHooks` and `constPing` (`RpcMessage.ts:172`). A liveness monitor replaces
`makePinger`.

Any raw WebSocket message is proof of life: the hook sits on the socket that
`connectionWebSocketConstructor` creates (`session.ts:133-137`), so an E2EE record counts before
reassembly. After 10 s with no inbound data the client sends the existing RPC `Ping`; after 30 s
(three intervals, each ±10 % jitter) it closes with code 4408, reason `liveness timeout`. The
supervisor stays the only retry owner (`docs/architecture/connection-runtime.md:364-366`).

**Why a local copy.** The vendored effect-smol is the installed 4.0.0-beta.107 and has the same
fixed pinger. An upstream "reset on any message" option would still see only reassembled E2EE
messages, so the raw-socket hook has to be ours either way. We would file an upstream issue and
drop the copy if a configurable pinger lands. Until then, about 150 copied lines need
re-checking on each Effect upgrade.

**Rejected:** upstream first (it waits on a release and still needs our hook), a `pnpm patch`
(hidden and fragile), and a faster server answer (impossible behind an in-flight message).
**Measured effect:** all 10 E2EE drops would have survived, and plain `/ws` survives any message
that arrives within 30 s (8.64 MB at 512 KiB/s took 16.5 s).

### 2. Split large plain `/ws` messages into records

**Decision.** On a negotiated connection, the server sends each RPC message over 64 KiB as
binary frames, one record per frame, in the E2EE record format: `0x00` for the final record and
`0x01` for a continuation. The existing limits apply: 64 MiB and 2,048 records
(`e2ee/frame.ts:3-8, 38-80`; `e2ee.rs:44-49, 118-129`). Smaller messages stay whole text
frames, and requests are not split (`http.rs:54-55`).

**Negotiation.** The client offers the WebSocket subprotocol `bibcode.rpc.chunked.v1`; the
constructor already takes `protocols` (`session.ts:133-137`). The server selects it with axum
0.8.9's `WebSocketUpgrade::protocols` (`extract/ws.rs:242`) in
`apps/server/src/http.rs:217-246`, and reads it back with `WebSocket::protocol()`
(`ws.rs:568`). No echo means today's framing.

**Rejected:** a query parameter (old servers give no answer), a `server.getConfig` capability
(it arrives after the 248 KB message it would govern), and WebSocket fragmentation (browsers
deliver only whole messages).

### 3. A priority lane for control messages

**Decision.** A small bounded lane beside the data queue carries Pong, interrupt exits,
admission-failure terminals and protocol errors. The writer drains it before each message and
between records. A control message sent between records goes out as a stand-alone record with a
new flag, `0x02`, which the assembler returns without touching the partial message.

Pong is sent with `try_send`, with no byte budget and no admission deadline, and a full lane
drops the Pong instead of ending the read loop. For E2EE the client lists
`"features":["interleave-v1"]` in `e2ee_auth` and the server confirms it in `e2ee_authenticated`
(`docs/architecture/remote.md:171-209`); without it, control messages jump the queue only between
whole messages. **Terminal output stays out of the lane:** its volume is unbounded and would
bring back head-of-line blocking; a follow-up can interleave small data messages of other request
ids between records. Optional: `TCP_NOTSENT_LOWAT` (Linux, macOS), since 0.3–0.75 MB sat in the
server's socket send queue during the tests.

**Rejected:** staying first-in-first-out with item 1 alone (interrupts and admission terminals
stay stuck) and stream multiplexing with ids (more than needed).

### 4. Write deadlines that measure progress

**Decision.** For plain and E2EE alike, each record (or each socket write of a legacy whole
frame) must be accepted within 20 s, measured by a counting writer, and each message gets 30 s +
size ÷ 16 KiB/s overall (about 9 minutes for 8 MiB), replacing E2EE's 64 KiB/s floor. When the
writer gives up it ends the session, so the socket closes at once; plain `/ws` doesn't today.
**Rejected:** E2EE's formula for both (it keeps the 64 KiB/s floor) and a progress deadline alone
(it never fails a peer that reads one byte per second).

### 5. Server heartbeat and reaper (research item 1)

**Decision.** Each pump sends a WebSocket Ping every 15 s to authenticated sockets: plain after
the upgrade, E2EE after `e2ee_authenticated` (pre-auth keeps its 10 s deadline, `e2ee.rs:53`). An
interval is alive if any frame arrived or the writer made progress. After three dead intervals
(about 45 s) the session ends, freeing its E2EE permits (`e2ee.rs:76-77`), live-connection row
and subscriptions. Late ticks are not charged (Orca's STA-3320 rule), and the E2EE pump writes
Pings itself because it drops queued ones (`e2ee.rs:1251`).

**Why it needs item 2.** A Ping leaves only between frames, so behind an unsplit 16 MiB frame the
browser's automatic Pong comes back only after the whole frame. **Rejected:** TCP keepalive alone
(a frozen client that still acknowledges looks alive; fine as a complement) and RPC-level server
pings (they need client changes).

### 6. An oversized response fails one request (research item 4)

**Decision.** A response that cannot fit the 64 MiB per-connection budget (`e2ee.rs:81`) fails
that request alone; `acquire_budget` stops cancelling the session (`session.rs:150-167`). The
limit also covers split plain sessions, unbudgeted today (`session.rs:656-663`), because the
client assembler rejects messages over 64 MiB. The error shape is ruling 7. Rename
`response_larger_than_the_connection_budget_fails_the_session_closed` (`session.rs:2120`) and
update `remote.md:309-311`. **Rejected:** failing the session, which drops every stream on it.

### 7. Reconnect jitter and an idle ladder (research item 6)

**Decision.** Add ±15 % jitter to every retry delay (`supervisor.ts:31, 101-103, 639-658`).
After 5 minutes of continuous failure, an environment that is not selected moves to 60, 120, then
300 s. Connect, retry, network-change and wakeup signals still end the wait at once
(`supervisor.ts:555-572`), and blocked states are unchanged. **Rejected:** jitter alone (it still
dials every 16 s forever) and a longer ladder for everyone (it slows recovery of the environment
in view).

### 8. Damage limits

- **Send the config once per connection.** `server.getConfig` (`session.ts:186-191`) and the
  first `subscribeServerConfig` snapshot (`apps/server/src/production/control.rs:1412-1430`)
  carry the same config, about 248 KB each as measured. Readiness should use the snapshot. The
  `application-active` probe (`supervisor.ts:400-403`) re-fetches the whole config
  (`session.ts:192-196`) and should use a small call instead.
- **Cap pages by bytes as well as by count.** Git Manager History: 100 commits
  (`git/manager/graph.rs:16`; `apps/web/src/components/gitManager/history/GitManagerHistoryView.tsx:39`) of up to 100 KiB subject and
  100 KiB body each (`graph.rs:20, 73-74`) under a 16 MiB cap (`git/repository.rs:39`), measured
  at 15.7 MB. `review.getDiffPreview`: `git diff` with no bound (`production/runtime.rs:882-895`)
  plus up to 32 MiB of untracked files (`runtime.rs:781-782, 929-971`). `gitManager.getDiff`:
  whole patches up to 4.375 MB (`graph.rs:18`). `orchestration.replayEvents`: no bound
  (`production/orchestration_rpc.rs:170`).
- **Stop tight re-request loops.** In `createEnvironmentRpcQueryAtomFamily` (used at
  `packages/client-runtime/src/state/gitManager.ts:74-80`), a request cut off by a transport
  failure is re-issued once on the next session. A second failure shows an error with Retry.

### 9. Wording and logging

The liveness close uses code 4408, so logs and the supervisor can tell it apart from a clean
1000. The client logs `liveness-timeout` with the time since the last inbound message, and the
server logs 4408 separately.

## UI and copy

Today's copy fails `UI.md:178-184` (say what failed and what to do next). Sources: `session.ts:125`
(shown by `apps/web/src/components/gitManager/gitManagerAvailability.ts:59-73`) and
`apps/web/src/components/add-project/useAddProjectWorkflow.ts:159-164`. The clone row applies only
until clone re-attach exists; after that, the clone-reconnect record's copy applies.

| Situation | Today | Proposed |
| --- | --- | --- |
| Liveness timeout (context card, Git Manager) | "Local disconnected." | "No data from Local for 30 seconds. The connection is too slow or was lost. Reconnecting…" |
| Server closed the connection | "Local disconnected." | "Local closed the connection. Reconnecting…" |
| Git Manager while reconnecting | "Git Manager Unavailable / Local disconnected." | "Reconnecting to Local. History loads when the connection is back." |
| Clone cut off by a lost connection | "The clone stopped before it finished. Try again." | "The connection to <host> was lost, so the clone stopped and its folder was removed. Clone again once <host> is connected." |
| Response over the budget (item 6) | the whole connection drops | "This result is too large to send (<size>; limit 64 MiB)." |

## Validation

- **Client runtime** (vitest with `TestClock`): activity resets the monitor; a Ping goes out only
  after 10 s idle; death comes at 30 s within the jitter, with 4408 and its reason; E2EE records
  count as activity; whole messages still work without the subprotocol echo; `0x02` mid-message
  and the caps are handled; a failed request is re-issued once, then shows Retry.
- **Server** (Rust): the subprotocol is chosen only when offered; record boundaries are correct;
  control messages overtake queued data; Pong never ends the read loop; the progress deadline
  catches stalled and trickling sinks; writer failure closes the socket within 1 s (the
  regression test for the silent socket); a reader that stops is reaped within 50 s while a slow
  reader making progress is not; an oversized response fails only its own request.
- **Regression harness (CI):** `apps/server/tests/rpc_liveness.rs` runs an in-process tokio
  throttling proxy (backpressure) between a real session and a test client that follows item 1,
  over {plain split, plain legacy, E2EE} × {64, 256 KiB/s} × {1, 8 MiB}. It passes when split and
  E2EE runs finish without a disconnect, legacy runs finish when under 30 s, and a silent client
  is detected within 33 s.
- **Browser runbook (manual):** the repro above at 64 and 256 KiB/s must not disconnect, and a
  frozen proxy must show "No data from…" within 33 s. Port the spike's proxy to a Node script
  under `scripts/`.
- **Gates:** `vp run check:contracts` when contracts change, `cargo fmt --all --check`, Clippy
  with `-D warnings`, `vp check`, `vp run typecheck`, `vp test`, and `vercel-react-best-practices`
  and `UI.md` reviews of the copy.

## Documentation and runbooks to update

- `docs/architecture/connection-runtime.md:331-367` ("State and retry policy"): liveness, code
  4408, jitter, the idle ladder, config once and re-requests.
- `docs/architecture/rpc-and-orchestration.md:18-40` ("Wire protocol"): records, the
  subprotocol, `0x02`, the control lane and oversize.
- `docs/architecture/remote.md`: E2EE features at `:171-209`; the Pong lane, write deadlines and
  oversize at `:290-338` (oversize is `:309-311`); and a new heartbeat paragraph.
- `docs/architecture/overview.md:471-475`.
- `docs/testing/cross-platform-validation.md`: a "Slow-link liveness scenario" beside "Clone
  from URL network scenario" (`:1093`). Link it from the Linux, macOS and Windows runbooks, and
  add rows to `execution-report-template.md` beside "Disconnect/reconnect" (`:155`).
- `docs/reference/scripts.md`, if the proxy script is added.

## Rollout and compatibility

|                | Old server | New server |
| -------------- | ---------- | ---------- |
| **Old client** | today | whole messages (no subprotocol offered); the browser answers heartbeat Pings; an oversized response fails one request |
| **New client** | whole messages; the 30 s rule still drops messages that take longer | split messages, control lane, all fixes |

E2EE records are already split, so the new client survives old E2EE servers; `0x02` is used
only when both sides list `interleave-v1`. The relay tunnel must pass `Sec-WebSocket-Protocol`
(if it strips it, the connection keeps today's framing); SSH forwards TCP transparently. Only
browsers and WebViews speak RPC in production (the desktop's `connect_async` calls are tests,
`apps/desktop/src-tauri/src/backend.rs:2920` onward). Remote servers update on their own
schedule, so every feature is negotiated with today's behavior as the fallback, and servers keep
answering RPC `Ping`.

## Residuals

- The kernel send queue still delays control messages unless `TCP_NOTSENT_LOWAT` is set
  (liveness is unaffected). Links under about 2 KiB/s can still be declared dead at 30 s.
- Requests are not split, so a large upload delays the client's Pings; the server counts inbound
  progress as alive. Old clients keep the 5–10 s pinger until they update.
- A real drop still cancels in-flight work; the clone-reconnect record covers clones.
- Spike limits: headless Chromium and a loopback proxy pacing each connection separately.
  WebKitGTK, a shared bottleneck and the full 64-entry-queue path were not measured.

## Separate findings (not in scope)

1. **The environment rail snaps back to Local.** Selecting a remote in the rail
   (`apps/web/src/components/sidebar/EnvironmentRail.tsx:76`) returns to "Local" within 2–5 s,
   with or without throttling. This was seen through `aria-checked` and not investigated; it
   needs its own bug.
2. **The pairing CLI can't reach a dev data root.** `bibcode pairing offer` and `issue` open
   `ServerConfig::new(&root.effective)` (`apps/server/src/lib.rs:252`; root at
   `config.rs:770-778`), whose state directory is `userdata` without a dev URL
   (`config.rs:155-162`), while `vp run dev` uses `dev` (`lifecycle.rs:241-244`;
   `persistence/state_files.rs:49-56`). The error is "no BiBCode data store at
   …/userdata/state.sqlite". Workarounds: the startup token, or `POST /api/auth/pairing-token`
   with an owner session. Fix: honor `VITE_DEV_SERVER_URL` (or add `--dev`) and document it in
   `docs/reference/scripts.md`.

## Rulings requested

1. **Pinger:** a local protocol copy now, plus an upstream issue (recommended).
2. **Thresholds:** client probe at 10 s idle, dead at 30 s ±10 %; server Ping every 15 s, reap
   at 45 s; writes 20 s of progress with a 16 KiB/s floor (recommended).
3. **Close code:** 4408 "liveness timeout", mirroring E2EE's 4403 (recommended).
4. **Negotiation:** the subprotocol `bibcode.rpc.chunked.v1` rather than a query parameter
   (recommended).
5. **Record flag `0x02`:** plain via the subprotocol, E2EE via `e2ee_auth` features
   (recommended).
6. **Terminal output:** out of the control lane; small-message interleaving later
   (recommended).
7. **Oversize error:** a typed `RpcResponseTooLargeError { method, bytes, limitBytes }` in the
   contracts, which the item 6 copy needs (recommended). The alternative, reusing the untyped
   admission-failure payload (`session.rs:1497-1503`), avoids a contract change but gives views
   only a generic failure.
8. **Page budgets:** History pages target 1 MiB, and `review.getDiffPreview` gets a bound like
   `gitManager.getDiff`'s (recommended).
9. **Config once:** readiness from the subscription snapshot, plus a small probe call
   (recommended).
10. **Re-requests:** one automatic retry, then an explicit Retry (recommended).
11. **Idle ladder:** 60/120/300 s after 5 minutes, with ±15 % jitter (recommended).
12. **Harness:** a Rust test in CI plus a manual browser runbook (recommended). Add Playwright
    only if a scripted browser harness is wanted.
