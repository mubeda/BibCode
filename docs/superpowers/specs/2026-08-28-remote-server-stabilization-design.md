# Remote Server Stabilization Design

**Status:** Approved in chat on 2026-08-28.

## Outcome

The remote-server feature keeps its existing protocol and product shape while
closing the reviewed exposure-safety holes, bounding transport work, restoring
repository-gate coverage, and moving duplicated policy to its owning packages.

The central invariant is that a desktop-hosted server is network-accessible
only while there is a live remote-access reason or a bounded share ceremony is
actively creating one. A failed or revoked ceremony converges to local-only
without relying on a renderer revision event, and a failure to persist or
restart one layer cannot silently make the next launch wide.

## Scope

This stabilization covers:

- share-state derivation for browser and bearer sessions;
- share-ceremony compensation and exposure-transition serialization;
- durable settings, backend restart, and firewall partial failures;
- concurrent grant creation and revocation during a narrowing transition;
- WebSocket, E2EE record, reassembly, allocation, and updater-call bounds;
- honest pairing failure semantics and actionable retry UX;
- ownership of pairing URLs and desktop-local connection identity;
- confirmed contract, classifier, dead-export, and repository-gate drift; and
- living documentation, focused regression coverage, and Docker validation.

This work does not redesign the relay, replace the Noise NK protocol, create a
production Node runtime or sidecar, or rewrite the 85-commit implementation
history. The relay executable-handle fix in `81eff018` is retained and
explicitly disclosed in the remediation report instead of being hidden by a
history rewrite.

## Approved Final-Review Amendments

The user approved the critical final-review corrections in the same session.
They refine the fail-closed model in three places:

- every fresh desktop process starts the actual backend local-only, and the
  authenticated renderer re-widens only from authoritative live share state;
- Tailscale and WSL settings restarts share the exposure coordinator and
  preserve actual runtime exposure rather than replaying a stale setting; and
- an ambiguous failed mint cancels its principal-scoped idempotency key before
  exposure cleanup; the server revokes a committed grant or stores a tombstone
  that blocks a delayed create.

These amendments do not change the public pairing-code or Noise protocol. They
close crash, restart, and response-loss paths that the original remediation
design did not fully specify.

## Ownership and Sources of Truth

`apps/server` owns authentication grants and sessions. Its share-state result
is the authority for whether a live off-host access reason exists.

`apps/desktop` owns the durable exposure setting, the actual
in-process backend topology, native firewall state, and serialization of
exposure transitions. Fresh processes always start local-only; the persisted
setting is not treated as startup permission or proof that a restart or
firewall operation succeeded.

`apps/web` owns the share ceremony and presentation. It can request a native
transition through `DesktopBridge`, but it cannot mutate settings, restart the
backend, or manage the firewall directly.

`packages/shared` owns pairing-code parsing and URL construction used by more
than one application. `packages/client-runtime` owns the desktop-local
connection identifier convention because it owns connection presentation and
classification. `packages/contracts` remains schema-only.

## Live Remote-Access Reasons

The server reports network-accessible as desired when either of these is true:

1. an unrevoked, unexpired, off-host pairing link remains active; or
2. an active, unrevoked session has `off_host = true`.

The session predicate does not filter by access method. In particular,
`browser-session-cookie`, `bearer-access-token`, and `dpop-access-token`
sessions all preserve the reason established by an off-host pairing flow.
This matches the living architecture statement and prevents consuming a
one-time browser link from immediately removing the reason that replaced it.

An end-to-end server test will create an off-host link, consume it through
`/api/auth/browser-session`, then assert that share state remains
network-accessible until the resulting browser session is revoked.

## Exposure Transition Model

### Serialization

The desktop host serializes every exposure apply and every other settings
operation that can restart native or WSL topology under one asynchronous mutex.
The mutex covers settings, backend restart, verification, recovery, and
firewall synchronization so renderer invocations cannot interleave native side
effects or restart the backend past each other. Non-exposure settings changes
preserve the actual runtime exposure mode.

Fresh desktop startup always launches the actual backend local-only under this
mutex. Renderer reconciliation then compares authenticated share state with
actual topology: it widens only when a live off-host reason exists, and narrows
when none remains. It fetches share state again after narrowing and performs one
compensating re-widen if a newer live reason appeared during the operation.
Further revision changes schedule a fresh reconciliation instead of forming an
unbounded loop.

