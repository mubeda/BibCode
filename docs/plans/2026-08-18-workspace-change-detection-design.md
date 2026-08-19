# Workspace Change Detection

Status: approved. Corrected polling (alternative B), with WSL and SSH workspaces
in the first cut. No new dependency.

## Goal

The Files tree should show files created, moved, renamed, or deleted outside
BiBCode without the user pressing Refresh. Today it does not notice them at all.

The reported case: a user pasted screenshots into a workspace folder with Windows
File Explorer, and the tree never showed them.

## Current behavior

`WorkspaceRpc` keeps one `WorkspaceSearchIndex` per canonical workspace root in
`indexes: Arc<Mutex<HashMap<PathBuf, WorkspaceSearchIndex>>>`
(`apps/server/src/workspace/rpc.rs:57`). `index()` builds a root's snapshot on
first use and returns the cached clone forever after
(`apps/server/src/workspace/rpc.rs:318`). Both `projects.listEntries` and
`projects.searchEntries` read that snapshot.

The cache is dropped in exactly three places:

- `invalidate_index()` after a successful `projects.writeFile`, `createEntry`,
  `renameEntry`, `deleteEntry`, or `duplicateEntry`
  (`apps/server/src/workspace/rpc.rs:115`, `:138`, `:162`, `:182`, `:202`);
- `refresh_index()`, whose only production caller is the workspace-refresh effect
  in `apps/server/src/production/runtime.rs:641`; and
- `projects.listEntries` when the request sets the optional `refresh` flag
  (`apps/server/src/workspace/rpc.rs:217`), which is how the Files panel's Refresh
  button now forces a rescan.

Nothing observes the filesystem.

## What the index actually contains

This determines what "a change" means, and an earlier draft of this document got
it wrong, so it is worth stating precisely.

A rebuild lists git-known paths with `git ls-files --cached --others
--exclude-standard`, then **walks the contents of ignored directories** with
`scan_ignored_directory_contents`, bounded by whatever remains of the 25 000-entry
budget (`apps/server/src/workspace/search.rs:154`, `:223`, `:272`, and
`SearchLimits` at `:51`).

Ignored directories are therefore **included**, not excluded. Measured in this
worktree: 7 649 git-listed files and roughly 1 100 implied directories, against 17
ignored roots — leaving on the order of 16 000 entries of ignored content that the
index does walk in and keep. That is why the reported bug is reproducible at all:
the pasted screenshots were inside an ignored directory, and the index is supposed
to show them.

Two consequences:

- Change detection cannot be built on `git status`, which by design will not
  report activity inside ignored directories — the exact case being fixed.
- The tree already surfaces a bounded, arbitrary slice of `node_modules`. That is
  a pre-existing issue, out of scope here, and noted so it is not mistaken for a
  regression introduced by this work.

The index stores only a path, a kind, and an ignored flag (`WorkspaceEntry`,
`apps/server/src/workspace/search.rs:27`). It holds no file contents. **Only
changes to the set of paths can change it.**

## Why the existing watcher is not the answer

`WorkspaceWatcher` (`apps/server/src/workspace/watcher.rs`) exists and is
referenced only by one test (`apps/server/tests/workspace_rpc.rs:293`). As
written it would not work here.

**Its entry cap truncates rather than degrades.** `snapshot()` walks the tree and
stops with an early `return output` once `max_entries` is reached
(`apps/server/src/workspace/watcher.rs:124`, `:135`); the watch loop calls it with
10 000 (`:56`). Traversal order comes from a `Vec` used as a stack plus `read_dir`
order, so two consecutive snapshots can truncate at different points.
`changed_paths()` then diffs two differently truncated maps (`:153`) and reports
the difference as filesystem activity — false positives, plus permanent blindness
past the cap.

**It stats every file to detect a change it does not need.** It records
`(len, mtime)` per path (`:141`), which is per-file content information. The index
does not store content, so per-file stats are cost without purpose. In this
worktree that walk covers 81 798 files under `node_modules` and 10 142 under
`target`, every tick.

