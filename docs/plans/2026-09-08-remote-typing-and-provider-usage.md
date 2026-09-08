# Remote typing and provider usage diagnosis

Status at authoring: provider-usage fix implemented and verified in the checkout;
terminal protocol improvement proposed, awaiting architectural approval. The
installed desktop app and remote server have not been replaced or restarted.

## Observed behavior

The running macOS desktop app selected `ai-server` and showed a Claude terminal
panel. The input-location clarification was unanswered during diagnosis, so the
typing investigation covers terminal input. It does not establish a problem in
the structured chat composer.

The footer selected `usePrimaryEnvironment()`, whose source is the catalog's
`PrimaryConnectionTarget`. The rail selects a different value,
`activeEnvironmentIdAtom`. Existing status-bar tests incorrectly mocked the
primary connection as the selected environment, hiding the mismatch.

A real-component regression with a fixed local primary and a selected remote
reproduced the error: expected the remote's **70% remaining**, received the
local's **10% remaining**. The fix reads `useActiveEnvironmentId()` and keeps
queries, refresh commands, reset overlays, and interaction state scoped to it.
Tests cover switching in both directions, a loading/offline remote, and a late
reset response arriving after switching. Resource queries and terminal counts
also now follow the selected identity, retaining the existing separate desktop
local resource diagnostic source.

## Remote latency evidence

A temporary diagnostic used the existing saved profile and pinned Noise key
to authenticate a separate encrypted connection. It loaded credentials in
memory, did not print or persist them, and sent only ping/pong and provider-usage
reads. No input was sent to the user's terminal.

| Probe                            | Observed milliseconds                    |
| -------------------------------- | ---------------------------------------- |
| Encrypted RPC ping/pong, pass 1  | 509, 1286, 523, 373, 404, 404, 563, 876  |
| Encrypted RPC ping/pong, pass 2  | 627, 1054, 836, 518, 408, 597, 1003, 300 |
| Remote `server.getProviderUsage` | 421, 384, 665, 838                       |
| Tailscale direct peer ping       | 904, 1096, 349, 435, 446                 |
| Tailscale TSMP                   | 914                                      |

Tailscale reported a direct endpoint, no exit node, and no health errors.
The TSMP probe bypasses the application. These results locate a substantial
delay outside terminal processing and React rendering. They do not identify
the exact source of the network jitter or prove there is no additional UI cost.
Remote provider-usage queries succeeded for both providers.

The production `createTerminalInputScheduler` adds another wait: it permits one
write RPC in flight. A 20-character harness with 30 ms between characters
measured zero rounded median/max queue delay at a simulated 5 ms RTT. At 120 ms
RTT, two runs measured 59 ms median and 119–120 ms maximum **before sending**.
These are simulation results, separate from the live network measurements.
A loopback small-packet comparison with TCP_NODELAY off/on did not reproduce
meaningful latency, so no speculative socket-option change was made.

The current ordering is deliberate: after a failed write, dependent characters
are dropped rather than delivered as a different command. The Rust RPC layer
spawns handlers concurrently, so simply allowing concurrent legacy
`terminal.write` calls cannot preserve this guarantee. Terminal scheduling and
production transport code remain unchanged.

## Proposed terminal improvement

| Approach                                    | Benefit                                                     | Cost or limit                                                                                                                               |
| ------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Reduce network latency                      | Improves every remote interaction                           | The connection is already direct; a lower-latency path or host still needs investigation outside this patch.                                |
| Ordered input with several writes in flight | Removes the extra acknowledgement wait during normal typing | Requires coordinated contracts, server, and client changes. Echo still takes a network round trip.                                          |
| Predictive local echo                       | Can make some terminal input appear immediately             | Requires correct rollback and cursor prediction for arbitrary Claude/Codex terminal UIs; risks displaying input the process did not accept. |

The recommended application change is ordered input with a bounded window:

1. Negotiate a default-false server capability. Existing servers retain the
   current serialized input path; failure on a capable server is never retried
   through the legacy path.
2. Acquire a server-issued input lease after terminal attachment. Bind it to
   the authenticated RPC connection, thread, terminal, and process generation.