### Widening

A widening transition is ordered as follows:

1. acquire the host exposure mutex and snapshot durable and actual state;
2. start or reconfigure the backend with the requested off-host topology;
3. synchronize the platform firewall and verify the reachable topology;
4. persist network-accessible only after the native side effects succeed; and
5. return the verified advertised endpoint.

If any step fails, the host attempts all local-only recovery steps even when a
settings write fails: persist local-only, restart or recover the backend in
local mode, close the firewall rule, and verify the recovered state. Errors are
combined so the caller sees both the initiating failure and any incomplete
recovery. A failed ignored write must never short-circuit restart or firewall
cleanup.

Persisting wide last makes the crash-safe next-launch target local-only while
the transition is incomplete. The normal authentication boundary remains in
force during the bounded ceremony; network reachability alone never grants an
RPC credential.

### Narrowing

A narrowing transition is deliberately fail-closed:

1. persist local-only first;
2. restart or reconfigure the backend for loopback;
3. close the platform firewall rule regardless of restart outcome; and
4. verify and report the actual recovered topology.

The recovery path never writes network-accessible back as compensation for a
failed narrowing. If loopback recovery cannot be verified, the host closes the
firewall and stops the backend rather than knowingly retaining a wide listener
after reporting failure. The next launch remains local-only.

### Failed Share Ceremony

Share generation continues to use bounded mint retries. When all attempts fail,
the renderer first calls the authenticated cancellation endpoint with the same
principal-scoped idempotency key. Under the issuance lock, cancellation revokes
an already committed offer or records an expiring tombstone that blocks a
delayed create. Only after cancellation succeeds does convergence refresh share
state:

- if another live off-host reason exists, it leaves the listener wide;
- otherwise it applies local-only immediately through the serialized host
  transition.

If cancellation cannot be confirmed, the renderer does not narrow because an
unreported grant may still exist; it presents an explicit cleanup failure. The
mount/revision reconciler remains a backstop, not the primary rollback
mechanism. The direct path does not depend on `access_revision`, so an
in-process backend restart resetting an in-memory revision cannot suppress
cleanup. The UI distinguishes “offer creation failed and remote access was
restored to local-only” from “offer creation failed and cleanup also failed,”
and never promises an automatic rollback that has not completed.

## Pairing Failure Semantics

The server keeps consuming a one-time pairing token before delivering the
encrypted credential reply. This is fail-closed: a dropped reply cannot be
replayed to obtain another credential. The living documentation and client UX
will state the real consequence—an interrupted exchange may burn the code, and
the user must generate a new offer—instead of claiming transparent retryability.

The client maps the consumed-code response to that actionable message. If
post-bootstrap verification or local persistence fails after a credential was
minted, the client reports that the attempt may appear in the server's client
list and directs the user to revoke it there. A new anonymous acknowledgement
or unauthenticated revocation protocol is out of scope because it would enlarge
the pairing trust boundary for an availability-only failure.

The encrypted reply omits `storageInstanceId` when there is no value instead
of emitting an undecodable empty string. Pairing-offer idempotency is scoped by
authenticated principal and bounded with the same style of active-entry cap
and expiry pruning as other pairing state.

## Transport and Backpressure

The `/ws-e2ee` upgrade receives explicit frame and message limits close to the
protocol's single-record maximum rather than accepting the much larger
WebSocket defaults. The protocol still applies its own length checks after the
upgrade; the transport limit prevents the WebSocket implementation from first
buffering a many-megabyte pre-auth frame.

Before the E2EE channel reaches `open`, the client assembler enforces the same
64 KiB logical-message ceiling as the server. After authentication, the
existing 64 MiB logical-message ceiling remains for RPC compatibility. Record
count, length, and nonce checks continue to fail closed.

Outbound encryption becomes record-at-a-time on both server and client:

1. slice one plaintext record;
2. acquire the Noise state only for encryption;
3. release the lock;
4. send that ciphertext under the existing timeout; and
5. continue only after backpressure permits.

The single outbound pump preserves Noise send order. No Noise mutex is held
across a socket await, inbound work can interleave between records, first-byte
latency no longer waits for a whole 64 MiB logical message, and ciphertext for
the full message is not retained at once. Decryption reuses a bounded scratch
buffer instead of allocating and zeroing a maximum-size vector for every
record.

