# Task 9 report — guard and quiesce authoritatively missing workspaces

## Status

Completed and ready to commit after this report was written. The server now
installs one shared thread/path availability guard before an authoritative
missing catalog snapshot is published, rejects new workspace-dependent work
with the exact structured `WorkspaceUnavailableError`, and runs bounded
provider/terminal quiescence without deleting conversation or terminal
history.

## Ownership and lifecycle

- `apps/server/src/worktree_catalog/availability.rs` owns the central
  `WorkspaceAvailabilityRegistry`. It indexes durable thread IDs and
  host-platform-normalized paths, including root/descendant checks and a
  canonical request-path check when the request still exists.
- Missing loss work is coalesced by `(threadId, generation, availability)`.
  Repeated authoritative snapshots in the already-guarded state do not start a
  second cleanup. A same-generation transition from `missing-registered` to
  `missing-unregistered` is still admitted once.
- Degraded/non-authoritative snapshots are no-ops. Recovery clears only the
  matching thread, normalized path, and physical repository. `removing` owns
  precedence and retains the newest matching missing state for restoration if
  the removal guard is released.
- Pending orphan cleanup is counted per thread rather than represented by a
  last-writer-wins boolean. One older reaper completion therefore cannot clear
  a newer transition's pending marker. Queue saturation deliberately retains
  both the guard and pending count.
- `WorktreeCatalogService` reconciles availability while its publication state
  is still locked and before `watch::send_replace`. The same ordering is used
  during initial catalog bootstrap, before the catalog entry/watch channel is
  inserted and before the first subscription returns. Only then is the
  asynchronous runtime-loss observer invoked.
- `apps/server/src/production/worktree_runtime.rs` owns warning persistence,
  provider stop, terminal quiescence, the five-second shared deadline, at most
  16 initial concurrent quiesces, and the bounded 64-entry reaper queue.
  Warning persistence and cleanup begin together; a failed or stalled warning
  cannot delay cleanup or extend the five-second bound. `ProductionRuntime`
  shuts the catalog before the reaper, then the provider and terminal owners.

## Runtime preservation

- The production provider action sends `ThreadSessionStop`. A missing provider
  session is already quiescent; other failures are logged without suppressing
  terminal cleanup.
- `TerminalManager::quiesce_thread_preserving_history` snapshots all sessions
  for the thread, signals every live PTY before waiting, and finalizes each
  successful exit into the existing retained session. It does not use the
  destructive terminal-close path.
- A kill failure is aggregated after every process has been attempted; the
  first failed kill cannot prevent later terminals from being signaled.
- The global terminal lifecycle lock covers only snapshot-and-signal ordering.
  It is released before process/tree exit waits, so unrelated terminal
  lifecycle work is not held behind the graceful cleanup wait.
- Read-only attach remains allowed after loss and returns the exact prior
  bounded transcript with `Exited` status. New open/restart/write and
  restart-on-attach remain guarded. Thread rows, conversation messages, and
  terminal session history are preserved.
- Each admitted transition appends one warning activity using a deterministic
  ID derived from thread, physical repository, generation, and availability.
  Duplicate refreshes do not append a second activity. Warning persistence
  failure is diagnostic only and cannot prevent provider/terminal cleanup.

## Guarded public boundaries

The production runtime injects the same registry instance into the catalog and
all affected public owners:

- orchestration: `thread.turn.start` is rejected after command validation but
  before attachment materialization, durable admission, or provider delivery;
- terminal: open, restart, write, and restart-on-attach are rejected before PTY
  operations; ordinary attach, resize, clear, and close remain available;
- Git/VCS/source-control/editor: every client request or stream carrying a
  guarded `cwd` is rejected before broadcaster subscription, progress
  publication, process launch, or repository mutation;
- workspace: file reads/writes, entry mutation/list/search, browse with a cwd,
  review, workspace assets, and project favicons are guarded before the owning
  filesystem, index, Git review, or asset service runs;
- internal cleanup continues to call `GitRepository` directly and does not pass
  through client-path guards.

Catalog refresh, conversation/history reads, terminal close/read-only attach,
and thread delete/detach remain allowed as required.

## Contracts and fixtures

`WorkspaceUnavailableError` was added to the affected RPC error unions,
including stream declarations. The generated Rust wire corpus was regenerated
in the same change:

- 89 methods and 16 streams;
- 171 typed-failure fixtures;
- 247 total fixtures;
- 228 schema fingerprints;
- 57 stream-shape fixtures;
- 69 changed fixture paths: 35 modified and 34 new typed failures.

The 34 new unary typed-failure fixtures cover assets, browse, Git pull-request
helpers, orchestration dispatch, all guarded project methods, review, editor,
source-control discovery/publish, terminal open/restart/write, and guarded VCS
operations. The affected streaming schemas are checked by the same manifest,
fingerprint, TypeScript parity, and Rust `rpc_wire` suites.

## TDD evidence

### RED

The implementation was driven through focused deterministic failures. The
important RED observations were:

- registry tests initially failed to compile because the availability types
  and state owner did not exist;
