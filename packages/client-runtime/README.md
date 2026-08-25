# Client Runtime

Shared client behavior for web and desktop. Public APIs are organized by package
subpath. The package intentionally has no root export.

## Public subpaths

| Subpath              | Responsibility                                                   |
| -------------------- | ---------------------------------------------------------------- |
| `authorization`      | Bearer and DPoP authorization plus token persistence contracts   |
| `cache`              | Authenticated cache envelopes, revision policy, and LRU bounds   |
| `connection`         | Environment routes, supervision, registry, and onboarding        |
| `environment`        | Environment identity, descriptors, endpoints, and scoped keys    |
| `errors`             | Shared client error inspection                                   |
| `operations`         | Multi-step application workflows                                 |
| `platform`           | Platform capability and persistence service contracts            |
| `platform/migration` | Bounded schemas for one-time persisted-data migrations           |
| `relay`              | Transitional BiBCode Connect compatibility pending removal       |
| `rpc`                | HTTP/RPC clients, protocol, sessions, and subscriptions          |
| `state/<domain>`     | Focused shared state, retention, reducers, and Atom constructors |

## Dependency direction

Platform applications provide `platform` persistence and host capabilities.
`connection` composes those capabilities with `authorization` and `rpc` and is
the sole owner of route admission, failover, reconnect, and environment
sessions. The legacy `relay` package is not an alternative state owner.
Independent `state` modules consume the connection registry and expose focused
state or Atom constructors to application-owned runtimes.

The normalized runtime has one aggregate boundary:

```text
KnownEnvironment -> zero or more routes -> at most one active RpcSession
                 -> zero or more discovery bindings
```

Routes and bindings locate an environment; they never define its identity.
Catalog rows hold only opaque secret references. Shell and thread snapshots are
scoped by both environment and persistent storage identity before authenticated
encryption. Hide changes presentation metadata only. Forget closes admission,
cancels and awaits the scoped runtime, deletes protected secrets, then commits
all remaining environment-owned rows and its repair receipt atomically.

Applications should import the narrowest relevant subpath. There is no broad
`state` export: use domain paths such as `state/shell`, `state/threads`,
`state/terminal`, or `state/vcs`. Subpath indices and explicitly exported domain
files are public API boundaries; all other files remain implementation details.
