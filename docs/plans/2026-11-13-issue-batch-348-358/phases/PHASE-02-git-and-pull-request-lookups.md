# Phase 2: Git lock limits, sign-in detector and pull-request lookups

- Goal: The #354 and #355 items of the spec (R21, R22, R23, R26 to R30) are fixed, recorded as limits in code, or decided by a test that stays as proof, with the server tests green.
- Round: 1
- Depends on: none
- Owns: `apps/server/src/git/process.rs`, `apps/server/src/git/sign_in.rs`, `apps/server/src/source_control/open_pull_request_lookups.rs`, `apps/server/src/source_control/pull_request.rs` (the file that holds `PullRequestService`), `apps/server/src/git/broadcaster.rs`, `apps/server/src/production/git_vcs.rs`, `apps/server/src/production/runtime.rs` (the quiesce step for lookups only; the spec names it `apps/server/src/runtime.rs`, which does not exist)
- Must not touch: `docs/skills/bibcode-profiler/references/events.md` and `docs/testing/cross-platform-validation.md` (Phase 9 owns every doc edit, including the doc line for the new quiesce step), `apps/server/src/production/worktree_catalog_rpc.rs`, `apps/server/src/terminal/**`, `apps/server/src/lifecycle.rs`
- Skills: `tdd` (red-green cycle for each behavior change), `mstack-diagnose` (R30 is decided by a test), `bibcode-profiler` (R26 to R28 touch the stop sequence and logging that profiler coverage watches)
- Read first: `AGENTS.md` (completion rules, profiler coverage, sensitive data); `docs/architecture/overview.md` section Profiler (what the stop sequence and `tracing` records must keep covering); `docs/plans/2026-11-13-issue-batch-348-358/spec.md` (D5 to D8 are binding); `docs/plans/2026-11-09-issue-batch-340-345-290/spec.md` requirements R15 to R17 (lock ownership rule the comments restate)
- Checkpoint: `cargo test -p bibcode-server --lib -j 2 -- open_pull_request_lookups:: sign_in:: pr_row_ a_failed_lookup index_lock_cleanup_ quiesce_in_` exits 0 and every listed filter runs at least one test; then `cargo fmt --all --check` and `cargo clippy -p bibcode-server --all-targets -- -D warnings` exit 0

Commands use the pinned toolchain (1.98.1) first on PATH, with `CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=line-tables-only CARGO_BUILD_JOBS=3`. Task order matters: 2.4, 2.5 and 2.6 all edit `open_pull_request_lookups.rs`, and 2.6 to 2.8 all edit `git_vcs.rs` and `broadcaster.rs`, so they run one after another.

Profiler coverage line for the final report: R26 adds a quiesce step before `git-writes` and before the profiler teardown (the step is timed by the existing `steps.mark` mechanism, so a slow step reaches `server.stop` through `slowSteps`); R27 adds one `tracing::warn!` with no URL, path or branch; nothing else in this phase spawns a process, adds an RPC method, removes a worktree or emits an event.

## Tasks

### Task 2.1: Record the pull limit at takes_index_lock

- Satisfies: R21 (D5): `pull` stays out of the lock list and the comment says why.
- Depends on: none
- Files: modify `apps/server/src/git/process.rs`
- Interfaces: consumes `fn takes_index_lock(args: &[OsString]) -> bool` (the `_ => false` arm with the comment "`pull` holds no lock while it fetches"); produces nothing other tasks use
- Skills: none
- Read first: `apps/server/src/git/process.rs` (`takes_index_lock`, `IndexLockWatch::after_forced_stop`, `holds_open`, `WriteSettlement::clean_up`)
- Tier: cheap
- TDD: exempt (comment only, no behavior)
- Done when: `rg -n "shortcut: pull" apps/server/src/git/process.rs` exits 0 and prints the new comment line; `cargo test -p bibcode-server --lib index_lock_cleanup_lists_only_commands_that_take_the_lock -j 2` exits 0 (the existing test already asserts that unlisted commands stay unlisted)

Steps

1. [ ] Replace the one-line comment above the `_ => false` arm with a comment that starts `// shortcut: pull is unlisted on purpose (D5),` and states three facts: its merge child, not the root, holds `index.lock`; `holds_open` looks only at the root's process id on Linux and macOS, so a listed `pull` could never pass the ownership check there; on Windows a listed `pull` would arm the 2-second rule during the fetch, which holds no lock, and could remove a foreign lock. End with `upgrade when holds_open covers the process group and Windows can check ownership`.
2. [ ] Run `cargo test -p bibcode-server --lib index_lock_cleanup_lists_only_commands_that_take_the_lock -j 2`. Expected: PASS (1 test).
3. [ ] Run `rg -n "shortcut: pull" apps/server/src/git/process.rs`. Expected: one match.
4. [ ] Run `cargo fmt --all --check`. Expected: no output, exit 0.

