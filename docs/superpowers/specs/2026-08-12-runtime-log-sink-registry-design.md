# Runtime-Owned Native Log Sink Registry Design

**Status:** Approved in conversation on 2026-08-12; written-spec review pending.

## Context

BiBCode installs one process-global `tracing` subscriber. A `ServerRuntime`
currently initializes `server.log` by replacing the writer behind that
subscriber. That is correct for the normal one-runtime production topology,
but it is unsafe when multiple runtimes execute concurrently in one process:
the most recent runtime retargets all process logging, and one runtime can tear
down a temporary log root while another runtime still writes through the
retargeted global writer.

The parallel Rust-test effort must remove that interference without
serializing tests, changing public server configuration, or migrating every
Tokio task and native worker thread to a new logging context.

## Decision

Replace the replaceable global writer with a named, process-owned
`LogSinkRegistry`. The process still installs exactly one native tracing
subscriber. Each active `ServerRuntime` registers its exact rotating
`server.log` writer and receives a private `LogSinkLease`. The registry-backed
`MakeWriter` snapshots all active writers under a short mutex, releases the
mutex, and mirrors each process log record to every active sink.

This explicitly defines native tracing as a process-wide stream. Concurrent
embedded runtimes do not receive semantically partitioned events; instead,
each active runtime-owned log contains the complete process stream for the
period in which its lease is active. The normal desktop and headless
production topology has one active runtime and therefore one sink.

## Ownership and Lifecycle

- `LogSinkRegistry` owns a monotonically allocated sink identity and a bounded-
  by-liveness map of active `LogWriter` values. It is the source of truth for
  process file sinks.
- `LogSinkLease` owns one exact registry identity. Its final drop removes only
  that identity; a stale lease cannot remove a replacement sink.
- Runtime startup opens and registers the sink through a crate-private owned
  initialization path. A startup error drops the provisional lease and leaves
  other sinks unchanged.
- The runtime server task and `ServerHandle` share the lease owner. Dropping a
  handle requests/aborts shutdown, but cannot deregister the sink while the
  owned server task is still capable of emitting diagnostics. Normal `join`
  waits for task termination before the final lease is released.
- Subscriber installation and first registration remain serialized by the
  existing initialization mutex. If subscriber installation fails, the
  provisional registration is rolled back exactly.
- The existing public `logging::initialize` API remains compatible. Its first
  successful call retains a process-lifetime lease; later calls report
  `AlreadyInstalled` and never retarget an existing sink. `ServerRuntime` uses
  the crate-private owned API.

No lock is held across an async wait, file write, flush, or rotation.

## Write and Failure Semantics

For each tracing record, the registry snapshots cheap `Arc`-backed writer
handles under its mutex, then attempts each write outside the registry lock.
One failed or rotating sink must not prevent attempts to healthy sinks.

The composite writer reports success when at least one active sink accepts the
record and reports an error only when every attempted sink fails. A record can
be partially present if an individual filesystem write fails; the logging
layer cannot make several independent files transactional. Existing per-file
rotation, record truncation, size, and backup bounds remain unchanged.

When no runtime sink is active, stderr remains available and the file layer
performs no file write.

## Performance and Capacity

The hot path adds one short registry mutex acquisition, an `Arc` snapshot, and
one write per active runtime sink. Production normally has one sink, so the
additional cost is constant and small. Multi-runtime tests deliberately pay
`O(active runtimes)` file-write cost to retain every runtime-owned diagnostic
file without global retargeting.

The registry does not add an arbitrary fixed capacity that could make server
startup fail solely because logging is full. Its size is indirectly bounded by
live runtime/process-lifetime leases, and exact final-drop removal prevents
terminal entries from accumulating.

## Testing

Add a dedicated integration regression in
`apps/server/tests/server_runtime.rs` that exercises production-compiled
logging behavior:

1. Start two runtimes concurrently with distinct temporary data roots and
   positively await both starts.
2. Emit marker A after both runtime-owned sinks are registered and assert that
   both `server.log` files contain it. The old replaceable writer
   deterministically writes only to the last target.
3. Shut down and join the left runtime, retain a snapshot of its log, and tear
   down its root.
4. Emit marker B and prove the right log receives it while no removed/stale
   left sink is accessed or recreated.

Focused unit coverage must also prove exact lease deregistration, first-install
rollback, attempt-all behavior when one sink fails, bounded rotation, and no
terminal registry accumulation. Synchronization uses positive start/join
events; timeouts are failure watchdogs, never ordering evidence.

Run the logging/lifecycle focused suites with parallel Rust test threads, then
the Task 6 formerly locked suites, the full server library suite at eight
threads, Clippy with warnings denied, `vp check`, and `vp run typecheck`.

## Documentation

Update `docs/operations/observability.md` in the implementation patch to state
that native tracing is process-wide and, when several runtimes coexist in one
process, records are mirrored to every active runtime-owned `server.log` sink.
Do not describe the files as runtime-isolated.

## Rejected Alternatives

### Per-task runtime context propagation

Propagating a runtime-specific dispatcher through all production Tokio spawns
and raw worker threads would provide semantically isolated logs, but it touches
roughly ninety-five task owners, creates a much larger cancellation and
coverage surface, and is unnecessary for the normal one-runtime topology.

### Public logging configuration on `ServerConfig`

A public sink/context would expose an internal observability ownership detail,
require callers to propagate it correctly, and still require a broad spawn
context architecture for strict event partitioning.

### Fileless secondary runtimes

Allowing only the first in-process runtime to own a log file is smaller, but it
does not give concurrent runtime fixtures durable logs and weakens the desired
same-process concurrency guarantee.