Also relevant: the poll loop publishes with `try_send` (`:69`), silently dropping
events when the bounded channel is full.

## Alternatives

**A. Keep manual Refresh only.** No moving parts, no idle cost. The user must
know to press Refresh, and files an agent writes stay invisible until they do.
The baseline.

**B. Corrected polling.** Poll cheaply for path-set changes and rebuild on any
difference. Portable, identical on every platform and filesystem, works over
network mounts and remote workspaces, no new dependency. Costs a periodic stat
sweep and bounds latency below by the interval.

**C. Native OS notification.** `ReadDirectoryChangesW`, `FSEvents`, `inotify`,
via the `notify` crate — not currently a dependency of `bibcode-server`.
Near-zero idle cost, low latency. Costs a dependency, three platform behaviours,
`inotify` watch-descriptor pressure on large trees, and unreliable or absent
behaviour over the network filesystems that WSL and SSH workspaces use.

**D. Root-mtime heuristics.** Rejected on correctness: a file created several
levels down does not change the root's mtime, which is the reported case.

**E. Client-driven periodic refresh.** Poll `listEntries` with `refresh: true` on
a timer. Moves a full rebuild onto a timer for every open panel, and the
composer's `@`-mention search shares the index. Rejected on cost.

## Decision

**B, detecting path-set changes by directory mtime.**

The index is a path set, and on every filesystem BiBCode targets, adding,
renaming, or removing an entry updates the containing directory's mtime, while
editing a file in place does not. Verified on NTFS: create, rename, and delete
each change the parent directory's `LastWriteTime`; an in-place append does not.
That is precisely the discrimination this index needs — it makes content edits,
which cannot affect the index, free to ignore.

So the poll sweep stats **directories only**, not files. In this worktree that is
on the order of 1 100 tracked directories plus the ignored directories the index
walked, against the current watcher's 92 000+ file stats per tick. A difference in
any directory's mtime, or the appearance or disappearance of a directory, means
the path set may have changed, and the root is rebuilt.

C was not chosen despite lower idle cost: it is a new dependency with three
platform behaviours, and it is weakest exactly where this decision puts coverage
first — remote workspaces. B is one implementation that behaves the same
everywhere. If idle cost later proves to matter, C can be added behind the same
seam as an optimisation, with B as its fallback.

What this trades away: latency is bounded below by the poll interval, and a
change that preserves every directory mtime is invisible until the next explicit
Refresh. Both are acceptable; neither loses data.

## Scope of the sweep

The sweep must cover the directories the index covers, and no more:

- directories implied by the git-listed paths, and
- the ignored directories whose contents the index actually walked.

Walking into ignored directories the index did not reach wastes the budget the
index itself declined to spend. The set of directories to stat is therefore
derived from the index snapshot, not from an independent tree walk — which also
keeps the two from disagreeing about what is in scope.

When the index is truncated, the sweep is necessarily incomplete too. Report that
honestly rather than implying full coverage; `SearchResult.truncated` is the
existing precedent.

## Delivering changes to the client

Detection alone is not the feature. The Files panel pulls, and the server has no
way to tell it anything.

A subscription RPC alongside the existing ones in
`apps/server/src/rpc/methods.rs` (see `stream(...)` entries such as
`orchestration.subscribeThread` at `:49`), carrying a coalesced "this root
changed" signal rather than a path list. The client refreshes the entries atom it
already owns.

A signal rather than a diff is deliberate. The client's cache is keyed per atom
(`packages/client-runtime/src/state/projectCommands.ts`, `listEntries` with
`staleTimeMs: 30_000`, `idleTtlMs: 5 * 60_000`), and the tree already reconciles a
whole path list on reset. A signal keeps one source of truth for entry data — the
index — and avoids a second incremental path that could disagree with it. It also
keeps the payload independent of how many files a `pnpm install` touched.

This stays on the typed HTTP/WebSocket RPC surface so browser and desktop modes
behave identically. It is normal application traffic, not a privileged desktop
operation, so it does not belong on `DesktopBridge`.

## Lifecycle, failure, and load

