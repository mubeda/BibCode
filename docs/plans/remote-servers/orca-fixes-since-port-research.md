# Orca remote-server fixes since the port: what BiBCode should consider

Research into the fixes Orca made to its remote-server support after BiBCode ported the
design, and whether BiBCode has the same bug or gap. Style and scope follow
`orca-remote-servers-research.md` (the port study).

- **Orca:** `/work/github/orca` at `122b8c25d7` (committed 2026-09-24). Paths prefixed
  `Orca:` are relative to that root. Each Orca citation names the commit whose tree the
  line numbers come from (`<sha>:path:line`).
- **Port baseline:** Orca `026389a3bc` (2026-08-27 00:26 -0700, `package.json` version
  `1.4.178-rc.2`). The port study's line citations match this tree: `runtime-rpc.ts` is
  1,876 lines and `protocol-version.ts:34-36` holds `RUNTIME_PROTOCOL_VERSION = 3` there.
  The `v1.4.178-rc.2` tag itself (`00f0c44a23`, 2026-08-09) does not match. Orca commits
  dated 2026-08-26 or 2026-08-27 that are ancestors of the baseline were already in the
  ported tree and are excluded (`0f522c35e5`, `8d61cb8b77`, `5631aa00dd`, `ac76e0dd06`).
- **Range reviewed:** `026389a3bc..122b8c25d7`, 2,378 commits. Of those, 269 touch the
  remote-runtime core paths (`src/main/runtime/rpc/*`, `runtime-rpc*`, `device-registry*`,
  `pairing-endpoint*`, `remote-server-updater*`, `src/shared/remote-runtime-*`,
  `runtime-environment*`, `execution-host*`, `protocol-*`, `pairing*`, `remote-pairing*`,
  `e2ee-crypto*`, `src/main/ipc/runtime-environment*`, `src/renderer/src/runtime/*`). The
  rest were searched by subject and body keywords (remote, runtime, pair, relay, reconnect,
  websocket, e2ee, serve, orcad, tunnel, ssh, updater, token, revoke, heartbeat).
- **BiBCode:** worktree `main-3` at `fd5effbb` (the terminal, Git Manager and clone commits
  landed during this research; the only other untracked files are unrelated plan documents,
  including the sibling `orca-remote-updates-research.md`). Paths prefixed `BiBCode:` are relative to the
  repository root. `codegraph sync .` succeeded; the CodeGraph MCP server was unavailable,
  so findings come from direct source reads and `rg`.
- **Method:** commit messages and diffs for every candidate, then the matching BiBCode
  source, tests and living docs. Nothing was executed against a live server. Findings
  marked **verify** are code-reading conclusions that need a reproduction before a fix.
- **Date:** 2026-09-24.

## Summary

Orca made **no post-port changes** to the parts BiBCode copied most directly: the E2EE
handshake and crypto, the pairing-offer format, device-token semantics (apart from a
Windows ACL fix and push notifications), the protocol-compatibility window, and the
remote-updater RPC. The update coordinator, restart wait and update dialog were already in
the baseline (`Orca: 0326594d52`, 2026-07-22); the sibling
`orca-remote-updates-research.md` covers that surface. Orca's post-port effort went into
**liveness under bad networks, capacity failures that should fail one request instead of a
connection, reconnect scheduling, and credential ownership across reused endpoints.**
Those are where BiBCode has gaps.

No P0 (security or data-loss) item was found.

### Prioritized list: BiBCode affected

| #   | Pri | Finding                                                                                                                                                                                                          | Orca evidence                            | Owning package                                                         |
| --- | --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------- |
| 1   | P1  | The server never reaps a half-open client. An idle dead socket keeps its E2EE slot, subscriptions and "connected" row indefinitely.                                                                              | `69fff5eaa3`, `7458c39181`, `9c92136009` | `apps/server` (`rpc/session.rs`, `rpc/e2ee.rs`)                        |
| 2   | P1  | **Verify first.** SSH environments cannot connect after **Add**, or after any socket drop that leaves the tunnel alive: the supervisor re-exchanges the one-time pairing token that onboarding already consumed. | `0c33f58e8a` (lesson)                    | `apps/desktop` (`ssh.rs`), `apps/web` (`connection/platform.ts`)       |
| 3   | P1  | **Verify.** Liveness treats slow as dead: a 5 s single-miss client pinger that counts only Pong, a Pong queued behind large responses, a flat 5 s plain-socket write deadline.                                   | `9c92136009`, `c91edafec0`, `2531dc9d5a` | `packages/client-runtime` (`rpc/session.ts`), `apps/server`            |
| 4   | P2  | One response over the 64 MiB E2EE connection budget cancels the whole session, dropping every terminal and stream on it. No first-party caller was found that exceeds it; P1 if one is.                          | `99d9111653`, `510305e574`, `f737f3499f` | `apps/server` (`rpc/session.rs`)                                       |
| 5   | P2  | SSH preparation (password prompt up to 180 s, remote launch) runs inside the supervisor's 15 s establishment race, and parallel attempts are not coalesced.                                                      | `4d24fb340b`, `0c33f58e8a`               | `packages/client-runtime` (`connection/supervisor.ts`), `apps/desktop` |
| 6   | P2  | Reconnect backoff has no jitter and no idle ladder, so every desired offline environment is dialed every 16 s forever, in lockstep after an outage.                                                              | `5083b58b9c`, `91cc834584`, `9c92136009` | `packages/client-runtime` (`connection/supervisor.ts`)                 |
| 7   | P2  | A copied data root or VM image clones the host key, storage identity and auth database. Nothing warns about it, and the UI reports "Server already saved".                                                       | `2b0ee06205`                             | docs, `apps/web` (`remote-servers/connectPresentation.ts`)             |
| 8   | P2  | The SSH askpass helper answers every prompt with one cached password, so hosts that require password plus OTP cannot be used.                                                                                    | `278f9ee876`                             | `apps/desktop` (`ssh.rs`)                                              |

What to change, in priority order:

1. **Server heartbeat and reaper (P1, `apps/server`).** Add transport-level liveness to
   both socket pumps. Send WebSocket protocol Ping frames about every 15 s, and only to
   authenticated sockets. For E2EE, start after `e2ee_authenticated`, which is Orca's
   `69fff5eaa3` rule; the pre-auth path already has its own 10 s deadline. Count any
   inbound frame as proof of life. Reap after three consecutive missed intervals, and do
   not charge a miss on a stalled tick. This is Orca's server heartbeat (pre-port) plus the
   post-port refinements. Write pings from the pump directly, because the E2EE outbound
   pump drops queued Ping and Pong messages today. WebSocket control frames carry no RPC
   plaintext, so the E2EE contract is unchanged. Clients need no change: browsers and
   tungstenite answer pings automatically. Document it in `docs/architecture/remote.md`.
   Test with a peer that stops reading and never closes.
