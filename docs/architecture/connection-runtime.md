# Connection runtime

`@bibcode/client-runtime` gives browser and desktop clients one supervised
connection model for local, manually paired, relay, and SSH environments. The
public package has no root export; callers use focused subpaths such as
`connection`, `authorization`, `rpc`, `relay`, and `state/<domain>`.

## Ownership

- `ConnectionResolver` converts a catalog entry into a `PreparedConnection`.
  It recovers profiles and credentials and performs bearer, DPoP, relay, or SSH
  preparation as required by the target. Every prepared connection retains the
  complete current `ExecutionEnvironmentDescriptor`; an unauthenticated primary
  fetches the public descriptor, and bearer plus fresh or cached DPoP attempts
  fetch it during every preparation rather than inferring it from a saved token.
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
- `EnvironmentSupervisor` owns desired state, connectivity, retries, the
  prepared connection, and the live RPC session for one environment.
- `EnvironmentRegistry` owns catalog entries and their scoped supervisors. It
  reconciles platform-provided registrations and exposes environment-scoped
  execution to domain state.
- Domain modules under `state/*` consume the registry and expose focused Atom
  constructors. React presentation does not own sockets or retry loops.

The composition root is
[`connection/layer.ts`](../../packages/client-runtime/src/connection/layer.ts).

## Targets

Canonical targets are defined in
[`connection/model.ts`](../../packages/client-runtime/src/connection/model.ts).

| Target                        | Preparation                                                                                                                                                     |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PrimaryConnectionTarget`     | Uses the host-provided HTTP/WebSocket address and optional primary bearer credential. It is runtime-provided, not persisted as a saved connection.              |
| `BearerConnectionTarget`      | Loads a saved endpoint profile and bearer credential, validates the environment identity, then exchanges/uses authorization.                                    |
| `RelayConnectionTarget`       | Uses the Clerk session and relay to obtain a DPoP-bound environment bootstrap, then prepares direct HTTP/WSS access.                                            |
| `SshConnectionTarget`         | Asks the desktop SSH gateway to probe or launch the remote server and create local forwarding, then authorizes with the returned bootstrap.                     |
| `UnavailableConnectionTarget` | Retains a platform-owned desired environment and its cached projections without an endpoint or credential; preparation fails transiently before transport work. |

Bearer, relay, and SSH targets may be persisted in the connection catalog.
Unavailable targets are reconciled only from host topology and are never
persisted as saved connections.
Profiles and credentials remain separate so catalog metadata can be listed
without exposing secrets.

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

A session becomes ready only after the socket connects and the initial
`server.getConfig` call succeeds. Current servers publish the same prepared
`storageInstanceId` through that configuration, the initial configuration
subscription snapshot, and lifecycle welcome and ready events as through the
well-known descriptor. Domain requests resolve the current scoped session
through the registry; they fail or wait according to the domain API instead of
retaining a global client. Removing a saved environment also removes its
registration, profile, credential, supervisor scope, and environment-keyed
client state.

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
[RPC and orchestration](./rpc-and-orchestration.md) for the wire boundary.
