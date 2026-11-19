# Refusal store and in-order config snapshots

Status: implemented with issues 388 and 377 (review round four).

## Refused repository data

Problem: a host refusal (`forbidden`, `not_found`) of a pull request list, a
pipelines list or a pipeline must hide every copy the client holds of it until
the host answers a later read of the same resource. The latch lived in a child
component, so a filter reset remounted it while the parent, the atom cache and
the stored copy still painted the rows.

Decision: `apps/web/src/components/repositoryModule/resourceRefusal.ts` keeps the
refusals in a module store keyed by surface and `environmentRpcKey` of the read.
`useResourceRefusal` reads it with `useSyncExternalStore`, records a refusal from
the live read or a change event, and clears it only when the live read succeeds
with a value other than the one held at the refusal. The parent that owns the
stored copy and the tab counts reads it.

Alternatives rejected:

- Component state in the parent. A route change unmounts it, and the stored copy
  repaints the rows on return.
- A field in the persisted view stores. Refusals would survive a reload against
  a host that has since restored access, and writing them needs effects anyway.

Trade-off: the store lives for the app session. After a reload the server's
stored copy can paint until the live read is refused again, because the server
keeps that row on a refused unary read.

## Capability changes on the config stream

Problem: the Git version probe built a full config snapshot and published it.
A `settingsUpdated` sent while it was built reached clients first, and the older
snapshot then replaced the client config.

Decision: the probe publishes an internal marker on the config event channel.
Each `subscribeServerConfig` stream keeps the config it has sent and replaces the
marker with that config plus the current environment descriptor, so the
snapshot changes only what the probe learned.

Alternatives rejected:

- Build the snapshot under `settings_update_lock`. Settings and most provider
  publications take that lock, but keybinding and tool publications do not, so
  the same rollback stays possible for them.
- A narrower `environmentUpdated` event. It needs a contracts change and a client
  handler for one capability that changes once per server start.

Trade-off: each connected stream builds its own snapshot, one per capability
change, which happens at most once per server start.