2. **SSH bootstrap credential lifecycle (P1, verify first; `apps/desktop` plus
   `apps/web`).** A reused tunnel must never hand back a consumed one-time token. The
   preferred fix is to store the bearer from the first exchange as the SSH target's saved
   credential and reuse it on reconnect, minting a new `bibcode pairing issue` token only
   when that bearer is rejected. The minimal fix is to strip `pairing_token` from the stored
   bootstrap and mint a fresh one when `issuePairingToken` is requested on a live tunnel.
   Add a test that runs two prepares against one live tunnel. This is the item to reproduce
   first: if the chain holds, desktop-managed SSH is broken today.
3. **Slow is not dead (P1, verify first; `packages/client-runtime` plus `apps/server`).**
   First, measure on a throttled link (64–512 KiB/s) while requesting a 4–16 MiB response.
   If the client disconnects with a ping timeout, replace Effect's fixed pinger: upstream a
   configurable one, or carry a local `makeProtocolSocket` variant that resets on any
   inbound frame and tolerates several missed probes. On the server, send `Pong` through the
   existing non-blocking control lane (`try_send_control_message`) and drop it when the queue
   is full, instead of awaiting it and ending the read loop. Give the plain `/ws`
   writer the same size-scaled deadline that E2EE already uses.
4. **Fail one request, not the connection (P2; P1 if reachable; `apps/server`).** When a response cannot
   fit the per-connection budget, stop cancelling the session in
   `RpcOutboundQueue::acquire_budget`. Deliver the existing unbudgeted
   `RpcOutboundAdmissionError` terminal, or a new typed "response too large" error, for
   that request ID, and end only that stream. Rename the test that pins the current
   behavior and update `remote.md:309-311`. Most producers already cap their output at
   4–16 MiB, so this is rare. When it happens, though, the view re-requests the same
   payload after every reconnect and loops.
5. **Stage-aware establishment bound and SSH single-flight (P2).** Start the supervisor's
   15 s bound at `opening`. Give SSH preparation its own bounds (prompt and launch) and a
   visible "waiting for SSH authentication" stage. In `ensure_environment`, join an
   in-flight attempt for the same connection key instead of starting a second prompt,
   port and launch.
6. **Retry jitter and an idle ladder (P2).** Apply ±10–20 % jitter to each delay. Once an
   environment has failed continuously for, say, five minutes and is not selected in the
   rail, stretch the ladder to 60/120/300 s. Keep network, visibility, Connect and explicit
   retry wakeups immediate; `waitForRetrySignal` already does. Update the
   "State and retry policy" section of `connection-runtime.md`.
7. **Cloned identity (P2).** Add a warning to `docs/user/server-installation.md` and
   `remote.md`: never image or copy a data root after the first `bibcode serve`, and delete
   the data root in golden images. Extend the duplicate-storage-identity copy to say "if
   this is a different machine created from a copied image or data directory, reset its
   data root".
8. **SSH MFA (P2).** Either route each askpass prompt's text (argv[1]) to the desktop UI
   per invocation, or use one authenticated OpenSSH `ControlMaster` connection so later
   commands do not re-authenticate (not available on Windows OpenSSH). At minimum,
   document that only password and key authentication are supported.

### Lower priority or needs investigation

- **Terminal queries with no renderer attached** (Orca `17ffbf3b31`). The BiBCode server
  answers only OSC 10/11/12 and DSR 996 itself (`BiBCode: apps/server/src/terminal/osc.rs:1-21`).
  xterm answers CPR and DA in a renderer, gated by the first-attachment grant and the new
  reply guard (`BiBCode: apps/web/src/components/terminalReplyGuard.ts`, commit `4becbdf2`).
  A program that probes CPR while no client is attached, on a headless server or during a
  disconnect, waits for its own timeout. Revisit with the reply-guard work; not a port item.
- **`wsl.exe` inherits the desktop's working directory** (Orca `4bc20cb842`, `8cf6e12009`).
  `BiBCode: apps/desktop/src-tauri/src/backend.rs:565-568` and `bridge.rs:830-833` spawn
  without `current_dir`, and `read_wsl_environment` reports any spawn failure as "WSL
  unavailable" (`bridge.rs:825-836`). Exposure is low because the OS shell launches the
  desktop, not a deletable `\\wsl.localhost` directory. Optional hardening: pin `current_dir`.
- **The rail paints reconnecting gray, like a deliberate disconnect**
  (`BiBCode: apps/web/src/components/sidebar/environmentRail.logic.ts:49-66`). Orca keeps
  `checking` and `reconnecting` separate from `disconnected` (`Orca: 122b8c25d7:src/shared/runtime-host-connection-state.ts:15-45`). The context card text
  already tells them apart (`BiBCode: packages/client-runtime/src/connection/presentation.ts:110-129`).
  Optional.
- **Architectural, deferred: PTYs outliving a service restart** (Orca `88f2f01061`,
  `ba742a86bb`). Orca moved its terminal daemon into its own systemd scope so that
  `systemctl restart` stops killing live PTYs. BiBCode PTYs live in-process, so a restart
  of a `bibcode service install` unit, including an update, kills them. The port study
  already flagged this (`orca-remote-servers-research.md:593-598`). Orca's commit is
  production evidence that it matters. It is not a cheap port.

### Already handled by BiBCode

