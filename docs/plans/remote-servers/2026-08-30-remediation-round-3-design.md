# Remote Servers — Third Adversarial Remediation: Design

Status: approved (user instruction 2026-08-30: "fix all findings" over
`docs/plans/remote-servers/2026-08-30-remediation-round-2-adversarial-review.md`).
Scope: every open finding from that review — 4 High, 31 Medium, 16 Low — plus the
validation-process gaps it documents. Items the review classifies as PRE-EXISTING
(outside the feature range) are out of scope and listed at the end.

This document records the alternatives and trade-offs for the decisions that are
architectural; mechanical fixes are listed in the execution order without
elaboration. Where a decision supersedes a written rejection in
`2026-08-29-remediation-round-2-design.md`, that supersession is explicit.

## D1. Outbound admission: one waiter machinery, push-granting, capped aging (H-N1, P2, M-S3, L13)

Context. `RpcOutboundBudget::acquire` parks every waiter in a loop that re-runs
`grant_combined_waiters` on every `Notify` wake — O(W) scans by each of W waiters
per release (P2). A second, `#[cfg(test)]`-only single-tier waiter machinery
shares the same `available` counters, and its hand-rolled refund skips the wakeup
the canonical path performs (M-S3). `b890a372` deleted the aging reservation
entirely, so grants are pure fit-first: under sustained small-message pressure a
large stream chunk loses every race, its 5 s admission deadline expires, and
`run_stream` returns with no terminal — the subscription silently dies (H-N1).
`run_latest_stream` delivers cancel interrupts via `try_send`, which refuses
whenever any waiter is queued, silently dropping the interrupt (L13).

Decision.

1. **Push-granting.** Waiters enqueue once and await their own oneshot with the
   caller's absolute deadline. Granting runs only from release paths (permit
   drop/shrink, waiter cancellation), one scan per release. The `Notify`-driven
   re-scan loop is deleted. All production releases of either outbound tier flow
   through `RpcOutboundBytePermit`, so hooking the combined grant into its
   drop/shrink covers every release.
2. **One machinery.** The `#[cfg(test)]` single-tier entry points on
   `RpcOutboundProcessBudget` are removed and their tests rewritten against the
   combined path; the process-tier `WeightedByteBudget` then never holds waiters
   of its own (debug-asserted). `WeightedByteBudget` remains the standalone
   primitive for the inbound pools, which already use direct oneshot handoff.
