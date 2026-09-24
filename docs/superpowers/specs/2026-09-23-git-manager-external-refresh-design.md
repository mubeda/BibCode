# Git Manager refresh after external Git commands

Status: **Approved by the user on 2026-09-23** (recommended options).

## Problem and evidence

User report: the Git Manager does not show changes made with `git` commands
run outside it (another terminal, including BiBCode's own terminal panel).
BiBCode's own Git Manager actions appear immediately because every mutation
handler refetches its queries on completion (`GitManagerToolbar.tsx`,
`GitManagerChangesView.tsx`, `GitManagerPanel.tsx`).

Current flow:

- The panel subscribes to `gitManagerEnvironment.signal({cwd})` and refetches
  refs, commits, and stashes when the signal generation changes
  (`packages/client-runtime/src/state/gitManager.ts`). No query polls.
- The generation changes only in `update_git_manager_signature`
  (`apps/server/src/git/broadcaster.rs`), called only from
  `refresh_remote_for_lifecycle`, which hashes `git_manager_signal_refs`
  (`for-each-ref refs/heads refs/remotes refs/tags`) plus the head signature.
- The filesystem watcher (`git/watcher.rs`) already sees every external Git
  command: it watches the worktree recursively, the git directory and common
  directory non-recursively (`HEAD`, `index`, `packed-refs`, `FETCH_HEAD`,
  `ORIG_HEAD`), and `refs/` recursively, and classifies them as
  `GitWatchEvent::Metadata`. Those events drive only the local status refresh.
- The local refresh reaches the remote refresh (and so the generation) only
  when the checked-out branch name changed
  (`reconcile_remote_after_local_publication`). A same-branch commit, stash,
  tag, branch creation, reset, or fetch waits for the automatic fetch tick
  (default 180 s; never when the interval is 0; after a failed fetch the tick
  backs off to 15 minutes). The server test
  `git_manager_signal_generation_bumps_after_an_external_commit` passes only
  because its fixture shortens that tick to 50 ms.
- `refs/stash` is not part of the signature, so stash changes never bump it.
- No window focus or visibility refetch exists, although the Git Manager spec
  named a focus-plus-timer fallback.

The Git Manager phase-09 plan deliberately avoided wiring the watcher to the
signal ("no new poller task and no new watcher subsystem"). The recommended
option reuses the existing watcher and debounce; it adds no subsystem.

## Alternatives and decisions

1. **Watcher-driven signal refresh (recommended).** The watcher classifies
   ref-shaped metadata (`refs/**`, `packed-refs`, `HEAD`, `*_HEAD`) separately
   from other metadata such as `index`. A debounced ref-metadata burst runs a
   lightweight signal refresh: the existing `for-each-ref` read plus `HEAD`,
   hashed with the current signature inputs and `refs/stash`. It bumps the
   generation only when the hash changes. It does not run the full remote
   status read, so external `git add` bursts cost nothing extra and the
   Changes view keeps using the local status stream it already has.
   Cost: one bounded `for-each-ref` per debounced ref-change burst.
2. **Client focus and visibility refetch.** Refetch refs, commits, and
   stashes when the window regains focus or becomes visible. No server
   change, but it misses commands run while BiBCode stays focused, such as in
   BiBCode's own terminal.
3. **Polling while the panel is open.** Rejected: steady background Git reads
   for every open panel, contrary to the performance-first rule.

Decision: option 1, plus option 2 as a cheap fallback for a watcher that
reports `GitWatcherHealth::FallbackRequired` (for example exhausted inotify
watches on a remote server).

## Behaviour

- Covered without waiting for a fetch tick: commit, amend, reset, checkout,
  branch create/delete/rename, tag, stash push/pop/drop, fetch, pull, merge,
  rebase, and `update-ref`, from any process.
- The generation is bumped once per debounced burst whose hash changed;
  duplicate bursts are no-ops, and the UI refetch is idempotent.
- Cancellation and repository retirement follow the existing lifecycle
  fences (`acquire_read_fence` / `publish_if_fence_current`), so a refresh
  racing a retirement cannot publish.
- The automatic fetch tick keeps its current role (remote tracking data).

## Rulings after the round-1 review (2026-09-24)

- **Stash pop/drop of any entry is covered.** The signature also hashes the
  stash reflog (`logs/refs/stash`, the stash list itself), and the watcher
  treats that file as ref-shaped metadata, so dropping or popping a non-top
  entry refreshes the panel.
- **Linked worktrees and reftable repositories are covered.** `HEAD` files of
  linked worktrees (`worktrees/<name>/HEAD` under the common directory) and the
  reftable store (`reftable/**`) are ref-shaped metadata, and the watcher
  observes them.
- **Working-tree churn never postpones a ref refresh.** The ref lane debounces
  on ref-shaped events only, with a hard cap (about one second from the first
  ref event), so a build or an agent writing files continuously cannot delay a
  commit's refresh.
- **A ref read skipped by an in-app mutation fence is rescheduled** when the
  fence settles, so an external change is never lost until the next tick.
- **Cost:** a burst runs the bounded `for-each-ref` plus the two small HEAD
  reads (`symbolic-ref`, `rev-parse`); reading HEAD through Git keeps reftable
  repositories correct.

## Rulings after the round-2 review (2026-09-24)

- **Watch set:** no native watches on object stores (`objects/`, `lfs/`,
  `modules/*/objects`). The git and common directory roots are watched
  non-recursively; `refs/`, the stash reflog, `reftable/`, and `worktrees/` are
  watched recursively once they exist. A worktree ignores its siblings'
  `worktrees/<other>/**` except their `HEAD` and `reftable/**`, so a sibling's
  `git add` costs nothing here.
- **Reftable linked worktrees:** `worktrees/<name>/reftable/**` is ref-shaped.
- **Cost:** reftable repositories add one bounded `git stash list` read per
  burst, because they keep no loose stash reflog file.
- **Signature failures never block remote status:** a failed HEAD or stash
  reflog read is logged, leaves the signature unchanged, and retries on the next
  trigger; the remote-status publication still happens.
- **Decorations stay server-owned:** after a refresh, rows already loaded get
  their current `%D` decorations from the server (Git's labels and order,
  including `origin/HEAD`); the client never rebuilds decoration labels.
- **Focus signal:** the degraded-only refetch uses its own focus/visibility
  signal; `application-active` keeps its existing meaning, so switching back to
  the window does not probe every connected server.

## Rulings after the round-3 review (2026-09-24)

- **Worktree root keeps its native recursive watch, exactly as before this
  change** (with the existing event-level filtering of object-store paths).
  Per-directory registration of the whole worktree is not used: on macOS and
  Windows a native recursive watch is far cheaper than one watch per directory.
  The main checkout's `.git` stays covered by that recursive watch, as before.
- **Targeted watches are only for Git metadata outside the worktree root** (a
  linked worktree's common directory): the root non-recursively, plus native
  recursive watches on `refs/`, `logs/`, `reftable/` and `worktrees/` once they
  exist. No native watch is placed on that directory's object stores.
- **Every full rescan invalidates refs**, whether it comes from the watcher's
  overflow signal or from the registration queue overflowing, so a ref change
  in the gap is never lost.
- **One Git-metadata layout classifier** decides both registration and event
  classification, and compares path components case-insensitively where path
  keys are normalized to upper case (Windows).

## Rulings after the round-4 review (2026-09-24)

- **History refreshes on either trigger:** the repository generation advancing
  (in-app operations while the watcher is degraded) refreshes History even when
  a signal exists, without a second read when both advance for one change.
- **Visible counts stay current:** the toolbar's stash count follows the signal
  even while the Stashes panel is closed.
- **Submodules keep refreshing:** only `modules/*/objects` is filtered, as the
  object-store rule intends; a submodule commit still refreshes the
  superproject's status.
- **Registration stays shallow:** only first-level store roots are queued;
  native recursion covers deeper directories, so many new ref directories do
  not force a full rescan.
- **`application-active` cannot be dropped** by coalescing in the shared
  wakeup buffer.

## Rulings after the round-5 review (2026-09-24)

- **Stash list only while the panel is open (replaces the round-4 "Visible
  counts" ruling):** HEAD never showed a stash count on the closed Stashes
  button, and keeping one current meant reading the whole list (a reflog read
  plus one `git stash show` per entry) on every ref change. The list is read on
  opening the panel and on each signal change or in-app operation while it is
  open; a closed panel reads nothing and shows no count. If a closed-panel count
  is wanted later, the signal can carry it from the stash reflog it already
  reads.
- **`worktrees/` stays recursive:** the common directory's own object stores
  stay unwatched. The recursive `worktrees/` watch also reaches linked
  worktrees' submodule Git directories (`worktrees/<name>/modules/`); their
  object-store events are filtered, and on Linux each directory costs an
  inotify watch. This is accepted rather than registering each administrative
  directory separately, which would reintroduce per-directory registration.
- **Name-only ref changes:** the repository generation tracks tip SHAs and HEAD
  (pre-existing). A name-only change whose signal is absorbed as an echo
  updates its decorations on the next refresh. Accepted as a low residual.
- **Stash RPC idle windows are the scenario:** the quiet window before each
  stash operation is what "refresh after idle" tests; it lives in one
  documented helper.

## Rulings after the round-6 review (2026-09-24)

- **Opening Stashes reads once:** closing the panel drops the stash query, so a
  reconnect re-reads nothing while it is closed; opening mounts a fresh query,
  and only a step from one signal generation to the next while the panel is
  open re-reads the list. The first generation after the signal (re)subscribes
  (load, worktree switch) is covered by the mounted query's own read.
- **Accepted low residuals:** a reconnect that restarts the signal at 0 can
  cost History two first-page reads; History's first read waits for the signal
  subscription, whose setup includes an initial status read; switching
  branches with "stash" from the toolbar relies on the signal to refresh an
  open stash list (a degraded watcher catches up on the next focus return); a
  repository whose signal starts at 0 re-reads an open stash list once at its
  first signature, because stashes have no second trigger to fall back on.

## Ruling after the clone-fix review (2026-09-24)

- **A HEAD without a ref or a commit is a state, not a failure:** an
  interrupted clone leaves HEAD on Git's placeholder `refs/heads/.invalid`
  (`symbolic-ref` exits 128 on files, 1 on reftable; `rev-parse` exits 1). The
  signature hashes it as "no symbolic ref, no commit", so such a repository
  still gets a signal and repairing HEAD bumps it. Other exit-code combinations
  stay errors, and a missing repository still fails the concurrent
  `for-each-ref`. A corrupt ref store can produce the same exit codes (a
  truncated ref file, an empty reftable `tables.list`); it then refreshes as a
  HEAD without a ref or commit instead of logging a read error, and `getRefs`
  and History still show the unresolved HEAD. Reftable placeholders have only
  unit coverage, because a real one needs an interrupted clone.

## Validation

- Server: an external commit, stash, tag, and fetch in a fixture repository
  each bump the signal with the default fetch interval (no shortened tick);
  an external `git add` does not run the signal read; an unchanged hash does
  not bump; a retired repository does not publish.
- Web: focus/visibility refetch fires only while degraded and at most once
  per focus change.
- Live: dev server, run `git commit`, `git stash`, and `git tag` in an external
  terminal and in BiBCode's terminal panel, and confirm the Git Manager
  updates within a second.
- Living docs: the Git section of `docs/architecture/overview.md`.