| Orca fix                                                                                                       | What Orca fixed                                                                                                                      | BiBCode evidence                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `2531dc9d5a` bound the connect phase                                                                           | A black-holed host held every call for 60 s. A new timeout message escaped a text-matching "recoverable" gate and dead-ended a pane. | Descriptor fetch 10 s (`packages/client-runtime/src/environment/descriptor.ts:6`), socket open 15 s (`rpc/session.ts:23`), E2EE handshake 10 s (`e2ee/socket.ts:22`), attempt 15 s (`connection/supervisor.ts:32`). Classification is typed, not text-matched (`connection/errors.ts`, `rpc/session.ts:47-98`).       |
| `c91edafec0` declare a socket dead even when its probe cannot be sent                                          | A probe that could not be written disarmed the only death verdict.                                                                   | Effect's pinger clears `recievedPong` before the ignored write, so an unsent probe still opens the timeout (`node_modules/.pnpm/effect@4.0.0-beta.107/.../RpcClient.ts:1182-1203`). See item 3 for the opposite problem.                                                                                              |
| `4fa3022c47` stop painting a disconnected host as connected                                                    | A clean close, or a half-finished handshake, showed green, and stale errors survived recovery.                                       | `connected` is published only after socket open plus `server.getConfig`, and it clears `lastFailure` (`connection/supervisor.ts:523-535`). Any close fails `closed` (`rpc/session.ts:114-131`). Presentation derives from that one state (`presentation.ts:79-110`).                                                  |
| `91cc834584` preserve standing reconnect intent (core)                                                         | An idle host with no subscriptions never reconnected.                                                                                | The registry owns desired intent outside supervisor scopes, and the supervisor retries while desired, whatever the subscriptions (`connection-runtime.md:349-356`, `supervisor.ts:576-659`). The idle-ladder half of this commit is item 6.                                                                           |
| `3b82d8de64`, `aabcc57366`, `1a47b9ee85`, `033a2a64e1`, `de73ac89c6`                                           | Renderer and main-process status recovery split, outage publication, a recovery ladder that could not finish, and latches.           | One supervisor per environment owns retries, status and generation (`connection-runtime.md:26-33, 364-366`). Retries are unbounded while desired, with no finite recovery window to exhaust. `retryNow` reaches the backoff, blocked and connected loops (`supervisor.ts:555-572, 620-636`).                          |
| `96eb97aad6` split host-contact epoch from connection generation                                               | A brief flap re-keyed and rebuilt the client-side session mirror.                                                                    | By design, a reconnect retains the cached snapshot as the render source and requires a fresh authoritative one (`connection-runtime.md:486-509`). The cost of each flap feeds item 3.                                                                                                                                 |
| `8fb0ba671b` keep the generation floor when a target is re-created                                             | A delayed mutation from a removed and re-added target passed a fence keyed on a restarted counter.                                   | Fences compare the exact `RpcSession` object as well as the generation (`packages/client-runtime/src/state/shell.ts:150-152, 186-187, 224-225`), so a new supervisor's sessions never match stale work.                                                                                                               |
| `0cbb01ef4b` apply the Windows ACL that never ran                                                              | PowerShell `-Command` never populated `$args`, so every Windows secure file kept inherited ACLs, silently.                           | BiBCode calls Win32 `SetEntriesInAclW` and `SetNamedSecurityInfoW` with a protected DACL for the current user SID, and propagates errors (`apps/server/src/auth/secret_store.rs:483-600`). The directory is hardened at init (`:126-131`), files on each read (`:137-148`).                                           |
| `78a17bb24d`, `11aace8dec`, `a35451f5b9` malformed or unknown pre-auth input                                   | One bad frame or escape threw out of a shared daemon; unknown messages self-closed the socket.                                       | Rust per-task isolation with `panic = "unwind"` (`Cargo.toml:115`) and handler `catch_unwind` (`apps/server/src/rpc/session.rs:1059`). Undecodable messages return a client protocol error and the session continues (`session.rs:754-766`).                                                                          |
| `6c3b97b950` a scope refusal is not a missing method                                                           | Scope gating runs before dispatch, so an older host answers `forbidden`, never `method_not_found`.                                   | New surfaces are capability-gated (`remoteUpdateControl`, `remote.md:473-476`). The one probe, `auth.confirmPairing`, accepts both the unknown-tag and the `access:write` denial shapes (`connection-runtime.md:146-163`).                                                                                            |
| `abc8386e14`, `0bf815a480` a lost reply must not build two                                                     | Retrying a create after a lost reply duplicated work.                                                                                | Terminal IDs are always client-chosen (`packages/contracts/src/terminal.ts:77`). Orchestration commands carry a `commandId` with durable receipts (`apps/server/src/orchestration/engine.rs:1832-1842`).                                                                                                              |
| `ad6cb0e05c`, `4d82149fe5`, `8b99c8365d`, `4e35e058fc`, `058e618bb4`                                           | A stale listing or an empty inventory authorized deletion or undid a create.                                                         | Only a current authoritative generation replaces catalog content (`connection-runtime.md:394-397`). An empty snapshot never establishes an empty catalog (`:486-499`). Absence needs an authoritative verdict (`:429-434`).                                                                                           |
| `2038376d8e` a park must not discard the only copy of scrollback                                               | A host that retained nothing blanked a remote pane on reveal.                                                                        | The server is the scrollback authority, with a 1 MiB cap above the 512 KiB client cap (`apps/server/src/terminal/history.rs:5-8`, `packages/client-runtime/src/state/terminalTranscript.ts:1`).                                                                                                                       |
| `ef4e9c40ab` replay paired snapshots at the host's grid                                                        | A snapshot parsed at the client's own grid re-wrapped and clipped.                                                                   | The renderer applies the snapshot's `size` before replaying it (`apps/web/src/components/ThreadTerminalPanel.tsx:1283-1305`).                                                                                                                                                                                         |
| `68f0b2e835`, `9cf0a6c37f` stream uploads; stop per-call capability probes                                     | Uploads were buffered whole; imports repeated capability probes.                                                                     | Uploads stream over token-in-path HTTP (`apps/server/src/transfer/upload.rs:146-153`). Capabilities are negotiated once per session (`connection-runtime.md:370-375`).                                                                                                                                                |
| `d5750648c2`, `946627f2ce`, `c61ca56a9b`, `d084a2a36a`, `7c94d12190`, `fb69f00b65`, `7574ee8403`, `b241a68ae4` | Routing and identity keyed on a raw repo or connection field, or on a path shared across hosts.                                      | Entity-ownership routing (spec D4). State is keyed by `environmentId` (`connection-runtime.md:419-425`), and one server is one environment (`remote.md:9-16`). Not re-audited here.                                                                                                                                   |
| `5083b58b9c` never replay a refresh token after a timeout                                                      | Replaying a possibly-rotated refresh token revoked whole token families (21,605 sign-outs).                                          | Not applicable: BiBCode's relay path has no rotating refresh token. It uses a Clerk session token plus a DPoP exchange per attempt (`packages/client-runtime/src/connection/resolver.ts:169-195`), and the auth paths use no `refresh_token` grant (`rg`).                                                            |
| `e49b3aa0bd`, `ef428d879e`, `77334e7c8b` say why the peer is signed out                                        | A signed-out desktop looked like an offline host.                                                                                    | Relay errors are typed: invalid auth is blocked with reason `authentication`, not authorized is blocked with reason `permission`, and an unavailable endpoint is transient (`connection/errors.ts:35-72`). A missing Connect session says "Sign in to BiBCode Cloud" (`apps/web/src/connection/platform.ts:243-250`). |
| `b00ec20731` an unreachable host must not gate local startup                                                   | One asleep SSH host held terminal restore for 15 s.                                                                                  | Supervisors and shell projection are per environment (`connection-runtime.md:486-499`).                                                                                                                                                                                                                               |
| `4085e1cf60` bound stale per-host registries                                                                   | Maps kept entries for removed hosts.                                                                                                 | Removal clears registration, profile, credential, scope and environment-keyed state (`connection-runtime.md:517-521`, `packages/client-runtime/src/connection/registry.ts:617-664`).                                                                                                                                  |