- **Ownership.** The sweep belongs with the index it invalidates, in
  `apps/server/src/workspace`. One per canonical root, shared by its subscribers,
  started on first subscription and stopped when the last goes away — never
  eagerly per workspace, or an unopened project pays for a sweep nobody reads.
  Losing the last subscriber is invisible to a task parked on the watcher, so
  idleness is checked on its own cadence rather than only when an event arrives;
  otherwise a quiet workspace keeps sweeping for the life of the process.
- **Coalescing and backpressure.** A `cargo build` or `pnpm install` is a change
  storm. The coalesce window is armed by the first change of a burst and not
  re-armed by later ones: because the window is shorter than the poll interval,
  re-arming on every change would push the flush past every tick and starve
  notifications for as long as the storm lasted. At most one scan runs per root
  at a time, and a scan that finishes after an invalidation does not publish, so
  the cache can never predate the latest signal. The signal is idempotent, so
  coalescing loses nothing.
- **Self-inflicted changes.** The app's own mutations already invalidate the
  index and will also move directory mtimes. Both paths must converge without a
  rebuild loop.
- **Reconnect.** A client cannot assume it saw every signal while disconnected.
  Resubscribe means resync: starting a sweep rebuilds the snapshot rather than
  inheriting a cached one, because a change made while nothing was watching is
  already on disk when the baseline is stamped and so could never surface as a
  difference.
- **Cancellation and shutdown.** Sweeps stop on server shutdown and on workspace
  unavailability. Subscribing acquires a path admission lease and holds it for the
  subscription's lifetime, and the stream terminates on that lease's
  loss cancellation, so a sweep neither starts on a fenced root nor outlives one.

## Remote environments

WSL and SSH workspaces (`docs/architecture/remote.md`,
`docs/architecture/runtime-modes.md`) are in the first cut, and polling is what
makes that affordable — it needs no platform notification API and works over any
filesystem the server can stat.

The sweep runs wherever the workspace's filesystem lives, which is the same side
that runs the scan. The known risk is directory-mtime fidelity: some network and
translation layers update directory timestamps coarsely or lazily. Where mtime
proves unreliable the failure mode is a missed change, not a wrong one, and manual
Refresh remains correct. This must be exercised on a real WSL workspace during
validation rather than assumed.

## Scope boundary

Not in this design: native OS notification; dragging files in from or out to the
OS file manager (its own proposal); watching outside a workspace root; per-file
incremental index updates; changing the `refresh` flag or mutation-driven
invalidation, both of which remain the correctness floor this sits on; and the
pre-existing truncated-`node_modules` behaviour of the index.

## Verification

A timing-dependent sweep resists deterministic testing, so the seams matter more
than the end-to-end path.

- Unit-test that the directory set is derived from the index snapshot and stays
  within it, since that is what makes the sweep affordable.
- Unit-test the mtime diff directly: an added path changes its parent's entry; an
  in-place content edit does not.
- Unit-test coalescing and the one-rebuild-in-flight rule with an injected clock
  and a synthetic change source, so no test depends on real filesystem timing.
- Integration-test the whole loop the way the existing staleness test does: write
  a file with `tokio::fs`, bypassing every RPC, then assert the index reflects it
  after a sweep — the same shape as
  `list_entries_refreshes_only_when_the_request_opts_in`
  (`apps/server/tests/workspace_rpc.rs`).
- Assert the storm case is bounded: N changes produce at most one rebuild in
  flight plus one follow-up.
- Cover resubscribe-means-resync.

Gates: focused Rust tests, `cargo fmt --all --check`, Clippy with warnings
denied, `vp check`, and `vp run typecheck` for the contract and client changes. On
Windows, `cargo` needs the repo launcher `node scripts/run-msvc-x64.mjs`
(`docs/testing/windows-desktop.md:146`).

This changes user-visible behavior, so the same patch must update
`docs/user/workspace-ui.md`, which currently states the tree does not notice
outside changes, and the Files coverage in
`docs/testing/cross-platform-validation.md`, which currently asks a validator to
confirm exactly that.