3. **Capped aging.** When the queue head has waited ≥ `OUTBOUND_PROCESS_AGING_THRESHOLD`
   (1 s) and currently fits its connection tier, each grant pass first routes
   available process-tier capacity into a reservation for that head (up to its
   need); younger waiters are granted only from the surplus. The head is granted
   the moment its reservation is complete. This guarantees eventual progress for
   large waiters (every release feeds the head first) without the M23 blockade
   (younger waiters keep flowing on surplus, and the pause is bounded by the
   volume of in-flight releases, not by the head's own deadline). Only the front
   waiter ages — one reservation at a time.
4. **Terminal on admission expiry.** `run_stream`'s chunk-send failure emits a
   request-scoped `failure` terminal through a small unbudgeted control lane
   (byte-budget-exempt, still bounded by the outbound mpsc and a short deadline)
   before returning; cancel interrupts use the same lane instead of `try_send`.
   Unbudgeted traffic is bounded by the in-flight request cap (64) times a
   ~200-byte control message, and each stream emits at most one.

Alternatives rejected: keeping the Notify loop with memoized scans (still O(W²)
worst case, and it leaves two machineries); deleting aging permanently with a
documented starvation caveat (silent stream death is the worst failure mode this
feature can have on its primary links); reserving a dedicated byte quota for
terminals (more accounting for the same bound the mpsc already provides).

Trade-off. A malicious head can hold its reservation for its own admission
deadline; that is bounded, was previously the M23 blockade case, and after the
grant the size-derived write deadline (H1 fix, kept) governs.

## D2. Inbound assembly: absolute per-message deadline (H-N3, NEW-7)

Context. `100a19b3` made inbound byte admission wait instead of disconnect
(H2 fix — kept), but reuses the resetting 10 s progress deadline as the admission
deadline (a record arriving at t=9.8 s gets 0.2 s of budget wait), and charges the
first record of every message with `deadline=None` — an unbounded wait. Two
principals dribbling 64 MiB each park the whole 128 MiB global pool and every
other connection's inbound pump indefinitely.

Decision. Each logical message gets one **absolute, size-derived assembly
deadline**, established at its first record:
`message_start + SOCKET_WRITE_TIMEOUT + bytes_received / E2EE_LOGICAL_WRITE_BYTES_PER_SECOND`,
recomputed as records arrive (the same 64 KiB/s floor the outbound writer uses,
so a compliant slow sender is never cut off). Byte admission for every record —
including the first — uses this absolute deadline; the socket-read wait uses
`min(progress deadline, absolute deadline)`. The 10 s progress timeout continues
to cut idle senders early. Occupancy of the global pool by any one message is
therefore bounded, so a compliant peer's admission wait is bounded by its own
message budget rather than by other principals' behaviour. The inverted test
(`inbound_global_pressure_waits_past_five_seconds_and_resumes`) is rewritten to
assert both properties: waits under transient pressure (H2) and fails at the
absolute deadline (H-N3). Teardown joins that can pin assembly permits are
bounded (NEW-7).

Alternative rejected: a flat absolute timeout (either too short for legitimate
64 MiB messages on slow links or so long it does not bound occupancy).

## D3. Pre-auth admission: reserve for fresh networks; forwarder keying (M-N1/H5, M-N3)

Context. 16 (per-network) + 16 = 32 (global): two /64s drain the pool; the
round-2 design rejected reserved headroom in writing and two tests pin the
exhaustion. Separately, every loopback source shares one `LoopbackForwarder`
bucket with burst 8 / refill 1 per second — behind a documented reverse-proxy
topology, one abusive client rate-limits the whole deployment.

Decision — supersedes the round-2 design's rejection (approved by the user's
fix-all instruction).

1. **Fresh-network reserve.** An admission whose peer/network bucket is already
   active proceeds only while global usage (including this connection) stays
   ≤ `E2EE_PREAUTH_GLOBAL_SOFT_CAP` (24); a bucket's **first** connection may use
   the full global cap (32). The review's literal rule ("admit a new network only
   while global < 24") is deliberately inverted: under the literal rule two
   networks still reach 16 + 16 = 32; under this rule established networks stop
   at 24 in aggregate and 8 slots remain that only fresh buckets can take, so a
   new legitimate device always finds room against a two-network attacker.
   Residual (documented): an attacker holding many distinct /64s can still take
   the reserve with first-connections — exhaustion now needs ~10 networks rather
   than 2; per-address caps cannot beat a /48 owner without an authentication or
   proof-of-work cost, which is out of scope.
2. **Forwarder keying.** For loopback sources carrying `X-Forwarded-For`, the
   admission key becomes the **last** entry of that header (the hop appended by
   the local, implicitly trusted reverse proxy) parsed as an IP and classified
   normally — per-client caps and rate apply behind a proxy. Remote peers can
   never reach this branch (they are not loopback), and the keyed entries live in
   the existing capped + TTL-pruned maps, so fabricated header values from local
   processes cannot grow state unboundedly. Unparseable values fall into the
   strict `Unspecified` bucket. Loopback without the header remains the exempt
   forwarder class, with its token bucket resized (burst 32, refill 8/s) to fleet
   reconnect-storm scale.

## D4. Pairing confirmation is server-authoritative (H-N2 spec half, NEW-9, M10 test)

Context. The durable-delivery guard runs only when the client sends
`pairingConfirmation: true` — an untrusted wire flag whose omission reverts to
the orphan-session-keeps-host-wide behaviour the guard exists to close.