---

## Path map for the Orca runtime RPC split

`Orca: 86d9c07a3c` (2026-08-29) split the 1,876-line `src/main/runtime/runtime-rpc.ts`
that the port study cites into `src/main/runtime/runtime-rpc/`. The top-level file is now
23 lines. For any older citation:

| Port-study citation (`026389a3bc`)                    | Current home                                                                          |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------- |
| bind widening and rebind ceremony (`:1378-1510`)      | `runtime-rpc/runtime-rpc-network-exposure.ts`                                         |
| offer generation and pending device (`:~698-770`)     | `runtime-rpc/runtime-rpc-pairing.ts`, `runtime-rpc-pairing-types.ts`                  |
| E2EE auth frame and device-token check (`:1703-1740`) | `runtime-rpc/runtime-rpc-websocket-dispatch.ts`                                       |
| mobile pairing and allowlist                          | `runtime-rpc/runtime-rpc-mobile-pairing.ts`, `runtime-rpc-mobile-method-allowlist.ts` |
| request admission, lifecycle, shutdown, state         | `runtime-rpc-request-admission.ts`, `-lifecycle.ts`, `-shutdown.ts`, `-state.ts`      |

---

## 1. Server-side liveness: half-open clients are never reaped (P1)

### Orca

- The server heartbeat predates the port. It sends protocol pings, requires three
  consecutive misses (STA-3320: "one unanswered probe is UNKNOWN, not death"), and does
  not charge a miss on a stalled tick (`Orca: 69fff5eaa3:src/main/runtime/rpc/remote-runtime-server-heartbeat.ts:3-7, 55`). The port
  study recommended it (`orca-remote-servers-research.md:223-228, 586-590`).
- `69fff5eaa3` (2026-09-01) stopped probing sockets that are still in the E2EE handshake.
  Probes now begin only after authentication binds a client ID, and the immediate sweep on
  start was removed (`Orca: 69fff5eaa3:src/main/runtime/rpc/ws-transport.ts:323-328`).
- `7458c39181` (2026-09-02) made the SSH relay agent reap a client that has stopped
  answering: "The relay's writer parks forever on a half-open link and nothing else ever
  notices, so an abandoned viewer kept its owner lease". It also bounds a client that
  clears the handshake and then never sends a frame (`Orca: 7458c39181:src/relay/dispatcher-client-lifecycle.ts:15-19, 218-224`).
- `9c92136009` (2026-09-17) applied the same rule to the relay control socket: three
  unanswered probes are required, and any inbound frame retires the run (`Orca: 9c92136009:src/main/runtime/relay/relay-control-liveness.ts:21-27, 62-65`).

### BiBCode

- The plain `/ws` session loop waits on `socket_reader.next()` with no deadline
  (`BiBCode: apps/server/src/rpc/session.rs:726-745`).
- The E2EE inbound pump has no deadline between logical messages
  (`apps/server/src/rpc/e2ee.rs:1296-1304`). This is documented: "An idle authenticated
  connection between messages has no assembly deadline" (`docs/architecture/remote.md:271-272`).
- Neither path originates pings. WebSocket Ping and Pong frames are skipped
  (`session.rs:753`; `e2ee.rs:1110, 1384`), and the E2EE outbound pump drops queued Ping
  and Pong messages (`e2ee.rs:1251`). No TCP keepalive is set anywhere in `apps/server/src`
  (`rg set_keepalive|socket2|keepalive`). The listener is a plain `TcpListener::bind`
  (`apps/server/src/lifecycle.rs:231`).
- The client's Effect pinger sends an RPC Ping every 5 s, so the server hears from a live
  client, but it never acts on silence.

### Consequence

A client that vanishes without a FIN leaves its socket open on the server. That happens
on laptop suspend, a Wi-Fi roam, a NAT timeout or a cellular blackhole. The server learns
only when it next writes and the kernel gives up retransmitting, which takes about 15
minutes with Linux defaults (`tcp_retries2 = 15`). If the server never writes, it never
learns. Until then the dead socket:

- Holds an established-E2EE permit. The caps are 64 process-wide and 32 per authenticated
  session (`e2ee.rs:76-77`; `remote.md:278-288`). A device that repeatedly suspends and
  resumes with idle connections can exhaust its own 32 and be refused.
- Keeps its live-connection registration, so the Share tab's client list shows a dead
  device as connected (`remote.md:589-591, 632-635`).
- Keeps its subscriptions running: shell, Git Manager signal and terminal attach. The
  server keeps doing watcher and refresh work for nobody.

### Change

Add a liveness task to the socket pumps. It sends WebSocket protocol Ping frames about
every 15 s, only after the upgrade and, for E2EE, only after `e2ee_authenticated`. The
10 s pre-auth deadline stays (`e2ee.rs:53`). Mark the socket alive on any inbound frame,
reap after three consecutive missed intervals, and skip the charge on stalled ticks.

Write pings from the pump, not the RPC queue. WebSocket control frames are already
described as transport control carrying no RPC plaintext (`remote.md:308-309`). No client
or wire change is needed.

Owner: `apps/server` (`rpc/session.rs`, `rpc/e2ee.rs`). Document in `remote.md`. Test with
a peer that stops acknowledging but never closes; expect the permit and registration
released within about 45 s.

## 2. SSH connect and reconnect re-exchange a consumed one-time token (P1, verify first)

Orca's relevant lesson is `0c33f58e8a` (2026-09-06). A client that minted the endpoint
credential before launching could overwrite the credential of a still-running incumbent
and wedge it. Only the process that proved ownership may publish or rotate the credential,
and the client must tell "no daemon" apart from "daemon present" (`Orca: 0c33f58e8a:src/relay/relay-endpoint-credential-publication.ts:4-9`). Checking BiBCode's
SSH launch against that lesson surfaced the following chain.

### BiBCode chain (code reading, not reproduced)

1. `ensure_environment` returns the existing bootstrap whenever the tunnel process is
   still running, before it looks at `issue_pairing_token`
   (`BiBCode: apps/desktop/src-tauri/src/ssh.rs:452-454, 642-660`).
2. That stored bootstrap carries the `pairing_token` minted by the first call
   (`ssh.rs:495-521`), published by `publish_tunnel` (`ssh.rs:672-695`).