The plain WebSocket route moves connected-state accounting until after a
successful upgrade, matching the E2EE lifecycle. Remote updater delegate calls
receive a bounded timeout; timeout becomes the existing typed per-environment
error and releases that environment's single-flight slot.

## Shared Policy and Contract Corrections

The remediation makes these ownership-preserving corrections:

- web share offers import the pairing deep-link and browser-URL builders from
  `@bibcode/shared/pairingCode`;
- client-runtime exports the desktop-local connection prefix or predicate, and
  web consumers stop mirroring the `local:` literal;
- pairing endpoint presentation parses the URL, compares the actual port, and
  classifies only parsed loopback or private IP addresses rather than matching
  path text or DNS-name prefixes;
- `RemoteUpdateSnapshot.error` accepts `string | null`, including an empty
  delegate message, as pinned by the public contract;
- the E2EE deep-link resolver delegates URL parsing to the shared pairing-code
  owner where possible; and
- stale lint-expectation reasons and dead authentication re-exports are removed
  or corrected.

Triplicated rail candidate mapping and the very large share component may be
factored only where the changed tests expose a clear shared policy seam. This
remediation will not perform an unrelated UI rewrite. The existing bounded
two-at-a-time update pool, per-row Check action, rail null-selection behavior,
and per-entry update wiring are intentional and remain unchanged.

## Repository Gates and Documentation

All five range-introduced gate failures are part of this change:

- add the four missing dependency-upgrade ledger entries and update its
  inventory counts;
- acknowledge `deep-link:default` in the Tauri hardening assertion;
- acknowledge the intended `@noble/ciphers@2.4.0` minimum-release-age
  exclusion in the toolchain contract;
- add `shareState` to the Rust-auth fixture exporter route list and counts; and
- add `GET /api/auth/share-state` to the server route inventory.

The final report will identify these as range-introduced corrections, not
baseline failures. `docs/architecture/remote.md` will be changed in the same
patch as any corrected lifecycle wording. The Linux, macOS, Windows, and
connection-runtime runbooks will be reviewed against the final commands and
flows; affected procedures will be updated, and unchanged ones will be
reported as reviewed and accurate.

## Test Strategy

Implementation follows red-green-refactor for each behavior seam. Focused
coverage includes:

- browser-link consumption preserving wide share state, followed by revocation
  returning it to local-only;
- all-mint-attempts-failed compensation, cleanup failure presentation, and the
  revision-reset case;
- settings-write, restart, verification, and firewall failures on both widening
  and narrowing, proving recovery steps continue and next launch is local;
- serialized concurrent applies and a grant created while narrowing;
- E2EE WebSocket oversize rejection before protocol buffering;
- client pre-auth reassembly rejection at 64 KiB and post-auth compatibility;
- record-at-a-time encryption order, bounded allocation shape, nonce failure,
  timeouts, and existing Cacophony interoperability;
- absent storage instance IDs, consumed-code UX, principal-scoped bounded
  idempotency, endpoint classification, shared URL builders, and update errors;
- all dependency, Tauri, toolchain, fixture-exporter, and route-inventory gates;
  and
- focused web, contracts, client-runtime, server, and desktop suites.

Completion requires `vp check`, `vp run typecheck`, the applicable full
TypeScript suite, `cargo fmt --all --check`, affected Rust tests, and server and
desktop Clippy with warnings denied. The final diff and status must be clean
apart from intentional commits.

Docker validation uses separate Linux server and client containers and repeats
the feature boundary: descriptor negotiation, pairing credential exchange,
authenticated WebSocket, E2EE traffic, browser-session share-state retention,
update status/check, typed manual-update failure, revocation, and cleanup. All
containers and networks are removed afterward.

## Residual Risk

The most important residual risk is packaged native behavior that a container
cannot reproduce: OS firewall integration, desktop restart coordination, and
the signed native updater UI on Windows, macOS, and Linux. Automated host-side
failure tests and the native runbooks reduce that risk, but final packaged
visual validation remains a separate release activity.

The deliberate consume-before-delivery pairing rule can still leave a burned
code or an orphaned visible session after an interrupted exchange. This design
makes that behavior honest and revocable without weakening the authentication
boundary; eliminating it completely would require a separately reviewed
two-phase credential-delivery protocol.
