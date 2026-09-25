# Clone from URL: keep a clone running across a WebSocket reconnect

Status: **Approved by the user on 2026-09-24** (the recommended option on every ruling listed below).

Follows [the network-budget record](./2026-09-23-clone-network-budget-design.md),
which lists this residual. Trace: [`research.md`](../../plans/git-transfer-lifecycle/research.md)
§1–§2. Citations re-checked against `fd5effbb` plus the uncommitted tree.

## Problem and evidence

A long clone over a flaky link (the reported remote at about 218 KiB/s) dies
whenever the WebSocket drops, and the user must start over.

- Teardown and `Interrupt` cancel the request token (`apps/server/src/rpc/session.rs:791-794, 851-855`),
  and `run_unary` drops the handler (`session.rs:1100-1110`). The transfer token
  is a request child plus a drop guard (`apps/server/src/git/repository.rs:4854-4855`),
  so the owned task stops Git and removes the folder it created
  (`repository.rs:4908, 6949-6962`). Nothing drains that untracked task at
  shutdown (`repository.rs:4859`).
- Sockets drop easily: one pong more than about 5 s late ends the socket
  (`.repos/effect-smol/packages/effect/src/unstable/rpc/RpcClient.ts:1095-1107, 1168-1190`),
  and the supervisor ends the lease on an offline event or a failed 15 s probe
  (`packages/client-runtime/src/connection/supervisor.ts:32, 381-449`).
- The pending call fails or is interrupted (`RpcClient.ts:758-764, 286-292`); only
  subscriptions move to the next session (`packages/client-runtime/src/rpc/client.ts:227-255`).
  The dialog shows `Clone failed: SocketCloseError: 1006` or "The clone stopped
  before it finished. Try again." (`apps/web/src/components/add-project/useAddProjectWorkflow.ts:159-164, 563-578`).

Other findings are cited where they decide a point below.

## Alternatives and decisions

### Architecture (decided: Alternative A)

- **A. Runtime-owned operation keyed by destination (chosen):** smallest wire
  change; reuses the destination serialization and reuse check; gives Orca's "a
  retry joins the running clone" plus Cancel and bounds; fixes the shutdown residual.
- **B. Operation id plus observation stream:** adds progress and multi-window
  observation but needs streamed runner output; A's entry can grow into it.
- **C. Durable receipt:** heaviest; Git cannot resume a clone, so it buys only cleanup.

### Server: the clone operation

- **Owner.** A clone runtime in `GitVcsRpcServices`, beside `worktree_removal_tasks`
  (`apps/server/src/production/git_vcs.rs:43-134, 209`), replaces the static
  `CloneDestinationRegistry` (`repository.rs:6849-6933`); the Git module keeps
  reservation, transfer, identity-checked cleanup, and the reuse check.
- **Entry**, keyed by canonical parent plus today's derived leaf
  (`repository.rs:4805-4816`): the URL, a root transfer token
  (`CancellationToken::new()`), a state watch, whether the starter detached, a
  clone of its admission permit (as removal does, `git_vcs.rs:780, 1087`), and the
  tracked task. Admission is non-waiting and bounded like the catalog runtime
  (`docs/architecture/rpc-and-orchestration.md:991-997`); proposed bound 16.
- **Start-or-join.** No live entry: today's path, dropping any retained outcome.
  Same URL running: join and share its outcome; same URL cleaning up: wait, then
  start (the retry-after-Cancel ruling). Another URL: `busy` at once (today: a
  wait, then "different origin").
- **`attach: true` is join-only:** join a live entry with the same URL (another
  URL: `busy`), else return a retained outcome, else run the reuse check without
  reserving (a finished clone's path, the incomplete-clone error, or
  `not-in-progress` for no folder).
- **Caller cancellation** (Interrupt, teardown, dropped handler) ends that caller's
  wait, and cancels the clone only if the caller started it without `detach`, so
  older clients keep today's Cancel. Joiners never cancel by leaving.