3. Every supervisor preparation of an SSH target calls
   `ensureSshEnvironment({ issuePairingToken: true })`, then exchanges
   `bootstrap.pairingToken` at `/oauth/token`
   (`apps/web/src/connection/platform.ts:289-317`; exchange at
   `apps/desktop/src-tauri/src/bridge.rs:1220-1242`).
4. The server consumes pairing links on exchange. A second exchange returns
   `InvalidCredential` (`apps/server/src/auth/service.rs:2168-2213`), because
   `bibcode pairing issue` mints one-time links (`remote.md:715-722`).
5. Onboarding already spends the token. `provisionDesktopSshEnvironment` exchanges it
   (`platform.ts:202-233`), then `registerSshConnection` registers the environment
   (`packages/client-runtime/src/connection/onboarding.ts:250-276`). The supervisor's first
   preparation then reuses the onboarding tunnel.
6. The tunnel is torn down only on environment removal
   (`packages/client-runtime/src/connection/registry.ts:651-664`).
7. The failure maps to a transient error (`platform.ts:188-200`), so the supervisor retries
   every 1–16 s with the same consumed token.

### Expected symptom

An SSH environment cannot connect after **Add**: onboarding consumed the token, and the
supervisor's first preparation reuses the onboarding tunnel and re-exchanges it. The only
way through is that the tunnel died in between. The environment also stays stuck in
"Reconnecting" after any WebSocket drop that leaves the tunnel alive: a remote server
restart or update, an `application-active` probe failure, or a pinger timeout (item 3).

No test covers bootstrap reuse; the only reuse test checks a missing target
(`ssh.rs:2596-2600`). No execution report records a live desktop-managed SSH **Add** or
reconnect since the pairing repair (`f65bed06`, 2026-08-27). The reports under
`docs/testing/reports/` cover SSH only through unit tests (for example,
`2026-08-28-remote-server-stabilization.md:159`). **Verify** with two consecutive
preparations against a live tunnel before changing code. Reproduce this item first: if the
chain holds, a flagship path is broken today.

### Change

- **Preferred:** save the bearer returned by the first exchange as the SSH target's
  credential and reuse it, as bearer targets do (`resolver.ts:111-166`). Mint a new
  pairing token over SSH only when the saved bearer is rejected.
- **Minimal:** never return a stored one-time token. Clear it after its first delivery, and
  mint a fresh one over the existing tunnel's auth when a caller asks for one.

Owner: `apps/desktop` (`ssh.rs`), `apps/web` (`connection/platform.ts`) and
`packages/client-runtime` (the SSH broker, `connection/resolver.ts:210-262`). Update the
SSH section of `remote.md:707-722`.

## 3. Liveness treats slow as dead (P1, verify)

### Orca

The STA-3320 rule, that a single miss is unknown, is applied everywhere after the port:

- the relay probe requires a run of three and counts any inbound frame (`9c92136009`, see
  item 1);
- the web client probes only after 25 s idle, with a 20 s grace, and treats any inbound
  frame as liveness (`Orca: c91edafec0:src/renderer/src/web/web-runtime-connection-heartbeat.ts:4-5, 24-27, 52-55`);
- the connect bound is an inactivity timer, "so a slow-but-answering host is not cut off"
  (`Orca: 2531dc9d5a:src/shared/remote-runtime-connect-bound.ts:11-25`).

### BiBCode

- **Client pinger.** BiBCode uses Effect's `RpcClient.makeProtocolSocket`
  (`BiBCode: packages/client-runtime/src/rpc/session.ts:165-170`). Its pinger waits 5 s,
  then fails the socket with "ping timeout" if the previous Ping got no Pong. One missed
  5–10 s window is death, and only a `Pong` resets it; data frames do not count
  (`node_modules/.pnpm/effect@4.0.0-beta.107/node_modules/effect/src/unstable/rpc/RpcClient.ts:1050, 1079-1081, 1108-1118, 1182-1203`).
  The interval and miss budget are not options. The vendored upstream is identical
  (`.repos/effect-smol/packages/effect/src/unstable/rpc/RpcClient.ts:1168-1190`, version
  4.0.0-beta.107).
- **Server Pong.** The Pong is queued FIFO on the same outbound queue as responses
  (`apps/server/src/rpc/session.rs:835-837` → `send_server_message`, `:1390-1423`).
  E2EE writes each logical message record by record before dequeuing the next, with an
  aggregate deadline of 5 s plus 1 s per 64 KiB (`e2ee.rs:51, 1136-1162, 1244-1266`). At
  that 64 KiB/s floor, a 1 MiB response takes 16 s to leave, and the Pong waits behind it.
- **Server read loop.** The read loop awaits the Pong enqueue into a 64-entry queue
  (`OUTBOUND_CAPACITY`, `session.rs:36`). If the queue cannot accept it within 5 s
  (`session.rs:39`), `process_client_message` fails, and the loop marks EOF and ends the
  session (`session.rs:772-782`).
- **Plain writer.** The plain `/ws` writer gives each whole WebSocket message a flat 5 s
  (`session.rs:703-706`), whatever its size. Relay and SSH ride plain `/ws`
  (`resolver.ts:204, 261` set `e2ee: null`).

### Consequence

On a constrained link a large response can take longer than 5 s to drain. That includes
Tailscale DERP relays, tethered cellular and slow SSH hops, and responses up to the 16 MiB
Git history cap (`git/repository.rs:39`). The client then declares the socket dead, or the
server ends the session, while data is flowing.

Each false flap costs a new handshake, authentication, `server.getConfig` and a full shell
snapshot (`connection-runtime.md:501-509`). It also resets and replays every attached
terminal (`packages/client-runtime/src/state/terminalTranscriptRuntime.ts:126-141`), and
the user retries the request that caused it.

### Change

1. Reproduce first on a throttled link, using toxiproxy or `tc netem` at 64–512 KiB/s.
2. **Client:** upstream a configurable pinger to Effect, or carry a local protocol variant,
   that resets on any inbound frame and tolerates about three missed 10 s probes.
3. **Server:** send `ServerMessage::Pong` through the existing non-blocking, unbudgeted
   control lane that interrupts already use (`try_send_control_message`,
   `session.rs:1451-1466`). Drop the Pong when the queue is full rather than awaiting it and
   ending the read loop.
4. **Server:** give the plain writer the E2EE size-scaled deadline
   (`E2EE_LOGICAL_WRITE_BYTES_PER_SECOND`, `e2ee.rs:51`).

Point 3 alone does not help a Pong stuck behind an in-flight message; point 2 is what
matters.

Owner: `packages/client-runtime` (`rpc/session.ts`), `apps/server` (`rpc/session.rs`).
Document in `connection-runtime.md` and `remote.md`.

## 4. An oversized response kills the whole session (P2; P1 if reachable)

### Orca

