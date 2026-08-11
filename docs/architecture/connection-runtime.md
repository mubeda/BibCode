# Connection runtime

`@bibcode/client-runtime` gives browser and desktop clients one supervised
connection model for local, manually paired, relay, and SSH environments. The
public package has no root export; callers use focused subpaths such as
`connection`, `authorization`, `rpc`, `relay`, and `state/<domain>`.

## Ownership

- `ConnectionResolver` converts a catalog entry into a `PreparedConnection`.
  It recovers profiles and credentials and performs bearer, DPoP, relay, or SSH
  preparation as required by the target.
- `ConnectionDriver` reports `preparing`, `opening`, and `synchronizing`
  progress, creates an `RpcSession`, and waits for its initial configuration.
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

| Target                    | Preparation                                                                                                                                        |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PrimaryConnectionTarget` | Uses the host-provided HTTP/WebSocket address and optional primary bearer credential. It is runtime-provided, not persisted as a saved connection. |
| `BearerConnectionTarget`  | Loads a saved endpoint profile and bearer credential, validates the environment identity, then exchanges/uses authorization.                       |
| `RelayConnectionTarget`   | Uses the Clerk session and relay to obtain a DPoP-bound environment bootstrap, then prepares direct HTTP/WSS access.                               |
| `SshConnectionTarget`     | Asks the desktop SSH gateway to probe or launch the remote server and create local forwarding, then authorizes with the returned bootstrap.        |

Bearer, relay, and SSH targets may be persisted in the connection catalog.
Profiles and credentials remain separate so catalog metadata can be listed
without exposing secrets.

## State and retry policy

The supervisor publishes these phases:

- `available`: disconnected and not requested;
- `offline`: requested while network state is offline;
- `connecting`: preparing, opening, or synchronizing;
- `backoff`: a transient failure is waiting for retry;
- `connected`: the WebSocket is open and `server.getConfig` succeeded;
- `blocked`: configuration, authentication, permission, or capability requires
  an explicit wakeup or user action.

Transient failures retry after 1, 2, 4, 8, then 16 seconds, with 16 seconds as
the cap. The sequence continues while the connection remains desired. A stable
30-second connection resets accumulated backoff. Network changes, credential
changes, catalog reconciliation, and explicit retry requests wake the
supervisor. Disconnect and scope closure interrupt in-flight work.

`RpcSessionFactory` disables protocol-owned reconnects. This is deliberate: one
supervisor owns retry state, status, cancellation, and generation fencing, so a
stale socket cannot silently become current.

## Worktree catalog subscriptions

The worktree catalog is capability gated. A server that does not advertise
`worktreeCatalog` produces no discovery controls and no catalog subscription;
clients do not synthesize an empty supported result. For a capable environment,
`state/worktrees` owns one catalog atom per `(environmentId, projectId)` with no
client idle grace period. The server view itself owns bounded sharing and idle
eviction.

The RPC stream is latest-value state. Client state accepts only a current
authoritative generation as new catalog content. If a later scan is degraded,
it retains the last authoritative candidate and adopted-workspace arrays while
publishing the new health status. Environment and project grouping in React is
presentation only; it does not merge the scoped catalog sources or grant the
browser authority over paths.

Subscription acquisition resolves the current supervisor session. When a
connection is replaced after disconnect or reconnect, the session switch ends
the old stream and subscribes again through the new session. Replacing an
environment registration follows the same scoped switch. Window focus and
document visibility request one single-flight refresh per distinct physical
project, even if several rows or panels render it.

Adoption and policy updates are serialized per project in the client runtime;
**Add all** is also bounded to four concurrent candidate operations and one
bulk lane per environment. These are responsiveness bounds, not correctness
locks: the server's command receipts, mutation locks, generation checks, and
repository verification remain authoritative.

## Data boundary

A session becomes ready only after the socket connects and the initial
`server.getConfig` call succeeds. Domain requests resolve the current scoped
session through the registry; they fail or wait according to the domain API
instead of retaining a global client. Removing a saved environment also removes
its registration, profile, credential, supervisor scope, and environment-keyed
client state.

See [Remote architecture](./remote.md) for access methods and
[RPC and orchestration](./rpc-and-orchestration.md) for the wire boundary, and
[Worktree catalog](./worktree-catalog.md) for discovery and lifecycle rules.
