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
6. [ ] Prove the test can fail: revert this task's change by hand (put the old two-`contains` body back, keeping the test) and run `cargo test -p bibcode-server --lib sign_in::tests::the_missing_username_refusal_needs_a_fatal_line -j 2`. Expected: FAIL on assertion (a) or (b). Restore the anchored detector and run it again. Expected: PASS.
7. [ ] Run `cargo fmt --all --check` and `cargo clippy -p bibcode-server --all-targets -- -D warnings`. Expected: no errors.

### Task 2.4: Wait for running lookups at quiesce

- Satisfies: R26: quiesce waits for every running lookup before the profiler teardown, whether or not its cache entry still exists; a lookup admitted after shutdown ends at once as cancelled.
- Depends on: none
- Files: modify `apps/server/src/source_control/open_pull_request_lookups.rs`; modify `apps/server/src/source_control/pull_request.rs`; modify `apps/server/src/production/git_vcs.rs`; modify `apps/server/src/production/runtime.rs`; test `apps/server/src/source_control/open_pull_request_lookups.rs` and `apps/server/src/production/git_vcs.rs`
- Interfaces:
  - consumes `OpenPullRequestLookups::admit` (the bare `tokio::spawn` of the shared lookup and the `flight_cancellation = CancellationToken::new()`), `FlightLease` (its `Drop` cancels the flight token), `Slot::InFlight { id, lease, result }`, `invalidate` (removes entries, in-flight ones included, so the flight keeps running with no entry), `make_room` and the capacity check (`state.entries.len() < state.capacity`; when full the flight runs with no entry), `OpenPullRequestLookups::resolve(self: &Arc<Self>, key: LookupKey, canonical_cwd: PathBuf, cancellation: &CancellationToken, load: F) -> Option<LookupResult>`, `LookupResult = Result<Option<ResolvedPullRequest>, SourceControlProviderError>`, `tokio_util::task::TaskTracker`
  - produces a root `shutdown: CancellationToken` and a `tasks: TaskTracker` as fields of `OpenPullRequestLookups` (outside the `Mutex<State>`). Every flight token is created as `self.shutdown.child_token()` in `admit`, before and independent of whether an entry is inserted, so shutdown reaches an invalidated flight and a flight started with no cache room. The lease still cancels only its own child token
  - produces `pub(crate) async fn shutdown(&self)` on `OpenPullRequestLookups`: cancels `shutdown`, calls `tasks.close()`, then `tasks.wait().await`; safe to call twice
  - the cancelled result is the existing type `Option<LookupResult>` with the value `None`: `resolve` returns `None` when `shutdown` is cancelled (a new first `biased` arm `() = self.shutdown.cancelled() => None` in its `select!`, and `Admission::Closed` from `admit` once `shutdown.is_cancelled()`, without calling `load`). `PullRequestService::resolve_current_optional_shared` already maps `None` to its "The pull-request lookup was cancelled." `SourceControlProviderError`. A flight that ends after shutdown still sends the loader's own outcome on its watch channel, but no waiter reads it
  - R27 (Task 2.5) never stores a cancelled flight's outcome: `settle` receives `cancelled = flight_cancellation.is_cancelled()`, which is true after a lease drop and after shutdown (a child token is cancelled with its parent)
  - produces `PullRequestService::shutdown_open_pull_request_lookups(&self)` (`pub async fn`) calling the above
  - produces `GitVcsRpcServices::pull_requests(&self) -> PullRequestService` (`pub(crate)`, a clone; the runtime calls it after every builder, because `with_hosting_executable_dir_for_integration_test` replaces the service)
  - every user of the shared cache, found with `rg "resolve_current_optional_shared|open_lookups"`: `lookup_open_pull_request` in `git_vcs.rs` (called from `vcs.refreshStatus`, its late callback, and the status stream's `start_lookup`); the `GitStatusSummaryService` holds a clone of the same `PullRequestService` and shares the `Arc`; `PullRequestService::invalidate_open_pull_request_lookups` (callers: `observe_local_changes`, the local-change closure near the `handle.spawn` site in `git_vcs.rs`, and `create_with_options` in `pull_request.rs`) stays valid after shutdown. `GitManagerRpcServices` builds its own `PullRequestService::default()` and never calls the shared lookup, so it needs no shutdown
  - produces the quiesce step name `pull-request-lookups`, marked with `steps.mark("pull-request-lookups")` directly after `steps.mark("status-broadcaster")` and before `worktree-catalog-operations`, so it runs before `git-writes` and before `profiler-end-session`. Phase 9 copies this exact name into `events.md` (position: after `status-broadcaster`)
- Skills: `tdd` (new shutdown behavior), `bibcode-profiler` (stop sequence and teardown order must stay covered)
- Read first: `apps/server/src/source_control/open_pull_request_lookups.rs` (module doc, `admit`, `settle`, `invalidate`, `make_room`, the `Loader` test helper whose gated mode returns `Err(failure())` at once on cancellation); `apps/server/src/production/runtime.rs` (`quiesce_for_update` from `mcp_control` to `profiler-end-session`); `apps/server/src/source_control/pull_request.rs` (`resolve_current_optional_shared`, `run_provider_os_with_allowed_exit_codes`); `apps/server/src/production/git_vcs.rs` (`Fixture`, `FAKE_GH`, `a_forge_cli_is_running`, test `a_lookup_past_the_refresh_bound_stops_at_quiesce`)
- Tier: most capable
- TDD: red-green
- Done when: `cargo test -p bibcode-server --lib -j 2 -- open_pull_request_lookups::tests::shutdown_` exits 0 with five tests passed (`shutdown_waits_for_a_lookup_that_ends_late`, `shutdown_stops_an_invalidated_flight`, `shutdown_stops_a_flight_that_had_no_cache_room`, `shutdown_ends_a_retained_waiter_as_cancelled`, `shutdown_refuses_a_new_lookup`), `cargo test -p bibcode-server --lib -j 2 -- production::git_vcs::tests::pull_request_lookup_shutdown_` exits 0 with one test passed, and the order check in step 10 prints the four names in order

Steps

1. [ ] Settle where the `gh` child is reaped. Finding from the code read for this plan: the flight future calls `PullRequestService::resolve_current_optional`, which awaits `self.runner.run(ProcessRequest { .. }, cancellation)` in `run_provider_os_with_allowed_exit_codes`. That runner stops a non-Git child by force (stop policy `Force` in `git/process.rs`), so the child dies at the cancel and is reaped inside that awaited call, in the detached flight task. Joining the task is therefore enough. Record this in the doc comment of `shutdown`. Do not use a `TERM` trap to model a slow exit: it has no effect here.
2. [ ] Extend the `Loader` helper in the `tests` module: a field `cleanup: Duration` (default zero) and an `ended: Arc<AtomicUsize>`; in gated mode, when the flight token is cancelled the loader does `tokio::time::sleep(self.cleanup).await`, increments `ended`, and returns `Err(failure())`. This is the seam: `load` is the closure the service hands the cache, so the delayed cleanup is injected without a real process. Add `#[cfg(test)] fn entry_count_for_test(&self) -> usize` on `OpenPullRequestLookups`.
3. [ ] Write the failing tests in `open_pull_request_lookups.rs`, each `#[tokio::test(start_paused = true)]` (the 200 ms is virtual time, advanced by the runtime when every task is idle): Expected: the change is in place, and the next command step checks it.
   - `shutdown_waits_for_a_lookup_that_ends_late`: a gated loader with `cleanup` 200 ms; spawn `resolve`, wait for the run, record `start = tokio::time::Instant::now()`, `lookups.shutdown().await`; assert `ended == 1` and `start.elapsed() >= 200 ms`.
   - `shutdown_stops_an_invalidated_flight`: spawn `resolve` with the same loader, wait for the run, call `lookups.invalidate(path)` (the entry is gone), then `shutdown`; assert the loader saw its cancellation (`cancelled == 1`) and `ended == 1`.
   - `shutdown_stops_a_flight_that_had_no_cache_room`: `OpenPullRequestLookups::with_limits(OPEN_PULL_REQUEST_LOOKUP_TTL, 0)` so no entry is stored; spawn `resolve`, wait for the run, `shutdown`; assert `cancelled == 1`, `ended == 1` and `entry_count_for_test() == 0`.
   - `shutdown_ends_a_retained_waiter_as_cancelled`: the waiter's own cancellation token is never cancelled and it still holds its lease when `shutdown` is called; assert the waiter's `resolve` returns `None` and `shutdown` returned.
   - `shutdown_refuses_a_new_lookup`: after `shutdown`, `resolve` returns `None` and `loader.runs() == 0`; a second `shutdown().await` returns at once.
4. [ ] Run `cargo test -p bibcode-server --lib -j 2 -- open_pull_request_lookups::tests::shutdown_`. Expected: FAIL to compile (`no method named shutdown`). Add `pub(crate) async fn shutdown(&self) {}` and `entry_count_for_test`, run again. Expected: five FAILs (`ended` is 0, `resolve` returns `Some(..)`).
5. [ ] Implement in `open_pull_request_lookups.rs` as listed in Interfaces. The spawn becomes `self.tasks.spawn(..)` and covers the no-room path too. `settle` is untouched here; Task 2.5 adds the `cancelled` parameter.
6. [ ] Add `PullRequestService::shutdown_open_pull_request_lookups` in `pull_request.rs` and `GitVcsRpcServices::pull_requests` in `git_vcs.rs`.
7. [ ] Write the failing wiring test `pull_request_lookup_shutdown_reaps_the_forge_cli` in the `tests` module of `git_vcs.rs` (Unix-only like its neighbors): `Fixture::new("pr-lookup-shutdown")`, `fixture.set("slow", "30")`, start a lookup with `fixture.refresh()` under `tokio::time::timeout(Duration::from_secs(5), ..)` so it returns at its bound while the fake `gh` keeps running, then `fixture.services.pull_requests().shutdown_open_pull_request_lookups().await`; immediately assert `!fixture.a_forge_cli_is_running()` (no polling: shutdown returned only after the reap). Run `cargo test -p bibcode-server --lib -j 2 -- production::git_vcs::tests::pull_request_lookup_shutdown_`. Expected before step 6 is done: FAIL to compile; after steps 5 and 6: PASS. Expected: the change is in place, and the next command step checks it.
8. [ ] In `runtime.rs` add a field `pull_requests: crate::source_control::PullRequestService` to the runtime struct, filled from `git_vcs.pull_requests()` after the last builder call, and in `quiesce_for_update`, after `self.status_broadcaster.shutdown().await; steps.mark("status-broadcaster");`, add `self.pull_requests.shutdown_open_pull_request_lookups().await; steps.mark("pull-request-lookups");`. The order after the status broadcaster is deliberate: streams that hold leases stop first.
9. [ ] Run `cargo test -p bibcode-server --lib -j 2 -- open_pull_request_lookups:: quiesce_in_ production::git_vcs::tests::a_lookup_past_the_refresh_bound_stops_at_quiesce`. Expected: PASS (all three filters match tests).
10. [ ] Check the order in the source: `rg -n 'steps.mark\("(status-broadcaster|pull-request-lookups|git-writes|profiler-end-session)"\)' apps/server/src/production/runtime.rs`. Expected: the four names in exactly that order.
11. [ ] Prove the tests can fail: revert this task's implementation edits by hand (no `git stash`) back to the step 4 stubs and the bare `tokio::spawn`, keeping the tests, and rerun `cargo test -p bibcode-server --lib -j 2 -- open_pull_request_lookups::tests::shutdown_`. Expected: FAIL. Restore the implementation and rerun. Expected: PASS.
12. [ ] Run `cargo fmt --all --check` and `cargo clippy -p bibcode-server --all-targets -- -D warnings`. Expected: no errors.

### Task 2.5: Remember a failed lookup for 5 seconds

- Satisfies: R27 (D6): the same key answers with the failure for 5 seconds without a new lookup; a cancelled lookup (a lease drop or shutdown) is never remembered as failed; an invalidation clears it; the failure is logged once at `warn` without the remote's URL.
- Depends on: 2.4 (same file and the same `Slot` enum)
- Files: modify `apps/server/src/source_control/open_pull_request_lookups.rs`; modify `apps/server/src/production/git_vcs.rs` (test `a_failed_lookup_is_not_remembered_as_no_pull_request` only); test `apps/server/src/source_control/open_pull_request_lookups.rs`
- Interfaces: consumes `Slot`, `settle(&self, key: &LookupKey, id: u64, outcome: &LookupResult)`, `make_room`, `LookupResult` (its error `SourceControlProviderError` is `Clone`), the `Loader` helper and `entry_count_for_test` from Task 2.4; produces `pub(crate) const OPEN_PULL_REQUEST_FAILURE_BACKOFF: Duration = Duration::from_secs(5)`, `Slot::Failed { error: SourceControlProviderError, expires_at: Instant }`, `Admission::Failed(SourceControlProviderError)` that `resolve` returns as `Some(Err(error))`, and `settle(&self, key, id, outcome, cancelled: bool)`. `with_limits(ttl, capacity)` keeps its signature. The only caller of `settle` is the flight task in `admit`
- Skills: `tdd` (new backoff behavior), `bibcode-profiler` (the warn record must hold no URL, path or branch)
- Read first: `apps/server/src/source_control/open_pull_request_lookups.rs` (`admit`, `settle`, `make_room`, tests `failures_are_shared_with_waiters_but_never_stored` and `one_waiter_leaving_does_not_cancel_the_shared_lookup_but_the_last_one_does`); `apps/server/src/production/git_vcs.rs` (test `a_failed_lookup_is_not_remembered_as_no_pull_request`)
- Tier: most capable
- TDD: red-green
- Done when: `cargo test -p bibcode-server --lib -j 2 -- open_pull_request_lookups::tests:: production::git_vcs::tests::a_failed_lookup` exits 0 with the new tests listed

Steps

1. [ ] Write the failing tests in `open_pull_request_lookups.rs`, all `#[tokio::test(start_paused = true)]` so time is the paused clock:
   - `a_failed_lookup_answers_from_memory_for_five_seconds`: first `resolve` returns `Some(Err(failure()))` with `loader.runs() == 1`; after `tokio::time::advance(4 s)` a second `resolve` returns `Some(Err(failure()))` with `runs() == 1`; after a further `advance(1 s + 1 ms)` a third `resolve` runs the loader (`runs() == 2`).
   - `a_cancelled_lookup_is_not_remembered_as_failed`: a gated loader; the only waiter is cancelled so the lease drops and the flight token is cancelled, and the loader returns `Err(failure())`. Wait for the flight to settle before retrying: loop `tokio::task::yield_now()` until `loader.cancelled == 1` and `lookups.entry_count_for_test() == 0` (a wrongly stored failure would leave one entry). Only then call `resolve` again; assert it runs the loader (`runs() == 2`).
   - `a_shutdown_flight_is_not_remembered_as_failed`: after the cancelled flight of a `shutdown`, `entry_count_for_test() == 0` (use a lookups value with capacity 64 and a gated loader; settle is awaited by `shutdown`).
   - `an_invalidation_clears_a_remembered_failure`: after a failure, `lookups.invalidate(path)`, then `resolve` runs the loader again within the 5 s.
   - `a_failed_lookup_warns_once_without_the_remote_address`: capture `tracing` output at `WARN` with `tracing::subscriber::set_default` and a local writer type shaped like the `CapturedLog` in `production/mcp_tools_tests/git.rs`; a failure whose `detail` and `cwd` hold `https://gitlab.example.test/example-group/sample-project` and `/work/sample-project` is resolved twice inside the backoff; assert exactly one WARN line and that it contains neither `gitlab.example.test` nor `sample-project`.
2. [ ] Rewrite the existing tests that conflict with the backoff. `failures_are_shared_with_waiters_but_never_stored` is today an unpaused `#[tokio::test]` with a real 50 ms `sleep`: change it to `#[tokio::test(start_paused = true)]` and replace that sleep with `tokio::time::advance(Duration::from_millis(50))`; it keeps proving that the second caller joined the running lookup (`loader.runs() == 1`); its last assertion becomes `recovered.runs() == 0` inside 5 s (the failure answers from memory) and `recovered.runs() == 1` after `tokio::time::advance(OPEN_PULL_REQUEST_FAILURE_BACKOFF)`. Rename it `failures_are_shared_with_waiters_and_remembered_for_five_seconds`. In `git_vcs.rs`, `a_failed_lookup_is_not_remembered_as_no_pull_request` keeps its name and meaning (a failure is not stored as "no pull request") and calls `fixture.services.pull_requests().invalidate_open_pull_request_lookups(&fixture.repository)` between `clear("fail")` and the second refresh: a push, a mutation or a local change does this in production. That test uses the real clock and a real fake `gh`, so it must not advance time.
3. [ ] Run `cargo test -p bibcode-server --lib -j 2 -- open_pull_request_lookups::tests::`. Expected: FAIL on `a_failed_lookup_answers_from_memory_for_five_seconds` with `left: 2, right: 1` (the second call ran the loader).
4. [ ] Implement: `settle` takes `cancelled: bool`, passed from the flight task as `flight_cancellation.is_cancelled()` read after `lookup.await`. For `Err(error)` with `!cancelled` and the key still owned by this flight, set `Slot::Failed { error: error.clone(), expires_at: Instant::now() + OPEN_PULL_REQUEST_FAILURE_BACKOFF }`; with `cancelled`, remove the entry as today. In `admit`, an unexpired `Slot::Failed` returns `Admission::Failed(error.clone())`; an expired one falls through to a new lookup. In `make_room`, keep an unexpired `Failed` entry and let expiry and the closest-to-expiring rule remove it. Log in the flight task once per lookup that ended with an uncancelled `Err`: `tracing::warn!(provider = ?key.provider, "open pull-request lookup failed; answering with the failure for 5 seconds")`. Do not log the error, cwd, reference or command.
5. [ ] Run `cargo test -p bibcode-server --lib -j 2 -- open_pull_request_lookups:: production::git_vcs::tests::pr_row_ production::git_vcs::tests::a_failed_lookup`. Expected: PASS (`pr_row_a_failed_lookup_keeps_the_pull_request` still passes: the stream keeps showing the request after a failure).
6. [ ] Prove the tests can fail: revert this task's implementation edits by hand (`settle` back to removing the entry on `Err`, no `Slot::Failed`, no log), keeping the tests, and rerun `cargo test -p bibcode-server --lib -j 2 -- open_pull_request_lookups::tests::`. Expected: FAIL. Restore the implementation and rerun. Expected: PASS.
7. [ ] Run `cargo fmt --all --check` and `cargo clippy -p bibcode-server --all-targets -- -D warnings`. Expected: no errors.

### Task 2.6: Stop showing a remembered pull request after a failed lookup on stale data

- Satisfies: R28 (D7): a failed lookup, with the last success for that branch more than 5 minutes old, clears the remembered request, on every path that completes a lookup (the refresh, the status stream, and the late lookup that a refresh hands to subscribers); without a failed lookup it stays however old; a ref change clears it as today.
- Depends on: 2.5 (the failure signal is the same; both edit `git_vcs.rs`)
- Files: modify `apps/server/src/git/broadcaster.rs`; modify `apps/server/src/production/git_vcs.rs`; test `apps/server/src/git/broadcaster.rs` and `apps/server/src/production/git_vcs.rs`
- Interfaces:
  - consumes `StatusBroadcaster::record_pull_request(&self, cwd: &Path, ref_name: Option<&str>, pull_request: Option<ChangeRequest>)`, `known_pull_request`, `notify_pull_request_change(&self, cwd: &Path)` (async), `RepositoryState`, `clear_remote_for_ref_change`, `keep_pull_request`; in `git_vcs.rs`, `lookup_open_pull_request(...) -> Option<Option<ChangeRequest>>` whose `None` means failed or cancelled. Every site that handles a lookup's result, found with `rg "lookup_open_pull_request|record_pull_request" apps/server/src/production/git_vcs.rs`: (1) the `Ok(None)` arm of `vcs.refreshStatus`; (2) the late callback inside `self.broadcaster.spawn_for_subscribers(&cwd, async move { if let Some(pull_request) = lookup.await { .. } })`, which today handles only success; (3) the `found` arm of the status stream loop. `record_pull_request` has these three writers and no other; `keep_pull_request` copies a cached request into a newer remote without a lookup and is not a success
  - produces `RepositoryState.pr_recorded_at: Option<tokio::time::Instant>`, set by `record_pull_request` on every success (including "no open request") and cleared in `clear_remote_for_ref_change`
  - produces `pub(crate) const PULL_REQUEST_STALE_AFTER: Duration = Duration::from_secs(300)` in `broadcaster.rs`
  - produces `pub(crate) fn note_failed_pull_request_lookup(&self, cwd: &Path, ref_name: Option<&str>) -> bool`: returns `false` and changes nothing when the broadcaster is closed, `ref_name` does not match, no request is remembered, or `pr_recorded_at` is younger than `PULL_REQUEST_STALE_AFTER`; otherwise sets the remembered `remote.pr` to `None` and returns `true`. It publishes nothing; callers decide
  - produces `#[cfg(test)] pub(crate) fn age_pull_request_for_test(&self, cwd: &Path, age: Duration)` that moves `pr_recorded_at` back by `age` (`checked_sub`, so a machine up for under `age` panics with a clear message), for the stream tests that run on the real clock
- Skills: `tdd` (new expiry behavior)
- Read first: `apps/server/src/git/broadcaster.rs` (`record_pull_request`, `known_pull_request`, `keep_pull_request`, `clear_remote_for_ref_change`, test `a_snapshot_under_a_new_epoch_keeps_the_known_pull_request`); `apps/server/src/production/git_vcs.rs` (the `Ok(None)` and `Err(_)` arms of `vcs.refreshStatus`, the `found` arm of the stream loop, `ShownStatus::reconcile`, tests `a_lookup_past_the_refresh_bound_reaches_the_subscriber` and `pr_row_a_failed_lookup_keeps_the_pull_request`)
- Tier: most capable
- TDD: red-green
- Done when: `cargo test -p bibcode-server --lib -j 2 -- git::broadcaster::tests::a_failed_lookup_ production::git_vcs::tests::pr_row_` exits 0 with the new tests listed

Steps

1. [ ] Decide how the callers tell failure from cancellation and write it in the doc comment of `note_failed_pull_request_lookup`. Stream arm: `found` is `Ok(None)` for a failed lookup and also for one cancelled through `task_token`; count it as a failure only when `finished.cancellation.is_cancelled()` is false. Refresh arm: the inner lookup runs under a token nothing cancels, so the lookup's own `None` is a failure; the select's `cancellation.cancelled()` arm is not the lookup's result and is not a failure. Late callback: `lookup.await` returning `None` after shutdown is a cancelled lookup, and `note_failed_pull_request_lookup` returns `false` when the broadcaster is closed, so shutdown clears nothing. Re-read the three sites and adjust if the shapes differ.
2. [ ] Write the failing tests in `broadcaster.rs` (`#[tokio::test(start_paused = true)]`, copying the setup of `a_snapshot_under_a_new_epoch_keeps_the_known_pull_request`; its fixtures use the real `StatusBroadcaster`, no component is replaced):
   - `a_failed_lookup_clears_a_request_recorded_six_minutes_ago`: record a request, `tokio::time::advance(360 s)`, `note_failed_pull_request_lookup` returns `true`; `known_pull_request` returns `None`.
   - `a_failed_lookup_keeps_a_request_recorded_four_minutes_ago`: same with 240 s; returns `false`; still `Some`.
   - `a_request_recorded_six_minutes_ago_stays_without_a_failed_lookup`: advance 360 s and call only `known_pull_request`; `Some`.
   - `a_failed_lookup_for_a_former_branch_clears_nothing`: `ref_name` differs; `false`; still `Some`.
   - `a_failed_lookup_after_a_ref_change_clears_nothing`: after `clear_remote_for_ref_change`, the stamp is gone; `false`, no panic.
   - `a_failed_lookup_after_shutdown_clears_nothing`: after `shutdown().await`, `false`.
3. [ ] Run `cargo test -p bibcode-server --lib -j 2 -- git::broadcaster::tests::a_failed_lookup_`. Expected: FAIL to compile (`no method named note_failed_pull_request_lookup`). Add a stub returning `false` and run again. Expected: FAIL on the six-minute test.
4. [ ] Implement in `broadcaster.rs` the field, the constant, the two methods from Interfaces, and the stamp in `record_pull_request` (under the same `ref_name` filter it already applies).
5. [ ] Call `note_failed_pull_request_lookup` from the three `git_vcs.rs` sites chosen in step 1. In the refresh arm and the stream arm, call it before the status is built and `shown.reconcile` runs, which then sends the cleared state. In the late callback, add an `else` branch: `if broadcaster.note_failed_pull_request_lookup(&late_cwd, late_ref.as_deref()) { broadcaster.notify_pull_request_change(&late_cwd).await; }`; the notify republishes the remote so the subscriber shows the cleared state. That republish makes each stream look up again, which the 5-second failure backoff of Task 2.5 answers from memory; the second failure finds nothing to clear and returns `false`, so no loop forms.
6. [ ] Add three stream tests in the `tests` module of `git_vcs.rs`, next to `pr_row_a_failed_lookup_keeps_the_pull_request`. They run on the real clock with the fake `gh`, so they age the stamp with `fixture.services.broadcaster.age_pull_request_for_test(&canonical_repository, Duration::from_secs(360))` (the same canonical path the broadcaster keys on): Expected: the change is in place, and the next command step checks it.
   - `pr_row_a_failed_lookup_after_six_minutes_clears_the_pull_request`: `subscriber_showing_the_pull_request`, age the stamp, `fixture.set("fail", "")`, invalidate the lookups, `fixture.report_pull_request_change()`; the subscriber later shows `pr().is_null()`.
   - `pr_row_a_failed_lookup_after_four_minutes_keeps_the_pull_request`: same with 240 s; after `subscriber.drain(..)` every shown value is 42.
   - `pr_row_a_late_failed_lookup_after_six_minutes_clears_the_pull_request`: the refresh-past-its-bound shape of `a_lookup_past_the_refresh_bound_reaches_the_subscriber`: the subscriber shows 42, age the stamp, set the markers `slow` = `6` and `fail`, call `fixture.forget_lookups()`, then `fixture.refresh()` under a 5 s timeout (it answers at its bound with the remembered request), and the subscriber later shows `pr().is_null()` once the late lookup fails. The fake `gh` in `FAKE_GH` exits at `fail` before it reaches `slow`, so this needs a harness change: move the `if [ -n "$slow" ]; then sleep "$slow"; fi` line above the `fail` line. Every existing test sets only one of the two markers, so none changes behavior.
7. [ ] Run `cargo test -p bibcode-server --lib -j 2 -- git::broadcaster::tests::a_failed_lookup_ production::git_vcs::tests::pr_row_`. Expected: PASS.
8. [ ] Prove the tests can fail: revert this task's implementation edits by hand (the stub returning `false` from step 3, and remove the three call sites), keeping the tests, and rerun the step 7 command. Expected: FAIL (the six-minute tests and the late-callback test). Restore and rerun. Expected: PASS.
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
- Interfaces: consumes `Fixture`, `subscriber_showing_the_pull_request`, `wait_for_lookups`, `fixture.set`, `fixture.clear`, `StatusBroadcaster::notify_local_change(&self, cwd: &Path)` (async), `StatusBroadcaster::notify_pull_request_change(&self, cwd: &Path)` (async); produces the test `a_neutral_local_change_during_a_lookup_replaces_its_outdated_answer`
- Skills: `mstack-diagnose` (the test decides between defect and no defect), `tdd` (defect branch only)
- Read first: `apps/server/src/production/git_vcs.rs` (test `a_local_change_during_a_lookup_replaces_its_outdated_answer`, which writes `saved.txt` and so changes status; `observe_local_changes`; the `publication` arm of the status stream loop that sets `look_again`); `apps/server/src/git/broadcaster.rs` (`notify_local_change`, `reconcile_remote_after_local_publication`)
- Tier: most capable
- TDD: red-green
- Done when: `cargo test -p bibcode-server --lib production::git_vcs::tests::a_neutral_local_change_during_a_lookup_replaces_its_outdated_answer -j 2` exits 0, and the outcome line (defect fixed or no defect) is written in the pull request notes for #355

Steps

1. [ ] Write the test by copying `a_local_change_during_a_lookup_replaces_its_outdated_answer` with one change: after `fixture.clear("open")` do not write `saved.txt`; call `fixture.services.broadcaster.notify_local_change(&fixture.repository).await` with the working tree untouched, so the local status is byte-identical. Assert that within the helper's wait the subscriber's `pr()` becomes null and `fixture.lookups()` equals `["main", "main", "main"]`.
2. [ ] Run `cargo test -p bibcode-server --lib production::git_vcs::tests::a_neutral_local_change_during_a_lookup_replaces_its_outdated_answer -j 2`. Expected: PASS means no defect and FAIL means the defect branch; the next steps say what follows each.
3. [ ] If the result is PASS: this is the no-defect branch. The status owner publishes a neutral change, or the stream loop starts a follow-up lookup, so nothing changes in code. Keep the test, add the sentence `Decided by test (R30): no defect; a status-neutral local change still starts one follow-up lookup.` to the test's doc comment, and stop.
4. [ ] If the result is FAIL because the subscriber keeps showing request 42 and the lookup count stays at 2: this is the defect branch (a neutral change publishes nothing, so `look_again` is never set). Fix at the first wrong decision: in `observe_local_changes` and the local-change closure in `GitVcsRpcServices`, after `invalidate_open_pull_request_lookups`, call `broadcaster.notify_pull_request_change(cwd)` for the observer path as the closure at the `handle.spawn` site already does, so every invalidation also asks each stream to look again. The invalidation writers are `observe_local_changes` (no notify today; the fix goes here, cloning `broadcaster` into its closure), the local-change closure near the `handle.spawn` site (already notifies) and `create_with_options` in `pull_request.rs` (its callers notify). Re-run the test. Expected: PASS.
5. [ ] In the defect branch also run `cargo test -p bibcode-server --lib production::git_vcs::tests::pr_ -j 2` and `cargo test -p bibcode-server --lib production::git_vcs::tests::a_ -j 2`. Expected: PASS (no other stream test now counts an extra lookup; if one does, change its expected `fixture.lookups()` only where the extra lookup follows a real invalidation).
6. [ ] In the defect branch prove the test can fail: revert this task's code change by hand (remove the added `notify_pull_request_change` call, keeping the test) and run the test. Expected: FAIL. Restore it and run again. Expected: PASS.
7. [ ] Run `cargo fmt --all --check` and `cargo clippy -p bibcode-server --all-targets -- -D warnings`. Expected: no errors.
