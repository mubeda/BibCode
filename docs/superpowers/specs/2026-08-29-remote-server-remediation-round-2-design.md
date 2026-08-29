# Remote Server Remediation Round 2 Design

Status: **Approved** by the user on 2026-08-29 after adjudication of
`docs/plans/remote-servers/2026-08-29-remediation-adversarial-review.md`.

## Purpose

The first remediation closed the original exposure leak, rollback, transport
allocation, endpoint discovery, and repository-gate findings. The follow-up
adversarial review found additional failure paths in the resulting transport,
pairing, exposure, persistence, and presentation behavior.

This design fixes the accepted findings as one coherent hardening pass. It does
not redesign the RPC protocol, add a production sidecar, or weaken the existing
Noise NK, no-downgrade, scope, and desktop-bridge boundaries.

The living architecture documents remain the source of truth for current
behavior. The original remote-server specification is historical evidence; it
gets a prominent supersession pointer instead of retroactive prose rewrites.

## Goals

1. Honest E2EE clients on ordinary WAN and mobile links can transfer every
   protocol-valid message without a flat five-second logical-message deadline.
2. Byte-pressure admission backpressures innocent authenticated connections
   instead of classifying shared-capacity pressure as a protocol violation.
3. Small outbound frames are not trapped behind large queued reservations at
   either the process or connection tier.
4. Pre-auth admission groups IPv6 peers by `/64`, protects IPv4 subnets from a
   single-host fan-out, and treats trusted loopback forwarders as a distinct
   deployment boundary.
5. A pairing credential becomes durable authority only after the client has
   verified the server and persisted the local connection successfully.
6. Every host shown in a pairing confirmation is the normalized host that will
   actually receive the connection.
7. Endpoint presentation never advertises an address family the listener does
   not serve, and never labels or preselects a public address as local.
8. Exposure/firewall transitions converge fail-closed across UI unmounts, WSL
   topology changes, command timeouts, and ambiguous pairing cancellation.
9. IndexedDB recovery never reports a queued deletion as cancelled, never makes
   destruction the only exit, and cannot be confirmed by the second click of a
   double-click.
10. Explicit connection intent and operation deadlines survive supervisor
    recreation and include acquisition work.

## Non-goals

- Interleaving records from different logical RPC messages. The record format
  has no stream identifier and continues to preserve one logical message at a
  time.
- Replacing Noise NK or changing pairing-code version 1.
- Adding trusted proxy headers. Kernel peer addresses remain the only network
  identity accepted by the server.
- Adding an IPv6 listener in this pass. IPv6 advertisement is suppressed until
  a separately designed dual-stack listener exists.
- Making distributed denial of service impossible. The admission changes
  increase attacker cost and preserve bounded work; a sufficiently distributed
  source set can still consume any finite public listener.
- Committing the two pre-existing staged environment-project document
  deletions. They remain user-owned until separately authorized.

## Ownership and trust boundaries

`apps/server` owns Noise transport state, authentication sessions, pairing
delivery state, admission budgets, WebSocket limits, and RPC authorization.

`apps/desktop` owns actual backend topology, durable exposure settings,
firewall state, WSL/native transitions, and serialization of privileged
effects. Every privileged transition continues to cross `DesktopBridge`.

`packages/client-runtime` owns saved-connection normalization, pairing
verification/persistence, supervisor intent, and whole-operation RPC deadlines.

`packages/shared` owns URL and endpoint classification rules used by browser
clients. `packages/contracts` remains schema-only and carries only additive,
typed RPC/schema declarations.

`apps/web` owns confirmation and recovery presentation. It never substitutes
raw user-controlled text for the normalized target and never claims a native
cleanup succeeded before the bridge reports it.

## 1. Weighted byte admission and E2EE progress

### Reusable fit-first allocator

The process and per-connection outbound tiers use the same internal weighted
allocator implementation. A waiter records its requested byte count, absolute
deadline, cancellation state, and one-shot grant channel. On each release the
allocator scans in arrival order and grants every request that fits current
capacity. It does not switch into the previous aged-head total-blockade mode.

This policy deliberately prefers useful small frames under pressure. A large
request that never fits reaches the same fixed five-second admission deadline
and fails predictably; it cannot stop unrelated small traffic for most of that
deadline. Cancellation removes the waiter and refunds any grant exactly once.
The waiter list remains explicitly bounded by the existing session/task bounds,
and tests cover cancellation, deadline, fit-first progress, and refund races.