- `99d9111653` (2026-09-02): "A ~900 KB `fs.listFiles` reply ... took down the whole remote
  session -- every terminal on it -- rather than failing the one Quick Open request". Its
  rule: "A JSON-RPC response is the droppable class of control frame: it carries an id, so
  one caller can be told and can retry" (`Orca: 99d9111653:src/relay/dispatcher-rpc-routing.ts:206-211, 236-238`).
- `510305e574` generalizes it to "signal capacity loss instead of dropping, hanging, or
  truncating".
- `f737f3499f` streams large listings so that their size stops being a correctness
  question.

### BiBCode

- `RpcOutboundQueue::acquire_budget` cancels the session when a single encoded response
  exceeds the connection capacity. On a failed acquisition with
  `bytes > budget.connection_capacity` it calls `shutdown.cancel()`
  (`BiBCode: apps/server/src/rpc/session.rs:150-167`).
- A test pins this, `response_larger_than_the_connection_budget_fails_the_session_closed`
  (`session.rs:2120-2168`), and the doc states it: "A response larger than the 64 MiB
  connection cap fails the session closed immediately" (`remote.md:309-311`).
- It applies to budgeted (E2EE) sessions. The capacity is 64 MiB per connection
  (`e2ee.rs:1404-1407`; `remote.md:290-291`). Plain sessions run unbudgeted
  (`session.rs:656-663`).
- A substitute terminal already exists for a lost admission deadline
  (`outbound_admission_failure`, `session.rs:1497-1503`; `send_stream_terminal`,
  `:1429-1445`), but the cancelled session prevents it from being delivered.

### Consequence

Most producers cap their output well below 64 MiB. Git outputs are capped at 4–16 MiB
(`apps/server/src/git/repository.rs:38-43`) and Claude transcript tails at 10 MiB
(`provider/claude/transcript.rs:20`).

No first-party path was found that exceeds the budget. The one uncapped producer found is
`orchestration.replayEvents`, which returns every event after a sequence number with no
limit (`apps/server/src/production/orchestration_rpc.rs:169-180` →
`orchestration/engine.rs:2569-2576`). No first-party client calls it; an older or
third-party client could. Thread-detail snapshots were not measured. Hence P2, rising to
P1 if a reachable producer turns up.

When it triggers, every terminal and subscription on that connection drops. The view
re-requests the same payload after reconnect, so it loops. The client could not accept
such a message anyway: its record assembler caps at 64 MiB (`remote.md:157-160`). The
right outcome is a per-request error.

### Change

Do not cancel the session on an impossible admission. Send the unbudgeted
`RpcOutboundAdmissionError` terminal, or a typed `RpcResponseTooLargeError` naming the
method and size, for that request ID, and end only that stream. Rename the pinning test
and update `remote.md:309-311`.

Owner: `apps/server` (`rpc/session.rs`), plus a contracts error schema if the error is
typed.

## 5. SSH preparation inside the 15 s establishment race, uncoalesced (P2)

### Orca

- `4d24fb340b` (2026-09-03): a flat 12 s dial bound hung up on reachable but slow relay
  cells, and every retry landed in the same contended window. The fix keeps the caller's
  bound until the socket opens, then re-arms a budget per stage (`Orca: 4d24fb340b:mobile/src/transport/replacement-session-authentication.ts:62-66`;
  `relay-dial-stage.ts:57-62`).
- `0c33f58e8a` shows that concurrent starts racing one endpoint must not both act.

### BiBCode

- The supervisor races the whole establishment against 15 s (`BiBCode: packages/client-runtime/src/connection/supervisor.ts:32, 458-471`). That includes
  `resolver.prepare` (`connection/driver.ts:55-58`).
- For SSH, preparation is `bridge.ensureSshEnvironment` behind an `Effect.tryPromise`
  with no abort (`apps/web/src/connection/platform.ts:297-301`). Interrupting the fiber
  does not stop the Tauri command.
- `ensure_environment` first tries BatchMode. It then prompts for a password with a 180 s
  timeout (`apps/desktop/src-tauri/src/ssh.rs:28, 602-640`) and launches or reuses the
  remote server and tunnel (`ssh.rs:440-525`).
- Passwords are cached in memory only (`ssh.rs:363`), so after every desktop restart the
  first connection to a password-auth host prompts inside the 15 s window.
- Nothing joins an in-flight `ensure_environment` for the same key. Each call creates a new
  prompt (`ssh.rs:1613-1623`), picks a new local port (`ssh.rs:456-457`) and publishes over
  any prior entry (`ssh.rs:693`). A user who takes more than 15 s to type the password
  therefore gets a second prompt one backoff step later.

### Change

Apply the 15 s bound from the `opening` stage. Bound SSH preparation by its own prompt and
launch deadlines, and surface it as a distinct stage. Make `ensure_environment`
single-flight per connection key.

Owner: `packages/client-runtime` (`connection/supervisor.ts`), `apps/desktop` (`ssh.rs`).

## 6. Reconnect schedule: no jitter, no idle ladder (P2)

### Orca

- `91cc834584` (2026-08-30) kept reconnect intent for idle hosts but moved them onto a
  longer ladder, `[..., 30_000, 60_000, 120_000, 300_000]` (`Orca: 91cc834584:src/shared/remote-runtime-shared-control-reconnect.ts:3-4, 55-74`).
- `5083b58b9c` added full ±10 % jitter after a cell recreate re-burst the fleet every
  54 minutes (`Orca: 5083b58b9c:src/main/runtime/relay/relay-renewal-jitter.ts:1-6, 22-24`).
- `9c92136009` jitters its probe deadlines for the same reason.

### BiBCode

- Fixed delays of 1/2/4/8/16 s with a 16 s cap, repeated forever while desired, and no
  jitter (`BiBCode: packages/client-runtime/src/connection/supervisor.ts:31, 101-103, 639-658`;
  `connection-runtime.md:343-347`).
- Each attempt against an unreachable direct target spends up to 10 s on the descriptor
  fetch (`environment/descriptor.ts:6`).
- Each relay attempt calls the Connect control plane (`resolver.ts:169-195`). After a
  Connect outage, every client's offline environments retry in lockstep.

### Change

Add ±10–20 % full jitter. Extend the ladder for environments that have been failing for a
long time and are not selected. Keep the early wakeups (`supervisor.ts:555-572`).

Owner: `packages/client-runtime` (`connection/supervisor.ts`). Update
`connection-runtime.md` "State and retry policy".

## 7. Cloned data root clones identity (P2)

### Orca