Decision. The server decides from the grant it consumes: a bootstrap exchange
whose grant is `off_host` mints `PendingPairing` (guard, sweep, confirm
required); on-host grants mint `Active`. The client request flag is removed from
the protocol (the server ignores unknown fields, so old clients are unaffected on
the wire); the reply's `pairingConfirmationRequired` remains the client's only
signal, so clients key confirmation off the reply — which also keeps new clients
working against pre-migration servers (no flag sent, no confirmation demanded,
`auth.confirmPairing` never called). An old client pairing an off-host grant
against a new server never confirms, so its session is swept — security over
compatibility, and that client cannot use the remote feature anyway.
Consequences handled in the same change: the startup pending-session sweep is
**age-gated** (only sessions older than the pairing-confirmation window are
revoked) so a desktop-triggered backend restart cannot revoke an in-flight
pairing (NEW-9), and a deterministic authenticate-time test replaces the raced
socket-close test as the guard's primary evidence (M10).

## D5. Pairing commit: cancellable, honest about failure (H-N2 client half)

`pairingAdd.ts` keeps exactly the persist + confirm steps inside
`Effect.uninterruptibleMask`; the bearer re-verification and `registry.retryNow`
move out of the mask, and `verifyPairingBearer` gets an explicit overall timeout.
Failure surfaces split: a failed/interrupted **confirm** is a pairing failure
(rollback — the server will revoke the pending session; reporting success there
is the success-on-revoked bug); a failed **bearer re-verification** after a
successful confirm + persist surfaces as a degraded-connection warning without
rolling back a session that is live server-side. The third concurrent socket
(C-F2) is removed: post-commit verification observes the registry's connection
state instead of opening its own handshake.

## D6. Exposure convergence: deadlines restored, reconciliation on failed cleanup (H-N4, M-N4, NEW-5, NEW-8)

The three `applyExposure` bridge calls regain `withShareExposureBridgeTimeout`
(surgical restore of the `44d6c548` hunk — not a revert of `e7ab93ba`, which
also carries changes that stay). The share-offer cleanup gate returns to firing
on `widened` alone, and — per the round-2 design's own prescribed remedy — a
failed cleanup (or failed cancel) triggers authoritative share-state
reconciliation instead of leaving the host wide until restart. The reconciler
gets one bounded retry pass on failure and surfaces apply failures to the
share status surface instead of `console.warn` (NEW-5); `set_wsl_only` firewall
failures propagate to the caller instead of being swallowed by `tauriInvokeOr`
(NEW-8). The four tests pinning cleanup-absence and the three pinning
deadline-absence are rewritten to assert the restored contracts.

## D7. Single-encode outbound responses (M24, P4)

`send_server_message` (and the guarded-unary reserve path) serialize once:
encode, drop the `Value` tree, then acquire budget for the encoded length. This
removes the second traversal (M24) and makes the memory resident during the
admission wait exactly the bytes that will be charged, instead of an uncharged
`Value` tree plus a second copy at encode time (P4). `remote.md`'s "encodes
once" sentence becomes true instead of being rewritten.

## D8. WebSocket tickets: transport-checked and single-use (L10, L11)

`verify_websocket_ticket` gains an explicit session-transport check (defense in
depth for the no-downgrade invariant, which currently rests on a comment
about an upstream rejection) and tickets become single-use: a `jti` claim
recorded in a TTL-bounded in-memory redeemed set; a replayed ticket within its
5-minute window is refused. The client mints a fresh ticket per connection
attempt, so single-use costs nothing on reconnect (verified before landing).
Residual: a process restart forgets the redeemed set for at most one TTL window.

## D9. Module extraction (M-S2) and constant parity (P5, M3 residual)