- **`vcs.cancelClone`** takes the clone's input (`url`, `parentDir`,
  `directoryName?`), so only the server derives keys. It cancels a live entry with
  that URL, waits for its cleanup, and returns `{ cancelled: true }`, else `false`;
  idempotent, it never touches a finished clone. `orchestration:operate`
  (`apps/server/src/auth/scope.rs:114-124`) and `mutation_unary`, like the other
  cancel RPCs (`apps/server/src/rpc/methods.rs:57, 156`).
- **Failure retention:** failed and cancelled outcomes stay in memory 5 minutes,
  so a re-attach gets the real reason; success needs none (the disk is the record).
- **Shutdown** (`apps/server/src/production/runtime.rs:598-639`) closes admission,
  cancels every root token, and drains beside `worktree_removal_tasks.close_and_drain()`
  (`runtime.rs:611`), so Git stops and the partial folder is removed first.

### Orphan policy (decided: let it finish, like Orca)

No orphan deadline, so a laptop sleep never loses a long clone; an unattached
clone runs under the 24-hour bound (`apps/server/src/git/mod.rs:66-71`) and, for
HTTP(S), the stall guard (`repository.rs:50-58`). Consequences:

- **Closing a window no longer stops a remote clone:** the socket close only
  detaches, and the unmount's `vcs.cancelClone` may not get out of a closing or
  disconnected window.
- **Disk and bandwidth:** an abandoned clone downloads everything and stays on
  disk until the user adds or removes it; on a dead SSH link (no stall guard) it
  holds its folder and slot up to 24 hours unless SSH's keepalive ends it.
- **Discovery:** no notification or list (B). Cloning the same URL into the same
  folder joins a running orphan or adds a finished one; **Open folder** adds it too.
- **Updates** (desktop local server only, `apps/server/src/maintenance.rs:630-638`):
  as today, a clone fails the 30 s drain naming `vcs.clone` (`maintenance.rs:192-238`);
  the failed preparation's shutdown (`maintenance.rs:448`) now cleans it up.

### Other decided points

- **Closing the dialog cancels** (today, `useAddProjectWorkflow.ts:258-266`),
  removing only the folder the clone created. With the capability, Cancel and
  close send `vcs.cancelClone`, then end the wait; an abort alone only detaches.
- **The client registers the project** after success or re-attach
  (`apps/web/src/components/add-project/addProjectOperations.ts:176-203`), so
  default-model resolution stays client-side (`useAddProjectWorkflow.ts:778-817`).
- **Scope: Clone from URL.** Only `vcs.clone` has a UI caller
  (`useAddProjectWorkflow.ts:713, 818-830`); `sourceControl.cloneRepository` shares
  `clone_repository` (`git_vcs.rs:867-871, 1574-1591`), so it uses the runtime
  without new fields (its client-runtime atom, `packages/client-runtime/src/state/sourceControl.ts:25-33`,
  has no caller). Follow-up: Git Manager transfers (`rpc-and-orchestration.md:305-307`),
  `vcs.pull`, and pushes (`git_vcs.rs:457`) still die on reconnect; B generalizes.
- **Capability `vcsCloneReattach`, default false,** gates the fields and the loop;
  the server detaches only when asked. It is load-bearing: `CloneInput` has no
  `deny_unknown_fields` (`git_vcs.rs:1951-1957`), so an older server would run an
  `attach` as a new clone.

### Rulings on the research's open questions (§7, items 5–10)

5. **Cancel key: by destination.** Naming a folder to cancel takes the authority
   to clone there; an operation id buys nothing until B.
6. **Crash cleanup: keep refusing leftovers, and also refuse one without an
   index.** Only a crash now leaves one. A git 2.55.0 probe (checkout paused by a
   slow smudge filter, group SIGKILLed) left a resolvable `HEAD`, no `.git/index`,
   a stale `index.lock`, and a partial tree, which today's `HEAD^{commit}` test
   accepts (`repository.rs:5036-5055`). Git writes the index once, after checkout
   (even for an empty tree, also probed), so reuse also requires the file at
   `git rev-parse --git-path index` to exist; same message. A lock alone may
   belong to a running Git command, so it is not the test. A durable receipt or
   temporary-sibling rename stays a follow-up.