`2b0ee06205` (2026-08-28) is a docs change. Two VMs booted from a snapshot taken after
`orca serve` had run "emitted identical `deviceToken` and `pairedDeviceId`". The rule it
adds: snapshot before the runtime has ever run, or delete the whole user-data directory
(`Orca: 2b0ee06205:skill-guides/orca-per-workspace-env.md:138-144, 173-175`).

### BiBCode

- The storage-identity marker is minted at first run
  (`BiBCode: apps/server/src/persistence/store.rs:225-238`), and the host key is the secret
  `host-identity-x25519` (`apps/server/src/auth/host_identity.rs:7`). Both live in the data
  root, next to the auth database.
- Saved remotes are keyed `remote:<storageInstanceId>` (`remote.md:17-27`). Pairing a
  second clone therefore fails as "Server already saved"
  (`packages/client-runtime/src/connection/pairingAdd.ts:231-246, 261-267`;
  `apps/web/src/components/settings/remote-servers/connectPresentation.ts:134-142`),
  which misstates the cause.
- Clones share the pinned host key, so pinning cannot tell them apart. If the auth
  database was copied too, each clone accepts the other's session credentials.
- No doc warns about this. `docs/user/server-installation.md` and
  `docs/guides/project-data-recovery.md` cover moved roots, not copied ones.

### Change

Add the warning to `server-installation.md` and `remote.md`. Extend the duplicate-identity
copy to name the cloned-image cause.

## 8. SSH askpass answers every prompt with one secret (P2)

### Orca

`278f9ee876` (2026-09-02): hosts with `AuthenticationMethods
keyboard-interactive,keyboard-interactive`, or any ladder ending in a second challenge,
failed with "All configured authentication methods failed". The auth queue is now rebuilt
on each partial success (`Orca: 278f9ee876:src/main/ssh/ssh-private-key-authentication.ts:7-8, 16-39`).

### BiBCode

- The POSIX and Windows askpass helpers print `BIBCODE_SSH_AUTH_SECRET` for every prompt
  (`BiBCode: apps/desktop/src-tauri/src/ssh.rs:45-61`), with `SSH_ASKPASS_REQUIRE=force`
  (`ssh.rs:783-788`).
- `run_with_ssh_auth` reruns each SSH command with the cached password: launch, tunnel and
  pairing issue (`ssh.rs:458-521, 602-640`). An OTP or second keyboard-interactive prompt
  receives the password, and the flow gives up after two prompts.

### Change

Give askpass a channel back to the desktop so each prompt's text reaches the UI, or use a
`ControlMaster` session (Unix only) so the other commands do not authenticate again. Until
then, document that only password and key authentication are supported
(`docs/user/remote-access.md`).

Owner: `apps/desktop` (`ssh.rs`).

---

## Commits reviewed and dismissed

One line each; grouped where many commits share one reason.

### Transport, liveness and capacity: used above or handled

- `69fff5eaa3`, `c91edafec0`, `9c92136009`, `7458c39181`: used in items 1 and 3.
- `2531dc9d5a`: handled (see the table).
- `99d9111653`, `510305e574`, `f737f3499f`: used in item 4.
- `61b09b7a02` (relay: abandon dead accepts, jitter the lease, fail direct probes fast): the
  jitter lesson is in item 6; the rest concerns cloud cells and the phone.
- `23df74d85a`, `e628090ad4`, `ceafdcad2f` (phone reconnect critical path, urgent probe on
  resume): mobile-only. BiBCode already probes on `application-active`
  (`supervisor.ts:400-443`).
- `3a8f806d6c` (terminal stream stall deadline on unacknowledged credit): Orca's own
  binary credit window. BiBCode streams use Effect RPC per-chunk `Ack` over one ordered
  socket (`session.rs:842`).
- `06272109da`, `de73ac89c6` (re-probe after reconnect publishes only verified status):
  Orca probes on a separate socket. BiBCode probes on the live session.

### Client session mirror, tab inventory and PTY authority

BiBCode's server owns terminals and threads, and client caches are non-authoritative
(`connection-runtime.md:486-509`), so these do not apply:

- `8b99c8365d`, `f864223723`, `4e35e058fc`, `cc66d6e900`, `0f2fe13374`, `0d2375a7ff`,
  `668946345a`, `2a785274ad`, `f492054bf0`, `851befa929`, `182ff17141`, `67dda9affe`,
  `a61119ceb0`, `779667c1e7`, `e45cf438bc`, `5c2d3322c1`, `06a8ca5f69`, `57e28ccf7c`,
  `f87359cda6`, `2741bdad38`, `4d82149fe5`, `593141590e`, `6256f3d137`, `fc78a7d9ca`,
  `ef03188956`, `c55121231a`, `ae0f3675a1`, `db84894eef`, `e8a956e833`, `252dbd60ea`,
  `da836faeef`, `9ed2f743a4`, `5723c5baa9`, `1aadf91153`, `0e935c4b0a`.

### Orca's SSH relay agent

Orca deploys a Node relay over SSH. BiBCode launches `bibcode serve` and forwards a port
(`remote.md:707-722`). These fixes target the relay agent, node-pty, ssh2 or PowerShell:

- `a7b1da9e14`, `25fa6a9920`, `b1fe9075db`, `7bbb8adc61`, `94e7586665`, `f23d0b166f`,
  `ba5f33402f`, `e4c279fa60`, `f2e95e7860`, `08c7152ab6`, `720c3299ba`, `76836b30ea`,
  `64dac75d9b`, `31007c0d86`, `7c6c8ef85e`, `39330c5aca`, `aa3ae6f56e`, `04ae62202a`,
  `a5d6114baf`, `f35015d0c8`, `e42c60e8a3`, `561a94038c`, `2ee507d744`, `7eb13c184c`,
  `9927edd631`, `36a826ff48`, `72a8c096a3`, `96b450fae8`, `edbcf68e53`, `637dc30a32`,
  `766b5b153c`, `8c6ae79e94`, `df88f83c70`, `c0fb04c8d2`, `d838ca1419`, `7dd2ff586a`,
  `bda6751da8`, `b8cfdb1702`, `02ffd40edc`, `4f4872c424`, `f9587f74f5`, `7f4a17d8eb`,
  `3d3b4f9053`, `0dbe9d0504`, `e02347ae9b`, `6d61305a96`, `07e1f953a5`, `9e9b80cb37`,
  `57681ecd09`, `d5803bdbc4`, `51eed5a1bc`, `f2ddf7779f`, `b8da193b7a`, `8854b5ded5`,
  `6c4797ca9f`, `5cc432eead`, `56626e7daa`, `99cca036e7`, `51ff9c7ff3`, `6a65d8406a`,
  `7879dead69`.
- Used as lessons, not ports: `0c33f58e8a` (items 2 and 5) and `278f9ee876` (item 8).
  `8fb0ba671b` is handled (see the table).

