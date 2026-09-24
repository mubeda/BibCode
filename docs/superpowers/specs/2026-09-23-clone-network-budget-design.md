# Clone from URL: network budget, cleanup, and incomplete-clone handling

Status: **Approved by the user on 2026-09-23** (recommended options).

## Problem and evidence

User report (remote Fedora server): cloning
`https://luna.tripunkt.de/tripunkt/customer-portal.git` into `/work/tripunkt`
ran for a while, then the dialog re-enabled without closing. Pressing Clone
again created a project whose primary branch showed `(unknown)`, and the Git
Manager showed no branches.

Diagnosis from the server trace and the disk state:

- `GitVcsDriver::clone_repository` (`apps/server/src/git/repository.rs`) runs
  `git clone` through the default driver, so it inherits
  `DEFAULT_TIMEOUT = 30 s`. The remote has 33,020 objects and streamed at about
  218 KiB/s; `vcs.clone` failed with "Git command timed out" at 30 s, leaving a
  26 MB `tmp_pack_*` behind.
- Nothing removes the partial destination. Its `HEAD` stays
  `ref: refs/heads/.invalid` (Git's placeholder before the remote HEAD is
  known), with no refs.
- The retry goes through `reuse_existing_clone`, which accepts any repository
  root whose origin matches as a finished clone, so the half-clone became a
  project. `gitManager.getRefs` then fails with "malformed repository ref
  state" on `.invalid`.
- Fetch and push also run with the 30 s default, so slow links can fail them
  the same way. Checkout writes already use a separate long safety bound
  (`CHECKOUT_WRITE_TIMEOUT`, 24 h) owned by a dedicated driver variant.

## Alternatives and decisions

### Budget for network transfers

1. **Long safety bound, stall detection, cancellation (recommended).** Clone,
   fetch, pull, and push run on a network-transfer driver variant with a long
   safety bound, following the checkout-write precedent. Git's own
   `http.lowSpeedLimit`/`http.lowSpeedTime` abort a stalled HTTP(S) transfer
   (for example below 1 KiB/s for 60 s), and the existing cancellation token is
   wired to a Cancel action in the dialog. Slow but moving transfers finish;
   stalled ones fail with a clear message.
2. **A larger fixed timeout (for example 10 minutes).** Simple, but still
   arbitrary: a large repository on a slow link fails, and a dead connection
   holds the dialog for the full window.
3. **Idle timeout from parsed `--progress` output.** Precise, but it needs a
   progress parser for clone, fetch, and push output formats; deferred.
   Progress display in the dialog can build on it later.

### Failed clone cleanup

Record whether the destination existed before the clone started. On failure,
timeout, or cancellation, remove the destination only when this clone created
it. Never delete a directory that existed beforehand.

### Reusing an existing destination

`reuse_existing_clone` rejects a repository with an unborn or placeholder
`HEAD` (`refs/heads/.invalid`) or without any commit. The error names the path
and says how to fix it ("An incomplete clone exists at <path>. Remove it or
choose another folder."), per `UI.md`'s actionable-error rule. Automatic
deletion of a pre-existing directory was rejected: it may hold user work.

### Unborn branches in the Git Manager

`gitManager.getRefs` represents an unborn or placeholder `HEAD` as "no
commits yet" instead of failing, so an empty repository renders instead of
erroring.

## UI

The clone dialog keeps the form while the clone runs, offers Cancel, and on
failure shows the server's message with the next step. It closes only after
the project is registered. It does not re-enable the Clone button over a
failed state without showing why.

## Validation

- Server: a clone whose transfer outlives 30 s succeeds (fixture remote
  served slowly); a stalled transfer fails with the stall message; a
  cancelled or failed clone removes only a destination it created and keeps
  a pre-existing one; reuse rejects `.invalid` and commit-less repositories
  with the actionable message; `getRefs` handles an unborn `HEAD`; fetch and
  push use the network driver.
- Web: the dialog shows progress state, Cancel, and the failure message.
- Live: clone a large repository over a throttled link on the dev server.
- Living docs: the Git section of `docs/architecture/overview.md`.

## Rulings after the implementation review (2026-09-24)

- **Transfers nobody can cancel stay bounded:** automatic fetch, `vcs.pull`,
  and the stacked-action and publish pushes (no Cancel wherever they start:
  chat header, Sidebar Update, Source Control panel, the Git Manager's Create PR
  dialog) keep the stall guard with a 10-minute bound (`for_bounded_transfer`),
  because SSH has no stall detection. Clone and the Git Manager operation
  stream's transfers keep the 24-hour safety bound with cancellation (the clone
  dialog's Cancel, the Git Manager operation banner's Cancel).
- **Retry after Cancel:** a clone into a destination that another clone is
  still using (running or being cleaned up) waits for it before reserving the
  folder, so an immediate retry does not report an incomplete clone; a retry
  behind a clone that succeeds reuses the finished clone.
- **Actionable copy:** "The transfer stalled (under 1 KB/s for 60 seconds).
  Check the connection to the remote and try again."; an existing non-repository
  folder, a file in the way, a folder inside another repository, and a folder
  that cannot be created each name the folder and the next step.
- **Placeholder HEAD in the Git Manager:** `getRefs` already returns a snapshot
  without a ref or commit; the web renders it as "No commits yet" with Fetch,
  and the Git Manager signal treats it as a state (recorded in the Git Manager
  design record).
- **Not routed:** the orchestration bootstrap fetch (its own runner and
  environment) and the Pull Requests checkout fetch (already on the 24-hour
  checkout budget); `ls-remote` reads keep their read budgets.
- **Residuals:** SSH transfers have no stall guard; a clone in flight at server
  shutdown is not cleaned up (the reuse check refuses the leftover); on
  Windows, removing a partial clone with read-only pack files may fail (the
  error names the folder); interrupting other inline Git RPCs kills only the
  top-level `git` process, so transport helpers can outlive the interrupt
  (pre-existing); a WebSocket reconnect cancels an in-flight clone and removes
  its folder, so long clones over flaky links must be retried; a pull or push
  still moving after 10 minutes fails with the generic timeout message.

## Side finding (not in scope)

Every native span in `server.trace.ndjson` has start equal to end
(`durationMs` 0), so Trace Diagnostics shows "0 ms" for real failures.
