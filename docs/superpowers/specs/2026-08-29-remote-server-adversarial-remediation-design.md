# Remote Server Adversarial Remediation Design

**Status:** Approved in chat on 2026-08-29.

## Outcome

The remote-server implementation retains its approved fail-closed security
model while repairing the confirmed lifecycle, admission, recovery,
cross-platform discovery, and presentation defects from the adversarial
re-review. The work does not restore automatic wide startup, weaken E2EE memory
admission, or claim that WSL networking is natively managed when it is not.

The remediation is divided into four independently testable subprojects:

1. pairing, authentication, and exposure recovery;
2. E2EE admission, fairness, and message lifetime;
3. desktop networking, firewall, Tailscale, and WSL truthfulness; and
4. browser persistence, update lifecycle, shared presentation policy, gates,
   documentation, and end-to-end validation.

## Global Constraints

- `apps/server` remains the authority for pairing grants, sessions, and live
  share state.
- `apps/desktop` remains the authority for native backend topology, persisted
  desktop settings, firewall state, and privileged recovery.
- `apps/web` owns user confirmation and presentation but performs privileged
  changes only through `DesktopBridge`.
- `packages/client-runtime` owns connection transport and lifecycle policy.
- `packages/contracts` remains schema-only.
- A fresh native desktop process starts local-only and never treats a persisted
  wide setting as startup permission.
- E2EE credentials remain unusable on plain HTTP and WebSocket surfaces.
- Node.js remains a development dependency only; no production helper or
  sidecar is added.
- Existing pairing codes and the Noise NK handshake remain wire-compatible.
- The user's staged plan deletions and untracked adversarial review are outside
  implementation ownership and must remain untouched.

## Subproject 1: Pairing, Authentication, and Exposure Recovery

### Hosted pairing confirmation

The hosted `/pair?host=...#token=...` route strips the token from the visible
URL immediately but does not submit it during mount. It renders the normalized
backend host and an explicit **Pair this backend** action. Only that action may
consume the one-time token. A submitted token remains single-use within the
page lifecycle; an ambiguous failure tells the user to request a new offer.

### Legacy-wide recovery

Automatic restoration from a persisted wide desktop setting remains forbidden.
The desktop exposure-state contract instead distinguishes actual runtime mode
from configured mode. When all of the following are true, the Share tab offers
an explicit **Resume legacy remote access** action:

- the actual native runtime is local-only;
- the configured mode records `network-accessible` from an older release;
- authoritative share state reports at least one legacy grant; and
- no current off-host grant already requires a normal reconciler widen.

The action invokes the existing serialized exposure bridge and widens only for
the current process. Every later fresh process again starts local-only and asks
for consent. Revoking the last legacy grant permits the ordinary reconciler to
narrow. The UI also offers re-pairing as the preferred path because a new grant
has explicit reach metadata.

### Pairing endpoint parity

Rust and TypeScript classifiers normalize IPv4-mapped IPv6 before loopback,
wildcard, private-network, and public classification. One checked-in fixture
table under `packages/shared/fixtures/` is consumed by both language test
suites so cross-language drift is executable evidence rather than duplicated
test prose.

### Orphan compensation

An E2EE pairing exchange creates a compensating session guard immediately after
the one-time grant is consumed and the long-lived session is minted. The guard
owns the new session ID until the encrypted credential reply is fully written.
Any later capacity-bind, encoding, encryption, or socket-write failure invokes
an internal auth-authority revocation operation and disarms only after delivery
succeeds. Revocation increments the authority revision and cancels any live
socket for the orphan. Cleanup failure is logged without replacing the original
transport failure.

### Crash-safe idempotency completion

A persisted pending pairing-offer reservation is not a permanent rejection.
Under the repository transaction and service issuance lock, a matching retry
revokes the pending grant, removes the incomplete reservation, and returns the
request to fresh issuance. A completed result still replays byte-for-byte; a
fingerprint mismatch still fails; and a cancellation tombstone still prevents
issuance. This closes the crash window without adding a second source of truth.

### Honest share cleanup

Share-offer failure cleanup returns a discriminated outcome rather than a
boolean-like string. Presentation distinguishes:

- local-only was verified;
- another live reason correctly kept the host wide;
- cancellation was not confirmed, so exposure was deliberately left alone; and
- cleanup itself failed and actual topology could not be verified.

No copy promises automatic narrowing unless local-only was actually confirmed.

## Subproject 2: E2EE Admission, Fairness, and Message Lifetime

### Pre-auth admission

Production Axum serving supplies the socket peer through `ConnectInfo`. The
E2EE route admits unauthenticated work through one bounded owner with:

- the existing process-wide 32-handshake cap;
- at most 4 concurrent handshakes per socket IP;
- a per-IP token bucket with burst 8 and refill 1 attempt per second;
- bounded, expiring peer entries; and
- the existing absolute 10-second handshake/authentication deadline.

The socket address, not forwarding headers, is authoritative. Tests use an
injected clock/admission owner and cover release, expiry, NAT-style concurrent
clients, and repeated abusive attempts.

### Inbound backpressure

Noise decryption and plaintext admission are separated. Decrypting one record
returns an owned chunk after releasing the Noise mutex. At most one such chunk
per connection waits for process budget, so waiting memory is bounded by the
established-connection cap and one Noise plaintext record each.

Per-connection and per-session limits remain hard failures for the sender that
exhausts its own allowance. Process-wide plaintext admission waits fairly for
one record-sized permit under a five-second absolute deadline. It never closes
an unrelated connection merely because another session temporarily owns the
global budget. The WebSocket receive loop naturally stops reading while it
waits, propagating TCP backpressure.

The record assembler rejects zero-byte continuation records and more than 2,048
records per logical message in Rust and TypeScript. A zero-byte final record
remains valid. Pre-auth remains capped at 64 KiB and authenticated logical
messages at 64 MiB.

Plaintext permits represent encrypted-channel reassembly and queued raw JSON,
not the lifetime of a streaming handler. They are released after successful
decode, authorization, and dispatch; a stream task does not retain the input
buffer permit for its entire response lifetime.

### Outbound fairness and deadlines

The process-wide outbound owner becomes a work-conserving fit-first allocator
with aging. A request that fits available bytes may bypass an older request that
does not, preventing a 64 MiB waiter from blocking a small control response.
Older requests gain reservation priority after a bounded aging interval, and
all requests retain the existing five-second admission deadline. Per-connection
64 MiB accounting remains unchanged.

Exact serialized length is still computed before allocation and admission.
The subsequent serialization pass is intentionally retained: serializing first
would allocate unbudgeted plaintext across connections, and a streaming async
Serde writer would be a separate protocol implementation. This rejects the
review's double-serialization optimization where it conflicts with the memory
safety invariant.

Once the outbound pump dequeues one logical message, a single absolute
five-second deadline covers all of its Noise records. Successful early records
do not reset the deadline. The queued frame continues to own its byte permits
until the final write succeeds or the message fails.

### Plain WebSocket lifecycle

Both WebSocket routes set explicit transport frame/message caps. Plain `/ws`
marks a client connected only from the upgrade-owned task, and failed upgrades
leave no live-client token or connected count. Coverage is behavioral through
the HTTP/WebSocket integration harness rather than a source-text assertion.

## Subproject 3: Desktop Networking and Native Process Bounds

### Interface enumeration

A focused desktop networking module owns interface discovery. Its production
provider enumerates active, non-loopback, non-unspecified unicast addresses on
Linux, macOS, and Windows; tests inject fixtures. Addresses are normalized and
deduplicated. IPv4 link-local addresses are excluded. IPv6 link-local addresses
are excluded unless a future contract carries a scope ID.

The UDP default-route probe remains only a ranking hint. Advertised endpoint
generation emits every usable address and ranks, in order:

1. the default-route address;
2. Tailscale/CGNAT addresses;
3. private LAN addresses; and
4. other routable addresses.

Stable endpoint IDs derive from the normalized address and port, never array
position. URL construction brackets IPv6 literals.

### Tailscale executable discovery

The desktop host resolves platform-known absolute Tailscale CLI candidates
before falling back to `PATH`. Every candidate is verified by the existing
bounded `status --json` operation. Failure remains an unavailable advertised
provider, not a desktop-startup failure. Tests inject candidate paths and a
runner rather than depending on host installation.

