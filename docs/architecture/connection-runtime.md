# Connection runtime

`@bibcode/client-runtime` gives browser and desktop clients one normalized,
supervised connection model for local, WSL, manually paired HTTPS, and
desktop-managed SSH environments. The public package has no root export;
callers use focused subpaths such as `connection`, `cache`, `authorization`,
`rpc`, and `state/<domain>`. Pre-v3 direct and SSH connection targets remain
bounded migration inputs; they are not a second environment model. BiBCode has
no hosted account or connection control plane.

## Ownership

- `ConnectionResolver` converts one selected environment route into a
  `PreparedConnection`. It resolves only the opaque secret reference and host
  capability required by that route. Every prepared connection retains the
  complete current `ExecutionEnvironmentDescriptor`; an unauthenticated primary
  fetches the public descriptor, and authenticated attempts fetch it during
  every preparation rather than inferring it from saved metadata or a token.
- Environment bootstrap decodes and retains the complete environment
  descriptor on `KnownEnvironment`, including its nullable
  `storageInstanceId`, rather than reducing it to a label and logical ID.
- `ConnectionDriver` reports `preparing`, atomically verifies and if necessary
  persists the prepared descriptor's storage identity, then reports `opening`
  and creates an `RpcSession`. After the session is ready it verifies the
  initial `server.getConfig` descriptor through the same identity owner. Only
  then does it report `synchronizing` and return a live lease. A prepared
  mismatch cannot open a socket, and a backend restart between HTTP preparation
  and WebSocket configuration cannot publish synchronization or a live lease.
- `EnvironmentSupervisor` owns desired state, connectivity, deterministic
  sequential route selection, retries, the prepared connection, and at most one
  live RPC session for one environment.
- `EnvironmentRegistry` owns normalized environment aggregates and their scoped
  supervisors. It reconciles platform-provided registrations, fences stale
  generations, and exposes environment-scoped execution to domain state.
- Domain modules under `state/*` consume the registry and expose focused Atom
  constructors. React presentation does not own sockets or retry loops.

The composition root is
[`connection/layer.ts`](../../packages/client-runtime/src/connection/layer.ts).

## Normalized environment aggregate

`KnownEnvironment` is the client source of truth for one accepted server
identity. Its shape is deliberately aggregate-first:

```text
KnownEnvironment
├── environmentId + acceptedStorageInstanceId
├── last verified descriptor
├── client-local alias + hidden flag
├── discovery bindings[]
└── connection routes[]
    └── activeRouteId -> one supervised RpcSession
```

The following invariants are decoded before publication:

- route IDs and binding IDs are unique within the environment;
- persisted route IDs are collision-free across environments; a cross-
  environment collision aborts publication of the second aggregate;
- every route carries the containing `environmentId`;
- every proved binding points to that same accepted identity;
- at most one route is pinned; and
- a retained descriptor must match both the accepted environment and storage
  UUIDs.

Bindings are mutable locators such as the desktop primary slot or a WSL distro
name. Routes are access methods. Neither is durable identity, and neither owns
projects, threads, provider processes, or cached state. Those remain scoped by
the accepted environment.

## Routes and failover

Normalized route schemas are defined in
[`connection/model.ts`](../../packages/client-runtime/src/connection/model.ts).

| Route                  | Trust and preparation                                                               |
| ---------------------- | ----------------------------------------------------------------------------------- |
| `DesktopLoopbackRoute` | Loopback HTTP/WebSocket supplied by the desktop host.                               |
| `DesktopWslRoute`      | WSL binding reached through a desktop-owned loopback forwarder.                     |
| `SshTunnelRoute`       | SSH locator prepared by the desktop host; the resulting transport is loopback-only. |
| `DirectHttpsRoute`     | Direct `https://` endpoint using system trust or an explicit pinned SPKI hash.      |