- catalog ordering tests initially failed to compile because there was no
  runtime-loss observer, and initial-bootstrap coverage later observed callback
  count `0` for an already-missing workspace;
- the registry initially rejected a valid same-generation availability change
  and mishandled filesystem roots;
- the paused-time reaper shutdown test hung because cancellation was not
  selected while awaiting an active job;
- boundary tests first failed because orchestration, terminal, Git/VCS, and
  workspace owners had no shared-registry injection or guard calls;
- terminal preservation coverage initially had no coherent quiesce API; the
  follow-up kill-failure test proved the first kill error left another PTY
  unsignaled;
- a pending-warning test observed provider/terminal cleanup call count `0`,
  proving warning persistence could block all cleanup;
- a two-job orphan test proved one completion cleared another pending cleanup
  under the original boolean representation;
- contract decoding failed before `WorkspaceUnavailableError` joined the RPC
  unions; the fixture exporter then reported the old 137/213/194 expectations
  instead of the final 171/247/228 corpus;
- the first warnings-denied Clippy run found one `collapsible_if` in the
  restart-on-attach guard.

All timing/concurrency tests use paused Tokio time, barriers, semaphores, or
observable task state rather than sleeps.

### GREEN

Final focused lifecycle matrix:

```text
availability registry state machine                    6 passed
catalog service lifecycle/publication ordering        46 passed
production warning/quiesce/reaper                      5 passed
terminal preserving quiesce                            2 passed
real-Git worktree catalog                              9 passed
orchestration unavailable boundary                     1 passed
terminal unavailable/history boundary                  2 passed
Git unavailable boundary                               1 passed
workspace unavailable boundary                         1 passed
provider workspace-loss stop                           1 passed
Rust rpc_wire parity                                   13 passed
TypeScript contracts/exporter/rpcRustParity            30 passed (4 files)
```

The real-Git lifecycle test creates a registered worktree, removes its
directory, observes `missing-registered`, verifies the guard, prunes/recreates
the exact path, and proves authoritative recovery clears it.

## Final validation

Commands run successfully after the final implementation changes:

```sh
cargo test -p bibcode-server --lib worktree_catalog::availability::tests -- --nocapture
cargo test -p bibcode-server --lib worktree_catalog::tests -- --nocapture
cargo test -p bibcode-server --lib production::worktree_runtime::tests -- --nocapture
cargo test -p bibcode-server --lib 'terminal::manager::tests::workspace_quiesce_' -- --nocapture
cargo test -p bibcode-server --test worktree_catalog -- --nocapture
cargo test -p bibcode-server --test production_orchestration_rpc workspace_unavailable -- --nocapture
cargo test -p bibcode-server --test production_server_terminal_rpc workspace_unavailable -- --nocapture
cargo test -p bibcode-server --test production_git_vcs_rpc workspace_unavailable -- --nocapture
cargo test -p bibcode-server --test workspace_rpc workspace_unavailable -- --nocapture
cargo test -p bibcode-server --test production_provider_runtime workspace_loss -- --nocapture
cargo test -p bibcode-server --test rpc_wire -- --nocapture
vp test run packages/contracts/src/rpcRustParity.test.ts packages/contracts/scripts/export-rust-rpc-fixtures.test.ts packages/contracts/src/rpc.test.ts packages/contracts/src/worktree.test.ts
vp run --filter @bibcode/contracts generate:rust-rpc-fixtures
cargo test -p bibcode-server --quiet
cargo fmt --all --check
cargo clippy -p bibcode-server --all-targets -- -D warnings
vp check
vp run typecheck
git diff --check
```

Results:

- full server: 1,013 library tests plus every integration and doc-test target
  passed;
- Rust format and all-targets Clippy with warnings denied passed;
- `vp check` passed all 1,775 format files and 1,309 lint files;
- workspace typecheck passed all 11 tasks. It printed the repository's existing
  non-failing Effect Schema finite-number suggestions; none are introduced by
  this task;
- fixture regeneration was stable and `git diff --check` passed.

## Documentation and self-review

`docs/architecture/rpc-and-orchestration.md` now records the shared registry
topology, authoritative/degraded ordering, normalized path identity, public
guard/allow boundaries, deterministic warning, retained terminal/conversation
history, five-second cleanup bound, 16-way initial quiesce admission, 64-entry
reaper, saturation semantics, and runtime shutdown ownership.

Final review specifically checked canonical/lexical path behavior, filesystem
roots and descendants, missing paths, repository-scoped recovery, duplicate
and availability-change transitions, bootstrap publication, removal
precedence, warning failure/stall, recovery/reaper overlap, queue saturation,
shutdown cancellation, terminal kill aggregation, durable-admission ordering,
contract error parity, and direct internal Git cleanup. No generated dependency
or vendored subtree changed.

Residual platform risk is limited to native process-tree termination semantics
already owned by the terminal/provider supervisors; the availability runtime
retains the guard and pending-cleanup signal when termination cannot be
confirmed or the reaper queue is saturated.