### Task 2.2: Record the hook limit at the forced-stop cleanup

- Satisfies: R22: the comment says a lock taken while a hook runs is kept on Linux and macOS and that Windows can still remove a foreign lock; the existing test is the proof.
- Depends on: 2.1 (same file)
- Files: modify `apps/server/src/git/process.rs`
- Interfaces: consumes `WriteSettlement::clean_up` (the `cfg!(any(target_os = "linux", target_os = "macos")) && report.before_force != Some(true)` guard) and the test `index_lock_cleanup_keeps_a_lock_another_git_took_during_a_forced_write`; produces nothing
- Skills: none
- Read first: `apps/server/src/git/process.rs` (`holds_open` doc comment: Git closes the lock while a hook or the editor runs)
- Tier: cheap
- TDD: exempt (comment only, no behavior)
- Done when: `rg -n "hook" apps/server/src/git/process.rs | rg "R22"` exits 0 and prints the new comment; `cargo test -p bibcode-server --lib index_lock_cleanup_keeps_a_lock_another_git_took_during_a_forced_write -j 2` exits 0 with 1 test passed

Steps

1. [ ] Extend the comment above the `if cfg!(any(target_os = "linux", target_os = "macos")) && report.before_force != Some(true)` guard in `clean_up` with a paragraph tagged `R22`: a write stopped by force while a hook runs holds no open lock, so on Linux and macOS a lock another Git process took meanwhile is kept, proven by `index_lock_cleanup_keeps_a_lock_another_git_took_during_a_forced_write`; the cost is that a lock the killed Git itself left during a hook also stays; on Windows the 2-second rule has no ownership check and can still remove a foreign lock.
2. [ ] Run `cargo test -p bibcode-server --lib index_lock_cleanup_keeps_a_lock_another_git_took_during_a_forced_write -j 2`. Expected: PASS (1 test).
3. [ ] Run `rg -n "R22" apps/server/src/git/process.rs`. Expected: one match.
4. [ ] Run `cargo fmt --all --check`. Expected: exit 0.

### Task 2.3: Anchor the sign-in detector to Git's fatal line