7. **Liveness: out of scope** (see Interplay).
8. **Error-path hardening: ruled in batch 1.** The error path keeps signalling
   the group after the root is reaped (a descendant still in the group keeps its
   id reserved); the drop guard signals only an unreaped root. See the
   cancellation invariants in `rpc-and-orchestration.md`.
9. **Duplicate projects: no change;** `project.create` returns the existing project
   for the same canonical root (`apps/server/src/orchestration/engine.rs:2913-2955`).
10. **Destination keys: canonical parent plus lexical leaf.** `vcs.clone` already
    canonicalizes (`git_vcs.rs:822`, `apps/server/src/production/host_paths.rs:24-60`);
    `sourceControl.cloneRepository` must too (`git_vcs.rs:1574-1591`). A leaf
    cannot be canonicalized before it exists.

## Interplay with other work

- **Batch-1 process-group guard: prerequisite and backstop.** At `fd5effbb` a
  dropped run kills only the root `git` (`apps/server/src/process/background.rs:131-137`);
  the uncommitted `SupervisedChildGuard` in `run_supervised_with_observer`
  (`apps/server/src/process/supervised.rs:102-183`) kills the group, so a clone
  task dropped by runtime shutdown, a panic, or a timed-out quiesce cannot leave
  helpers writing into a folder nobody removes. Land it first; it only kills, and
  the owned cancel-and-drain removes the folder.
- **Connection-liveness spec: independent.** It makes spurious drops rarer; this
  design makes the rest (sleep, network change, restart) harmless to a clone.

## Wire changes

- `GitCloneInput` (`packages/contracts/src/git.ts:169-173`) and `CloneInput` gain
  optional `attach` and `detach` (default false).
- `vcs.clone` errors add `GitCloneOperationError { reason, destination, message }`
  (`busy`, `capacity`, `shutting-down`, `not-in-progress`, `cancelled`).
- `vcs.cancelClone` beside `WsVcsCloneRpc` (`packages/contracts/src/rpc.ts:964-973`),
  in `GIT_VCS_UNARY_METHODS` (`git_vcs.rs:169-189`), `methods.rs`, and `scope.rs`.
- `vcsCloneReattach` in `ExecutionEnvironmentCapabilities` (`packages/contracts/src/environment.ts:30-62`),
  advertised at `apps/server/src/lifecycle.rs:63` and `production/control.rs:2171`.
- `packages/contracts/fixtures/rpc-wire/` (method entry, `typed-failures/vcs__cancelClone-*`,
  one more `typed-failures/vcs__clone-*`, fingerprints) via `vp run check:contracts`,
  after updating the pinned counts (131 methods, 288 typed failures, 389 fixtures)
  in `packages/contracts/scripts/export-rust-rpc-fixtures.ts:861-879`, its test
  (`:101-114`), and `apps/server/tests/rpc_wire.rs:85-95`.

## Client runtime

`packages/client-runtime/src/state/vcs.ts` owns the loop (React owns no retry
loops, `docs/architecture/connection-runtime.md:31-32`). Capability false:
today's single call. Capability true: send `detach: true`; on `RpcClientError`,
`EnvironmentRpcUnavailableError`, or an interrupt it did not request, publish
`reconnecting`, wait for the next session as `subscribe()` does, and re-issue
with `attach: true`. Typed failures never re-attach. No attempt limit or timer:
the loop ends at an outcome, a Cancel or close, a blocked or user-disconnected
environment, or a session without the capability (reported as stopped). Cancel
goes out on its own lane, since the clone holds its serial lane
(`packages/client-runtime/src/state/vcsCommandScheduler.ts:38-49`).

## UI

The form keeps its values in every outcome. Phases: `idle → cloning ⇄
reconnecting → registering → closed`, plus `cancelling`. **Cancel clone** shows in
`cloning` and `reconnecting`. `<host>` is the dialog's host label.