### Firewall deadline

Every firewall child uses `kill_on_drop`, bounded output, and one absolute
15-second timeout. Timeout terminates and awaits the child before releasing the
exposure coordinator. Firewall verification and cleanup use the same runner and
cannot hold the topology mutex forever.

### WSL truthfulness

The WSL primary continues to use the bind required by Windows-to-WSL runtime
connectivity. The desktop exposure contract reports that topology as
`externally-managed` and network-accessible instead of `local-only`. The Share
tab explains that WSL/Hyper-V firewall policy controls external reachability
and that native automatic narrowing is unavailable. The native exposure bridge
remains forbidden in WSL-only mode.

This is intentionally not implemented as a guessed WSL firewall manager.
Default NAT, mirrored networking, Hyper-V firewall policy, and enterprise WSL
configuration have different reachability semantics; silently writing Linux or
Hyper-V policy would add a privileged cross-system owner without an approved
installation and rollback model.

## Subproject 4: Browser Recovery, Updates, Shared Policy, and Governance

### IndexedDB recovery

The web connection-storage owner publishes boot-level database health even when
its Effect layer cannot be constructed. `openDatabase` classifies:

- `VersionError` as an incompatible-newer-database condition;
- `blocked` as another tab or process retaining the database; and
- other open failures as non-destructive unavailable storage.

A renderer-wide coordinator subscribes without depending on the failed
connection runtime. Version conflict renders a dedicated dialog describing that
saved remote servers, credentials, accepted storage identities, shell cache,
and thread cache will be deleted. Reset requires explicit confirmation, calls
`indexedDB.deleteDatabase` directly, reports blocked deletion, and reloads only
after successful deletion. It never invokes project-data recovery, which owns a
different server-side store. Generic unavailable storage offers reload and
diagnostic copy, not destructive reset.

### Registry and updates

Registry `disconnect` looks up an existing supervisor and is a no-op for a cold
environment. Operations that actually require RPC continue to acquire/connect
the supervisor.

Remote update checks receive a 30-second per-environment deadline at the Effect
command boundary so interruption propagates through the RPC session. The
two-worker fan-out remains bounded and failure-isolated; a timed-out environment
settles as failure and releases its worker.

### Shared presentation and limits

`packages/client-runtime` remains the single owner of connection transport
security classification, including trimmed host keys. Web badges consume that
policy. Auth capacity constants move to one server auth limits module consumed
by service and repository code. Desktop local-recovery helpers share one
internal safeguard routine.

### Gates and documentation

Repository validation uses behavioral coverage for failed WebSocket upgrades
instead of reintroducing brittle source-text assertions. Any dependency added
for interface discovery receives lockfile, dependency-ledger, inventory, and
minimum-release-age treatment in the same commit.

The living remote architecture changes with the behavior. The earlier approved
stabilization design receives a supersession note rather than rewritten history.
The original phase specification remains historical and is not rewritten to
pretend the later decisions existed originally. Native Linux, macOS, Windows,
and connection-runtime runbooks are reviewed and updated where commands,
presentation, or validation evidence changed.

## Validation

Every behavioral change follows red-green-refactor and lands in a focused
commit. Required completion evidence includes:

- focused TypeScript and Rust tests for each seam;
- cross-language classifier and E2EE fixture parity;
- browser recovery component and IndexedDB event tests;
- server HTTP/WebSocket integration tests;
- desktop interface, firewall, Tailscale, exposure, and WSL tests;
- `vp check` and `vp run typecheck`;
- the full applicable TypeScript suite;
- `cargo fmt --all --check`;
- server and desktop Rust suites and Clippy with warnings denied;
- final diff/status review preserving user-owned changes; and
- Docker validation with separate Linux server and client containers covering
  descriptor negotiation, pairing, E2EE RPC, update calls, revocation,
  admission/reassembly limits, and cleanup.

Packaged Windows/macOS/Linux validation remains necessary for native interface,
Tailscale-bundle, firewall, WSL, and IndexedDB WebView behavior that containers
cannot reproduce.