- Satisfies: R23: only a line that starts with `fatal:` and holds both phrases counts; a commit message or hook output that holds both phrases elsewhere does not.
- Depends on: none
- Files: modify `apps/server/src/git/sign_in.rs`; test `apps/server/src/git/sign_in.rs` (module `tests`)
- Interfaces: consumes `pub fn has_missing_username_refusal(detail: &str) -> bool` with callers `ExecutionPlace::push_guidance(&self, git_detail: &str) -> Option<String>`, `operations.rs::remote_push_guidance` (passes `error.outputs.last()?.stderr`) and `git_vcs.rs` (passes the wire `detail`); produces the same signature with the anchored rule
- Skills: `tdd` (the detector's behavior changes)
- Read first: `apps/server/src/git/sign_in.rs` (detector and test `detects_the_missing_username_refusal_only_with_prompts_disabled`); `apps/server/src/git/manager/operations.rs` (`remote_push_guidance`); `apps/server/src/production/git_vcs.rs` (the `failed_phase == Some("push")` block in the stacked-action stream) and `apps/server/src/git/repository.rs` (`actionable_git_failure`)
- Tier: standard
- TDD: red-green
- Done when: `cargo test -p bibcode-server --lib sign_in:: -j 2` exits 0 with the new test listed as passed

Steps

1. [ ] Settle the input question first and write the finding into the doc comment of `has_missing_username_refusal`. Read both callers. Finding from the code read for this plan: neither joins lines. `operations.rs` passes the raw `stderr` of the last Git output. `git_vcs.rs` passes the wire `detail`, which comes from `actionable_git_failure` and is the redacted, trimmed stderr, still multi-line. The `{detail} {note}` join in `git_vcs.rs` is built after the detector runs and is not an input. Git progress output separates updates with a carriage return, so the fatal line can follow a progress update after `\r` and not after `\n`. Re-read both files; if either now joins lines, add that separator to the split in step 4.
2. [ ] Write the failing test `the_missing_username_refusal_needs_a_fatal_line` in `apps/server/src/git/sign_in.rs` asserting: (a) `has_missing_username_refusal("fix: could not read Username and terminal prompts disabled")` is false; (b) a hook output line `hook: could not read username ... terminal prompts disabled` inside a multi-line text is false; (c) a text whose first line is `Writing objects: 50%\rfatal: could not read Username for 'https://gitlab.example.test': terminal prompts disabled` is true; (d) `"   FATAL: Could not read Username for 'https://gitlab.example.test': Terminal Prompts Disabled\r\n"` is true; (e) a `fatal:` line holding only one phrase is false; (f) the existing `MISSING_USERNAME` constant still passes.
3. [ ] Run `cargo test -p bibcode-server --lib sign_in::tests::the_missing_username_refusal_needs_a_fatal_line -j 2`. Expected: FAIL on assertion (a) or (b) (the old detector accepts them).
4. [ ] Implement in `sign_in.rs`: `detail.split(['\n', '\r']).any(|line| { let line = line.trim_start().to_ascii_lowercase(); line.starts_with("fatal:") && line.contains("could not read username") && line.contains("terminal prompts disabled") })`. Keep `#[must_use]` and the signature.
5. [ ] Run `cargo test -p bibcode-server --lib sign_in:: -j 2`. Expected: PASS, including `detects_the_missing_username_refusal_only_with_prompts_disabled` and the push-guidance tests in `git/manager/operations/sign_in_tests.rs` run by `cargo test -p bibcode-server --lib sign_in_tests -j 2`.
6. [ ] Prove the test can fail: remove the `starts_with("fatal:")` condition, then run `cargo test -p bibcode-server --lib sign_in::tests::the_missing_username_refusal_needs_a_fatal_line -j 2`. Expected: FAIL. Restore the condition and run it again. Expected: PASS.
7. [ ] Run `cargo fmt --all --check` and `cargo clippy -p bibcode-server --all-targets -- -D warnings`. Expected: no errors.

### Task 2.4: Wait for running lookups at quiesce

- Satisfies: R26: quiesce waits for every running lookup before the profiler teardown; a lookup admitted after shutdown ends at once as cancelled.
- Depends on: none
- Files: modify `apps/server/src/source_control/open_pull_request_lookups.rs`; modify `apps/server/src/source_control/pull_request.rs`; modify `apps/server/src/production/git_vcs.rs`; modify `apps/server/src/production/runtime.rs`; test `apps/server/src/source_control/open_pull_request_lookups.rs` and `apps/server/src/production/runtime.rs`
- Interfaces:
  - consumes `OpenPullRequestLookups::admit` (the bare `tokio::spawn` of the shared lookup), `Slot::InFlight { id, lease, result }`, `PullRequestService.open_lookups: Arc<OpenPullRequestLookups>`, `tokio_util::task::TaskTracker`
  - produces `OpenPullRequestLookups::shutdown(&self) -> impl Future<Output = ()>` (`pub(crate) async fn shutdown(&self)`): marks the set closed, cancels the cancellation token of every in-flight lookup, closes a `TaskTracker` and waits for it; safe to call twice; after it, `resolve` returns `None` without calling `load`
  - produces `PullRequestService::shutdown_open_pull_request_lookups(&self)` (`pub async fn`), calling the above
  - produces `GitVcsRpcServices::pull_requests(&self) -> PullRequestService` (`pub(crate)`, a clone; the runtime calls it after every builder, because `with_hosting_executable_dir_for_integration_test` replaces the service)
  - produces the quiesce step name `pull-request-lookups`, marked with `steps.mark("pull-request-lookups")` directly after `steps.mark("status-broadcaster")` and before `worktree-catalog-operations`, so it runs before `git-writes` and before `profiler-end-session`. Phase 9 copies this exact name into `events.md` (position: after `status-broadcaster`)
- Skills: `tdd` (new shutdown behavior), `bibcode-profiler` (stop sequence and teardown order must stay covered)
- Read first: `apps/server/src/source_control/open_pull_request_lookups.rs` (module doc, `admit`, `settle`, the `Loader` test helper); `apps/server/src/production/runtime.rs` (`quiesce_for_update` from `mcp_control` to `profiler-end-session`, test `index_lock_cleanup_quiesce_stops_a_running_git_write`); `apps/server/src/source_control/pull_request.rs` (`resolve_current_optional_shared`, `run_provider_os_with_allowed_exit_codes`)
- Tier: most capable
- TDD: red-green
- Done when: `cargo test -p bibcode-server --lib open_pull_request_lookups::tests::shutdown_ -j 2` exits 0 with at least 3 tests, and `cargo test -p bibcode-server --lib production::runtime::tests::quiesce_in_ -j 2` exits 0 including the new `quiesce_in_waits_for_a_running_pull_request_lookup`

Steps

1. [ ] Settle where the `gh` child is reaped. Finding from the code read for this plan: the flight future calls `PullRequestService::resolve_current_optional`, which awaits `self.runner.run(ProcessRequest { .. }, cancellation)` in `run_provider_os_with_allowed_exit_codes`. The supervised runner kills and reaps the child inside that awaited call when the flight's token is cancelled. So the child is reaped inside the detached flight task, and joining that task is enough; nothing else needs tracking. Record this finding in the doc comment of `OpenPullRequestLookups::shutdown`. Re-read both functions; if the runner instead hands the reap to a background task, join that too and say so in the comment.
2. [ ] Write the failing tests in the `tests` module of `open_pull_request_lookups.rs`: Expected: the tests below compile and are the ones the next step runs.
   - `shutdown_waits_for_a_lookup_that_ends_late`: a loader that, once its flight token is cancelled, waits 200 ms (use `tokio::time::sleep`, paused clock, `#[tokio::test(start_paused = true)]`) and then sets an `ended` flag; start `resolve` on a spawned task, wait for the run, call `lookups.shutdown().await`; assert `ended` is true when `shutdown` returns.
   - `shutdown_cancels_a_lookup_nobody_leaves`: the waiter is still waiting when `shutdown` is called; assert the loader saw its cancellation and the waiter got `None`.
   - `a_lookup_admitted_after_shutdown_ends_as_cancelled`: after `shutdown`, `resolve` returns `None` and `loader.runs() == 0`.
3. [ ] Write the failing runtime test `quiesce_in_waits_for_a_running_pull_request_lookup` in the `tests` module of `production/runtime.rs`, copying the shape of `index_lock_cleanup_quiesce_stops_a_running_git_write`: start a lookup through `runtime`'s `GitVcsRpcServices::pull_requests()` with a fake forge command that ignores its first TERM for 200 ms, call `runtime.quiesce_for_update().await`, assert the fake command has exited and `quiesce_for_update` returned `Ok`. Gate with `#[cfg(unix)]` like its neighbors.
4. [ ] Run `cargo test -p bibcode-server --lib open_pull_request_lookups::tests::shutdown_ -j 2`. Expected: FAIL to compile (`no method named shutdown`). Add a stub `pub(crate) async fn shutdown(&self) {}` and run again. Expected: FAIL on `ended` being false.
5. [ ] Implement in `open_pull_request_lookups.rs`: add `tasks: TaskTracker` and a `closed` flag in `State`; store each flight's `CancellationToken` in `Slot::InFlight`; spawn the shared lookup with `self.tasks.spawn(..)` instead of `tokio::spawn(..)` (the uncoalesced no-room path goes through the same spawn); in `admit`, when `closed` is true return a new `Admission::Closed`, which `resolve` maps to `None` before `load` is called; `shutdown` sets `closed`, cancels every in-flight token, calls `tasks.close()`, then `tasks.wait().await`. Add `PullRequestService::shutdown_open_pull_request_lookups` in `pull_request.rs` and `GitVcsRpcServices::pull_requests` in `git_vcs.rs`.
6. [ ] Implement in `runtime.rs`: add a field `pull_requests: crate::source_control::PullRequestService` to the runtime struct, filled from `git_vcs.pull_requests()` after the last builder call; in `quiesce_for_update`, after `self.status_broadcaster.shutdown().await; steps.mark("status-broadcaster");` add `self.pull_requests.shutdown_open_pull_request_lookups().await; steps.mark("pull-request-lookups");`. Order after the status broadcaster is deliberate: streams that hold leases are stopped first, so the cancelled lookups have no waiters left.
7. [ ] Run `cargo test -p bibcode-server --lib open_pull_request_lookups:: -j 2` and `cargo test -p bibcode-server --lib production::runtime::tests::quiesce_in_ -j 2`. Expected: PASS. Also run `cargo test -p bibcode-server --lib production::git_vcs::tests::a_lookup_past_the_refresh_bound_stops_at_quiesce -j 2`. Expected: PASS.
8. [ ] Prove the tests can fail: replace `self.tasks.spawn(..)` with `tokio::spawn(..)`, then run `cargo test -p bibcode-server --lib open_pull_request_lookups::tests::shutdown_waits_for_a_lookup_that_ends_late -j 2`. Expected: FAIL. Restore it and run again. Expected: PASS.
9. [ ] Check the order in the source: `rg -n 'steps.mark\("(status-broadcaster|pull-request-lookups|git-writes|profiler-end-session)"\)' apps/server/src/production/runtime.rs`. Expected: the four names in exactly that order.
10. [ ] Run `cargo fmt --all --check` and `cargo clippy -p bibcode-server --all-targets -- -D warnings`. Expected: no errors.

### Task 2.5: Remember a failed lookup for 5 seconds

- Satisfies: R27 (D6): the same key answers with the failure for 5 seconds without a new lookup; a cancelled lookup is never remembered as failed; an invalidation clears it; the failure is logged once at `warn` without the remote's URL.
- Depends on: 2.4 (same file and the same `Slot` enum)
- Files: modify `apps/server/src/source_control/open_pull_request_lookups.rs`; modify `apps/server/src/production/git_vcs.rs` (test `a_failed_lookup_is_not_remembered_as_no_pull_request` only); test `apps/server/src/source_control/open_pull_request_lookups.rs`
- Interfaces: consumes `Slot`, `settle(&self, key: &LookupKey, id: u64, outcome: &LookupResult)`, `LookupResult = Result<Option<ResolvedPullRequest>, SourceControlProviderError>` (the error is `Clone`); produces `pub(crate) const OPEN_PULL_REQUEST_FAILURE_BACKOFF: Duration = Duration::from_secs(5)`, a new variant `Slot::Failed { error: SourceControlProviderError, expires_at: Instant }`, a new variant `Admission::Failed(SourceControlProviderError)` that `resolve` returns as `Some(Err(error))`. `with_limits(ttl, capacity)` keeps its signature
- Skills: `tdd` (new backoff behavior), `bibcode-profiler` (the warn record must hold no URL, path or branch)
- Read first: `apps/server/src/source_control/open_pull_request_lookups.rs` (`admit`, `settle`, `make_room`, test `failures_are_shared_with_waiters_but_never_stored`); `apps/server/src/production/git_vcs.rs` (test `a_failed_lookup_is_not_remembered_as_no_pull_request`)
- Tier: most capable
- TDD: red-green
- Done when: `cargo test -p bibcode-server --lib open_pull_request_lookups:: -j 2` exits 0 with the new tests listed, and `cargo test -p bibcode-server --lib production::git_vcs::tests::a_failed_lookup -j 2` exits 0

Steps

1. [ ] Write the failing tests in `open_pull_request_lookups.rs`, all with `#[tokio::test(start_paused = true)]`:
   - `a_failed_lookup_answers_from_memory_for_five_seconds`: first `resolve` returns `Some(Err(failure()))` with `loader.runs() == 1`; a second `resolve` at +4 s returns `Some(Err(failure()))` with `runs() == 1`; at +5 s plus 1 ms a third `resolve` runs the loader again (`runs() == 2`).
   - `a_cancelled_lookup_is_not_remembered_as_failed`: a gated loader whose waiter is cancelled so the flight token is cancelled and the loader returns `Err(failure())`; the next `resolve` runs the loader (`runs() == 2`).
   - `an_invalidation_clears_a_remembered_failure`: after a failure, `lookups.invalidate(path)`, then `resolve` runs the loader again.
   - `a_failed_lookup_warns_once_without_the_remote_address`: capture `tracing` output at `WARN` with `tracing::subscriber::set_default` and a local `CapturedLog` writer (copy the shape used in the `tests` module of `production/runtime.rs`); a failure whose `detail` and `cwd` hold `https://gitlab.example.test/example-group/sample-project` and `/work/sample-project` is resolved twice inside the backoff; assert exactly one WARN line, and that it contains neither `gitlab.example.test` nor `sample-project`.
2. [ ] Update the existing test `failures_are_shared_with_waiters_but_never_stored`: it must keep proving that waiters share one run, and its last assertion changes from "a failure must not be remembered" to `recovered.runs() == 0` inside 5 s, then `recovered.runs() == 1` after `tokio::time::advance(Duration::from_secs(5))`. Update `a_failed_lookup_is_not_remembered_as_no_pull_request` in `git_vcs.rs` to call `fixture.services.pull_requests.invalidate_open_pull_request_lookups(&fixture.repository)` between `clear("fail")` and the second refresh (a push, a mutation or a local change does this in production); its name and meaning stay: a failure is not stored as "no pull request". Expected: both updated tests compile and fail in the next run until the backoff exists.
3. [ ] Run `cargo test -p bibcode-server --lib open_pull_request_lookups:: -j 2`. Expected: FAIL on `a_failed_lookup_answers_from_memory_for_five_seconds` with `left: 2, right: 1` (the second call ran the loader).
4. [ ] Implement: in `settle`, take `cancelled: bool` (the flight token's `is_cancelled()` read in the spawned task before `settle`); for `Err(error)` with `!cancelled` and the key still owned by this flight, set `Slot::Failed { error: error.clone(), expires_at: Instant::now() + OPEN_PULL_REQUEST_FAILURE_BACKOFF }`; with `cancelled`, remove the entry as today. In `admit`, a `Slot::Failed` whose `expires_at > now` returns `Admission::Failed(error.clone())`; an expired one falls through to a new lookup. In `make_room`, keep an unexpired `Failed` entry and count it among the entries removed by expiry or by the closest-to-expiring rule. Log in the spawned task, once per lookup that ended with an uncancelled `Err`: `tracing::warn!(provider = ?key.provider, "open pull-request lookup failed; answering with the failure for 5 seconds")`. Do not log the error, cwd, reference or command.
5. [ ] Run `cargo test -p bibcode-server --lib open_pull_request_lookups:: -j 2` and `cargo test -p bibcode-server --lib production::git_vcs::tests::pr_ -j 2`. Expected: PASS (`pr_row_a_failed_lookup_keeps_the_pull_request` still passes: the stream shows the request after a failure).
6. [ ] Prove the tests can fail: make `settle` store `Slot::Failed` for a cancelled flight too, then run `cargo test -p bibcode-server --lib open_pull_request_lookups::tests::a_cancelled_lookup_is_not_remembered_as_failed -j 2`. Expected: FAIL. Restore it and run again. Expected: PASS.
7. [ ] Run `cargo fmt --all --check` and `cargo clippy -p bibcode-server --all-targets -- -D warnings`. Expected: no errors.

### Task 2.6: Stop showing a remembered pull request after a failed lookup on stale data

- Satisfies: R28 (D7): a failed lookup, with the last success for that branch more than 5 minutes old, clears the remembered request; without a failed lookup it stays however old; a ref change clears it as today.
- Depends on: 2.5 (the failure signal is the same; both edit `git_vcs.rs`)
- Files: modify `apps/server/src/git/broadcaster.rs`; modify `apps/server/src/production/git_vcs.rs`; test `apps/server/src/git/broadcaster.rs`
- Interfaces:
  - consumes `GitBroadcaster::record_pull_request(&self, cwd: &Path, ref_name: Option<&str>, pull_request: Option<ChangeRequest>)`, `known_pull_request`, `RepositoryState`, `clear_remote_for_ref_change`, and in `git_vcs.rs` `lookup_open_pull_request(...) -> Option<Option<ChangeRequest>>` whose `None` means failed or cancelled
  - produces `RepositoryState.pr_recorded_at: Option<tokio::time::Instant>`, set by `record_pull_request` on every success (including "no open request") and cleared in `clear_remote_for_ref_change`
  - produces `pub(crate) const PULL_REQUEST_STALE_AFTER: Duration = Duration::from_secs(300)` in `broadcaster.rs`
  - produces `pub(crate) fn note_failed_pull_request_lookup(&self, cwd: &Path, ref_name: Option<&str>)`: when `ref_name` matches, `pr_recorded_at` is older than `PULL_REQUEST_STALE_AFTER` and a request is remembered, sets the remembered `remote.pr` to `None`; then it requests a republish the way `notify_pull_request_change` does so streams show the cleared state
- Skills: `tdd` (new expiry behavior)
- Read first: `apps/server/src/git/broadcaster.rs` (`record_pull_request`, `known_pull_request`, `keep_pull_request`, `clear_remote_for_ref_change`, test `a_snapshot_under_a_new_epoch_keeps_the_known_pull_request`); `apps/server/src/production/git_vcs.rs` (the `Ok(None)` and `Err(_)` arms of `vcs.refreshStatus`, and the `found` arm of the status stream loop)
- Tier: most capable
- TDD: red-green
- Done when: `cargo test -p bibcode-server --lib git::broadcaster::tests::a_failed_lookup_ -j 2` exits 0 with the new tests listed, and `cargo test -p bibcode-server --lib production::git_vcs::tests::pr_row_ -j 2` exits 0

Steps

1. [ ] Decide how the callers tell failure from cancellation, and write it in the doc comment of `note_failed_pull_request_lookup`. In the status stream, `found` is `Ok(None)` for both a failed lookup and one cancelled by `task_token`; count it as a failure only when `finished.cancellation.is_cancelled()` is false. In `vcs.refreshStatus`, the inner lookup runs under a token nothing cancels, so `Ok(None)` from the timeout wrapper's inner result is a failure; the outer `cancellation.cancelled()` arm produces `Ok(None)` of the select (not the lookup) and is not a failure. Re-read both arms and adjust if the shapes differ.
2. [ ] Write the failing tests in `broadcaster.rs` (`#[tokio::test(start_paused = true)]`, copying the setup of `a_snapshot_under_a_new_epoch_keeps_the_known_pull_request`):
   - `a_failed_lookup_clears_a_request_recorded_six_minutes_ago`: record a request, `tokio::time::advance(360 s)`, call `note_failed_pull_request_lookup`; `known_pull_request` returns `None`.
   - `a_failed_lookup_keeps_a_request_recorded_four_minutes_ago`: same with 240 s; still `Some`.
   - `a_request_recorded_six_minutes_ago_stays_without_a_failed_lookup`: advance 360 s and call only `known_pull_request`; `Some`.
   - `a_failed_lookup_for_a_former_branch_clears_nothing`: `ref_name` differs; still `Some`.
   - `a_ref_change_clears_the_recorded_time`: after `clear_remote_for_ref_change`, a later failure on the new ref has no stale stamp to compare (no request shown, no panic).
3. [ ] Run `cargo test -p bibcode-server --lib git::broadcaster::tests::a_failed_lookup_ -j 2`. Expected: FAIL to compile (`no method named note_failed_pull_request_lookup`). Add a stub that does nothing and run again. Expected: FAIL on the six-minute test (the request is still `Some`).
4. [ ] Implement in `broadcaster.rs` the field, the constant and the method from Interfaces; `record_pull_request` sets `entry.pr_recorded_at = Some(Instant::now())` under the same `ref_name` filter it already applies. `keep_pull_request` needs no change: it copies a cached request only when the new remote has none, and the cache now holds `None` after expiry.
5. [ ] Call `note_failed_pull_request_lookup` from both `git_vcs.rs` sites chosen in step 1, in the stream arm before `shown.reconcile`, and in `vcs.refreshStatus` where `Ok(None)` is matched.
6. [ ] Add a stream test next to `pr_row_a_failed_lookup_keeps_the_pull_request` named `pr_row_a_failed_lookup_after_six_minutes_clears_the_pull_request`: `Fixture` with a paused or advanced clock, the subscriber shows request 42, advance 6 minutes, `fixture.set("fail", "")`, `fixture.services.pull_requests.invalidate_open_pull_request_lookups(..)`, `fixture.report_pull_request_change()`; the subscriber later shows `pr().is_null()`. If `Fixture` cannot advance the broadcaster's clock, add a `#[cfg(test)]` setter `set_pull_request_recorded_at_for_test(&self, cwd, Instant)` on `GitBroadcaster` and use it.
7. [ ] Run `cargo test -p bibcode-server --lib git::broadcaster::tests::a_failed_lookup_ -j 2` and `cargo test -p bibcode-server --lib production::git_vcs::tests::pr_row_ -j 2`. Expected: PASS.
8. [ ] Prove the tests can fail: change the comparison to `>=` the wrong way (clear when the stamp is younger than 300 s), then run `cargo test -p bibcode-server --lib git::broadcaster::tests::a_failed_lookup_keeps_a_request_recorded_four_minutes_ago -j 2`. Expected: FAIL. Restore it and run again. Expected: PASS.
9. [ ] Run `cargo fmt --all --check` and `cargo clippy -p bibcode-server --all-targets -- -D warnings`. Expected: no errors.

### Task 2.7: Record the limit at spawn_for_subscribers

- Satisfies: R29 (D8): the doc comment states that a late lookup with no status subscriber is dropped on purpose.
- Depends on: 2.6 (same file)
- Files: modify `apps/server/src/git/broadcaster.rs`
- Interfaces: consumes `pub(crate) fn spawn_for_subscribers(&self, cwd: &Path, task: impl Future<Output = ()> + Send + 'static)`; produces nothing
- Skills: none
- Read first: `apps/server/src/git/broadcaster.rs` (`spawn_for_subscribers`); `apps/server/src/production/git_vcs.rs` (its only caller, the `Err(_)` arm of `vcs.refreshStatus`)
- Tier: cheap
- TDD: exempt (comment only, no behavior)
- Done when: `rg -n "D8" apps/server/src/git/broadcaster.rs` exits 0 and prints the new comment line

Steps

1. [ ] Extend the doc comment of `spawn_for_subscribers` with: `shortcut: with no status subscriber the late lookup is dropped (D8). Nothing would show its answer, and the next refresh asks again. A refresh with no subscriber therefore never warms the remembered request. Upgrade only if a caller needs the answer without a stream.`
2. [ ] Run `rg -n "D8" apps/server/src/git/broadcaster.rs`. Expected: one match.
3. [ ] Run `cargo fmt --all --check`. Expected: exit 0.

### Task 2.8: Decide by test whether a status-neutral local change leaves a stale answer

- Satisfies: R30: a stream test invalidates during a lookup with a local change that alters no status; if the pre-invalidation answer is shown with no follow-up lookup, a follow-up lookup is started; otherwise the test stays as proof.
- Depends on: 2.6 (same files)
- Files: modify `apps/server/src/production/git_vcs.rs` (test; code only in the defect branch); modify `apps/server/src/git/broadcaster.rs` (defect branch only); test `apps/server/src/production/git_vcs.rs`
- Interfaces: consumes `Fixture`, `subscriber_showing_the_pull_request`, `wait_for_lookups`, `fixture.set`, `fixture.clear`, `GitBroadcaster::notify_local_change(&self, cwd: &Path)` (async), `GitBroadcaster::notify_pull_request_change(&self, cwd: &Path)` (async); produces the test `a_neutral_local_change_during_a_lookup_replaces_its_outdated_answer`
- Skills: `mstack-diagnose` (the test decides between defect and no defect), `tdd` (defect branch only)
- Read first: `apps/server/src/production/git_vcs.rs` (test `a_local_change_during_a_lookup_replaces_its_outdated_answer`, which writes `saved.txt` and so changes status; `observe_local_changes`; the `publication` arm of the status stream loop that sets `look_again`); `apps/server/src/git/broadcaster.rs` (`notify_local_change`, `reconcile_remote_after_local_publication`)
- Tier: most capable
- TDD: red-green
- Done when: `cargo test -p bibcode-server --lib production::git_vcs::tests::a_neutral_local_change_during_a_lookup_replaces_its_outdated_answer -j 2` exits 0, and the outcome line (defect fixed or no defect) is written in the pull request notes for #355

Steps

1. [ ] Write the test by copying `a_local_change_during_a_lookup_replaces_its_outdated_answer` with one change: after `fixture.clear("open")` do not write `saved.txt`; call `fixture.services.broadcaster.notify_local_change(&fixture.repository).await` with the working tree untouched, so the local status is byte-identical. Assert that within the helper's wait the subscriber's `pr()` becomes null and `fixture.lookups()` equals `["main", "main", "main"]`.
2. [ ] Run `cargo test -p bibcode-server --lib production::git_vcs::tests::a_neutral_local_change_during_a_lookup_replaces_its_outdated_answer -j 2`. Expected: PASS means no defect and FAIL means the defect branch; the next steps say what follows each.
3. [ ] If the result is PASS: this is the no-defect branch. The status owner publishes a neutral change, or the stream loop starts a follow-up lookup, so nothing changes in code. Keep the test, add the sentence `Decided by test (R30): no defect; a status-neutral local change still starts one follow-up lookup.` to the test's doc comment, and stop.
4. [ ] If the result is FAIL because the subscriber keeps showing request 42 and the lookup count stays at 2: this is the defect branch (a neutral change publishes nothing, so `look_again` is never set). Fix at the first wrong decision: in `observe_local_changes` and the local-change closure in `GitVcsRpcServices`, after `invalidate_open_pull_request_lookups`, call `broadcaster.notify_pull_request_change(cwd)` for the observer path as the closure at the `handle.spawn` site already does, so every invalidation also asks each stream to look again. Re-run the test. Expected: PASS.
5. [ ] In the defect branch also run `cargo test -p bibcode-server --lib production::git_vcs::tests::pr_ -j 2` and `cargo test -p bibcode-server --lib production::git_vcs::tests::a_ -j 2`. Expected: PASS (no other stream test now counts an extra lookup; if one does, change its expected `fixture.lookups()` only where the extra lookup follows a real invalidation).
6. [ ] In the defect branch prove the test can fail: remove the added `notify_pull_request_change` call, then run the test. Expected: FAIL. Restore it and run again. Expected: PASS.
7. [ ] Run `cargo fmt --all --check` and `cargo clippy -p bibcode-server --all-targets -- -D warnings`. Expected: no errors.