`RpcOutboundBudget::acquire` applies one absolute deadline to both tiers. It
acquires the connection allocation through the fit-first allocator and then the
process allocation with the remaining time. Failure of the second tier drops
the first grant immediately. No semaphore wait is allowed outside the deadline.

### Outbound encrypted writes

Each successfully written Noise record counts as progress. A record that cannot
be accepted by the WebSocket sink within the existing five-second write timeout
fails the session, preserving slow-reader protection.

The logical message additionally receives a size-derived absolute deadline:
five seconds of base allowance plus one second per 64 KiB of plaintext. This
allows a maximum-size message roughly seventeen minutes while keeping every
smaller message proportionally bounded. Tests use paused time and a controlled
sink; they prove both that progress across multiple records is accepted and that
a stalled record or exhausted aggregate deadline closes the session.

### Inbound encrypted reassembly

The global and per-principal plaintext budgets use a cancellable fit-first
allocator rather than Tokio's fair weighted semaphore. Capacity pressure waits;
it is not mapped to `Protocol` and does not by itself close the connection.

The per-connection logical-message maximum remains a protocol limit enforced by
the record assembler. Because records from different logical messages cannot
interleave on one connection, exceeding 64 MiB or 2,048 records is an offender
error, while another connection holding a principal/global permit is shared
pressure and therefore backpressure.

Once a continuation record starts an incomplete logical message, the next
accepted record must arrive within ten seconds. The timer resets only after a
record is decrypted, validated, and charged to all budgets. Idle authenticated
connections between logical messages have no assembly timer. Empty
continuations remain invalid, and the record-count cap bounds tiny-progress
attempts. Closing, revocation, cancellation, timeout, and decode failure release
all held permits through ownership guards.

Inbound permits cover buffered ciphertext/plaintext through decode,
authorization, and dispatch. They are released before a long-running spawned
request completes; living documentation will state that boundary exactly.

## 2. Pre-auth admission

Admission retains the global 32-connection cap, exact-peer cap of four, burst
limit, refill, ten-second combined handshake/auth deadline, and RAII release.

Peer accounting adds a second network key:

- IPv6 addresses are canonicalized to their `/64` prefix.
- IPv4 addresses are canonicalized to their `/24` prefix.
- Loopback addresses use a trusted-local-forwarder class rather than the exact
  loopback address and are exempt from the public exact-peer/subnet caps while
  remaining subject to the global cap. This avoids penalizing multiple devices
  behind an explicitly local SSH/reverse-proxy boundary.
- Missing `ConnectInfo` uses one strict unspecified bucket and never receives
  the loopback treatment.

For non-loopback peers, exact-peer limits still apply inside a network bucket.
Network buckets are TTL-pruned and hard-capped like peer entries. A subnet may
consume at most half the global pool, so addresses from one IPv4 `/24` or IPv6
`/64` cannot exhaust all pre-auth capacity. Tests distinguish exact peer,
subnet, loopback forwarder, unspecified peer, pruning, and global exhaustion
behavior.

The global cap remains an honest residual limit: sufficiently many unrelated
networks can fill it. The architecture and operator guidance state this rather
than claiming reserved headroom can identify a legitimate unauthenticated peer.

## 3. Durable pairing delivery

### Session state

The auth-session persistence model gains an additive delivery state:
`pending-pairing` or `active`. Existing rows decode/migrate as `active`.
Normal session creation remains active; only a session minted by the in-channel
pairing form starts pending.

A pending session is authenticated and may perform the bootstrap
`server.getConfig` verification. It remains visible to share-state derivation so
consuming an off-host link does not transiently remove the access reason while
the client saves its replacement session.

### Confirmation RPC

Contracts add `auth.confirmPairing`, an empty-input, empty-success RPC under the
closest existing `access:write` scope. Rust parity, fixture export, RPC wire,
route inventory, and exactly-one-scope checks change together.

The handler derives the session ID from `RpcSessionContext`; callers cannot
confirm another session. It atomically changes only that session from
`pending-pairing` to `active`. Repeated confirmation of an already-active
session is idempotent for the same authenticated session.

### Client sequence

The bootstrap session remains scoped through the complete add operation:

1. consume the one-time link and receive the encrypted pending credential;
2. verify authenticated environment and storage identities;
3. persist the connection registration and accepted storage identity;
4. call `auth.confirmPairing` over that same E2EE session; and
5. return success only after confirmation succeeds.