| Situation                       | Dialog                                                                                                     |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Connection lost                 | **Cloning…**; "Lost the connection to <host>. The clone continues on the server; reconnecting…"            |
| Reconnected, still running      | **Cloning…**; status cleared                                                                               |
| Cancel while disconnected       | **Cancelling…**; "The clone stops when <host> reconnects."                                                 |
| Cancel confirmed                | "Clone cancelled." (today)                                                                                 |
| Success after re-attach         | **Adding project…**, closes once the project opens (today)                                                 |
| Clone failed, live or retained  | "Clone failed: <server detail>" (today)                                                                    |
| `not-in-progress`               | "No clone is in progress for <path>. Press Clone to start again."                                          |
| `cancelled`, not by this dialog | "The clone into <path> was cancelled elsewhere. Press Clone to start again."                               |
| `busy`                          | "Another clone into <path> is in progress. Wait for it to finish or choose another folder."                |
| `capacity`                      | "Too many clones are running on <host>. Wait for one to finish and try again."                             |
| `shutting-down`                 | "<host> is shutting down. Press Clone again once it is back."                                              |
| Blocked or disconnected         | "Can't reconnect to <host>. The clone continues there; clone the same URL into the same folder to finish." |

`busy` omits the other URL, which may embed credentials. Per `UI.md`, the
reconnecting line is needed to recover: without it the user restarts a live clone.

## Validation

- **Server** (`apps/server/tests/production_git_vcs_rpc.rs`, slow loopback remote
  as at `:2239`): `detach` survives a socket close and an Interrupt, and a new
  socket's `attach` gets the path; without `detach`, the interrupt test and
  `repository.rs:11390, 11420, 11447` stay green; `vcs.cancelClone` after a
  reconnect stops the group, removes only the created folder, then answers
  `false`; every `attach` answer; shared join, `busy`, capacity, shutting-down;
  shutdown removes the partial folder; the drain names a detached `vcs.clone`; an
  index-less leftover is refused while an empty-tree clone is still reused; a
  symlinked parent joins via `cloneRepository`.
- **Client runtime:** no fields and Interrupt-Cancel without the capability;
  re-attach on each transport failure, never on typed ones; a disconnected Cancel
  goes out on the next session, off the clone's lane; a downgrade stops the loop.
- **Web** (`apps/web/src/components/add-project/`): every row above, unmount
  cancels, registration after re-attach; reviews against
  `vercel-react-best-practices` and `UI.md`.
- **Gates:** `vp run check:contracts`, `cargo fmt --all --check`, Clippy with
  `-D warnings`, `vp check`, `vp run typecheck`.
- **Live:** a dev server (`BIBCODE_PORT_OFFSET`, `BIBCODE_HOME`), the runbook's
  throttled smart-HTTP remote, and a drop mid-clone (Playwright
  `context.setOffline(true)` for over 5 s, or a TCP proxy that closes connections
  on a signal or stalls past the 5 s pinger). Expect the reconnecting line, then
  registration; Cancel after a reconnect removes the folder; a restart mid-clone
  shows "No clone is in progress…".

## Documentation to update

- `docs/architecture/rpc-and-orchestration.md:1931-1940`: with `detach`, admission
  into the clone runtime is the handoff; caller cancellation then ends only the
  wait, and `vcs.cancelClone` stops the clone.
- `docs/architecture/overview.md:152-171` (clone lifecycle),
  `docs/architecture/connection-runtime.md:450-456` (**Cancel clone**, re-attach
  loop, capability), and `docs/user/workspace-ui.md:86-92` (user behaviour).
- `docs/testing/cross-platform-validation.md:1072-1098` and
  `docs/testing/execution-report-template.md:214-219`: drop, Cancel after
  reconnect, and restart steps with their evidence.

## Residuals

- No progress and no list of running clones; other windows see a clone only by
  cloning into the same folder (B).
- Retention is in memory: after a restart, or 5 minutes after a failure, `attach`
  answers `not-in-progress`.
- A crash still leaves a partial folder; the reuse check refuses it.
- On a case-insensitive macOS volume, a leaf differing only by case gets its own
  key; the second request meets the first's folder and is refused as incomplete.
- Mixed versions: an older client that started a clone still cancels it for a
  newer window that joined.
