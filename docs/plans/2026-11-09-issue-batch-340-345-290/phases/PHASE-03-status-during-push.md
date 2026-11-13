# Phase 3: Status during a push

- Goal: Local status for a worktree is delivered while a push-family operation waits on the network, writes stay serialized, and every outcome releases readers, with tests and the architecture document updated (#345).
- Round: 2
- Depends on: 2
- Owns: `apps/server/src/git/status_owner.rs`, `apps/server/src/git/broadcaster.rs`, `apps/server/src/production/git_vcs.rs`, `apps/server/src/git/manager/operations.rs`, `apps/server/src/diagnostics/profiler/latency.rs`, `apps/server/tests/production_git_vcs_rpc.rs`, `docs/architecture/rpc-and-orchestration.md`, `docs/architecture/overview.md`
- Must not touch: `apps/server/src/git/repository.rs`, `apps/server/src/process/**` (Phase 2), `apps/server/src/git/sign_in.rs`, `apps/web/**`, `packages/contracts/**`
- Skills: test-driven-development (every gate change starts from a failing concurrency test); mstack-diagnose (when a held-push test fails for an unexpected reason)
- Read first: `spec.md` section E (R18 to R23, D5); `docs/architecture/rpc-and-orchestration.md` and `docs/architecture/overview.md` (both describe the mutation and status-read contract; find the passages with `rg -n -i "status read|read gate|trailing refresh" docs/architecture`); `AGENTS.md` (Architectural Decision Standards; RPC methods and `is_long_running`)
- Checkpoint: `cargo test -p bibcode-server --lib -j 2 status_owner` and `cargo test -p bibcode-server --lib -j 2 held_pu` exit 0. During a slow push the change list in Source Control keeps updating.

## Tasks

### Task 3.1: Let a mutation reopen status reads while it keeps the write lock

- Satisfies: R20 (second write during a held push; status read before the action ended), R23 (refresh blocked by something else)
- Depends on: none
- Files: modify `apps/server/src/git/status_owner.rs`; modify `apps/server/src/git/broadcaster.rs`; modify `apps/server/src/diagnostics/profiler/latency.rs`
- Interfaces: consumes `StatusReadOwner::begin_mutation` (status_owner.rs line 507), `StatusMutationGuard` (359) with `finish` (1132) and `settle` (1136), `finish_mutation_burst_if_idle` (697), `worktree_can_retire` (1203) and `retire_reads` (1211); produces `impl StatusMutationGuard { pub fn local_writes_finished(&mut self) }`, a per-worktree state flag `mutation_lock_held: bool` that stays true from lock acquisition to `settle`, and the same method forwarded on the broadcaster's guard wrapper. After `local_writes_finished`: `mutation_active` is false, the epoch is bumped once, the read gate reopens even when other mutations are queued behind the held lock, and one refresh is queued. A mutation queued behind a lock in this state closes the gate only when it acquires the lock, not when it is requested. This matters because `begin_mutation` is also called by work no person started (`apps/server/src/workspace/rpc.rs` lines 2655, 2743 and 3256, and pull-request checkout), which would otherwise bring the #345 wait back. `settle` keeps bumping the epoch and always publishes the trailing refresh: today `finish_mutation_burst_if_idle` (line 709) returns early when the gate is already open, which is the normal state after `local_writes_finished`, so the pending trailing refresh is drained in `settle` whatever the gate state.
- Skills: none
- Read first: `apps/server/src/git/status_owner.rs` lines 359-600, 697-770 and 1131-1215; the tests at 1785-1990 (`mutation_retires_the_old_read_and_signals_one_trailing_refresh`, `read_admitted_during_mutation_waits_for_settlement_before_starting`, `publication_fence_waits_for_mutation_and_rejects_the_next_epoch`, `queued_mutations_emit_one_post_burst_refresh_and_local_load`)
- Tier: most capable
- TDD: red-green
- Done when: `cargo test -p bibcode-server --lib -j 2 status_owner` exits 0 with the 7 new tests passing and no existing test removed

Steps

1. [ ] In the tests of `status_owner.rs`, add `reads_resume_after_local_writes_finish_while_the_lock_is_held`: begin a mutation, call `local_writes_finished`, start a read, and assert it is admitted and can publish before `finish` is called.
2. [ ] Add `a_second_mutation_waits_for_the_whole_first_mutation`: after `local_writes_finished` on the first guard, `begin_mutation` for the same worktree does not resolve until the first guard finishes.
3. [ ] Add `a_worktree_with_a_held_lock_is_not_retired`: after `local_writes_finished`, cancel all reads and subscribers and assert a new `begin_mutation` still waits on the same lock (the worktree entry was not dropped and recreated).
4. [ ] Add `a_read_started_before_the_mutation_is_not_published_after_reads_resume`: a read admitted before `begin_mutation` fails its publication fence, and a fresh status is published after `finish`.
5. [ ] Add `a_mutation_queued_behind_a_released_lock_does_not_close_the_gate_until_it_starts`: after `local_writes_finished` on the first guard, request a second mutation; a status read is still admitted and published; when the first guard finishes and the second acquires the lock, the gate closes and the epoch advances. Add `a_mutation_queued_before_local_writes_finish_no_longer_blocks_reads_afterwards`: the second mutation is requested first, then `local_writes_finished` is called, and a read is admitted. Add `settling_after_reads_resumed_still_publishes_the_trailing_refresh`: a read completes during the held lock, then the guard finishes with no watcher event, and exactly one trailing refresh is published.
6. [ ] Run `cargo test -p bibcode-server --lib -j 2 status_owner`. Expected: FAIL to compile, `local_writes_finished` is not defined.
7. [ ] Implement `local_writes_finished` and `mutation_lock_held`. `worktree_can_retire` returns false while `mutation_lock_held` is true. Calling `local_writes_finished` twice, or after the guard settled, does nothing. Forward the method on the broadcaster guard returned by `broadcaster.begin_mutation`.
8. [ ] Run `cargo test -p bibcode-server --lib -j 2 status_owner`. Expected: PASS, including every existing test.
9. [ ] Prove the test can fail: make `worktree_can_retire` ignore `mutation_lock_held`, run the same command. Expected: FAIL in `a_worktree_with_a_held_lock_is_not_retired`. Restore and run again. Expected: PASS.
10. [ ] In the tests of `latency.rs`, add `a_status_refresh_blocked_past_ten_seconds_is_still_a_hang`: an in-flight `vcs.refreshStatus` that is 11 seconds old yields one `rpc.hang` finding, and `is_long_running("vcs.refreshStatus")` is false. Run `cargo test -p bibcode-server --lib -j 2 a_status_refresh_blocked`. Expected: PASS (this pins behavior that already holds; do not change `is_long_running`).
11. [ ] Run `cargo fmt --all --check` and `cargo clippy --workspace --all-targets -- -D warnings`. Expected: no errors.

### Task 3.2: Stacked actions deliver status while the push waits

- Satisfies: R18 (held push; another worktree), R21 (each outcome), R22 (lookup during a held push)
- Depends on: 3.1
- Files: modify `apps/server/src/production/git_vcs.rs`; modify `apps/server/tests/production_git_vcs_rpc.rs`
- Interfaces: consumes `stalled_http_remote()` and `accept_git` (tests/production_git_vcs_rpc.rs lines 2714 and 2725, a listener that never answers, used to hold a real push), `StatusMutationGuard::local_writes_finished` (Task 3.1), the guard taken at git_vcs.rs line 1681, `run_stacked_action_steps` (2891) with the push phase starting at lines 3119-3120, and the test helper `ControlledMutationRunner` (3903) with `blocked_operation`, `mutation_started` and `release_mutation`; produces a `&mut` guard (or a callback `on_local_writes_finished`) passed into `run_stacked_action_steps`, called once immediately before `*phase = Some("push")` when the action pushes, and otherwise immediately before the pull-request step at line 3202 (the bounded transfer at line 3184 is inside `if wants_push`, so an action without a push never reaches it).
- Skills: none
- Read first: `apps/server/src/production/git_vcs.rs` lines 1677-1810, 2879-3290 and the tests at 4113-4440 (`stacked_push_runs_inside_the_shared_mutation_boundary`, `mutation_retires_one_shared_read_for_two_clients_and_publishes_one_trailing_refresh`, `blocked_pull_request_enrichment_cannot_delay_base_or_local_publications`)
- Tier: most capable
- TDD: red-green
- Done when: `cargo test -p bibcode-server --lib -j 2 held_pu` exits 0 with 6 tests passing, `cargo test -p bibcode-server --test production_git_vcs_rpc -j 2 a_real_commit_survives` exits 0, and `cargo test -p bibcode-server --lib -j 2 stacked_push` exits 0

Steps

1. [ ] In the tests of `git_vcs.rs`, add `held_push_delivers_status_to_refresh_and_subscribers`: with `ControlledMutationRunner { blocked_operation: Some("GitVcsDriver.pushCurrentBranch") }`, start a commit-and-push stacked action, wait for `mutation_started`, then call `vcs.refreshStatus` and read one subscriber publication for the same worktree. Assert both complete and show the commit before `release_mutation` is released.
2. [ ] Add `held_push_does_not_gate_another_worktree`: with the push held in worktree A, `vcs.refreshStatus` for worktree B completes.
3. [ ] Add `held_push_keeps_writes_serialized_and_the_commit_saved`: a second stacked action for the same worktree does not start until the first ends; make the held push fail and assert the commit made before it is still reported by the status after the action.
4. [ ] Add `held_push_every_outcome_releases_readers`: drive the action to each of success, authentication refusal (exit 128 with a refusal stderr), timeout, cancellation and a removed workspace. After each, `vcs.refreshStatus` completes, a timeout is reported as "Git command timed out." with no exit code, and no call fails with "status read owner stopped".
5. [ ] Add `held_push_does_not_block_pull_request_lookups`: with the push held and an immediate fake provider, `pullRequests.getVocabulary` and `pullRequests.getCreateDefaults` complete before the push is released. Add `held_pull_request_step_without_a_push_delivers_status`: an action that only opens a pull request, with the provider call held, still answers `vcs.refreshStatus`. In `tests/production_git_vcs_rpc.rs`, add `a_real_commit_survives_a_held_and_failed_push`: with real Git and `stalled_http_remote()`, start commit-and-push, wait until the push is connected, assert `vcs.refreshStatus` answers and `git log -1` in the repository shows the new commit, then close the listener and assert the action fails, the commit is still in `git log`, and a second stacked action then runs.
6. [ ] Run `cargo test -p bibcode-server --lib -j 2 held_pu`. Expected: FAIL, `held_push_delivers_status_to_refresh_and_subscribers` times out waiting for the refresh.
7. [ ] Pass the guard into `run_stacked_action_steps` and call `local_writes_finished` at the two points named under Interfaces. An action with neither a push nor a pull-request step never calls it.
8. [ ] Run `cargo test -p bibcode-server --lib -j 2 held_pu` and `cargo test -p bibcode-server --test production_git_vcs_rpc -j 2 a_real_commit_survives`. Expected: PASS, 6 tests and 1 test.
9. [ ] Prove the test can fail: remove the call before the push phase, run the same command. Expected: FAIL. Restore and run again. Expected: PASS.
10. [ ] Update `stacked_push_runs_inside_the_shared_mutation_boundary` on purpose: rename it to `stacked_push_keeps_the_write_lock_and_retires_stale_reads`, keep its assertions that the stale read is retired and one trailing refresh is published, and add the assertion that a second write waits for the push. Run `cargo test -p bibcode-server --lib -j 2 stacked_push`. Expected: PASS.
11. [ ] Run `cargo test -p bibcode-server --test production_git_vcs_rpc -j 2`. Expected: PASS.
12. [ ] Run `cargo fmt --all --check` and `cargo clippy --workspace --all-targets -- -D warnings`. Expected: no errors.

### Task 3.3: Git Manager push-family operations deliver status; pull and fetch do not

- Satisfies: R19 (held Git Manager push; pull and fetch keep waiting), R21 (each outcome)
- Depends on: 3.2
- Files: modify `apps/server/src/git/manager/operations.rs`; modify `docs/architecture/rpc-and-orchestration.md`; modify `docs/architecture/overview.md`
- Interfaces: consumes `StatusMutationGuard::local_writes_finished` (Task 3.1), `run_branch_or_sync_operation` (operations.rs near line 972, guard taken at 1029, finished near 1068), `execute_branch_or_sync_operation` (1310) and `network_step` (near 1240-1300); produces a private `fn releases_reads_during_transfer(request: &...) -> bool` that is true for Push, PublishBranch, ForcePush and RemoteBranchDelete and false for Pull, Fetch and every other request, and a call to `local_writes_finished` immediately before the network step when it is true.
- Skills: none
- Read first: `apps/server/src/git/manager/operations.rs` lines 341-544 (the request variants) and 972-1310; `apps/server/src/git/manager/operations/sign_in_tests.rs` (the `RemoteRunner` fake used to hold a network step)
- Tier: most capable
- TDD: red-green
- Done when: `cargo test -p bibcode-server --lib -j 2 manager_transfer_gate` exits 0 with 3 tests passing

Steps

1. [ ] In the Git Manager operation tests, add `manager_transfer_gate_push_family_delivers_status`: for each of Push, PublishBranch, ForcePush and RemoteBranchDelete, hold the network step, and assert a status read for the same worktree is admitted before the step is released.
2. [ ] Add `manager_transfer_gate_pull_and_fetch_keep_reads_waiting`: for Pull and Fetch, the status read is admitted only after the operation finishes.
3. [ ] Add `manager_transfer_gate_every_outcome_releases_readers`: a held push ended by success, a refusal, a timeout, a cancellation and a removed workspace each leaves the next status read admitted.
4. [ ] Run `cargo test -p bibcode-server --lib -j 2 manager_transfer_gate`. Expected: FAIL, the push-family read is not admitted while the step is held.
5. [ ] Implement `releases_reads_during_transfer` and the `local_writes_finished` call.
6. [ ] Run `cargo test -p bibcode-server --lib -j 2 manager_transfer_gate`. Expected: PASS, 3 tests.
7. [ ] Prove the test can fail: make `releases_reads_during_transfer` return true for Pull, run the same command. Expected: FAIL in `manager_transfer_gate_pull_and_fetch_keep_reads_waiting`. Restore and run again. Expected: PASS.
8. [ ] In `docs/architecture/rpc-and-orchestration.md`, update every passage `rg -n -i "status read|read gate|trailing refresh" docs/architecture` finds in that file and in `docs/architecture/overview.md` (lines 133 and 144 say a read admitted during a mutation cannot publish and that the gate reopens only at the final idle transition; both change). In the overview's process and profiler passages, also describe the Git stop sequence of Phase 2 (ask, 2 second wait, force, lock cleanup, shutdown waits for running writes). The new text says: reads resume once a push-family operation finishes its local writes, the write lock is held to the end, pull and fetch keep reads waiting, and a fresh status is published when the operation ends.
9. [ ] Run `cargo test -p bibcode-server --test git_rpc -j 2`, `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings` and `vp run check:markdown-links`. Expected: PASS and no errors.

### Task 3.4: A status refresh does not wait on a slow pull-request lookup

- Satisfies: R18 (a slow pull-request lookup, amendment A7)
- Depends on: 3.3
- Files: modify `apps/server/src/production/git_vcs.rs`; modify `apps/server/tests/production_git_vcs_rpc.rs`
- Interfaces: consumes `enrich_remote_pull_request` and `finish_fenced_enrichment` (git_vcs.rs near lines 890 and 3417) and `PullRequestService::resolve_current_optional_shared`; produces a bound on the refresh's wait for that lookup (a named constant well under the 10 second hang budget) after which the refresh answers without pull-request details, while the lookup keeps running and its result reaches subscribers through the status stream.
- Skills: none
- Read first: `apps/server/src/production/git_vcs.rs` near lines 880-900 and 1480-1500 (both enrichment call sites)
- Tier: most capable
- TDD: red-green
- Done when: `cargo test -p bibcode-server --test production_git_vcs_rpc -j 2 slow_pull_request_lookup` exits 0 with the new tests passing

Steps

1. [ ] Add `slow_pull_request_lookup_does_not_delay_the_refresh` (a stub `gh` that answers after 12 seconds; the refresh answers within the bound with local status and no pull-request details) and `slow_pull_request_lookup_reaches_subscribers_when_it_finishes` (the subscriber receives the details after the stub answers). Run the Done when command. Expected: FAIL, the refresh waits for the stub.
2. [ ] Implement the bound. Run the Done when command. Expected: PASS.
3. [ ] Prove the test can fail: remove the bound. Expected: FAIL. Restore. Expected: PASS.
4. [ ] Run `cargo fmt --all --check` and `cargo clippy --workspace --all-targets -- -D warnings`. Expected: no errors.