Plain non-loopback HTTP is not representable. Route URLs cannot contain
credentials, query parameters, or fragments. Authentication material is held
outside route rows and addressed only by opaque `secretRef` values.

Eligible routes are attempted sequentially: the pinned route first, then the
last active route, then ascending numeric priority, with route ID as a stable
tie-breaker. A route must be autoconnect-enabled unless it is pinned. A blocked
route is skipped until an explicit retry or credential-change wakeup; a
transient failure falls through to the next eligible route in the same cycle.
Only one route may publish the live lease. Route results retain environment and
route generations so late success, failure, or progress from an older attempt
cannot replace current state.

## Pre-v3 direct-target migration

Legacy direct-target adapters are defined in
[`connection/model.ts`](../../packages/client-runtime/src/connection/model.ts).
They exist only to migrate v1 direct and SSH catalog entries. Normalized
persistence and supervision use `KnownEnvironment` routes rather than one
target per environment.

| Target                        | Preparation                                                                                                                                                     |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PrimaryConnectionTarget`     | Uses the host-provided HTTP/WebSocket address and optional primary bearer credential. It is runtime-provided, not persisted as a saved connection.              |
| `BearerConnectionTarget`      | Loads a saved endpoint profile and bearer credential, validates the environment identity, then exchanges/uses authorization.                                    |
| `SshConnectionTarget`         | Asks the desktop SSH gateway to probe or launch the remote server and create local forwarding, then authorizes with the returned bootstrap.                     |
| `UnavailableConnectionTarget` | Retains a platform-owned desired environment and its cached projections without an endpoint or credential; preparation fails transiently before transport work. |

Bearer and SSH targets may still appear in the v1 connection catalog.
Obsolete hosted entries are discarded and their credentials are deleted during
migration; they cannot produce a route. Unavailable targets are reconciled only
from host topology and are never persisted as saved connections. Profiles and
credentials remain separate so legacy metadata can be listed without exposing
secrets. After the v1-to-v3 migration receipt exists, registry startup reads
normalized environment rows exclusively.

## Normalized persistence and migration

The web persistence owner stores environment records, routes, bindings, UI
state, cache manifests, encrypted shell snapshots, encrypted thread snapshots,
and migration receipts separately. Dependent route, binding, and thread-cache
stores have an `environmentId` index. Publication occurs only after an
environment aggregate has been decoded from committed rows; no store is a
second in-memory source of truth.

The one-time `catalog-v1-to-v3` migration is deterministic and bounded:

- a legacy direct bearer or SSH target is accepted only with its matching
  profile and an accepted storage UUID;
- non-loopback direct routes must decode as HTTPS, while safe loopback URLs may
  become a desktop loopback route;
- bearer values stay in a memory-only staging list until the desktop OS secret
  provider returns opaque references;
- Relay-only targets and legacy remote DPoP tokens are counted and discarded,
  not copied into normalized rows;
- corrupt, incomplete, conflicting, or unsafe entries produce only a bounded
  SHA-256 fingerprint and stable reason code; and
- normalized rows and the receipt commit together. An aborted commit deletes
  newly staged secret references and is safe to retry.

Startup never mixes the two models. Without a receipt the migration owner runs;
with a receipt the registry ignores v1 targets. A secret-provider failure
publishes neither normalized rows nor a receipt.

Environment navigation has its own one-time
`environment-navigation-v1-to-v2` boundary. Selected ownership paths,
environment/project disclosure, manual-toggle intent, and per-environment order
are one decoded v2 document in IndexedDB. The document and its receipt commit in
one transaction; a receipt without the document is treated as an integrity
failure rather than an empty preference set. Before that receipt exists, the
web client reads only bounded v1 project preferences and migrates a CWD or old
group key only when the current project catalog resolves it to exactly one
`environmentId + projectId`. After the receipt exists, v1 localStorage is never
consulted for navigation.

The v2 document is presentation state, not catalog authority. It may store
expanded ownership paths, manual environment order, pin/hidden intent, focus,
and selection, but it cannot manufacture an environment, project, thread,
route, or live result. The renderer's flat tree retains a descendant's
environment/project ancestry under search and never uses connection status as
a sorting input. Environment settings and lifecycle controls route to center
workspaces; the left panel remains navigation-only.

### Desktop topology reconciliation

The renderer owns one reference-counted desktop topology controller. Native
local-bootstrap and WSL-discovery events are authoritative; focus and explicit
refresh requests are coalesced, and a five-minute wakeup exists only to recover
from a missed event. `getWslState` reads the current native snapshot and cannot
launch discovery. `refreshWslDiscovery` is the explicit mutating request.

WSL reconciliation is catalog-owned and generation-fenced:

- every running distro is visible, including an unproved **Setup required**
  candidate;
- an accepted stopped or absent distro retains its environment identity and is
  registered as unavailable;
- an unaccepted stopped distro is discovery-only and appears in **Add
  Environment**, not the accepted hierarchy;
- stale or failed discovery retains the last accepted binding and route;
- descriptor UUIDs, never distro names, prove a rename;
- an accepted environment or storage UUID mismatch becomes
  `identity-conflict` and cannot be auto-adopted; and
- replacing an unproved locator row compare-deletes only the exact unchanged
  row, so concurrent acceptance cannot be erased.

An initial WSL bootstrap is withheld until discovery can attach its stable
binding and route IDs. A legacy URL-derived bearer fallback is rejected and any
previous volatile WSL route is transactionally replaced. Non-authoritative
topology failure retains accepted environments even after a transient bootstrap
credential expires.

## Accepted storage identity

The schema-v1 connection catalog additively stores accepted non-null storage
identities without changing its schema version. Browser mode persists the whole
catalog in IndexedDB. A desktop host that advertises protected catalog support
sends the same serialized catalog through the desktop bridge, which protects
and restores it as one opaque value. Desktop hosts without that capability use
the same IndexedDB backend as browser mode; neither path has a second ongoing
storage-identity source.

Catalog transitions use exact raw revisions, not a renderer-owned document
cache. Each lookup or transition starts with a fresh backend read. A mutating
transition decodes that revision, reapplies its transformation, and attempts to
replace the exact serialized value it read. A keep transition compares that
same raw revision without encoding or writing a document. A conflict rereads
and reapplies either transition, with a bounded eight-attempt limit and a
cooperative yield between conflicts. This preserves disjoint target, profile,
credential, DPoP-token, and accepted-identity changes made by separately
constructed stores. Corrupt-catalog recovery never replaces authoritative bytes
implicitly. The catalog owner quarantines the exact corrupt revision when its
backend supports quarantine, publishes structured `recovery-required` health,
and rejects mutations while that revision remains authoritative. An explicit
reset uses exact compare-and-set to install an empty catalog; a concurrent valid
repair wins without being overwritten.

In browser mode, and in desktop mode when native catalog protection is
unavailable, IndexedDB performs both compare-only and conditional `put`
transitions in `readwrite` transactions on the catalog key, so its transaction
serialization coordinates independent stores, tabs, and WebViews. The
compare-only transaction performs a `get` but never a `put`, including for an
absent catalog. On a capable desktop host, `compareConnectionCatalog` and
`compareAndSetConnectionCatalog` are privileged typed `DesktopBridge` commands.
The Rust catalog owner holds one process-wide mutex across compare-only reads,
protected reads, comparison, and writes; legacy `get`, `set`, and `clear`
commands use the same owner. Desktop bridge contract version 3 introduces the
compare-only command alongside protected compare-and-set and the
`protectedConnectionCatalog` capability. The renderer never emulates either
atomic transition with separate bridge calls. A host without protected CAS
explicitly selects IndexedDB and atomically migrates any legacy renderer-local
catalog into it before clearing the legacy value.

Before exposing a protected version 3 bridge, the desktop adapter collapses a
legacy renderer-local catalog into the native source. It first reads native
storage. If native is absent and the legacy value is non-blank, it attempts one
native CAS from `null` to that exact value, then rereads native whether it won
or lost. An already-present or concurrent native value is authoritative and is
never overwritten by the legacy copy. Only after an authoritative native read
or post-CAS confirmation does the adapter clear the renderer copy. Absent and
blank renderer values require no CAS. Once installed, protected `get`,
compare-only, CAS, set, and clear operations use native storage exclusively;
Keep never falls back to or rewrites renderer storage.

If reading the renderer legacy source, reading native storage, adopting, or
confirming fails, adapter installation preserves both sources and exposes the
catalog capability as unknown. Catalog consumers then fail with a redacted
typed persistence error without writing IndexedDB or clearing either source.
During unprotected-host migration, an already-valid IndexedDB value is the
exact canonical winner. If IndexedDB instead contains corrupt bytes and the
legacy catalog is valid, the renderer replaces those exact corrupt bytes by
CAS and quarantines them before clearing the only valid legacy copy. Migration
uses the same eight-attempt bound as ordinary catalog updates.

Catalog protection capability has three states. Only bridge contract version 3
with an explicit `protectedConnectionCatalog: true` selects protected native
compare-only/CAS, and only version 3 with an explicit `false` selects IndexedDB
and legacy migration. Rejected metadata, older bridge contracts, and missing
capability fields, plus failed protected-source collapse, are `unknown`:
catalog startup and mutation fail with a redacted typed error, without writing
IndexedDB, invoking native clear, or deleting a legacy renderer copy. This
prevents transient metadata failure, migration failure, or version skew from
downgrading a Windows DPAPI catalog into renderer storage.

Once a compare-only or CAS call is issued it is uninterruptible through
transaction/command completion. There is no in-memory catalog publication
afterward, so a caller interrupted around commit cannot leave stale renderer
state that overwrites the durable winner on a later update. On protected hosts,
the native mutex coordinates every WebView in one desktop host. Separate
simultaneously running desktop processes are not yet coordinated by an OS/file
lock and remain a documented residual risk.

Accepted identities use target keys that remain stable when endpoints, labels,
credentials, or local paths change:

| Target  | Accepted-identity key   |
| ------- | ----------------------- |
| Primary | `platform:primary`      |
| Bearer  | `bearer:<connectionId>` |
| Relay   | `relay:<environmentId>` |
| SSH     | `ssh:<connectionId>`    |

Keys never contain bearer/DPoP credentials, endpoint URLs, SSH host/profile
data, or filesystem paths. `AcceptedStorageIdentityStore` exposes an atomic
transition over the shared catalog in addition to direct catalog reads and
writes. The transition callback receives the accepted identity from each fresh
revision and is re-evaluated after every conflict; only the result computed for
the successful revision is returned. First observation, equality, change, and
a version-skewed `null` report are represented as `Bootstrap`, `Accepted`,
`Changed`, and `Unverifiable`. Bootstrap uses CAS to persist the first non-null
identity. Accepted, Changed, and Unverifiable decisions use compare-only and do
not rewrite an existing catalog, create an absent catalog, or depend on the
catalog writer. Equality and unverifiable reports keep the current baseline,
and an unverifiable report never erases it. When concurrent runtimes bootstrap
the same target, the first CAS winner persists its identity and every loser
re-decides against that winner before it can open a session.

`ConnectionDriver` applies this decision table after descriptor preparation
and before `RpcSessionFactory.connect`. Bootstrap persistence must complete
before a socket opens. It applies the table again to the session's cached
initial configuration after `session.ready` and before synchronization or
lease publication, closing the session scope if the WebSocket reached a
different store. An accepted match continues normally, and an unverifiable
`null` continues without deleting a prior baseline. A changed non-null identity
fails with a structured `ConnectionStorageChangedError` that retains the target
key plus both identities; the supervisor publishes it as a blocked state
without publishing prepared/session state or consuming a new snapshot.

Adoption is an explicit `EnvironmentRegistry.acceptStorageIdentity` command.
It is valid only while that environment's current supervisor state is blocked
by the structured storage-change error. The registry conditionally transitions
exactly the error's accepted identity to its reported identity, then signals
one normal retry. If another runtime has already changed the durable baseline,
the transition fails without overwriting that newer value or scheduling the
retry. The operation is serialized with registration/removal for the logical
environment and becomes uninterruptible once it owns that lease, so
cancellation cannot commit the user decision without also scheduling the
retry. Adoption neither clears environment caches nor reads, writes, copies,
or merges either server database.

This identity boundary starts when both sides understand persistent store
UUIDs. An older server reports `null`, and the client deliberately treats that
as unverifiable without erasing an accepted UUID. Likewise, the first
protected release cannot infer whether an earlier release had already selected
a different valid database before either database had a marker. Once a store
publishes an identity and the client accepts it, subsequent switches are
blocked before synchronization. See
[Project data safety and recovery](../guides/project-data-recovery.md) for the
observable platform scenarios and supported recovery actions.

## State and retry policy

The supervisor publishes these phases:

- `available`: disconnected and not requested;
- `offline`: requested while network state is offline;
- `connecting`: preparing, opening, or synchronizing;
- `backoff`: a transient failure is waiting for retry;
- `connected`: the WebSocket is open and `server.getConfig` succeeded;
- `blocked`: configuration, authentication, permission, capability, or a
  changed persistent store requires an explicit wakeup or user action.

Transient failures retry after 1, 2, 4, 8, then 16 seconds, with 16 seconds as
the cap. The sequence continues while the connection remains desired. A stable
30-second connection resets accumulated backoff. Network changes, credential
changes, catalog reconciliation, and explicit retry requests wake the
supervisor. Disconnect and scope closure interrupt in-flight work.

`RpcSessionFactory` disables protocol-owned reconnects. This is deliberate: one
supervisor owns retry state, status, cancellation, and generation fencing, so a
stale socket cannot silently become current.

The supervisor vocabulary is exactly `available`, `offline`, `connecting`,
`backoff`, `connected`, and `blocked`; the optional connection stage is
`preparing`, `opening`, or `synchronizing`. UI presentation maps those internal
states to `online`, `connecting`, `reconnecting`, `offline`,
`authentication-required`, `version-incompatible`, `updating`, or `stopped` as
appropriate. Binding discovery uses `available`, `unavailable`, `stopped`,
`setup-required`, or `identity-conflict`. New status strings require a contract
and presentation change together; callers must not infer a new state from a
free-form detail message.

## Secret and offline-cache boundary

Normalized environment rows never contain a credential, DPoP private key, or
cache key. They contain an opaque secret reference whose value can be resolved
only through `EnvironmentSecretStore`. Desktop implementations route that
capability across the typed `DesktopBridge` to the OS credential store. A
missing or locked provider is a typed, redacted failure; renderer storage is
not a credential fallback.

Shell and thread snapshots use AES-256-GCM envelopes. The authenticated
additional data is the exact tuple
`{schemaVersion, environmentId, storageInstanceId, entityKind, entityId}`.
This prevents a valid ciphertext from being replayed under another environment,
server store, entity kind, or entity ID. Desktop durable cache keys are random
material held behind an opaque OS secret reference. A secure browser may keep a
non-exportable Web Crypto key through structured-clone persistence; if durable
key persistence is unavailable, both key and cache remain session-only.

The cache manifest and encrypted write commit in one transaction. Stale server
revisions cannot overwrite a newer entry. Age and total-byte limits evict the
least recently accessed unselected entries, while the current selection is
protected. Authentication failure, payload mismatch, or storage/scope mismatch
quarantines and removes the affected envelope instead of rendering it.
Legacy plaintext cache is migrated once only when a secure durable key is
available; otherwise it is deleted and the server must resynchronize it.

## Hide, route removal, and Forget

Hide and restore update only the client-local `hidden` field. They retain
routes, bindings, secrets, cache, settings, and the current supervisor.
Removing one route deletes that route's secret and reconstructs the supervised
aggregate while retaining the environment, including when no usable route
remains.

Forget is a cancellation boundary, not a display mutation:

1. increment the environment admission generation and persist a redacted
   `pending` cleanup receipt;
2. cancel and await the supervisor scope so no route attempt owns work;
3. resolve the cache manifest and idempotently delete every route and cache-key
   secret reference;
4. clear client-only ephemeral state; and
5. in one IndexedDB transaction remove route rows, binding rows, UI selection
   and ordering, cache manifest and encrypted/plaintext snapshots, the
   environment row, and the cleanup receipt.

Registrations and platform reconciliations capture admission tickets before
their work and must still match both phase and generation at publication. A
late completion after Forget is ignored. A secret or metadata failure leaves a
redacted `secret-deletion-failed` or `metadata-deletion-failed` repair state;
restart remains closed until Forget is retried. After a successful commit, a
new explicit authoritative registration may recreate the environment.

Browser-local pin, unread, visit, and legacy disclosure metadata cannot share
the authoritative Forget transaction. The web client therefore writes one
independently keyed IndexedDB client-repair receipt before starting Forget,
confirms it after server success, clears and verifies both in-memory and
persisted scoped metadata, and removes the receipt only after verification.
Per-environment keys prevent concurrent tabs from overwriting another
environment's receipt. On restart, a prepared receipt remains dormant while
the authoritative catalog still contains the environment; a confirmed receipt,
or a prepared receipt for an absent environment, is repaired idempotently.
Failure to make the receipt durable prevents Forget from starting, while
incomplete post-success cleanup is reported explicitly and remains retryable
rather than being presented as a clean removal.

Disconnect is earlier and weaker than every removal operation: it cancels the
active client session but retains routes, credentials, cache, bindings,
settings, and remote state. The removal workspace may request optional remote
service uninstall or purge only through a fresh versioned plan and a trusted
desktop, local-control, or SSH host-authority adapter. Those remote outcomes
are separate from Forget. When the environment is offline, force-Forget
requires explicit unknown-outcome confirmation, executes no remote command,
queues nothing for reconnect, and warns that the server, projects, worktrees,
credentials, and data may remain.

## Worktree catalog subscriptions

The worktree catalog is capability gated through one exported policy selector.
The client reads `worktreeCatalog` from the connected session's negotiated
configuration and uses that same session for the request, so reconnect cannot
pair an old capability decision with a new socket. A false or missing capability
starts no catalog subscription and makes no catalog refresh, policy, managed-
create, panel-create, retarget, adoption, plan, detach, destructive-removal, or
bulk RPC call. Discovery and destructive-removal controls remain hidden. The
only older-server fallback is an explicitly confirmed legacy detach through
ordinary thread deletion; it leaves Git and files untouched and never invokes a
raw-path destructive method. Active, archived, direct, and bulk entry points use
this same policy.

Focus refresh reasons are negotiated independently through the default-false
`worktreeCatalogRefreshReason` capability. The scheduler retains Focus as its
logical refresh class, but the request builder omits `reason` immediately before
sending through a session that did not advertise support. This preserves old-
server Explicit behavior without merging Focus with a concurrent manual Retry
and without retrying a rejected request on another wire shape.

For a capable environment, `state/worktrees` owns one catalog atom per
`(environmentId, projectId)` with no client idle grace period. The server view
itself owns bounded sharing and pointer-checked 60-second idle eviction after
the final subscription or unary operation releases it.

The RPC stream is latest-value state. Client state accepts only a current
authoritative generation as new catalog content. If a later scan is degraded,
it retains the last authoritative candidate and adopted-workspace arrays while
publishing the new health status. React projects remain strictly scoped to their
owning environment; repository metadata never merges catalog sources or grants
the browser authority over paths.

One client-runtime presentation selector governs workspace-action availability.
A cold/no-status row, `present`, and retained `verification-unavailable` remain
usable because none proves absence. Only authoritative `missing-registered`,
`missing-unregistered`, and `removing` disable path-dependent actions. Sidebar,
chat, and panel surfaces call this selector rather than reimplementing the
decision.

Subscription acquisition resolves the current supervisor session. When a
connection is replaced after disconnect or reconnect, the session switch ends
the old stream and subscribes again through the new session. Replacing an
environment registration follows the same scoped switch. Window focus and
document visibility request one single-flight refresh per distinct physical
project, even if several rows or panels render it.

Managed creation, panel creation, retargeting, adoption, policy, and removal
updates are serialized in the appropriate project/host lanes in the client
runtime; **Add all** is also bounded to four concurrent candidate operations and
one bulk lane per environment. These are responsiveness bounds, not correctness
locks: the server's command receipts, mutation locks, generation checks,
physical identity, and repository verification remain authoritative.

## Shell projection authority

Shell projection keeps connection availability separate from project count.
Each desired environment is `starting`, `synchronizing`, `live`, `degraded`,
`storage-changed`, `recovery-required`, `unavailable`, or
`configuration-error`. A cached snapshot remains the render source while an
environment reconnects or is blocked, but it is not authoritative. Only a
successful shell snapshot transitions the environment to `live`, including a
successful snapshot containing zero projects. The global shell summary permits
the genuine empty-project presentation only after the environment catalog is
loaded, contains at least one desired environment, and every desired
environment is `live` with a snapshot. Missing snapshots may yield no project
rows for rendering, but never establish an empty catalog. Catalog
`recovery-required` health is a configuration error in this projection, so
corrupt persisted bytes cannot be interpreted as a confirmed empty project
list. Health messages are redacted and do not expose raw catalog contents.

Shell authority is fenced to the exact supervisor session and connection
generation. Connection-state and session publication are observed as one
serialized projection, so either publication order starts the same subscription
without letting a prior-session stream become current. Reconnect, blocked,
backoff, session replacement, or generation change immediately retains the
cached snapshot as non-authoritative and requires a new full snapshot. Deltas
are ignored until that snapshot arrives; afterward only strictly newer deltas
may update state or the persistence queue. Duplicate and stale deltas publish
nothing.

## Data boundary

A session becomes ready only after the selected route connects and the initial
`server.getConfig` call succeeds. Current servers publish the same prepared
`storageInstanceId` through that configuration, the initial configuration
subscription snapshot, and lifecycle welcome and ready events as through the
well-known descriptor. Domain requests resolve the current scoped session
through the registry; they fail or wait according to the domain API instead of
retaining a global client. Forget removes this client's supervisor, protected
secret references, routes, bindings, UI state, and environment-keyed cache. It
does not claim to stop a remote server or remove remote projects, worktrees, or
data.

`environmentId` remains the logical routing identity. `storageInstanceId` is
the persistent-store UUID supplied by a current server on its initial
descriptor. The descriptor decoder accepts an omitted field as `null` for
older or third-party remote servers; it still validates any supplied value as
a trimmed non-empty string. The connection catalog can retain the last
explicitly accepted non-null value; an older descriptor reporting `null` never
replaces it. Prepared-descriptor mismatch gating happens before session
creation, and initial-configuration mismatch gating happens before
synchronization, lease publication, or cache consumption. Neither decision is
inferred by the bootstrap helper or authorization token cache.

See [Remote architecture](./remote.md) for access methods and
[RPC and orchestration](./rpc-and-orchestration.md) for the wire boundary, and
[Worktree catalog](./worktree-catalog.md) for discovery and lifecycle rules.