If registration, identity persistence, or confirmation fails, local persistence
is rolled back best-effort before the bootstrap scope closes. Closing an
unconfirmed bootstrap connection revokes the pending server session through the
existing delivery guard. Error copy reports the actual cleanup outcome and no
longer instructs the operator to perform a revocation the protocol can do.

### Crash and restart

The server disarms its delivery guard only after the confirmation transaction
commits. On process startup, all `pending-pairing` sessions are revoked before
share-state is served. A client cannot have observed a successful confirmation
response unless the active-state transaction committed, so this sweep cannot
revoke an acknowledged session. Normal expiry/pruning also removes abandoned
pending sessions.

## 4. Pairing target and catalog normalization

`normalizeRemoteBaseUrl` rejects any non-empty URL username or password.
Hosted-pairing parsing normalizes the target once, before rendering or network
access, and stores the normalized base URL in the request model. The
confirmation renders `URL.host` from that normalized value, including punycode
and explicit port. Submission consumes the same normalized value; no second raw
parse may select a different destination.

Pairing URLs continue to keep credentials in the fragment. Both `/pair` and the
settings route remove legacy query `code` parameters immediately after reading
them so browser history and copied URLs do not retain the credential.

Saved bearer profiles normalize a null, empty, or whitespace-only `hostKey` to
`null` at the persistence/catalog boundary. Authorization and presentation then
consume the normalized field: only a non-empty key selects `/ws-e2ee`; legacy
null profiles use `/ws` and show the unencrypted guidance.

The Connect-tab test preserves the real client-runtime transport policy through
a partial mock. Tests may stub stateful dependencies but may not reimplement the
classification switch.

## 5. Endpoint discovery and presentation

Desktop endpoint discovery owns one Rust address-classification function that
returns advertised reachability, safe label kind, and default eligibility.
Default-route ranking calls the same `is_usable_unicast` predicate as interface
enumeration, so unspecified, loopback, multicast, and link-local results fail
closed.

The shared endpoint fixture records both pairing classification and advertised
reachability for loopback, link-local, RFC1918, CGNAT/Tailscale, and public
examples. Rust and TypeScript tests consume literal expected values from that
fixture; the two public vocabularies remain distinct where their user-facing
purposes differ, but their address predicates cannot drift silently.

Until the desktop listener is dual-stack, discovery suppresses all IPv6
candidates. Every emitted endpoint is therefore reachable through the current
IPv4 wildcard listener.

Public addresses use explicit warning copy such as `Public address` and are
never `isDefault`. If no private/CGNAT candidate exists, the Share surface starts
without a selected endpoint and requires an explicit public-address selection
after presenting the firewall/exposure warning. Linux and macOS continue to
state that BiBCode does not manage the platform firewall.

## 6. Desktop exposure and firewall convergence

### Shared local recovery

Narrowing and failure recovery call one internal local-recovery routine. The
routine attempts every step even when an earlier step fails: persist local-only,
restart/recover the native backend locally, close the firewall rule, and verify
actual topology. It combines errors without allowing a failed settings write to
skip later safeguards.

Every exposure, Tailscale, native/WSL, and related settings operation that can
restart topology remains serialized by the desktop exposure coordinator.

### WSL transitions

Entering WSL-only first establishes and persists local-only native exposure and
closes the Windows firewall rule, then switches topology. It never preserves a
stale network-accessible setting after the native backend is stopped. Leaving
WSL-only starts local-only and lets authoritative share-state reconciliation
decide whether a new widen is justified.

### Renderer reconciliation

Component mount state gates whether a new reconciliation starts, but never
gates compensation after a native narrow has committed. After narrowing, the
client re-fetches authoritative share state and performs one compensating widen
when a live off-host reason appeared concurrently, even if the initiating view
unmounted. Bridge calls receive explicit deadlines and actual-state error copy.

Ambiguous offer cancellation uses bounded retries of the principal-scoped
idempotency cancellation. After retries, the client performs authoritative
share-state reconciliation. It narrows only when the server proves no live
reason; otherwise it leaves exposure wide. A pending retry/tombstone and the
five-minute offer expiry provide later convergence, while fresh desktop startup
still begins local-only.

### Windows command timeout

Firewall command execution is serialized by a firewall worker. The caller has a
bounded deadline that includes process spawn. If a spawn or command outlives the
deadline, the worker retains ownership and queues a verified delete operation
after the late job. The exposure coordinator can report failure and persist
local-only without abandoning a child that may apply a rule later. Subsequent
firewall operations serialize behind the cleanup, so a late add can never be
the worker's final state.