3. Send monotonically sequenced frames over typed RPC without waiting for the
   preceding reply. The shared client runtime owns one scheduler across all
   callers for the same terminal, including paste and control sequences.
4. Enforce a connection-wide ceiling of 16 outstanding input requests and
   256 KiB of input payload, with individual frames capped at 16 KiB of UTF-8.
   Admission must also respect existing RPC capacity and preserve capacity for
   control traffic; it must not increase the server's 64-request limit. Queued
   client input has a 1 MiB cap; overflow fails the input batch visibly.
5. The Rust terminal owner writes each lease's frames in sequence, serializing
   physical PTY writes with existing terminal operations. Bound reorder storage
   by the same count/byte limits and a five-second missing-sequence deadline.
   A gap timeout, invalid sequence, overflow, or write failure seals the lease
   and drops dependent frames. Do not acknowledge success before the PTY write
   completes, and never write duplicate frames twice.
6. Disconnect, workspace loss, terminal close, and process-generation changes
   invalidate the lease and queued frames. An already executing PTY write may
   have completed; treat lost acknowledgements as uncertain and never replay.
   The client drops pending input, ignores old results, and requires a fresh
   attachment before accepting input again after failure.

Contracts remain schema-only. `apps/server` owns admission and ordered physical
writes; `packages/client-runtime` owns scheduling and backpressure; `apps/web`
binds the scheduler to the existing terminal UI. Authentication uses the same
terminal-operation scope. No new desktop bridge command, sidecar, socket
protocol, persistent input queue, or production Node dependency is required.

Acceptance must cover ordered delivery from multiple UI callers; Unicode paste
boundaries; partial/failed writes; duplicate or missing sequences; reconnect and
restart; old-server compatibility; bounded memory and RPC admission under load;
and control traffic while input is saturated. A deterministic 120 ms RTT,
30 ms character-interval test should show each frame admitted before the prior
reply while capacity remains. A real native terminal echo measurement must
separate network time from client queue and paint time before claiming a live
typing improvement.

This proposal changes the public input protocol and its lifecycle guarantees.
`AGENTS.md` requires approval of its alternatives and trade-offs before
implementation. It is not implemented in this patch.

## Validation of the implemented usage fix

Commands run from the repository root:

```sh
vp test run apps/web/src/components/status-bar/AppStatusBar.rerender.test.tsx -t 'selected server'
vp test run apps/web/src/components/status-bar
vp test run apps/web/src/components/status-bar apps/web/src/state/entities.test.ts apps/web/src/state/environments.test.ts apps/web/src/components/sidebar/EnvironmentRail.test.tsx packages/client-runtime/src/state/terminalInput.test.ts apps/web/src/components/ThreadTerminalPanel.interactions.test.tsx
vp check
vp run typecheck
vp run --filter @bibcode/web build
git diff --check
```

The first command initially failed on the exact 10%/70% mismatch. After the fix,
the status-bar suite passed 99 tests. Adding the loading/offline cases and
running the broader command passed 264 tests across 16 files. Formatting/lint,
workspace typechecking, the production web build, and whitespace review passed.
Formatting checks identified the new test and this report; formatting those
files and rerunning the gate succeeded. Vitest emitted Node's existing
localStorage availability warning; typechecking emitted an unrelated Effect
suggestion in `ActivityPanel.tsx`, with exit status zero.

The changed hook was reviewed against `UI.md`: usage follows the selected
server, local data is not substituted, and switching retains account isolation.
The required `vercel-react-best-practices` skill review was **not run** because
the skill was unavailable in the configured skill directories/plugin cache.
No Rust behavior changed, so dedicated Rust tests, rustfmt, and Clippy were not
required; workspace typechecking included the repository's Cargo checks.

The shared native visual-validation runbook now includes distinct local/remote
usage and switching while refresh is pending. Native host runbooks were reviewed
for the affected flow and remain accurate through that shared procedure.
Packaged validation of the patched app was not run: the installed application
continues using its existing build. Unrelated staged planning documents and
the existing untracked `outputs/` directory were preserved.