### Cloud relay fleet operations

Orca's relay cells and Postgres run on a separate control plane; BiBCode Connect is
different (`remote.md:693-705`):

- `128e97ffca`, `1116c54230`, `ae3d380b23`, `a2a78ab335`, `1043dc5e1d`, `51c3434851`,
  `bf3f95245c`, `8568d77b06`, `bf8d63bc67`, `c8a5580659`, `e476193bf5`, `2524737ef0`,
  `5b8ac36f41`, `4f839cc8c9`, `eb6068a434`, `68b11282a5`, `fa0010e8d6`, `030a1e0c77`,
  `7080eb0604`, `164c7140fd`, `3467e5f6b5`, `ce5d8c02d4`, `4b4ee040df`, `6c913a917f`,
  `27bddc6198`, `acedcf2a97`, `ff8f7085cc`, `399306c171`, `91ade4b82a`, `ddbad2218b`,
  `cbd04704d6`, `8e8a9b38ea`, `0e7948fa6d`, `09622f0c28`, `0ed2771fa5`, `1957437005`,
  `a3046cd27b`, `7184b1dc5b`, `5947d6b269`, `69787e763a`, `0699d73fd6`, `77cd61df39`,
  `71e308e574`, `d51747e4c4`, `2162e31f80`, `101cdc45f8`, `ce82438828`, `9f10f415f5`,
  `f7238ce469`, `113e58f34e`, `1d7bb47a11`, `cd9aa43a2c`, `a6e6de93c4`, `bcd4076dd1`,
  `5857357fcf`, `33af0af4ea`, `8cd0abf76a`, `1bf30670d4`, `9c8f4c398c`, `91d7783f2b`,
  `e068947d4c`, `f5be177e44`, `ecfcc0d833`, `5dab495655`, `1326d6b40c`, `3bb038a185`,
  `a3c1d32995`, `ba4bbacd6b`, `974acc901c`, `e2b70a5eba`, `74ad08ec66`, `0f5f5e6979`,
  `6aba81f90a`, `b6f453df06`, `8f1e64471e`, `7cb05477a1`, `2f4f4578c8`, `7b108abf71`.
- Robustness lessons marked handled in the table: `11aace8dec` (cloud relay upgrade
  parsing), `a35451f5b9` (desktop relay control client) and `78a17bb24d` (SSH relay agent
  frame decoder).

### Mobile and phone relay

Out of scope; BiBCode has no mobile relay surface:

- `e60d9aaac9`, `ef428d879e`, `e49b3aa0bd`, `83b1558ecc`, `a84f16df3d`, `4d24fb340b`,
  `6c3b97b950`, `abc8386e14`, `996f9cc306`, `9641a1b544`, `d5dc7b9cf8`, `ac4dc6599b`,
  `5287c5cdbc`, `3cfb070294`, `e2afb5eef9`, `381a3da46f`, `ed909846f6`, `5064469687`.
- `4d24fb340b` is used as a lesson in item 5. `6c3b97b950` and `abc8386e14` are handled.

### Updater, serve, orcad and packaging

- `7da9788c83` (dev build picker rate limits), `b81e578cff` (GitHub asset redirects on
  Windows), `90b02cba60` (status-bar error disclosure), `aa658d28e3`, `7cb1db63db`,
  `22a9e30ba1` (tests): the Electron updater. BiBCode's feed URL is baked into the Tauri
  release configuration (`remote.md:485-490`).
- `f37d2fec97`: Linux AppImage packaging. It also switched deb/rpm servers to manual
  remote updates. BiBCode's `.deb`/`.rpm` are headless-server packages
  (`docs/user/server-installation.md:36-38`), which already report `manual` (spec §4.5).
  Desktop "interactive" support keys on updater presence
  (`apps/desktop/src-tauri/src/remote_update_delegate.rs:20-36`,
  `apps/desktop/src-tauri/src/lib.rs:125-134`). Left to `orca-remote-updates-research.md`.
- `18e8fe4770` (module-scope throw crashed `orca serve` under a supervisor), `3cb9b5d87f`
  (Chromium switches), `34999e328e` (orcad spawn-helper): Orca-specific startup and
  Electron code.
- `88f2f01061`, `ba742a86bb`: the architectural item under "Lower priority".
- `9af6a3d798` (CLI reports sandbox EPERM): Orca's CLI dials a running app; BiBCode's does not.

### WSL

Orca routes its own Git and agents through WSL paths; BiBCode runs a WSL backend server:

- `4bc20cb842`, `8cf6e12009`: noted under "Lower priority".
- `d7d3114716`, `6cc9319d87`, `a8183884bd`, `e741ff1318`, `26dfa46aa9`, `9542b45d99`,
  `e4a708da17`, `a4cd00ed18`, `879fdfdac6`, `5bd66bac8b`, `3b055c869f`, `8d38dbf565`,
  `6ee7e9511b`.

### Security and credentials

- `0cbb01ef4b`: handled.
- `5083b58b9c`: not applicable (no refresh token).
- `2b0ee06205`: item 7.
- `91fbc1529a`: cloud relay dependency bumps.
- `b0ec11f5b0`: OMP credential redaction.
- `22f56f7c2a`: Base64 padding on Orca's RPC file writes; BiBCode uploads over HTTP.
- `fc8c981103`, `cb848647e5`: browser-preview grants, which BiBCode does not have.

### Features, refactors and reverts

- `800d33e5c9` (name runtime machines): a feature. BiBCode codes carry a name plus a
  client alias (`connection-runtime.md:83-88`).
- Refactors: `86d9c07a3c`, `07652e252f`, `b5d0e51d33`, `9bdc146f13`, `8d3a420b7b`,
  `a5796ec8eb`, `41015f9393`, `5b4e7edb50`, `2ecde717b4`, `c84007c541`, `bc5e67606f`,
  `c09810b641`, `1cf38bbcef`, `2dfaa676d8`.
- Reverted pairs: `0677271709` ↔ `7a4f080086`, `7b86833120` ↔ `4bc2085271`,
  `3160b54c69` ↔ `d53cbed43f` (restored in `341b13cf67`, push only), `249d93bc5d` ↔
  `551fbb9ac7`.
- `5412276776`, `f46823a30a`: a React render loop in Orca's status-bar target selector.
- `4085e1cf60`, `b00ec20731`: handled.

### Bulk categories, not remote-server support

Counts are within the 269 core-path commits; the same themes dominate the wider range:

- native and structured chat: about 60;
- orchestration and workers: about 29;
- agent launch and status: about 23;
- mobile: about 22;
- plus Jira, Linear, GitHub and GitLab integrations, i18n, lint rules, automations,
  browser preview and session search.