Tests use an injected worker/runner to cover stalled spawn, late add, queued
delete, unsuccessful delete verification, and normal idempotent enable/disable.
Windows-native packaged validation remains required because Linux cannot compile
or execute the real platform command path.

## 7. Client persistence and connection lifecycle

### IndexedDB recovery

`deleteDatabase`'s `blocked` event publishes a blocked-but-pending health state;
it does not settle the reset promise. The same request remains owned until
`success` or `error`. The modal tells the user to close other tabs/windows and
keeps the operation visibly pending. A later success resets health and reloads
through the existing injected reload boundary.

Every incompatible-database view offers a non-destructive Reload/use-the-newer-
client exit. Destructive reset requires an explicit checkbox followed by a
separate enabled confirmation button; swapping one button for another on the
first click is removed, so a double-click cannot confirm deletion.

### Supervisor intent

`EnvironmentRegistry` owns desired connection state outside disposable service
scopes. Explicit Connect sets it true; explicit Disconnect sets it false;
removal clears it. Catalog drift recreates the scope with the stored intent and
cannot silently reconnect a disconnected environment.

Passive `state` reads never change desired intent. Registry initialization and
new registration are the explicit places that establish the default auto-
connect intent for saved environments. Commands that intentionally require a
connection may connect according to their command policy, but a passive status
query cannot do so accidentally.

### Whole-operation deadlines

Remote update checks apply one deadline outside environment supervisor
acquisition and RPC execution. Lock wait, uninterruptible scope creation, socket
readiness, and the RPC call all consume the same budget. Timeout releases the
two-at-a-time fan-out slot and produces the existing per-environment error
snapshot without changing another environment's result.

## 8. WebSocket limits and connection accounting

Plain `/ws` keeps a 64 MiB logical-message cap but restores tungstenite's 16 MiB
frame cap. `/ws-e2ee` keeps the 65,535-byte ciphertext frame/message cap. Route-
level integration tests send frames beyond each configured limit and assert a
bounded close/terminal result; protocol-level E2EE oversize tests remain
separate so deleting the upgrade cap makes a route test fail.

Both plain and E2EE authenticated routes use an RAII live-connection guard.
Once `mark_connected` succeeds, every exit path, panic unwind, cancellation,
upgrade/session failure, and normal close releases the exact connection token.

The production E2EE WebSocket constructor continues to set
`binaryType = "arraybuffer"` before Effect adapts it. The focused production-
path test remains the contract; no duplicate binary policy is added inside the
generic encrypted `Socket` wrapper.

## 9. Documentation, tests, and commit boundaries

Each behavior change follows red-green-refactor and lands with its closest
behavioral tests. Tests assert outcomes rather than source substrings or mock
implementations. Contract/Rust parity and fixtures change in the same commit as
public surfaces.

The historical remote-server spec receives only a dated supersession pointer to
this design and `docs/architecture/remote.md`. Living architecture and affected
Linux, macOS, Windows, cross-platform, and connection-runtime runbooks are
updated with exact current behavior and commands.

Implementation commits use subjects matching their contents. A final evidence
commit may contain documentation and execution reports only; executable test or
source changes land before the full validation run so the report's tested SHA is
the actual executable HEAD.

Validation requires focused tests for every failure seam, `vp check` with any
protected untracked document exclusion disclosed, `vp run typecheck`, the full
TypeScript suite, `cargo fmt --all --check`, server and desktop tests, forced
Clippy with warnings denied for both affected Rust packages, direct TS/Rust E2EE
interop, and the cross-container remote-server smoke. Windows/macOS packaged
firewall and UI validation remain explicitly unavailable unless executed on
those platforms.

## Alternatives rejected

### Isolated minimal patches

Changing only the flat E2EE deadline, raw hosted host, and default-route filter
would be faster, but it would leave shared-pressure disconnects, pending-session
crash authority, per-connection FIFO blocking, WSL firewall drift, and IndexedDB
deletion ambiguity. Those are failures of the same safety guarantees and are in
scope for the requested full remediation.

### Multiplexed encrypted records

Adding logical-message IDs and interleaving records could improve large-message
latency, but it changes the wire protocol, both crypto implementations, and
compatibility negotiation. Fit-first admission and bounded progress address the
reported failures without that protocol redesign.

### Trusted proxy headers

Using `X-Forwarded-For` would improve per-client accounting behind a proxy but
creates a new spoofing boundary and deployment configuration. The local-
forwarder bucket solves the supported tunnel/proxy case without trusting
network-supplied identity.