The `WeightedByteBudget`/combined-admission machinery moves to
`apps/server/src/rpc/byte_budget.rs` as a pure move before any behavioural
change. The five E2EE framing constants and the two throughput constants move
into a shared JSON fixture (`packages/shared/fixtures/e2ee-transport-constants.json`)
`include_str!`-asserted from Rust and imported by the TS frame layer's tests, the
same pattern the advertised-endpoint fixture uses; the TS half of that existing
fixture additionally asserts the full classification vocabulary so reverting the
Rust fail-closed behaviour breaks a TS test too.

## Execution order

1. `docs(plans)`: land the two staged deletions (M5). — done before this doc
2. this design document
3. `refactor(server)`: extract `byte_budget.rs` (M-S2), pure move
4. `fix(server)`: D1 — property tests first (aged head wins; small waiters flow;
   terminal on expiry; refund on drop; H6 single critical section preserved)
5. `fix(server)`: D2 (H-N3, NEW-7)
6. `fix(server)`: D3 (M-N1, M-N3) + rewrite the two pinning tests
7. `fix(server)`: D4 (server-authoritative confirmation, age-gated sweep,
   deterministic authenticate-time test, interop baseline gate)
8. `fix(server)`: D7 single-encode
9. `fix(server)`: hygiene — R2 delivery-state literals single-sourced; R3 reach
   literal via `PAIRING_REACH_VALUES`; R4 confirmPairing scope policy made
   consistent (one declared policy, both tests agree); M-S4 remove
   production-dead `mark_connected`; L12 residual drop-guard on the plain path;
   L8 idempotency liveness on replay; D8 tickets; L9 strip `code` from `/pair`
   URLs + Referrer-Policy on the pairing surface
10. `test(server)`: M27 route-cap assertions (mutation-detectable), close-code
    assertions on the six discarded sites, realistic-chunk + real-cap rewrites of
    the two weak budget tests, larger H1 reproduction size
11. `fix(desktop)`: R6 exposure-mode writes through the owning helper; R5 label
    enum; NEW-6 firewall spawn inside the timeout + cross-platform runner
    compilation; M13 residual (no hard-coded `available` for unbindable
    endpoints); M12 residual (public default-route labelling); WSL
    `is_verified_local` hardening; S3 dead `is_private_network`
12. `fix(client-runtime)`: D5 + NEW-3 (`retryNow` records intent) + M26
    (`binaryType` defense + test-double default) + C-F4 ordering
13. `fix(web)`: D6
14. `fix(web)`: IndexedDB recovery honesty — M14(c) blocked-open resumes
    (versionchange handler + bounded open), T-4 generation-scoped health mute,
    N8 dialog copy derived from the active catalog backend, C-F6
15. `fix(web+shared)`: M-S1 one pairing-URL owner; discarded side-effect guard
    made explicit; POST_BOOTSTRAP alias; duplicate timeout helpers unified
16. `test(remote)`: D9 parity fixtures
17. `chore`: the four unused eslint-disable comments
18. `docs(remote)`: spec dated markers (M-S5, M-S6, S9), execution-prompt note,
    migration-49 persisted shape into the three architecture docs (M-S7/D1),
    plan checkbox accuracy (S6), H-B disclosure (L6), dated corrections in the
    two earlier review documents
19. `docs(testing)`: runbook updates (fresh-lint prescription; admission and
    cancellation sections re-verified)
20. commit the three adversarial review documents
21. validation battery + `docs(testing)` report (fresh clippy, correct flake
    attribution to `dff24b3e`, third-flake disclosure, interop scope statement)

## Out of scope (pre-existing, disclosed)

Plain `/ws` DOM decode and missing outbound byte budget; principal-unpartitioned
outbound budget; `auth_sessions` unbounded growth; `provider_opencode.rs` timing
tests; the seven unreachable browser-runtime tests; the prose-only
`remote-architecture-contract.test.ts` shape; the SQLite checkpoint/startup and
offer-retry flakes themselves (attribution and disclosure are corrected; the
flakes predate the range); the absolute-date activity fixture class. Commit
subjects already pushed (grab-bag `fix` subjects, report ordering) cannot be
rewritten; they are disclosed here instead.
